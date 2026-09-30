// Host plugin for Task Badge — HOST level (profile bundle).
// Uses HTTP routes via webServer.register() (same pattern as dshmarket).
// Tracks: 1) active sessions via api-session/status, 2) unread session IDs, 3) background jobs.
const name = 'dsh-task-badge'
const inject = ['jobs']

function apply(ctx) {
  console.log('[task-badge] Host apply() called')

  const jobs = ctx.get('jobs')

  // === Session tracking ===
  const activeSessions = new Set()      // session ids currently processing
  const unreadSessions = new Set()      // session ids with unread responses
  const subagentSessions = new Set()    // session ids belonging to subagents (excluded from counts)
  let viewedSessionId = null            // last session the client said it is looking at

  // === Background job tracking ===
  const jobMap = new Map()              // job id -> { status, owner }
  const viewedJobIds = new Set()        // jobs whose owning session has been opened

  // Track subagent lifecycle to filter them out.
  // The payload is `{ runId, provider, id, local }` and `id` is the child's
  // *session* id — there is no `sessionId` field, so reading one never matched
  // and every child session kept counting as the user's own unread.
  // Entries are deliberately never removed on `subagent/end`: the child's final
  // `api-session/status` may still arrive afterwards, and dropping the marker
  // first would let it land in `unreadSessions` for good. Ids are unique, so a
  // retained entry can never match a real conversation later.
  ctx.on('subagent/start', (info) => {
    const id = info && info.id
    if (!id) return
    if (subagentSessions.has(id)) return
    subagentSessions.add(id)
    // Learned late: drop anything already recorded for this child.
    activeSessions.delete(id)
    unreadSessions.delete(id)
    console.log('[task-badge] subagent started:', id)
  }, { global: true })

  ctx.on('api-session/status', (sessionId, running) => {
    if (subagentSessions.has(sessionId)) return // skip subagent sessions
    if (running) {
      activeSessions.add(sessionId)
    } else {
      activeSessions.delete(sessionId)
      unreadSessions.add(sessionId)
    }
  })

  ctx.on('api-session/activity', (sessionId) => {
    if (subagentSessions.has(sessionId)) return // skip subagent sessions
    unreadSessions.add(sessionId)
  })

  // Client tells host which session it viewed → remove from unread, and read
  // the background jobs that session owns on the way through.
  function markViewed(sessionId) {
    viewedSessionId = sessionId || null
    if (!sessionId) return
    unreadSessions.delete(sessionId)
    jobMap.forEach((job, id) => {
      if (job.owner === sessionId) viewedJobIds.add(id)
    })
  }

  // The registry exposes `jobs.events.subscribe({ owners }, listener)` — there
  // is no `onJobsChanged`, so the old subscription threw into its catch and
  // `jobMap` stayed empty forever (running jobs and unviewed jobs both
  // counted as zero). `{ owners: 'all' }` delivers every owner's jobs, not
  // just the unowned ones.
  if (jobs && jobs.events && typeof jobs.events.subscribe === 'function') {
    try {
      jobs.events.subscribe({ owners: 'all' }, (event) => {
        if (!event || event.type === 'output') return // no job record carried
        const job = event.job
        if (!job || !job.id) return
        if (event.type === 'removed') {
          jobMap.delete(job.id)
          viewedJobIds.delete(job.id)
          return
        }
        jobMap.set(job.id, { status: job.status, owner: job.owner })
      })
      console.log('[task-badge] job events subscribed')
    } catch (e) {
      console.log('[task-badge] job events unavailable:', String(e))
    }
  } else {
    console.log('[task-badge] jobs service not available')
  }

  function getCounts() {
    try {
      let runningJobs = 0
      const unviewed = []

      jobMap.forEach((job, id) => {
        if (subagentSessions.has(job.owner)) return // subagent work, not the user's
        if (job.status === 'running' || job.status === 'stopping') {
          runningJobs++
          return
        }
        // A job counts as unread only until the user opens the session that
        // owns it; an unowned job has no session to open, so it can never be
        // cleared and is left out rather than sticking forever.
        if (job.status !== 'completed') return
        if (!job.owner) return
        if (viewedJobIds.has(id)) return
        if (job.owner === viewedSessionId) return // already on screen
        unviewed.push({ id: id, owner: job.owner })
      })

      let runningSessions = 0
      activeSessions.forEach((id) => {
        if (!subagentSessions.has(id)) runningSessions++
      })

      const unreadSessionIds = []
      unreadSessions.forEach((id) => {
        if (!subagentSessions.has(id)) unreadSessionIds.push(id)
      })

      // Owners of those jobs, so a click can jump to the session holding them.
      const unviewedJobSessionIds = []
      for (let i = 0; i < unviewed.length; i++) {
        const owner = unviewed[i].owner
        if (unviewedJobSessionIds.indexOf(owner) < 0) unviewedJobSessionIds.push(owner)
      }

      return {
        running: runningSessions + runningJobs,
        // Return the actual session IDs so client can manage read/unread locally
        unreadSessionIds,
        unviewedJobs: unviewed.length,
        unviewedJobSessionIds
      }
    } catch (e) {
      return { running: 0, unreadSessionIds: [], unviewedJobs: 0, unviewedJobSessionIds: [] }
    }
  }

  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.get('webServer')
    if (!webServer || !webServer.register) {
      console.log('[task-badge] webServer.register not available')
      return
    }

    function sendJson(response, status, data) {
      const body = JSON.stringify(data)
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      response.end(body)
    }

    function readBody(request) {
      return new Promise((resolve) => {
        let body = ''
        request.on('data', (chunk) => { body += chunk })
        request.on('end', () => {
          try { resolve(JSON.parse(body)) } catch (e) { resolve({}) }
        })
      })
    }

    webServer.register({
      kind: 'exact',
      path: '/task-badge/counts',
      handler: (request, response) => {
        if (request.method === 'OPTIONS') { sendJson(response, 204, {}); return }
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
        sendJson(response, 200, getCounts())
      }
    })

    webServer.register({
      kind: 'exact',
      path: '/task-badge/mark-viewed',
      handler: async (request, response) => {
        if (request.method === 'OPTIONS') { sendJson(response, 204, {}); return }
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
        const body = await readBody(request)
        // `sessionId: null` is the client reporting that nothing is on screen;
        // it releases the remembered session instead of clearing anything.
        markViewed(body && body.sessionId)
        sendJson(response, 200, { ok: true })
      }
    })

    console.log('[task-badge] HTTP routes registered')
  })

  console.log('[task-badge] Plugin initialized')
}

export { apply, inject, name }
