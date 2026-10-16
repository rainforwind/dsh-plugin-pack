// Host half of Session Manager.
//
// DSH stores each session as an append-only log under the JSONL persistence
// root and — by design — ships no deletion API: "Nothing deletes session
// files" (@deepseek-ai/dsh-session-persistence-jsonl README). This plugin adds
// the one destructive operation the archived-session surface lacks:
// permanently deleting an archived session.
//
// Safety boundary (shared by the HTTP route and the agent tool):
//   * the session must exist in session persistence,
//   * it must be archived (the registry-global archive set is the guard; a
//     normal session is never deleted, only a hidden one the user archived),
//   * it must not be resident in this process (no Session object, no Agent)
//     and have no active work; both are settled first through
//     `workspace/session-stop` with a grace period, because the session list
//     merges disk with resident instances — a fileless resident Session would
//     resurrect as a ghost row,
//   * the target directory must resolve inside the persistence root.
//
// Deletion order: unarchive first (durable, reversible), then remove the
// session-owned directory, then detach the workspace record's membership
// (durable `sessionIds` slot) so the row cannot be rebuilt, then tell the
// Client list feed to drop the cached summary by emitting
// `api-session/removed` — the same event the Session Controller emits when a
// live Session is disposed.
//
// Path derivation mirrors @deepseek-ai/dsh-session-persistence-jsonl
// `projectKey`/`encodeSegment` exactly:
//   <root>/--<normalized-cwd>--/<encoded-id>/   (or <root>/_no-cwd/<id>/)

import { readdir, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const NAME = 'dsh-session-manager'

/** Escape one path segment exactly like the JSONL persistence backend. */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** Build the readable project-directory key exactly like the JSONL backend. */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** The directory the JSONL backend owns for one session. */
function sessionDir(root, cwd, id) {
  const project = cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd))
  return join(project, encodeSegment(id))
}

/**
 * Remove residue for a ghost session whose header is gone: every
 * `<root>/<project>/<encoded-id>` (plus the raw-id and `_no-cwd` variants).
 * The sweep only descends one level below the persistence root, never follows
 * directory symlinks, and re-checks containment per candidate. `root` must be
 * a resolved absolute path.
 */
async function sweepGhostResidue(root, sessionId) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
  const names = new Set([encodeSegment(sessionId), sessionId])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const name of names) {
      const candidate = resolve(join(root, entry.name, name))
      if (candidate === root || !candidate.startsWith(root + sep)) continue
      await rm(candidate, { recursive: true, force: true })
    }
  }
}

function isValidSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * Whether the session is resident in this process (a Session object or Agent
 * holds it). The session list merges disk with resident instances, so a
 * fileless resident session resurrects as a ghost row after deletion.
 */
function sessionIsResident(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  return !!((sessions && sessions.get(sessionId)) || (agents && agents.get(sessionId)))
}

/**
 * Whether a session currently has active work, through the same
 * `workspace/session-activity` waterfall the archive flow consults.
 */
function activeActivity(ctx, sessionId) {
  return ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
}

/**
 * Ask every `workspace/session-stop` provider to cancel the session's work —
 * the same idempotent stop the archive flow issues. Failing providers are
 * logged, never a reason to keep the session visible (mirrors dsh-workspace).
 */
async function stopSessionActivity(ctx, sessionId) {
  try {
    await ctx.parallel('workspace/session-stop', { sessionId })
  } catch (error) {
    const failures = error instanceof AggregateError ? error.errors : [error]
    for (const failure of failures) {
      ctx.logger && ctx.logger.warn(`${NAME}: stopping session '${sessionId}' for delete failed: ${String(failure)}`)
    }
  }
}

/**
 * The shared deletion core. Never throws for expected refusals: it answers
 * `{ ok: false, code, message }` so the HTTP route and the agent tool report
 * the same outcomes.
 * @param ctx - the plugin's Cordis context.
 * @param sessionId - the session to delete.
 * @returns the deletion outcome.
 */
async function deleteArchivedSession(ctx, sessionId, options = {}) {
  if (!isValidSessionId(sessionId)) {
    return { ok: false, code: 'invalid-id', message: 'sessionId must be a non-empty string' }
  }
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.stat !== 'function') {
    return { ok: false, code: 'no-backend', message: 'session persistence is unavailable' }
  }
  const root = typeof persistence.root === 'string' && persistence.root.length > 0 ? persistence.root : undefined
  if (root === undefined) {
    return {
      ok: false,
      code: 'no-backend',
      message: 'the session persistence backend does not expose its root directory; deletion is unsupported in this composition',
    }
  }
  const registry = ctx.get('workspaceRegistry')
  if (!registry || !Array.isArray(registry.archivedSessionIds)) {
    return { ok: false, code: 'no-registry', message: 'the workspace registry is unavailable; the archived guard cannot be checked' }
  }
  // The archived guard runs BEFORE existence: a ghost — an archived entry
  // whose files are long gone — is exactly the residue that must stay
  // deletable, and it clears through the same unarchive → detach → removed
  // path with a headerless filesystem sweep.
  if (!registry.archivedSessionIds.includes(sessionId)) {
    return {
      ok: false,
      code: 'not-archived',
      message: `session '${sessionId}' is not archived; only archived sessions can be deleted`,
    }
  }
  const snapshot = await persistence.stat(sessionId)
  const resolvedRoot = resolve(root)
  let dir
  if (snapshot) {
    try {
      dir = resolve(sessionDir(root, snapshot.header && snapshot.header.cwd, sessionId))
    } catch (error) {
      return { ok: false, code: 'io', message: `cannot derive the session directory: ${String(error && error.message || error)}` }
    }
    if (dir === resolvedRoot || !dir.startsWith(resolvedRoot + sep)) {
      return { ok: false, code: 'io', message: 'refusing to delete a path outside the session persistence root' }
    }
  }
  // Settle residency and active work first, the way the archive flow stops
  // activity: the session list merges disk with resident instances, so
  // deleting files under a still-resident Session would leave a ghost row that
  // reappears from memory. Stop providers release the job/schedule/subagent
  // carriers that often keep an archived session resident; a viewing tab's
  // carrier only releases when that view closes.
  //
  // options.force is the escape hatch for a resident-but-idle session whose
  // carrier never released (the registries expose no per-id release API). It
  // bypasses ONLY residency, never running work: activity > 0 refuses even
  // with force. A forced delete leaves the in-memory instance alive until
  // restart; the detached membership + `api-session/removed` keep the row out
  // of the lists meanwhile.
  let forced = false
  try {
    const initialActivity = await activeActivity(ctx, sessionId)
    if (!Array.isArray(initialActivity)) throw new Error('workspace/session-activity returned a non-array result')
    let activity = initialActivity.length
    let resident = sessionIsResident(ctx, sessionId)
    if (activity > 0 || resident) {
      await stopSessionActivity(ctx, sessionId)
      const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 8000
      const deadline = Date.now() + graceMs
      while ((activity > 0 || resident) && Date.now() < deadline) {
        await sleep(250)
        const next = await activeActivity(ctx, sessionId)
        if (!Array.isArray(next)) throw new Error('workspace/session-activity returned a non-array result')
        activity = next.length
        resident = sessionIsResident(ctx, sessionId)
      }
      if (activity > 0) {
        return {
          ok: false,
          code: 'live',
          message: `session '${sessionId}' is still running active work that did not stop; try again once it settles`,
        }
      }
      if (resident) {
        if (options.force !== true) {
          const parent = snapshot && snapshot.header && snapshot.header.parentSession
          return {
            ok: false,
            code: 'resident',
            message: parent
              ? `session '${sessionId}' is a delegated child of '${parent}' and is still held in this process; stop that delegation (team/subagent) and retry — or force the delete`
              : `session '${sessionId}' is still resident in this process (its view or work has not released it); close it and try again — or force the delete`,
          }
        }
        forced = true
        ctx.logger && ctx.logger.warn(`${NAME}: force-deleting resident idle session '${sessionId}'; its in-memory instance stays until restart`)
      }
    }
  } catch (error) {
    return { ok: false, code: 'registry', message: `the session activity check failed: ${String(error && error.message || error)}` }
  }
  // Unarchive first: it is durable and reversible, so a later filesystem
  // failure leaves the session visible again instead of half-deleted.
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    return { ok: false, code: 'registry', message: `cannot unarchive the session: ${String(error && error.message || error)}` }
  }
  try {
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    } else {
      await sweepGhostResidue(resolvedRoot, sessionId)
    }
  } catch (error) {
    return { ok: false, code: 'io', message: `cannot remove the session directory: ${String(error && error.message || error)}` }
  }
  // Re-read the archived set after the filesystem step: concurrent archive
  // mutations can lose an update, and a resurrection here is exactly how
  // deleted sessions came back as ghosts. Self-heal once, best-effort.
  try {
    if (registry.archivedSessionIds.includes(sessionId)) await registry.unarchiveSession(sessionId)
  } catch (error) {
    ctx.logger && ctx.logger.warn(`${NAME}: re-unarchive for '${sessionId}' failed: ${String(error && error.message || error)}`)
  }
  // Drop the durable workspace membership next: the workspace record keeps a
  // `sessionIds` slot per session, and a stale slot plus any later summary
  // source can rebuild the row. Resolve by the session's cwd first (a session
  // belongs to at most one workspace — attach validates cwd equality), then
  // scan the registry entities as a fallback for a vanished cwd. Both paths
  // are idempotent (detachSession filters) and best-effort: the read-time path
  // filter self-heals the record on the next header index.
  try {
    const candidates = []
    const cwd = snapshot && snapshot.header && snapshot.header.cwd
    if (typeof cwd === 'string' && cwd.length > 0 && typeof registry.resolveByPath === 'function') {
      try {
        // resolveByPath canonicalizes internally and rejects on a missing path.
        const workspace = await registry.resolveByPath(cwd)
        if (workspace) candidates.push(workspace)
      } catch (error) { /* cwd gone — the scan below still covers membership */ }
    }
    const entities = registry.entities
    if (entities && typeof entities.values === 'function') {
      for (const entity of entities.values()) if (!candidates.includes(entity)) candidates.push(entity)
    }
    for (const workspace of candidates) {
      if (!workspace || typeof workspace.detachSession !== 'function') continue
      await workspace.detachSession(sessionId)
    }
  } catch (error) {
    ctx.logger && ctx.logger.warn(`${NAME}: workspace detach for '${sessionId}' failed: ${String(error && error.message || error)}`)
  }
  // Drop the Client's cached summary; the workspace follow stream carries the
  // archive-set change on its own.
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch (error) {
    ctx.logger && ctx.logger.warn(`${NAME}: api-session/removed emission failed`)
  }
  ctx.logger && ctx.logger.info(`${NAME}: deleted archived session '${sessionId}'${snapshot ? '' : ' (ghost residue)'}${forced ? ' (forced)' : ''}`)
  return { ok: true, sessionId, ghost: !snapshot, forced }
}

/**
 * Describe one session for the row menu: existence, archived, and whether it
 * is resident or running work — the same liveness semantics the deletion core
 * enforces before touching anything.
 * @param ctx - the plugin's Cordis context.
 * @param sessionId - the session to describe.
 * @returns {Promise<{ exists: boolean, archived: boolean, live: boolean }>}
 */
async function describeSession(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  const persistence = ctx.get('sessionPersistence')
  let exists = false
  let header
  try {
    const snapshot = persistence && typeof persistence.stat === 'function' ? await persistence.stat(sessionId) : null
    if (snapshot) {
      exists = true
      header = snapshot.header
    }
  } catch (error) {
    exists = false
  }
  // Split the residency sources so a refused delete is diagnosable: which map
  // holds the instance (a view/carrier or an agent), how much active work
  // there is, and whether the session is a delegated child (the delegation
  // graph — subagent/team — is what usually keeps such a child resident).
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const residentSessions = !!(sessions && sessions.get(sessionId))
  const residentAgents = !!(agents && agents.get(sessionId))
  let activity = 0
  let activityUnknown = false
  try {
    const list = await activeActivity(ctx, sessionId)
    if (Array.isArray(list)) activity = list.length
    else activityUnknown = true
  } catch (error) {
    activityUnknown = true
  }
  const live = residentSessions || residentAgents || activityUnknown || activity > 0
  return {
    exists,
    archived: !!(registry && Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(sessionId)),
    live,
    resident: { sessions: residentSessions, agents: residentAgents },
    activity,
    activityUnknown,
    parentSession: (header && header.parentSession) || undefined,
    isSeeded: !!(header && header.isSeeded),
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(body)
}

function readJsonBody(request, limit = 64 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectPromise(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) { resolvePromise({}); return }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        rejectPromise(new Error('request body is not valid JSON'))
      }
    })
    request.on('error', (error) => rejectPromise(error))
  })
}

// CSRF posture for the mutating route: require a JSON request body. A
// cross-site page cannot send `Content-Type: application/json` without a CORS
// preflight this server never answers, and a form-based cross-site POST would
// arrive form-encoded and be refused here. Comparing the browser's Origin to
// the Host header would instead break every legitimate reverse proxy (the
// shipped dsh-lan-proxy rewrites Host to the loopback authority), so it is
// deliberately not used. The GET route has no side effects and needs no guard.
function jsonOnlyRejected(request) {
  const contentType = request.headers && request.headers['content-type']
  return typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')
}

const STATUS_BY_CODE = {
  'invalid-id': 400,
  'not-found': 404,
  'not-archived': 409,
  'live': 409,
  'resident': 409,
  'no-backend': 503,
  'no-registry': 503,
  'registry': 500,
  'io': 500,
}

export const inject = ['webServer']
// Exported for offline verification of the shared core (the HTTP route and
// the agent tool both call it through apply's closure).
export { deleteArchivedSession, describeSession, sessionDir }

export function apply(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      ctx.logger && ctx.logger.warn(`${NAME}: webServer.register unavailable; no HTTP routes`)
      return
    }
    const route = (path, handler) => hostCtx.effect(() => webServer.register({ kind: 'exact', path, handler }), `${NAME}: route ${path}`)

    // GET /dsh-session-manager/state?sessionId=… — the row menu asks whether
    // the Delete entry applies before rendering it.
    route('/dsh-session-manager/state', (request, response) => {
      if (request.method === 'OPTIONS') { sendJson(response, 204, {}); return }
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
      let sessionId
      try {
        sessionId = new URL(request.url || '/', 'http://127.0.0.1').searchParams.get('sessionId') || ''
      } catch (error) {
        sessionId = ''
      }
      if (!isValidSessionId(sessionId)) {
        sendJson(response, 400, { ok: false, error: 'invalid-id', message: 'sessionId query parameter is required' })
        return
      }
      // Existence and the residency split come from the shared describer.
      void (async () => {
        const state = await describeSession(ctx, sessionId)
        sendJson(response, 200, { ok: true, state })
      })()
    })

    // POST /dsh-session-manager/delete — body { sessionId }. Same core as the
    // session_delete agent tool.
    route('/dsh-session-manager/delete', async (request, response) => {
      if (request.method === 'OPTIONS') { sendJson(response, 204, {}); return }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
      if (jsonOnlyRejected(request)) {
        sendJson(response, 415, { ok: false, error: 'unsupported-media-type', message: 'a JSON request body is required' })
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: 'bad-request', message: String(error && error.message || error) })
        return
      }
      // The UI may send force after a 'resident' refusal; the core enforces
      // that force never bypasses running work. The agent tool never forces.
      const result = await deleteArchivedSession(ctx, body && body.sessionId, { force: body && body.force === true })
      if (result.ok) {
        sendJson(response, 200, { ok: true, sessionId: result.sessionId, ghost: result.ghost === true, forced: result.forced === true })
        return
      }
      sendJson(response, STATUS_BY_CODE[result.code] || 500, { ok: false, error: result.code, message: result.message })
    })
  })

  // The agent-facing half: one operation, the same core. Only archived, idle
  // sessions are deletable, so the tool cannot touch working history.
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.get('tools')
    if (!tools || typeof tools.register !== 'function') return
    toolCtx.effect(() => tools.register({
      name: 'session_delete',
      description:
        'Permanently delete an archived session and its durable log. '
        + 'Only an archived session that is not running can be deleted; the Host refuses any other session. '
        + 'The deletion is irreversible — it removes the session log from disk. '
        + 'Use session_search/session listing first to find archived session ids.',
      parameters: {
        sessionId: {
          type: 'string',
          required: true,
          description: 'The id of the archived session to delete permanently.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true, description: 'Always true; failures throw instead.' },
            sessionId: { type: 'string', required: true, description: 'The deleted session id.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Deleted archived session ${value.sessionId}.` }],
      },
      async execute(args) {
        const result = await deleteArchivedSession(ctx, args.sessionId)
        if (!result.ok) throw new Error(result.message)
        return { ok: true, sessionId: result.sessionId }
      },
    }), `${NAME}: session_delete tool`)
  })
}
