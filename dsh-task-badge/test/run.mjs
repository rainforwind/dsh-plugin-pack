// Standalone test for the dsh-task-badge host half.
// Run with: node test/run.mjs
// Exercises the HTTP routes against a stubbed cordis context and a stubbed job
// registry: session read/unread bookkeeping, subagent exclusion, running and
// unviewed background-job counts, and the mark-viewed contract.

import assert from 'node:assert/strict'
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

// ── stubs ──────────────────────────────────────────────────────────────────

function makeHost({ jobs } = {}) {
  const listeners = new Map()
  const routes = new Map()
  // Mirror the real webServer contract: register returns a disposer, and
  // registering the same (kind, path) twice throws (dsh-host-webserver).
  const webServer = {
    register: (route) => {
      const key = `${route.kind}:${route.path}`
      if (routes.has(key)) throw new Error(`duplicate route ${key}`)
      routes.set(key, route)
      return () => routes.delete(key)
    },
  }

  const effects = []
  const ctx = {
    get(name) {
      if (name === 'jobs') return jobs
      if (name === 'webServer') return webServer
      return undefined
    },
    on(name, fn, options) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push({ fn, options })
    },
    inject(names, cb) { cb(ctx) },
    effect(fn) {
      const dispose = fn()
      const entry = { dispose }
      effects.push(entry)
      return () => {
        if (entry.dispose) { entry.dispose(); entry.dispose = null }
      }
    },
    emit(name, ...args) {
      for (const l of listeners.get(name) || []) l.fn(...args)
    },
  }

  // The plugin narrates on every apply; keep the test output readable.
  const quiet = console.log
  console.log = () => {}
  try { apply(ctx) } finally { console.log = quiet }
  // Runs every effect disposer, i.e. what cordis does when the plugin is disabled.
  const dispose = () => { for (const e of effects.splice(0)) e.dispose?.() }
  return { ctx, routes, dispose }
}

async function counts(routes) {
  const route = routes.get('exact:/task-badge/counts')
  const out = {}
  await new Promise((resolve) => route.handler({ method: 'GET' }, {
    writeHead(status) { out.status = status },
    end(body) { out.body = JSON.parse(body); resolve() },
  }))
  return out.body
}

async function markViewed(routes, sessionId) {
  const route = routes.get('exact:/task-badge/mark-viewed')
  const chunks = [JSON.stringify({ sessionId })]
  let status
  await new Promise((resolve) => route.handler({
    method: 'POST',
    on(event, cb) {
      if (event === 'data') cb(chunks.shift())
      if (event === 'end') cb()
    },
  }, { writeHead(s) { status = s }, end() { resolve() } }))
  return status
}

// The registry's real seam is `events.subscribe(filter, listener)`.
function makeJobs() {
  let listener = null
  let filter = null
  return {
    events: {
      subscribe(f, fn) { filter = f; listener = fn; return () => {} },
    },
    fire(event) { if (listener) listener(event) },
    get filter() { return filter },
  }
}

// ── sessions ───────────────────────────────────────────────────────────────

await test('a session that finishes is unread; opening it clears that', async () => {
  const { ctx, routes } = makeHost({ jobs: makeJobs() })

  ctx.emit('api-session/status', 'ses-1', true)
  ctx.emit('api-session/status', 'ses-1', false)
  assert.deepEqual(await counts(routes), {
    running: 0, unreadSessionIds: ['ses-1'], unviewedJobs: 0, unviewedJobSessionIds: [],
  })

  await markViewed(routes, 'ses-1')
  assert.deepEqual(await counts(routes).then((c) => c.unreadSessionIds), [])
})

await test('a running session counts as running', async () => {
  const { ctx, routes } = makeHost({ jobs: makeJobs() })
  ctx.emit('api-session/status', 'ses-1', true)
  assert.equal((await counts(routes)).running, 1)
})

await test('output arriving after you read a session makes it unread again', async () => {
  const { ctx, routes } = makeHost({ jobs: makeJobs() })
  ctx.emit('api-session/status', 'ses-1', false)
  await markViewed(routes, 'ses-1')
  assert.deepEqual(await counts(routes).then((c) => c.unreadSessionIds), [])

  ctx.emit('api-session/activity', 'ses-1')
  await markViewed(routes, 'ses-2')   // the reader moved on elsewhere
  assert.deepEqual(await counts(routes).then((c) => c.unreadSessionIds), ['ses-1'])
})

await test('a null sessionId is accepted and releases the remembered session', async () => {
  const { ctx, routes } = makeHost({ jobs: makeJobs() })
  ctx.emit('api-session/status', 'ses-1', false)
  await markViewed(routes, 'ses-1')
  assert.equal(await markViewed(routes, null), 200)
  assert.deepEqual(await counts(routes).then((c) => c.unreadSessionIds), [])
})

// ── subagent exclusion ─────────────────────────────────────────────────────

await test('the subagent payload is read from `id`, so children never count', async () => {
  const { ctx, routes } = makeHost({ jobs: makeJobs() })
  ctx.emit('subagent/start', { runId: 'r1', provider: 'x', id: 'child-1', local: false })
  ctx.emit('api-session/status', 'child-1', true)
  ctx.emit('api-session/status', 'child-1', false)
  ctx.emit('api-session/activity', 'child-1')

  const out = await counts(routes)
  assert.deepEqual(out.unreadSessionIds, [], 'child leaked into unread')
  assert.equal(out.running, 0, 'child leaked into running')
})

await test('a child discovered after its events had already landed is purged', async () => {
  const { ctx, routes } = makeHost({ jobs: makeJobs() })
  ctx.emit('api-session/status', 'child-2', true)
  ctx.emit('api-session/status', 'child-2', false)
  ctx.emit('subagent/start', { id: 'child-2' })

  assert.deepEqual(await counts(routes), {
    running: 0, unreadSessionIds: [], unviewedJobs: 0, unviewedJobSessionIds: [],
  })
})

// ── background jobs ────────────────────────────────────────────────────────

await test('subscribes through the registry\'s real events seam', async () => {
  const jobs = makeJobs()
  makeHost({ jobs })
  assert.deepEqual(jobs.filter, { owners: 'all' })
})

await test('a running job counts as running, and stops when it settles', async () => {
  const jobs = makeJobs()
  const { routes } = makeHost({ jobs })

  jobs.fire({ type: 'registered', job: { id: 'bash-1', status: 'running', owner: 'ses-A', startedAt: 1 } })
  assert.equal((await counts(routes)).running, 1)

  jobs.fire({ type: 'settled', job: { id: 'bash-1', status: 'completed', owner: 'ses-A', startedAt: 1, finishedAt: 2 } })
  assert.equal((await counts(routes)).running, 0)
})

await test('a completed job elsewhere is unread, and offers its session to jump to', async () => {
  const jobs = makeJobs()
  const { routes } = makeHost({ jobs })
  jobs.fire({ type: 'settled', job: { id: 'bash-1', status: 'completed', owner: 'ses-A', startedAt: 1, finishedAt: 2 } })

  const out = await counts(routes)
  assert.equal(out.unviewedJobs, 1)
  assert.deepEqual(out.unviewedJobSessionIds, ['ses-A'])
})

await test('opening the owning session reads its jobs', async () => {
  const jobs = makeJobs()
  const { routes } = makeHost({ jobs })
  jobs.fire({ type: 'settled', job: { id: 'bash-1', status: 'completed', owner: 'ses-A', startedAt: 1, finishedAt: 2 } })
  await markViewed(routes, 'ses-A')

  assert.deepEqual(await counts(routes), {
    running: 0, unreadSessionIds: [], unviewedJobs: 0, unviewedJobSessionIds: [],
  })
})

await test('a job finishing in the session already on screen stays invisible', async () => {
  const jobs = makeJobs()
  const { routes } = makeHost({ jobs })
  await markViewed(routes, 'ses-A')
  jobs.fire({ type: 'settled', job: { id: 'bash-2', status: 'completed', owner: 'ses-A', startedAt: 1, finishedAt: 2 } })
  assert.equal((await counts(routes)).unviewedJobs, 0)
})

await test('several finished jobs in one session count once', async () => {
  const jobs = makeJobs()
  const { routes } = makeHost({ jobs })
  jobs.fire({ type: 'settled', job: { id: 'bash-7', status: 'completed', owner: 'ses-A', startedAt: 1, finishedAt: 2 } })
  jobs.fire({ type: 'settled', job: { id: 'bash-8', status: 'completed', owner: 'ses-A', startedAt: 1, finishedAt: 3 } })

  const out = await counts(routes)
  assert.equal(out.unviewedJobs, 1, 'two jobs in one session are one thing to look at')
  assert.deepEqual(out.unviewedJobSessionIds, ['ses-A'])
})

await test("a session's finished job never doubles its own unread badge", async () => {
  const jobs = makeJobs()
  const { ctx, routes } = makeHost({ jobs })
  ctx.emit('api-session/status', 'ses-A', true)
  ctx.emit('api-session/status', 'ses-A', false)   // ses-A is now unread
  jobs.fire({ type: 'settled', job: { id: 'bash-9', status: 'completed', owner: 'ses-A', startedAt: 1, finishedAt: 2 } })

  const out = await counts(routes)
  assert.deepEqual(out.unreadSessionIds, ['ses-A'])
  assert.equal(out.unviewedJobs, 0, 'the unread badge already covers this session')
  assert.deepEqual(out.unviewedJobSessionIds, [])
})

await test('an unread session and a job in another session stay two counts', async () => {
  const jobs = makeJobs()
  const { ctx, routes } = makeHost({ jobs })
  ctx.emit('api-session/status', 'ses-A', false)
  jobs.fire({ type: 'settled', job: { id: 'bash-10', status: 'completed', owner: 'ses-B', startedAt: 1, finishedAt: 2 } })

  const out = await counts(routes)
  assert.deepEqual(out.unreadSessionIds, ['ses-A'])
  assert.equal(out.unviewedJobs, 1)
  assert.deepEqual(out.unviewedJobSessionIds, ['ses-B'])
})

await test('a job being stopped still counts as running until it settles', async () => {
  const jobs = makeJobs()
  const { routes } = makeHost({ jobs })

  jobs.fire({ type: 'registered', job: { id: 'bash-6', status: 'running', owner: 'ses-B', startedAt: 1 } })
  jobs.fire({ type: 'stopping', job: { id: 'bash-6', status: 'stopping', owner: 'ses-B', startedAt: 1 } })
  assert.equal((await counts(routes)).running, 1)

  jobs.fire({ type: 'settled', job: { id: 'bash-6', status: 'killed', owner: 'ses-B', startedAt: 1, finishedAt: 2 } })
  assert.equal((await counts(routes)).running, 0)
  assert.equal((await counts(routes)).unviewedJobs, 0, 'a killed job is not a completed one')
})

await test('an unowned completed job is not a badge that can never be cleared', async () => {
  const jobs = makeJobs()
  const { routes } = makeHost({ jobs })

  jobs.fire({ type: 'registered', job: { id: 'bash-3', status: 'running', startedAt: 1 } })
  assert.equal((await counts(routes)).running, 1, 'unowned running work should still count')

  jobs.fire({ type: 'settled', job: { id: 'bash-3', status: 'completed', startedAt: 1, finishedAt: 2 } })
  assert.equal((await counts(routes)).unviewedJobs, 0)
})

await test('removed and output events are handled safely', async () => {
  const jobs = makeJobs()
  const { routes } = makeHost({ jobs })

  jobs.fire({ type: 'registered', job: { id: 'bash-4', status: 'running', owner: 'ses-B', startedAt: 1 } })
  jobs.fire({ type: 'removed', job: { id: 'bash-4', status: 'completed', owner: 'ses-B' } })
  assert.equal((await counts(routes)).running, 0)

  jobs.fire({ type: 'output', id: 'bash-4', total: 10 })   // carries no `job`
  assert.equal((await counts(routes)).unviewedJobs, 0)
})

await test('jobs owned by a subagent are not the user\'s counts', async () => {
  const jobs = makeJobs()
  const { ctx, routes } = makeHost({ jobs })
  ctx.emit('subagent/start', { id: 'child-9' })
  jobs.fire({ type: 'registered', job: { id: 'bash-5', status: 'running', owner: 'child-9', startedAt: 1 } })
  assert.equal((await counts(routes)).running, 0)
})

// ── state (diagnosis) route ────────────────────────────────────────────────

await test('state route names the sessions and jobs behind `running`', async () => {
  const jobs = makeJobs()
  const { ctx, routes } = makeHost({ jobs })
  ctx.emit('api-session/status', 'ses-A', true)
  ctx.emit('api-session/status', 'ses-B', true)
  ctx.emit('subagent/start', { id: 'child-1' })
  ctx.emit('api-session/status', 'child-1', true) // learned late, still purged
  jobs.fire({ type: 'registered', job: { id: 'bash-9', status: 'running', owner: 'ses-B', startedAt: 1 } })

  const route = routes.get('exact:/task-badge/state')
  const out = {}
  await new Promise((resolve) => route.handler({ method: 'GET' }, {
    writeHead(status) { out.status = status },
    end(body) { out.body = JSON.parse(body); resolve() },
  }))

  assert.equal(out.status, 200)
  assert.deepEqual(out.body.runningSessions.sort(), ['ses-A', 'ses-B'], 'subagent child excluded from the named list')
  assert.deepEqual(out.body.subagentSessions, ['child-1'])
  assert.deepEqual(out.body.runningJobs, [{ id: 'bash-9', owner: 'ses-B', status: 'running' }])
  assert.equal(
    out.body.runningSessions.length + out.body.runningJobs.length,
    (await counts(routes)).running,
    'named parts must add up to the badge number'
  )
})

// ── lifecycle: routes must not outlive the plugin ──────────────────────────

await test('disable unregisters every route, so re-enable cannot hit duplicates', () => {
  const quiet = console.log
  const host = makeHost({ jobs: makeJobs() })
  assert.equal(host.routes.size, 3, 'counts, state, mark-viewed registered')
  host.dispose()
  assert.equal(host.routes.size, 0, 'all routes released on disable')
  // Re-enable = apply again on the same webServer. The stub throws on
  // duplicate (kind, path), mirroring dsh-host-webserver: without effect-
  // wrapped registration this second apply would blow up.
  console.log = () => {}
  try { apply(host.ctx) } finally { console.log = quiet }
  assert.equal(host.routes.size, 3, 're-apply after dispose registers cleanly')
  host.dispose()
})

// ── degraded host ──────────────────────────────────────────────────────────

await test('a host without the jobs service still serves session counts', async () => {
  const { ctx, routes } = makeHost({ jobs: undefined })
  ctx.emit('api-session/status', 'ses-9', true)
  ctx.emit('api-session/status', 'ses-9', false)
  assert.deepEqual(await counts(routes), {
    running: 0, unreadSessionIds: ['ses-9'], unviewedJobs: 0, unviewedJobSessionIds: [],
  })
})

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`)
process.exit(failures.length > 0 ? 1 : 0)
