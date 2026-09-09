// Host plugin for Task Badge — HOST level (profile bundle).
// Uses HTTP routes via webServer.register() (same pattern as dshmarket).
// Tracks: 1) active sessions, 2) unread sessions (synced with native markers), 3) background jobs.
const name = 'dsh-task-badge'
const inject = ['jobs']

function apply(ctx) {
  console.log('[task-badge] Host apply() called')

  const jobs = ctx.get('jobs')
  if (jobs === undefined) {
    console.log('[task-badge] jobs service not available')
    return
  }

  // === Session tracking ===
  const activeSessions = new Set()      // session ids currently processing
  const unreadSessions = new Set()      // session ids with unread responses

  // Track running state
  ctx.on('api-session/status', (sessionId, running) => {
    if (running) {
      activeSessions.add(sessionId)
    } else {
      activeSessions.delete(sessionId)
      // Agent finished → has unread response until user views it
      unreadSessions.add(sessionId)
    }
  })

  // Also track new session activity (aligns with native unread markers)
  ctx.on('api-session/activity', (sessionId, updatedAt) => {
    // New activity means the session has something unread
    unreadSessions.add(sessionId)
  })

  // Client tells us which session the user is now viewing → mark as read
  function markViewed(sessionId) {
    if (sessionId) {
      unreadSessions.delete(sessionId)
    }
    return getCounts()
  }

  // === Background job tracking via events ===
  const jobMap = new Map()
  const viewedJobIds = new Set()

  try {
    jobs.onJobsChanged((jobList) => {
      if (!jobList || !Array.isArray(jobList)) return
      for (let i = 0; i < jobList.length; i++) {
        const j = jobList[i]
        if (j && j.id) jobMap.set(j.id, { id: j.id, status: j.status, reported: j.reported })
      }
    })
  } catch (e) {}

  function getCounts(viewingSessionId) {
    try {
      let runningJobs = 0, unviewedJobs = 0
      jobMap.forEach((j) => {
        if (j.status === 'running') runningJobs++
        else if (j.status === 'completed' && !j.reported && !viewedJobIds.has(j.id)) unviewedJobs++
      })
      const running = activeSessions.size + runningJobs
      // Exclude the session the user is currently viewing from unread count
      let unviewedSessions = 0
      unreadSessions.forEach((sid) => {
        if (sid !== viewingSessionId) unviewedSessions++
      })
      const unviewed = unviewedSessions + unviewedJobs
      return { running, completedUnviewed: unviewed, total: running + unviewed }
    } catch (e) {
      return { running: 0, completedUnviewed: 0, total: 0 }
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
        // Read sessionId from query params to exclude from unread
        let viewingSessionId = null
        try {
          const url = new URL(request.url, 'http://localhost')
          viewingSessionId = url.searchParams.get('sessionId')
        } catch (e) {}
        sendJson(response, 200, getCounts(viewingSessionId))
      }
    })

    // Client calls this when user navigates to a session (URL hash change)
    webServer.register({
      kind: 'exact',
      path: '/task-badge/viewing',
      handler: async (request, response) => {
        if (request.method === 'OPTIONS') { sendJson(response, 204, {}); return }
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
        const body = await readBody(request)
        sendJson(response, 200, markViewed(body.sessionId))
      }
    })

    console.log('[task-badge] HTTP routes registered')
  })

  console.log('[task-badge] Plugin initialized')
}

export { apply, inject, name }
