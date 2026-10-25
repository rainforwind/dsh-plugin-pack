// Host plugin for Quick Actions — HOST level (profile bundle).
// HTTP routes via webServer.register() (same pattern as dsh-task-badge).
//
// A button definition carries a `scope` with two layers of meaning:
//   1. definition visibility — where the button shows up, and
//   2. run-instance sharing — which contexts share one execution.
//
//   scope: global    visible everywhere            one instance shared by everyone
//   scope: workspace visible in matching workspace  one instance per workspace
//   scope: session   visible in matching session    one instance per session
//
// `target` optionally pins the definition to one workspace id / session id;
// without it a workspace-scoped button is visible in every session (its run
// still keys per workspace) and a session-scoped button is visible in every
// session (its run keys per session).
//
// Button definitions come from two layers: `config.buttons` in
// cordis.patch.yml (static, read-only in the panel) and a JSON store that the
// panel edits at runtime. Runs execute through `ctx.shell`; output is pumped
// from the handle's non-consuming observed readers into an in-memory buffer
// that the HTTP routes hand to every viewer of that instance.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const name = 'dsh-quick-actions'
const inject = ['webServer']

const SCOPES = ['global', 'workspace', 'session']
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const DROP_MARKER = '…[earlier output dropped]\n'
const MAX_LABEL = 100
const MAX_COMMAND = 4000
const MAX_TARGET = 300
const MAX_PATH_FIELD = 1000
const MAX_ICON = 8
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
const MAX_PARAM_VALUE = 2000
const MAX_PARAMS = 8

const STORE_FILE = 'dsh-quick-actions.json'
const SETTINGS_FILE = 'dsh-quick-actions.settings.json'

// `~` and `~/…` only; a relative path keeps the historical "resolve against
// the host cwd" behaviour, so absolute paths are what the docs recommend.
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

// Where the panel's own override lives. It has to be findable without knowing
// the store path — that is the whole point — so it sits in the profile dir,
// next to the store the profile would use by default.
function settingsPathOf(ctx) {
  const profile = ctx.get('profileContext')
  const dir = profile && typeof profile.dir === 'string' ? profile.dir.trim() : ''
  return dir ? join(dir, SETTINGS_FILE) : join(homedir(), '.dsh', SETTINGS_FILE)
}

// A malformed settings file must never take the plugin down: it is an optional
// convenience layer, so a bad read degrades to "no override".
function readSettings(path) {
  try {
    if (!existsSync(path)) return {}
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch (error) {
    console.log(`[quick-actions] settings unreadable (${String(error && error.message || error)}); ignoring the panel override`)
    return {}
  }
}

// Every place the store may come from, in precedence order. The first entry
// whose path is non-empty wins; the panel renders this same list so what it
// shows and what the code actually does cannot drift apart.
//
// `config` (cordis.patch.yml) outranks the panel on purpose: an administrator
// who pinned a path did so to override the UI, and the panel says so instead of
// pretending the field is free.
function storeCandidates(ctx, config, settings) {
  const explicit = typeof config.storePath === 'string' ? config.storePath.trim() : ''
  const fromPanel = settings && typeof settings.storePath === 'string' ? settings.storePath.trim() : ''
  const profile = ctx.get('profileContext')
  const profileDir = profile && typeof profile.dir === 'string' ? profile.dir.trim() : ''
  const envDir = (process.env.DSH_PROFILE_DIR || '').trim()
  return [
    { source: 'config', raw: explicit, path: explicit ? expandHome(explicit) : '' },
    { source: 'panel', raw: fromPanel, path: fromPanel ? expandHome(fromPanel) : '' },
    { source: 'profile', path: profileDir ? join(profileDir, STORE_FILE) : '' },
    { source: 'env', path: envDir ? join(envDir, STORE_FILE) : '' },
    { source: 'home', path: join(homedir(), '.dsh', STORE_FILE) },
  ]
}

// The store belongs to the profile that is RUNNING, not to whatever spawned the
// host. `DSH_PROFILE_DIR` describes the launcher's session — a host started
// from another profile's shell inherits it — so it is only a compatibility
// fallback for hosts that predate `profileContext`. Getting this wrong reads an
// empty file and the panel looks like it lost every button.
function resolveStore(ctx, config) {
  const candidates = storeCandidates(ctx, config, readSettings(settingsPathOf(ctx)))
  const winner = candidates.find((candidate) => candidate.path) || candidates[candidates.length - 1]
  return { path: winner.path, source: winner.source, candidates }
}

// Where pre-`profileContext` versions looked: the one location a user upgrading
// from would already have data in.
const legacyStorePath = () => join(homedir(), '.dsh', STORE_FILE)

function toInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

// Parameters let a button carry run-time inputs: the "+" panel declares them
// (name, whether required, default), the card collects a value when it opens,
// and the run substitutes `{name}` in the command. Keeping them in the
// definition — not the run record — keeps one instance key per scope.
function validateParams(raw, where) {
  if (raw === undefined || raw === null) return { value: [] }
  if (!Array.isArray(raw)) return { error: `${where}.params: expected an array` }
  if (raw.length > MAX_PARAMS) return { error: `${where}.params: at most ${MAX_PARAMS} parameters` }
  const seen = new Set()
  const params = []
  raw.forEach((item, index) => {
    const label = `${where}.params[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return // already reported by the outer check
    }
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!PARAM_NAME.test(name)) {
      throw new Error(`${label}.name: must match ${String(PARAM_NAME)}`)
    }
    if (seen.has(name)) throw new Error(`${label}.name: duplicate parameter "${name}"`)
    seen.add(name)
    const required = item.required !== false
    const def = typeof item.default === 'string' ? item.default : ''
    if (def.length > MAX_PARAM_VALUE) throw new Error(`${label}.default: at most ${MAX_PARAM_VALUE} characters`)
    params.push({ name, required, default: def })
  })
  return { value: params }
}

// Validate one definition. Returns `{ value }` on success or `{ error }` with a
// message naming the offending field, so the config panel can show it.
function validateButton(raw, where, reserved, seen) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${where}: must be an object` }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!ID_PATTERN.test(id)) return { error: `${where}.id: must match ${String(ID_PATTERN)}` }
  if (seen && seen.has(id)) return { error: `${where}.id: duplicate id "${id}"` }
  if (reserved && reserved.has(id)) return { error: `${where}.id: "${id}" is reserved by config.buttons` }
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  if (!label || label.length > MAX_LABEL) return { error: `${where}.label: 1-${MAX_LABEL} characters required` }
  const command = typeof raw.command === 'string' ? raw.command : ''
  if (!command.trim() || command.length > MAX_COMMAND) return { error: `${where}.command: 1-${MAX_COMMAND} characters required` }
  const scope = raw.scope === undefined || raw.scope === null || raw.scope === '' ? 'global' : raw.scope
  if (!SCOPES.includes(scope)) return { error: `${where}.scope: expected global|workspace|session` }
  let target = typeof raw.target === 'string' ? raw.target.trim() : ''
  if (target.length > MAX_TARGET) return { error: `${where}.target: at most ${MAX_TARGET} characters` }
  if (scope === 'global') target = ''
  let workdir = typeof raw.workdir === 'string' ? raw.workdir.trim() : ''
  if (workdir.length > MAX_PATH_FIELD) return { error: `${where}.workdir: at most ${MAX_PATH_FIELD} characters` }
  const icon = typeof raw.icon === 'string' ? raw.icon.trim() : ''
  if (icon.length > MAX_ICON) return { error: `${where}.icon: at most ${MAX_ICON} characters` }
  let params
  try {
    params = validateParams(raw.params, where)
  } catch (error) {
    return { error: error.message }
  }
  if (params.error) return params
  return { value: { id, label, command, scope, target, workdir, icon, params: params.value } }
}

// Validate a whole list, keeping entry order (it is the strip's display order).
function validateList(list, reserved) {
  const buttons = []
  const errors = []
  const seen = new Set()
  list.forEach((raw, index) => {
    const result = validateButton(raw, `buttons[${index}]`, reserved, seen)
    if (result.error) { errors.push(result.error); return }
    seen.add(result.value.id)
    buttons.push(result.value)
  })
  return { buttons, errors }
}

function apply(ctx, config = {}) {
  // A patch row may carry `config: null`; never let that reach property reads.
  if (!config || typeof config !== 'object') config = {}
  console.log('[quick-actions] Host apply() called')

  const maxOutputChars = toInt(config.maxOutputChars, 200000, 4000, 4000000)
  const pollMs = toInt(config.pollMs, 150, 5, 10000)
  // Rebindable: choosing another store from the panel re-resolves these in
  // place, so the switch takes effect without restarting the host.
  let resolution = resolveStore(ctx, config)
  let storePath = resolution.path
  let storeSource = resolution.source
  let storeCandidatesResult = resolution.candidates
  console.log(`[quick-actions] store: ${storePath} (source=${storeSource})`)
  // Whether the buttons on screen came from the read-only legacy fallback; the
  // panel explains that, otherwise a path with no file looks like a data loss.
  let storeFromLegacy = false

  // Static definitions from the patch layer: drop invalid ones loudly but keep
  // the plugin alive — a typo in the YAML must not take the bundle down.
  const configButtons = Array.isArray(config.buttons) ? config.buttons : []
  const configReserved = new Set()
  const parsedConfigButtons = []
  if (configButtons.length) {
    const result = validateList(configButtons, new Set())
    result.buttons.forEach((button) => { configReserved.add(button.id) })
    result.errors.forEach((error) => console.log(`[quick-actions] config.buttons dropped: ${error}`))
    parsedConfigButtons.push(...result.buttons)
  }

  // ── JSON store (the panel's editable layer) ──────────────────────────────
  // Parse one store file into validated buttons. Returns null when the file is
  // unreadable, so the caller can tell "no file" from "empty list".
  function readButtons(path) {
    if (!existsSync(path)) return null
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.buttons) ? raw.buttons : []
      const result = validateList(list, configReserved)
      result.errors.forEach((error) => console.log(`[quick-actions] store dropped: ${error}`))
      return result.buttons
    } catch (error) {
      console.log(`[quick-actions] store unreadable (${String(error && error.message || error)}); starting empty`)
      return []
    }
  }

  function loadStore() {
    const own = readButtons(storePath)
    if (own !== null) return own
    // Upgrading from a version that keyed the store off the launcher env: the
    // data usually still sits in ~/.dsh. Show it once, but never write there —
    // the first save lands in `storePath`, and the legacy file stays untouched
    // as the rollback path. Only for the profile source: an env-derived path is
    // exactly the wrong-profile directory this fix removes, so never read that.
    if (storeSource === 'profile') {
      const legacy = legacyStorePath()
      if (legacy !== storePath) {
        const inherited = readButtons(legacy)
        if (inherited && inherited.length) {
          console.log(`[quick-actions] store: legacy ${legacy} is visible; first save writes ${storePath}`)
          storeFromLegacy = true
          return inherited
        }
      }
    }
    return []
  }

  let storeButtons = loadStore()

  function persistStore() {
    const dir = dirname(storePath)
    mkdirSync(dir, { recursive: true })
    const tmp = `${storePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, buttons: storeButtons }, null, 2)}\n`)
    renameSync(tmp, storePath)
  }

  // `config.storePath` in cordis.patch.yml outranks the panel by design, so the
  // panel reports it as pinned instead of offering a field that cannot win.
  const configStorePath = typeof config.storePath === 'string' ? config.storePath.trim() : ''
  const settingsPath = settingsPathOf(ctx)

  // The store state the panel renders. Built from the same candidate list the
  // resolver walks, so the explanation cannot drift from the behaviour.
  function describeStore() {
    return {
      path: storePath,
      source: storeSource,
      exists: existsSync(storePath),
      pinnedBy: configStorePath ? 'config' : '',
      settingsPath,
      legacyPath: legacyStorePath(),
      legacyVisible: storeFromLegacy,
      candidates: storeCandidatesResult.map((candidate) => ({
        source: candidate.source,
        path: candidate.path,
        raw: candidate.raw === undefined ? '' : candidate.raw,
        active: !!candidate.path && candidate.path === storePath,
      })),
    }
  }

  // Re-resolve after the panel wrote its override, and swap the live store over
  // to the winning path: no host restart, and the next save lands there.
  function rebindStore() {
    resolution = resolveStore(ctx, config)
    storePath = resolution.path
    storeSource = resolution.source
    storeCandidatesResult = resolution.candidates
    storeFromLegacy = false
    storeButtons = loadStore()
    console.log(`[quick-actions] store: ${storePath} (source=${storeSource})`)
  }

  function allButtons() {
    return [
      ...parsedConfigButtons.map((button) => ({ ...button, source: 'config' })),
      ...storeButtons.map((button) => ({ ...button, source: 'store' })),
    ]
  }

  function findButton(buttonId) {
    return allButtons().find((button) => button.id === buttonId) || null
  }

  // ── scope: context, visibility, instance identity ────────────────────────
  // The client sends only the session on screen; the workspace that session
  // belongs to is resolved here so both layers of scope come from one place.
  // The registry's `sessionIds` getter is filtered by the durable header index,
  // so a session created moments ago is in no list yet. Falling back to the
  // session's own working directory keeps {workspace} and the default workdir
  // correct during that window instead of running the command in the wrong
  // directory (a fresh session used to report "not a git repository").
  function sessionDirectory(sessionId) {
    const working = ctx.get('workingDirectory')
    if (working && typeof working.get === 'function') {
      try {
        const agents = ctx.get('agents')
        const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
        const session = agent && agent.session
        if (session) {
          const dir = working.get(session)
          if (typeof dir === 'string' && dir) return dir
        }
      } catch (error) { /* no live agent for this session yet */ }
    }
    return ''
  }

  function workspaceOf(sessionId) {
    if (!sessionId) return { id: '', path: '' }
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return { id: '', path: '' }
    try {
      const list = registry.list() || []
      for (const workspace of list) {
        const ids = workspace.sessionIds || []
        if (ids.indexOf(sessionId) >= 0) return { id: String(workspace.id || ''), path: String(workspace.path || '') }
      }
      // Not indexed yet: match the workspace whose directory is this session's
      // working directory, so the instance key and the command agree.
      const dir = sessionDirectory(sessionId)
      if (dir) {
        for (const workspace of list) {
          const path = String(workspace.path || '')
          if (path && (path === dir || dir.startsWith(`${path}/`))) {
            return { id: String(workspace.id || ''), path }
          }
        }
        // A directory outside every workspace is still a real working directory.
        return { id: '', path: dir }
      }
    } catch (error) { /* registry unavailable: treat the session as ungrouped */ }
    return { id: '', path: '' }
  }

  function contextOf(sessionId) {
    const workspace = workspaceOf(sessionId)
    return {
      sessionId: sessionId || null,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
    }
  }

  function isVisible(button, context) {
    if (button.scope === 'global') return true
    if (!context.sessionId) return false
    if (button.scope === 'session') return !button.target || button.target === context.sessionId
    // workspace
    if (button.target) return context.workspaceId !== '' && context.workspaceId === button.target
    return true
  }

  function instanceKeyOf(button, context) {
    if (button.scope === 'global') return `g:${button.id}`
    // A workspace-scoped button shares one instance per workspace — but only
    // when the session really belongs to one. Without a workspace id every
    // ungrouped session would share `w:<id>:`, so two unrelated sessions would
    // see each other's run; fall back to the session id instead.
    if (button.scope === 'workspace') {
      return context.workspaceId ? `w:${button.id}:${context.workspaceId}` : `w:${button.id}:~${context.sessionId || ''}`
    }
    return `s:${button.id}:${context.sessionId}`
  }

  // `{workspace}` / `{session}` expand when the fact is known and stay literal
  // otherwise, so a broken placeholder is visible instead of silently empty.
  function expand(command, context) {
    return command
      .replace(/\{workspace\}/g, () => context.workspacePath || '{workspace}')
      .replace(/\{session\}/g, () => context.sessionId || '{session}')
  }

  // `{name}` expands to the run-time value when supplied; an unknown or empty
  // placeholder stays literal so the omission is visible instead of silently
  // collapsing into a different command.
  function expandParams(command, params) {
    const map = params || {}
    return command.replace(/\{([A-Za-z][A-Za-z0-9_]{0,31})\}/g, (whole, name) => {
      const value = map[name]
      return value === undefined || value === null || value === '' ? whole : String(value)
    })
  }

  // The card sends `{ name: value }` for the parameters it collected; the run
  // joins only those that exist in the definition (a stale client cannot inject
  // an arbitrary placeholder) and enforces required ones.
  function resolveParams(button, supplied) {
    const defs = button.params || []
    const values = {}
    if (supplied && typeof supplied === 'object' && !Array.isArray(supplied)) {
      for (const def of defs) {
        const value = supplied[def.name]
        if (typeof value === 'string' && value.length <= MAX_PARAM_VALUE) values[def.name] = value
      }
    }
    for (const def of defs) {
      if (def.required && !(values[def.name] || def.default)) {
        return { error: `missing-param:${def.name}` }
      }
      if (!values[def.name] && def.default) values[def.name] = def.default
    }
    return { values }
  }

  // ── run registry ─────────────────────────────────────────────────────────
  let runSeq = 0
  const runs = new Map()   // instanceKey -> record; one live/latest run per instance
  const timers = new Set()

  // One record per instance key keeps the map bounded by button × context
  // counts, but session-scoped keys follow every session ever opened. When the
  // map grows past 120, evict the oldest settled records (never a running one)
  // so a long-lived profile cannot accumulate output buffers forever.
  function pruneRuns() {
    if (runs.size <= 120) return
    const settled = [...runs.entries()].filter(([, record]) => record.status !== 'running')
    settled.sort((left, right) => left[1].startedAt - right[1].startedAt)
    for (const [key] of settled) {
      runs.delete(key)
      if (runs.size <= 100) break
    }
  }

  function appendText(record, text) {
    if (!text) return
    record.text += text
    if (record.text.length > maxOutputChars) {
      const excess = record.text.length - maxOutputChars
      record.dropped += excess
      record.text = DROP_MARKER + record.text.slice(excess)
    }
  }

  function pump(record) {
    const exec = record.exec
    if (!exec || !exec.observed) return
    try {
      const out = exec.observed.stdout.readFrom(record.outOff)
      record.outOff = out.nextOffset
      appendText(record, out.text)
      const err = exec.observed.stderr.readFrom(record.errOff)
      record.errOff = err.nextOffset
      appendText(record, err.text)
    } catch (error) { /* reader races during teardown are harmless */ }
  }

  function settle(record) {
    if (record.status !== 'running') return
    if (record.timer) {
      clearInterval(record.timer)
      timers.delete(record.timer)
      record.timer = null
    }
    pump(record)   // drain whatever arrived since the last tick
    const exec = record.exec
    record.exitCode = exec ? exec.exitCode : null
    record.signal = exec ? exec.signal : null
    record.status = record.killRequested ? 'killed' : (record.exitCode === 0 ? 'completed' : 'failed')
    record.endedAt = Date.now()
  }

  function shellService() {
    const shell = ctx.get('shell')
    if (!shell || typeof shell.execute !== 'function' || typeof shell.resolve !== 'function') return null
    return shell
  }

  // Start a run for `button`'s instance, or join the one already running:
  // the shared instance is the whole point of scope, so two viewers clicking
  // the same button get the same execution and the same output.
  async function startRun(button, context, suppliedParams) {
    const shell = shellService()
    if (!shell) return { error: 'shell-unavailable', status: 503 }

    const instanceKey = instanceKeyOf(button, context)
    const existing = runs.get(instanceKey)
    if (existing && existing.status === 'running') return { record: existing, joined: true }

    const resolved = resolveParams(button, suppliedParams)
    if (resolved.error) return { error: resolved.error, status: 400 }

    const command = expandParams(expand(button.command, context), resolved.values)
    const workdir = button.workdir || config.workdir || context.workspacePath || undefined
    const record = {
      runId: `run-${String(++runSeq)}`,
      buttonId: button.id,
      instanceKey,
      command,
      workdir: workdir || null,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      signal: null,
      text: '',
      dropped: 0,
      params: resolved.values,
      killRequested: false,
      outOff: 0,
      errOff: 0,
      exec: null,
      timer: null,
    }
    // Published before the first await: a second click sees `running` and joins.
    pruneRuns()
    runs.set(instanceKey, record)

    try {
      const request = { command, onExpiry: 'none' }
      if (workdir) request.workdir = workdir
      const exec = await shell.execute(shell.resolve(request))
      record.exec = exec
      record.timer = setInterval(() => pump(record), pollMs)
      timers.add(record.timer)
      exec.done.then(() => settle(record)).catch(() => settle(record))
    } catch (error) {
      record.status = 'failed'
      record.endedAt = Date.now()
      const note = `[spawn failed: ${String(error && error.message || error)}]`
      appendText(record, `${record.text && !record.text.endsWith('\n') ? '\n' : ''}${note}`)
    }
    return { record, joined: false }
  }

  function killRun(instanceKey) {
    const record = runs.get(instanceKey)
    if (!record || record.status !== 'running') return null
    record.killRequested = true
    try { if (record.exec) record.exec.kill() } catch (error) { /* already gone */ }
    return record
  }

  function viewRecord(record) {
    return {
      runId: record.runId,
      buttonId: record.buttonId,
      instanceKey: record.instanceKey,
      status: record.status,
      command: record.command,
      workdir: record.workdir,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      text: record.text,
      dropped: record.dropped,
      params: record.params,
    }
  }

  function viewButton(button, context, source) {
    const instanceKey = instanceKeyOf(button, context)
    const record = runs.get(instanceKey)
    return {
      id: button.id,
      label: button.label,
      icon: button.icon,
      command: button.command,
      workdir: button.workdir,
      scope: button.scope,
      target: button.target,
      source,
      instanceKey,
      params: (button.params || []).map((def) => ({ name: def.name, required: def.required, default: def.default })),
      run: record ? {
        runId: record.runId,
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
      } : null,
    }
  }

  // Resolve `{ buttonId, sessionId }` from a request into a visible button and
  // its context; returns `{ error, status }` when the request must fail.
  function resolveTarget(body) {
    const button = findButton(body && body.buttonId)
    if (!button) return { error: 'unknown-button', status: 404 }
    const context = contextOf(body && body.sessionId)
    if (!isVisible(button, context)) return { error: 'not-visible', status: 404 }
    return { button, context, instanceKey: instanceKeyOf(button, context) }
  }

  // ── HTTP plumbing (same shape as dsh-task-badge) ─────────────────────────
  function sendJson(response, status, data) {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    response.end(JSON.stringify(data))
  }

  function readBody(request) {
    return new Promise((resolve) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { resolve({}) }
      })
    })
  }

  function queryOf(request) {
    try {
      return new URL(request.url || '/', 'http://127.0.0.1').searchParams
    } catch (error) {
      return new URLSearchParams('')
    }
  }

  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.get('webServer')
    if (!webServer || !webServer.register) {
      console.log('[quick-actions] webServer.register not available')
      return
    }
    const disposers = []
    const route = (path, handler) => disposers.push(webServer.register({ kind: 'exact', path, handler }))

    const guard = (request, response, method) => {
      if (request.method === 'OPTIONS') { sendJson(response, 204, {}); return true }
      if (request.method !== method) { response.writeHead(405); response.end(); return true }
      return false
    }

    // Buttons visible in one context, each with its instance key and run state.
    route('/quick-actions/buttons', (request, response) => {
      if (guard(request, response, 'GET')) return
      const params = queryOf(request)
      const sessionId = params.get('sessionId') || null
      const context = contextOf(sessionId)
      const buttons = allButtons()
        .filter((button) => isVisible(button, context))
        .map((button) => viewButton(button, context, button.source))
      sendJson(response, 200, {
        ok: true,
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
        buttons,
      })
    })

    // GET reads the current run of one button in one context (fresh text each
    // time: runs are capped in memory, so a full read is cheaper than offset
    // bookkeeping). POST starts the run — or joins the one already running.
    // The web server rejects duplicate (kind, path) registrations, so both
    // directions live in this one handler.
    route('/quick-actions/run', async (request, response) => {
      if (request.method === 'OPTIONS') { sendJson(response, 204, {}); return }
      if (request.method === 'GET') {
        const params = queryOf(request)
        const resolved = resolveTarget({ buttonId: params.get('buttonId'), sessionId: params.get('sessionId') })
        if (resolved.error) { sendJson(response, resolved.status, { ok: false, error: resolved.error }); return }
        const record = runs.get(resolved.instanceKey) || null
        sendJson(response, 200, { ok: true, run: record ? viewRecord(record) : null })
        return
      }
      if (request.method === 'POST') {
        const body = await readBody(request)
        const resolved = resolveTarget(body)
        if (resolved.error) { sendJson(response, resolved.status, { ok: false, error: resolved.error }); return }
        const started = await startRun(resolved.button, resolved.context, body.params)
        if (started.error) { sendJson(response, started.status, { ok: false, error: started.error }); return }
        sendJson(response, 200, {
          ok: true,
          joined: started.joined,
          instanceKey: resolved.instanceKey,
          run: viewRecord(started.record),
        })
        return
      }
      response.writeHead(405)
      response.end()
    })

    route('/quick-actions/kill', async (request, response) => {
      if (guard(request, response, 'POST')) return
      const body = await readBody(request)
      const resolved = resolveTarget(body)
      if (resolved.error) { sendJson(response, resolved.status, { ok: false, error: resolved.error }); return }
      const record = killRun(resolved.instanceKey)
      if (!record) { sendJson(response, 200, { ok: false, error: 'not-running', run: null }); return }
      sendJson(response, 200, { ok: true, run: viewRecord(record) })
    })

    // Definition management for the "+" panel. GET reads both layers; POST
    // replaces the editable store layer (validated, then persisted).
    route('/quick-actions/config', async (request, response) => {
      if (request.method === 'OPTIONS') { sendJson(response, 204, {}); return }
      if (request.method === 'GET') {
        const legacy = legacyStorePath()
        sendJson(response, 200, {
          ok: true,
          buttons: storeButtons,
          configButtons: parsedConfigButtons,
          storePath,
          storeSource,
          store: describeStore(),
        })
        return
      }
      if (request.method === 'POST') {
        const body = await readBody(request)
        if (!body || !Array.isArray(body.buttons)) {
          sendJson(response, 400, { ok: false, errors: ['buttons: expected an array'] })
          return
        }
        const result = validateList(body.buttons, configReserved)
        if (result.errors.length) { sendJson(response, 400, { ok: false, errors: result.errors }); return }
        const previous = storeButtons
        storeButtons = result.buttons
        try {
          persistStore()
        } catch (error) {
          storeButtons = previous
          sendJson(response, 500, {
            ok: false,
            error: 'store-write-failed',
            message: String(error && error.message || error),
          })
          return
        }
        // Runs of buttons that just disappeared are unreachable; drop them.
        const live = new Set(allButtons().map((button) => button.id))
        for (const [key, record] of runs) {
          if (!live.has(record.buttonId)) runs.delete(key)
        }
        sendJson(response, 200, { ok: true, buttons: storeButtons, configButtons: parsedConfigButtons })
        return
      }
      response.writeHead(405)
      response.end()
    })

    // The panel's store override. It lives in the profile dir as a small
    // settings file rather than in cordis.patch.yml: `configEditor` only owns
    // rows the profile patch itself declares, and this plugin is inserted by its
    // bundle, so editing it that way is not addressable. Owning the file also
    // means the switch takes effect immediately — `rebindStore()` swaps the live
    // path instead of waiting for a host restart.
    route('/quick-actions/store', async (request, response) => {
      if (request.method === 'OPTIONS') { sendJson(response, 204, {}); return }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return }

      const body = await readBody(request)
      if (!body || typeof body.storePath !== 'string') {
        sendJson(response, 400, { ok: false, error: 'bad-request', message: 'storePath: expected a string' })
        return
      }
      const raw = body.storePath.trim()
      if (raw && raw.length > MAX_PATH_FIELD) {
        sendJson(response, 400, { ok: false, error: 'bad-path', message: `storePath: at most ${MAX_PATH_FIELD} characters` })
        return
      }
      // The value ends up inside a JSON document other tools may read; keep it
      // to something that cannot break out of a scalar.
      if (/[\r\n\t\0]/.test(raw)) {
        sendJson(response, 400, { ok: false, error: 'bad-path', message: 'storePath: no line breaks or tabs' })
        return
      }
      if (configStorePath) {
        sendJson(response, 409, {
          ok: false,
          error: 'pinned-by-config',
          message: `config.storePath is pinned to ${configStorePath}; change it in cordis.patch.yml`,
        })
        return
      }

      // Write before rebinding: a path that cannot be persisted must not appear
      // to work until the next restart, which would look like silent data loss.
      try {
        const nextSettings = { ...readSettings(settingsPath), }
        if (raw) nextSettings.storePath = raw
        else delete nextSettings.storePath
        const dir = dirname(settingsPath)
        mkdirSync(dir, { recursive: true })
        if (Object.keys(nextSettings).length === 0) {
          if (existsSync(settingsPath)) unlinkSync(settingsPath)
        } else {
          const tmp = `${settingsPath}.tmp`
          writeFileSync(tmp, `${JSON.stringify(nextSettings, null, 2)}\n`)
          renameSync(tmp, settingsPath)
        }
      } catch (error) {
        sendJson(response, 500, {
          ok: false,
          error: 'settings-write-failed',
          message: String(error && error.message || error),
        })
        return
      }

      rebindStore()
      sendJson(response, 200, {
        ok: true,
        buttons: storeButtons,
        configButtons: parsedConfigButtons,
        storePath,
        storeSource,
        store: describeStore(),
      })
    })

    hostCtx.effect(() => () => {
      for (const dispose of disposers) { try { dispose() } catch (error) {} }
      for (const timer of timers) clearInterval(timer)
      timers.clear()
    }, 'quick-actions: routes')

    console.log('[quick-actions] HTTP routes registered')
  })

  console.log('[quick-actions] Plugin initialized')
}

export { apply, inject, name }
