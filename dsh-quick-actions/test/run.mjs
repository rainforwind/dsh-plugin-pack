// Standalone test for the dsh-quick-actions host half.
// Run with: node test/run.mjs
// Exercises the HTTP routes against a stubbed cordis context: scope-based
// visibility and run-instance sharing, the shell execution lifecycle (start,
// join, pump, settle, kill), placeholder expansion, the output cap, and the
// definition store (validation + persistence round-trip).

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

let passed = 0
const failures = []
async function test(label, fn) {
  try {
    await fn()
    passed++
    console.log(`ok   ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.error(`FAIL ${label}\n     ${error.stack ?? error}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const flush = async () => { for (let i = 0; i < 6; i++) await sleep(0) }

// ── stubs ──────────────────────────────────────────────────────────────────

// One execution handle per `shell.execute`, with non-consuming observed
// readers that behave like the real SubprocessOutputReader contract.
function makeShell() {
  const executions = []
  return {
    executions,
    resolve(request) {
      return { ...request, timeoutMs: 0, stdoutMaxBytes: 1024, onExpiry: request.onExpiry || 'none' }
    },
    async execute(spec) {
      const streams = { stdout: '', stderr: '' }
      let settle
      const done = new Promise((resolve) => { settle = resolve })
      const state = { exitCode: null, signal: null }
      const reader = (channel) => ({
        readFrom(from) {
          const text = streams[channel].slice(from)
          return { text, nextOffset: streams[channel].length, lossy: false }
        },
      })
      const exec = {
        spec,
        observed: { stdout: reader('stdout'), stderr: reader('stderr') },
        get exitCode() { return state.exitCode },
        get signal() { return state.signal },
        done,
        kill() { return true },
        emit(text) { streams.stdout += text },
        emitErr(text) { streams.stderr += text },
        finish(exitCode, signal = null) { state.exitCode = exitCode; state.signal = signal; settle() },
      }
      executions.push(exec)
      return exec
    },
  }
}

// workspaces: [{ id, path, sessionIds }] rows for the registry stub.
// profileContext: the Host service that names the running profile; omitted by
// default so every existing case keeps exercising the compat path.
function makeHost({ shell, workspaces = [], storePath, config = {}, sessionDirs = {}, profileContext, configEditor } = {}) {
  const routes = new Map()
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const registry = { list: () => workspaces }
  // `workingDirectory.get(session)` / `agents.get(id)` as the Host serves them:
  // a session created moments ago is in no workspace's `sessionIds` yet, but
  // its own working directory is already known.
  const workingDirectory = { get: (session) => sessionDirs[session && session.id] || '/fallback' }
  const agents = { get: (id) => (sessionDirs[id] ? { session: { id } } : undefined) }
  const disposers = []
  const ctx = {
    get(service) {
      if (service === 'webServer') return webServer
      if (service === 'shell') return shell
      if (service === 'workspaceRegistry') return registry
      if (service === 'workingDirectory') return workingDirectory
      if (service === 'agents') return agents
      if (service === 'profileContext') return profileContext
      if (service === 'configEditor') return configEditor
      return undefined
    },
    on() {},
    inject(names, cb) { cb(ctx) },
    effect(fn) { const d = fn(); disposers.push(d); return d },
  }

  // The plugin narrates on every apply; keep the test output readable.
  const quiet = console.log
  console.log = () => {}
  try {
    apply(ctx, { pollMs: 5, storePath, ...config })
  } finally {
    console.log = quiet
  }
  return { ctx, routes, dispose: () => disposers.forEach((d) => d()) }
}

function call(routes, path, { method = 'GET', query = '', body } = {}) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} was never registered`)
  return new Promise((resolve) => {
    const out = {}
    const response = {
      writeHead(status) { out.status = status },
      end(payload) { out.body = payload ? JSON.parse(payload) : undefined; resolve(out) },
    }
    const url = query ? `${path}?${query}` : path
    if (method === 'GET' || method === 'OPTIONS') {
      route.handler({ method, url }, response)
      return
    }
    const chunks = body === undefined ? [] : [JSON.stringify(body)]
    route.handler({
      method,
      url,
      on(event, cb) {
        if (event === 'data') cb(chunks.shift())
        if (event === 'end') cb()
      },
    }, response)
  })
}

const listButtons = (routes, sessionId) =>
  call(routes, '/quick-actions/buttons', { query: `sessionId=${encodeURIComponent(sessionId ?? '')}` })
    .then((r) => r.body)

const startRun = (routes, buttonId, sessionId) =>
  call(routes, '/quick-actions/run', { method: 'POST', body: { buttonId, sessionId } })
    .then((r) => r.body)

const readRun = (routes, buttonId, sessionId) =>
  call(routes, '/quick-actions/run', { query: `buttonId=${encodeURIComponent(buttonId)}&sessionId=${encodeURIComponent(sessionId ?? '')}` })
    .then((r) => r.body)

const killRun = (routes, buttonId, sessionId) =>
  call(routes, '/quick-actions/kill', { method: 'POST', body: { buttonId, sessionId } })
    .then((r) => r.body)

const postConfig = (routes, buttons) =>
  call(routes, '/quick-actions/config', { method: 'POST', body: { buttons } }).then((r) => r)

const getConfig = (routes) => call(routes, '/quick-actions/config').then((r) => r.body)

// Two sessions in one workspace, one session in another, one ungrouped.
const workspaces = [
  { id: 'ws-a', path: '/proj/a', sessionIds: ['ses-a1', 'ses-a2'] },
  { id: 'ws-b', path: '/proj/b', sessionIds: ['ses-b1'] },
]

const buttons = [
  { id: 'global-thing', label: 'Global', command: 'echo global', scope: 'global' },
  { id: 'ws-a-thing', label: 'For ws-a', command: 'echo a', scope: 'workspace', target: 'ws-a' },
  { id: 'ws-any', label: 'Any workspace', command: 'echo any', scope: 'workspace' },
  { id: 'ses-a1-thing', label: 'For ses-a1', command: 'echo one', scope: 'session', target: 'ses-a1' },
  { id: 'ses-any', label: 'Any session', command: 'echo mine', scope: 'session' },
]

const storePath = join(mkdtempSync(join(tmpdir(), 'qa-')), 'buttons.json')

// ── visibility (definition layer of scope) ─────────────────────────────────

{
  const { routes } = makeHost({ shell: makeShell(), workspaces, storePath, config: { buttons } })
  const idsFor = async (sessionId) => (await listButtons(routes, sessionId)).buttons.map((b) => b.id)

  await test('a session in ws-a sees global, workspace and session buttons', async () => {
    assert.deepEqual(await idsFor('ses-a1'), [
      'global-thing', 'ws-a-thing', 'ws-any', 'ses-a1-thing', 'ses-any',
    ])
  })

  await test('a session in the same workspace misses the other workspace target', async () => {
    assert.deepEqual(await idsFor('ses-a2'), ['global-thing', 'ws-a-thing', 'ws-any', 'ses-any'])
  })

  await test('a session in another workspace sees its own target instead', async () => {
    assert.deepEqual(await idsFor('ses-b1'), ['global-thing', 'ws-any', 'ses-any'])
  })

  await test('an ungrouped session still sees the untargeted workspace button', async () => {
    assert.deepEqual(await idsFor('ses-orphan'), ['global-thing', 'ws-any', 'ses-any'])
  })

  await test('without a session on screen only global buttons show', async () => {
    const listed = await listButtons(routes, null)
    assert.deepEqual(listed.buttons.map((b) => b.id), ['global-thing'])
    assert.equal(listed.workspaceId, '')
  })

  await test('the response carries the resolved workspace of the session', async () => {
    assert.equal((await listButtons(routes, 'ses-b1')).workspaceId, 'ws-b')
  })
}

// ── instance identity (sharing layer of scope) ─────────────────────────────

await test('global buttons share one instance key across every session', async () => {
  const { routes } = makeHost({ shell: makeShell(), workspaces, storePath, config: { buttons } })
  const [one, two] = await Promise.all([
    listButtons(routes, 'ses-a1'),
    listButtons(routes, 'ses-b1'),
  ])
  const key = (listed) => listed.buttons.find((b) => b.id === 'global-thing').instanceKey
  assert.equal(key(one), 'g:global-thing')
  assert.equal(key(one), key(two))
})

await test('workspace buttons key per workspace, sessions per session', async () => {
  const { routes } = makeHost({ shell: makeShell(), workspaces, storePath, config: { buttons } })
  const a1 = await listButtons(routes, 'ses-a1')
  const a2 = await listButtons(routes, 'ses-a2')
  const b1 = await listButtons(routes, 'ses-b1')
  const pick = (listed, id) => listed.buttons.find((b) => b.id === id).instanceKey
  // Two sessions of ws-a share one workspace instance; ws-b gets its own.
  assert.equal(pick(a1, 'ws-a-thing'), 'w:ws-a-thing:ws-a')
  assert.equal(pick(a1, 'ws-a-thing'), pick(a2, 'ws-a-thing'))
  assert.equal(pick(b1, 'ws-any'), 'w:ws-any:ws-b')
  assert.equal(pick(a1, 'ws-any'), 'w:ws-any:ws-a')
  // Session buttons are per session even without a target.
  assert.equal(pick(a1, 'ses-any'), 's:ses-any:ses-a1')
  assert.equal(pick(a2, 'ses-any'), 's:ses-any:ses-a2')
  assert.equal(pick(a1, 'ses-a1-thing'), 's:ses-a1-thing:ses-a1')
})

// ── shell execution lifecycle ──────────────────────────────────────────────

await test('a run starts, pumps live output, and settles on exit 0', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons } })

  const started = await startRun(routes, 'global-thing', 'ses-a1')
  assert.equal(started.ok, true)
  assert.equal(started.run.status, 'running')
  assert.equal(started.joined, false)
  assert.equal(shell.executions.length, 1)

  const exec = shell.executions[0]
  exec.emit('hello ')
  exec.emit('world\n')
  exec.emitErr('careful\n')
  await sleep(40)

  const reading = await readRun(routes, 'global-thing', 'ses-a1')
  assert.equal(reading.run.status, 'running')
  assert.equal(reading.run.text, 'hello world\ncareful\n')

  exec.finish(0)
  await flush()
  const after = await readRun(routes, 'global-thing', 'ses-a1')
  assert.equal(after.run.status, 'completed')
  assert.equal(after.run.exitCode, 0)
  assert.ok(after.run.endedAt >= after.run.startedAt)
})

await test('a second click joins the running instance instead of re-running', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons } })

  const first = await startRun(routes, 'global-thing', 'ses-a1')
  const second = await startRun(routes, 'global-thing', 'ses-b1') // other session, same global instance
  assert.equal(second.joined, true)
  assert.equal(second.run.runId, first.run.runId)
  assert.equal(shell.executions.length, 1)

  shell.executions[0].finish(1)
  await flush()

  const third = await startRun(routes, 'global-thing', 'ses-a1')
  assert.equal(third.joined, false, 'a settled instance must start fresh')
  assert.notEqual(third.run.runId, first.run.runId)
  assert.equal(shell.executions.length, 2)
})

await test('session-scoped instances run independently', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons } })

  await startRun(routes, 'ses-any', 'ses-a1')
  await startRun(routes, 'ses-any', 'ses-a2')
  assert.equal(shell.executions.length, 2, 'one per session, not shared')
  shell.executions[0].finish(0)
  shell.executions[1].finish(0)
  await flush()
  assert.equal((await readRun(routes, 'ses-any', 'ses-a1')).run.status, 'completed')
  assert.equal((await readRun(routes, 'ses-any', 'ses-a2')).run.status, 'completed')
})

await test('kill marks the run and settles it as killed', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons } })

  await startRun(routes, 'global-thing', 'ses-a1')
  const killed = await killRun(routes, 'global-thing', 'ses-a1')
  assert.equal(killed.ok, true)
  assert.equal(killed.run.status, 'running') // still winding down

  shell.executions[0].emit('bye\n')
  shell.executions[0].finish(null, 'SIGTERM')
  await flush()

  const after = await readRun(routes, 'global-thing', 'ses-a1')
  assert.equal(after.run.status, 'killed')
  assert.equal(after.run.signal, 'SIGTERM')
  assert.ok(after.run.text.endsWith('bye\n'))

  const again = await killRun(routes, 'global-thing', 'ses-a1')
  assert.equal(again.ok, false)
  assert.equal(again.error, 'not-running')
})

await test('a nonzero exit settles the run as failed', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons } })
  await startRun(routes, 'global-thing', 'ses-a1')
  shell.executions[0].finish(3)
  await flush()
  const after = await readRun(routes, 'global-thing', 'ses-a1')
  assert.equal(after.run.status, 'failed')
  assert.equal(after.run.exitCode, 3)
})

await test('without a shell executor the run fails with 503, not a crash', async () => {
  const { routes } = makeHost({ shell: undefined, workspaces, storePath, config: { buttons } })
  const result = await startRun(routes, 'global-thing', 'ses-a1')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'shell-unavailable')
})

await test('unknown or invisible buttons are refused before anything runs', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons } })

  assert.equal((await startRun(routes, 'nope', 'ses-a1')).error, 'unknown-button')
  // `ses-a1-thing` targets one session; asking from another is not visible.
  assert.equal((await startRun(routes, 'ses-a1-thing', 'ses-b1')).error, 'not-visible')
  // Session-scoped buttons need a session at all.
  assert.equal((await startRun(routes, 'ses-any', null)).error, 'not-visible')
  assert.equal(shell.executions.length, 0)
})

await test('{workspace} and {session} expand with the request context', async () => {
  const shell = makeShell()
  const { routes } = makeHost({
    shell,
    workspaces,
    storePath,
    config: { buttons: [{ id: 'where', label: 'Where', command: 'ls {workspace} {session}', scope: 'session' }] },
  })
  await startRun(routes, 'where', 'ses-b1')
  assert.equal(shell.executions[0].spec.command, 'ls /proj/b ses-b1')
  shell.executions[0].finish(0)
  await flush()
})

await test('an unknown placeholder stays literal instead of expanding empty', async () => {
  const shell = makeShell()
  const { routes } = makeHost({
    shell,
    workspaces,
    storePath,
    config: { buttons: [{ id: 'where', label: 'Where', command: 'ls {workspace}', scope: 'global' }] },
  })
  await startRun(routes, 'where', 'ses-orphan') // ungrouped → no workspace path
  assert.equal(shell.executions[0].spec.command, 'ls {workspace}')
  shell.executions[0].finish(0)
  await flush()
})

await test('output past the cap is dropped from the head, with a marker', async () => {
  const shell = makeShell()
  const { routes } = makeHost({
    shell,
    workspaces,
    storePath,
    config: { buttons, maxOutputChars: 4000 },
  })
  await startRun(routes, 'global-thing', 'ses-a1')
  const exec = shell.executions[0]
  exec.emit('A'.repeat(3000))
  exec.emit('B'.repeat(3000))
  await sleep(40)
  const run = (await readRun(routes, 'global-thing', 'ses-a1')).run
  assert.ok(run.dropped > 0, 'head must be accounted as dropped')
  assert.ok(run.text.length < 4200, `capped text was ${String(run.text.length)}`)
  assert.ok(run.text.startsWith('…[earlier output dropped]'))
  assert.ok(run.text.endsWith('B'.repeat(1000)))
  exec.finish(0)
  await flush()
})

// ── definition store ───────────────────────────────────────────────────────

await test('the config endpoint rejects bad definitions with field errors', async () => {
  const { routes } = makeHost({ shell: makeShell(), workspaces, storePath, config: { buttons } })

  const badId = await postConfig(routes, [{ id: 'Bad Id!', label: 'x', command: 'echo x' }])
  assert.equal(badId.status, 400)
  assert.match(badId.body.errors[0], /buttons\[0\]\.id/)

  const missingLabel = await postConfig(routes, [{ id: 'ok', label: '   ', command: 'echo x' }])
  assert.equal(missingLabel.status, 400)
  assert.match(missingLabel.body.errors[0], /buttons\[0\]\.label/)

  const badScope = await postConfig(routes, [{ id: 'ok', label: 'x', command: 'echo', scope: 'planet' }])
  assert.equal(badScope.status, 400)
  assert.match(badScope.body.errors[0], /scope/)

  const reserved = await postConfig(routes, [{ id: 'global-thing', label: 'x', command: 'echo' }])
  assert.equal(reserved.status, 400)
  assert.match(reserved.body.errors[0], /reserved by config/)

  const notArray = await call(routes, '/quick-actions/config', { method: 'POST', body: { buttons: 'no' } })
  assert.equal(notArray.status, 400)
})

await test('a valid definition persists and shows up for the right scopes', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons } })

  const saved = await postConfig(routes, [
    { id: 'clean', label: 'Clean', command: 'rm -rf dist', icon: '🧹', scope: 'workspace', target: 'ws-b' },
  ])
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.buttons.map((b) => b.id), ['clean'])

  const stored = JSON.parse(readFileSync(storePath, 'utf8'))
  assert.equal(stored.version, 1)
  assert.deepEqual(stored.buttons.map((b) => b.id), ['clean'])

  assert.deepEqual((await listButtons(routes, 'ses-b1')).buttons.map((b) => b.id),
    ['global-thing', 'ws-any', 'ses-any', 'clean'])
  assert.deepEqual((await listButtons(routes, 'ses-a1')).buttons.map((b) => b.id),
    ['global-thing', 'ws-a-thing', 'ws-any', 'ses-a1-thing', 'ses-any'])
  // config buttons are reported separately so the panel can mark them read-only
  const configView = await getConfig(routes)
  assert.deepEqual(configView.configButtons.map((b) => b.id), ['global-thing', 'ws-a-thing', 'ws-any', 'ses-a1-thing', 'ses-any'])
  assert.equal(configView.storePath, storePath)
})

await test('a fresh apply reloads the store and keeps config ids reserved', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons } })
  const configView = await getConfig(routes)
  assert.deepEqual(configView.buttons.map((b) => b.id), ['clean'])

  const clash = await postConfig(routes, [
    { id: 'clean', label: 'Clean again', command: 'echo' },
    { id: 'global-thing', label: 'Copy of config', command: 'echo' },
  ])
  assert.equal(clash.status, 400, 'config ids stay reserved across restarts')
  assert.equal(clash.body.errors.length, 1)
})

await test('replacing the store drops runs of removed buttons', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons: [] } })
  await postConfig(routes, [{ id: 'temp', label: 'Temp', command: 'echo' }])
  await startRun(routes, 'temp', 'ses-a1')
  assert.equal((await readRun(routes, 'temp', 'ses-a1')).run.status, 'running')

  await postConfig(routes, [])
  assert.equal((await readRun(routes, 'temp', 'ses-a1')).error, 'unknown-button')
  shell.executions[0].finish(0)
  await flush()
})

// ── parameters ─────────────────────────────────────────────────────────────

const paramButton = {
  id: 'greet',
  label: 'Greet',
  command: 'echo Hello {name} in {dir}',
  scope: 'global',
  params: [
    { name: 'name', required: true },
    { name: 'dir', required: false, default: '/tmp' },
  ],
}

await test('a required parameter missing is refused before the shell runs', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons: [paramButton] } })

  const missing = await call(routes, '/quick-actions/run', {
    method: 'POST',
    body: { buttonId: 'greet', sessionId: 'ses-a1' },
  }).then((r) => r)
  assert.equal(missing.status, 400)
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.error, 'missing-param:name')
  assert.equal(shell.executions.length, 0, 'nothing must spawn for a missing required parameter')

  const supplied = await call(routes, '/quick-actions/run', {
    method: 'POST',
    body: { buttonId: 'greet', sessionId: 'ses-a1', params: { name: 'Ada' } },
  }).then((r) => r.body)
  assert.equal(supplied.ok, true)
  assert.equal(shell.executions[0].spec.command, 'echo Hello Ada in /tmp')
  shell.executions[0].finish(0)
  await flush()
})

await test('the run echoes back the parameter values it used', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons: [paramButton] } })
  const started = await call(routes, '/quick-actions/run', {
    method: 'POST',
    body: { buttonId: 'greet', sessionId: 'ses-a1', params: { name: 'Ada', dir: '/opt' } },
  }).then((r) => r.body)
  assert.equal(started.run.params.name, 'Ada')
  assert.equal(started.run.params.dir, '/opt')
  assert.equal(shell.executions[0].spec.command, 'echo Hello Ada in /opt')
  shell.executions[0].finish(0)
  await flush()
})

await test('unknown parameters are ignored and empty values stay literal', async () => {
  const shell = makeShell()
  const { routes } = makeHost({ shell, workspaces, storePath, config: { buttons: [paramButton] } })
  const started = await call(routes, '/quick-actions/run', {
    method: 'POST',
    body: {
      buttonId: 'greet',
      sessionId: 'ses-a1',
      params: { name: 'Ada', dir: '', injected: 'boom', '{x}': 'nope' },
    },
  }).then((r) => r.body)
  assert.equal(started.ok, true)
  assert.equal(started.run.params.injected, undefined, 'a name outside the definition must not join')
  // Empty `dir` falls back to the declared default; `{session}` (a placeholder
  // with no parameter of that name) stays literal.
  assert.equal(shell.executions[0].spec.command, 'echo Hello Ada in /tmp')
  shell.executions[0].finish(0)
  await flush()
})

await test('parameter definitions round-trip through the config store', async () => {
  const { routes } = makeHost({ shell: makeShell(), workspaces, storePath, config: { buttons: [] } })
  const saved = await postConfig(routes, [paramButton])
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.buttons[0].params, [
    { name: 'name', required: true, default: '' },
    { name: 'dir', required: false, default: '/tmp' },
  ])

  const listed = await listButtons(routes, 'ses-a1')
  const view = listed.buttons.find((b) => b.id === 'greet')
  assert.equal(view.params.length, 2)
  assert.equal(view.params[0].name, 'name')
  assert.equal(view.params[0].required, true)
  assert.equal(view.params[1].default, '/tmp')
})

// A host that predates the parameter feature drops `params` on write, which is
// exactly what a stale process looks like from the panel: declare, save,
// reopen, gone. Guard the write path so the symptom always has a failing test.
await test('a declared parameter is still there when the store is read back', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'qa-tr-')), 'buttons.json')
  const first = makeHost({ shell: makeShell(), workspaces, storePath: path, config: { buttons: [] } })

  // The panel writes the definition, then reads the store back on reopen.
  const saved = await postConfig(first.routes, [
    { id: 'shell-run', label: 'run', command: '`{script}`', scope: 'workspace', params: [{ name: 'script', required: true }] },
  ])
  assert.equal(saved.status, 200)

  const reopened = await getConfig(first.routes)
  const button = reopened.buttons.find((b) => b.id === 'shell-run')
  assert.ok(button, 'the button vanished from the store')
  assert.ok(Array.isArray(button.params), 'params were dropped on write')
  assert.equal(button.params.length, 1)
  assert.equal(button.params[0].name, 'script')

  // The on-disk JSON is what a restart replays, so inspect it too.
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(onDisk.buttons[0].params[0].name, 'script', 'the parameter never reached disk')

  // A fresh host reading that same file must still expose the parameter.
  const restarted = makeHost({ shell: makeShell(), workspaces, storePath: path, config: { buttons: [] } })
  const after = await getConfig(restarted.routes)
  assert.equal(after.buttons[0].params[0].name, 'script', 'the parameter did not survive a restart')
})

await test('bad parameter definitions are rejected with field errors', async () => {
  const { routes } = makeHost({ shell: makeShell(), workspaces, storePath, config: { buttons: [] } })

  const badName = await postConfig(routes, [
    { id: 'x', label: 'x', command: 'echo', params: [{ name: '1bad', required: true }] },
  ])
  assert.equal(badName.status, 400)
  assert.match(badName.body.errors[0], /buttons\[0\]\.params\[0\]\.name/)

  const duplicate = await postConfig(routes, [
    { id: 'x', label: 'x', command: 'echo', params: [{ name: 'a' }, { name: 'a' }] },
  ])
  assert.equal(duplicate.status, 400)
  assert.match(duplicate.body.errors[0], /duplicate parameter/)

  const notArray = await postConfig(routes, [
    { id: 'x', label: 'x', command: 'echo', params: 'no' },
  ])
  assert.equal(notArray.status, 400)
  assert.match(notArray.body.errors[0], /params: expected an array/)
})

// ── a session created moments ago ──────────────────────────────────────────

// The registry's `sessionIds` is filtered by the durable header index, so a
// brand-new session belongs to no list yet. Resolving it to an empty workspace
// used to run the command in the wrong directory ("not a git repository") and
// to collide every such session onto one instance key.
await test('a session not yet indexed still resolves its workspace directory', async () => {
  const shell = makeShell()
  const path = join(mkdtempSync(join(tmpdir(), 'qa-new-')), 'buttons.json')
  const { routes } = makeHost({
    shell,
    workspaces,
    storePath: path,
    config: {
      buttons: [{ id: 'status', label: 'Git', command: 'git -C {workspace} status -sb', scope: 'workspace' }],
    },
    // ses-fresh is absent from every workspace.sessionIds above.
    sessionDirs: { 'ses-fresh': '/proj/a/sub' },
  })

  const listed = await listButtons(routes, 'ses-fresh')
  assert.equal(listed.workspaceId, 'ws-a', 'the workspace must be found from the session directory')
  const button = listed.buttons.find((b) => b.id === 'status')
  assert.equal(button.instanceKey, 'w:status:ws-a', 'the instance key must follow the resolved workspace')

  const started = await startRun(routes, 'status', 'ses-fresh')
  assert.equal(started.ok, true)
  assert.equal(shell.executions[0].spec.command, 'git -C /proj/a status -sb', '{workspace} must expand')
  assert.equal(started.run.workdir, '/proj/a', 'the default workdir must be the resolved directory')
  shell.executions[0].finish(0)
  await flush()
})

await test('two ungrouped sessions never share a workspace-scoped instance', async () => {
  const shell = makeShell()
  const path = join(mkdtempSync(join(tmpdir(), 'qa-iso-')), 'buttons.json')
  const { routes } = makeHost({
    shell,
    workspaces,
    storePath: path,
    config: {
      buttons: [{ id: 'status', label: 'Git', command: 'echo {workspace}', scope: 'workspace' }],
    },
    // Neither session is indexed and neither resolves to a workspace.
    sessionDirs: {},
  })

  await startRun(routes, 'status', 'ses-loose-1')
  const first = (await readRun(routes, 'status', 'ses-loose-1')).run
  const otherSession = await readRun(routes, 'status', 'ses-loose-2')
  assert.equal(first.status, 'running')
  assert.equal(otherSession.run, null, 'another ungrouped session must not see this run')

  shell.executions[0].finish(0)
  await flush()
})

// ── store location: the running profile, not the launcher env ──────────────
// A host started from another profile's shell inherits that profile's
// DSH_PROFILE_DIR. Keying the store off it made every button vanish; the
// authoritative answer is the `profileContext` service.

const seed = (path, ids) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ version: 1, buttons: ids.map((id) => ({ id, label: id, command: 'echo hi', scope: 'global' })) }, null, 2)}\n`)
}

// HOME is what `homedir()` reads at call time on POSIX; point it at a temp dir
// so the legacy fallback can be exercised without touching the real ~/.dsh.
async function withHome(home, fn) {
  const before = process.env.HOME
  process.env.HOME = home
  try { return await fn() } finally {
    if (before === undefined) delete process.env.HOME
    else process.env.HOME = before
  }
}

async function withProfileEnv(dir, fn) {
  const before = process.env.DSH_PROFILE_DIR
  if (dir === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = dir
  try { return await fn() } finally {
    if (before === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = before
  }
}

// AC1: the launcher env points at a store full of buttons; the profile does not.
await test('the profile wins over a polluted launcher env', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-profile-'))
  const p1 = join(root, 'p1')
  const p2 = join(root, 'p2')
  mkdirSync(p1, { recursive: true })
  mkdirSync(p2, { recursive: true })
  seed(join(p2, 'dsh-quick-actions.json'), ['from-launcher'])

  await withHome(join(root, 'home'), async () => {
    await withProfileEnv(p2, async () => {
      const host = makeHost({ shell: makeShell(), profileContext: { name: 'web', dir: p1 } })
      const config = await getConfig(host.routes)
      assert.equal(config.storePath, join(p1, 'dsh-quick-actions.json'))
      assert.equal(config.storeSource, 'profile')
      assert.deepEqual(config.buttons, [], 'buttons must not come from the launcher profile')
    })
  })
  rmSync(root, { recursive: true, force: true })
})

// AC1/AC6: the profile's own file is the only one read, even when both exist.
await test('only the profile store is read when both locations exist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-both-'))
  const p1 = join(root, 'p1')
  const p2 = join(root, 'p2')
  mkdirSync(p1, { recursive: true })
  mkdirSync(p2, { recursive: true })
  seed(join(p1, 'dsh-quick-actions.json'), ['mine'])
  seed(join(p2, 'dsh-quick-actions.json'), ['theirs'])

  await withProfileEnv(p2, async () => {
    const host = makeHost({ shell: makeShell(), profileContext: { name: 'web', dir: p1 } })
    const config = await getConfig(host.routes)
    assert.deepEqual(config.buttons.map((b) => b.id), ['mine'])
  })
  rmSync(root, { recursive: true, force: true })
})

// AC2: a host without profileContext keeps the old env behaviour.
await test('a host without profileContext still honours DSH_PROFILE_DIR', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-env-'))
  const p2 = join(root, 'p2')
  mkdirSync(p2, { recursive: true })
  seed(join(p2, 'dsh-quick-actions.json'), ['from-env'])

  await withProfileEnv(p2, async () => {
    const host = makeHost({ shell: makeShell() })
    const config = await getConfig(host.routes)
    assert.equal(config.storePath, join(p2, 'dsh-quick-actions.json'))
    assert.equal(config.storeSource, 'env')
    assert.deepEqual(config.buttons.map((b) => b.id), ['from-env'])
  })
  rmSync(root, { recursive: true, force: true })
})

// AC3: an explicit storePath outranks the profile and the env.
await test('an explicit storePath wins over profile and env', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-explicit-'))
  const p1 = join(root, 'p1')
  const p2 = join(root, 'p2')
  mkdirSync(p1, { recursive: true })
  mkdirSync(p2, { recursive: true })
  seed(join(p1, 'dsh-quick-actions.json'), ['profile-button'])
  seed(join(p2, 'dsh-quick-actions.json'), ['env-button'])
  const explicit = join(root, 'x.json')

  await withProfileEnv(p2, async () => {
    const host = makeHost({ shell: makeShell(), storePath: explicit, profileContext: { name: 'web', dir: p1 } })
    const config = await getConfig(host.routes)
    assert.equal(config.storePath, explicit)
    assert.equal(config.storeSource, 'config')
    assert.deepEqual(config.buttons, [], 'neither profile nor env may be consulted')

    await postConfig(host.routes, [{ id: 'kept', label: 'kept', command: 'echo hi', scope: 'global' }])
    const onDisk = JSON.parse(readFileSync(explicit, 'utf8'))
    assert.equal(onDisk.buttons[0].id, 'kept', 'the write must land on the explicit path')
  })
  rmSync(root, { recursive: true, force: true })
})

// AC4 + AC5: an upgrade shows the legacy data once, then writes to the profile
// file and leaves the legacy file byte-identical.
await test('a fresh profile store shows the legacy file, then writes its own', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-legacy-'))
  const home = join(root, 'home')
  const p1 = join(root, 'p1')
  mkdirSync(p1, { recursive: true })
  const legacy = join(home, '.dsh', 'dsh-quick-actions.json')
  seed(legacy, ['old-a', 'old-b'])
  const legacyBytes = readFileSync(legacy, 'utf8')

  await withHome(home, async () => {
    await withProfileEnv(undefined, async () => {
      const host = makeHost({ shell: makeShell(), profileContext: { name: 'web', dir: p1 } })
      const config = await getConfig(host.routes)
      assert.equal(config.storePath, join(p1, 'dsh-quick-actions.json'), 'the reported path stays the profile one')
      assert.deepEqual(config.buttons.map((b) => b.id), ['old-a', 'old-b'], 'the legacy buttons must be visible')

      await postConfig(host.routes, [{ id: 'new-one', label: 'new', command: 'echo hi', scope: 'global' }])
      const own = join(p1, 'dsh-quick-actions.json')
      assert.ok(existsSync(own), 'the first save must create the profile store')
      assert.equal(JSON.parse(readFileSync(own, 'utf8')).buttons[0].id, 'new-one')
      assert.equal(readFileSync(legacy, 'utf8'), legacyBytes, 'the legacy file must not be touched')
    })
  })
  rmSync(root, { recursive: true, force: true })
})

// AC6: once the profile store exists the legacy file is never consulted.
await test('an existing profile store is never merged with the legacy one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-idem-'))
  const home = join(root, 'home')
  const p1 = join(root, 'p1')
  mkdirSync(p1, { recursive: true })
  seed(join(p1, 'dsh-quick-actions.json'), ['only-mine'])
  seed(join(home, '.dsh', 'dsh-quick-actions.json'), ['legacy-one', 'legacy-two'])

  await withHome(home, async () => {
    await withProfileEnv(undefined, async () => {
      const host = makeHost({ shell: makeShell(), profileContext: { name: 'web', dir: p1 } })
      const config = await getConfig(host.routes)
      assert.deepEqual(config.buttons.map((b) => b.id), ['only-mine'], 'legacy must not be merged in')
    })
  })
  rmSync(root, { recursive: true, force: true })
})

// ── editing the store path from the panel ──────────────────────────────────

const waitTick = () => new Promise((resolve) => { setTimeout(resolve, 10) })

await test('the panel override moves the live store without a restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-panel-'))
  const p1 = join(root, 'p1')
  mkdirSync(p1, { recursive: true })
  seed(join(p1, 'dsh-quick-actions.json'), ['profile-button'])
  const custom = join(root, 'custom.json')

  const host = makeHost({ shell: makeShell(), profileContext: { name: 'web', dir: p1 } })
  let config = await getConfig(host.routes)
  assert.equal(config.storeSource, 'profile')
  assert.deepEqual(config.store.candidates.map((c) => c.source), ['config', 'panel', 'profile', 'env', 'home'])
  assert.equal(config.store.candidates.find((c) => c.active).source, 'profile')
  assert.equal(config.store.pinnedBy, '', 'nothing pins the path here')

  const answer = await call(host.routes, '/quick-actions/store', { method: 'POST', body: { storePath: custom } })
  assert.equal(answer.status, 200)
  // Rebinding is in-process: the same response already reports the new state.
  assert.equal(answer.body.storePath, custom)
  assert.equal(answer.body.storeSource, 'panel')
  assert.equal(answer.body.store.candidates[1].active, true, 'the panel row must now be the winner')
  assert.equal(answer.body.store.exists, false, 'the target file does not exist yet')

  const settings = JSON.parse(readFileSync(join(p1, 'dsh-quick-actions.settings.json'), 'utf8'))
  assert.equal(settings.storePath, custom, 'the override was not persisted next to the profile')

  // A later save lands on the chosen path, not the profile default.
  await postConfig(host.routes, [{ id: 'moved', label: 'moved', command: 'echo hi', scope: 'global' }])
  assert.equal(JSON.parse(readFileSync(custom, 'utf8')).buttons[0].id, 'moved')
  assert.deepEqual(
    JSON.parse(readFileSync(join(p1, 'dsh-quick-actions.json'), 'utf8')).buttons.map((b) => b.id),
    ['profile-button'],
    'the previous store must stay untouched',
  )

  config = await getConfig(host.routes)
  assert.equal(config.storePath, custom)
  rmSync(root, { recursive: true, force: true })
})

await test('clearing the override returns to the profile store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-panel-clear-'))
  const p1 = join(root, 'p1')
  mkdirSync(p1, { recursive: true })
  seed(join(p1, 'dsh-quick-actions.json'), ['back-home'])
  const settingsPath = join(p1, 'dsh-quick-actions.settings.json')
  const custom = join(root, 'custom.json')

  const host = makeHost({ shell: makeShell(), profileContext: { name: 'web', dir: p1 } })
  await call(host.routes, '/quick-actions/store', { method: 'POST', body: { storePath: custom } })
  assert.ok(existsSync(settingsPath), 'the override file should exist after pinning')

  const answer = await call(host.routes, '/quick-actions/store', { method: 'POST', body: { storePath: '   ' } })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.storeSource, 'profile')
  assert.equal(answer.body.storePath, join(p1, 'dsh-quick-actions.json'))
  assert.deepEqual(answer.body.buttons.map((b) => b.id), ['back-home'], 'the profile buttons must be back')
  assert.ok(!existsSync(settingsPath), 'an empty override must remove the file, not store "" ')
  rmSync(root, { recursive: true, force: true })
})

await test('a path pinned by cordis.patch.yml cannot be overridden from the panel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-panel-pinned-'))
  const p1 = join(root, 'p1')
  mkdirSync(p1, { recursive: true })
  const pinned = join(root, 'pinned.json')

  const host = makeHost({
    shell: makeShell(),
    profileContext: { name: 'web', dir: p1 },
    config: { storePath: pinned },
  })
  const config = await getConfig(host.routes)
  assert.equal(config.store.pinnedBy, 'config', 'the panel must know it is pinned')

  const answer = await call(host.routes, '/quick-actions/store', { method: 'POST', body: { storePath: join(root, 'other.json') } })
  assert.equal(answer.status, 409)
  assert.equal(answer.body.error, 'pinned-by-config')
  assert.ok(!existsSync(join(p1, 'dsh-quick-actions.settings.json')), 'nothing may be written')
  rmSync(root, { recursive: true, force: true })
})

await test('a path that would break the settings document is rejected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-panel-bad-'))
  const p1 = join(root, 'p1')
  mkdirSync(p1, { recursive: true })
  const host = makeHost({ shell: makeShell(), profileContext: { name: 'web', dir: p1 } })

  for (const bad of ['/tmp/a\nstorePath: /evil', '/tmp/a\tb']) {
    const answer = await call(host.routes, '/quick-actions/store', { method: 'POST', body: { storePath: bad } })
    assert.equal(answer.status, 400, `accepted a dangerous path: ${JSON.stringify(bad)}`)
    assert.equal(answer.body.error, 'bad-path')
  }
  assert.ok(!existsSync(join(p1, 'dsh-quick-actions.settings.json')))
  rmSync(root, { recursive: true, force: true })
})

// leave the temp store behind for OS cleanup
rmSync(join(storePath, '..'), { recursive: true, force: true })

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`)
process.exit(failures.length > 0 ? 1 : 0)
