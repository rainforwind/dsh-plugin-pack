// Host plugin for Task Badge — HOST level (profile bundle).
// Uses HTTP routes via webServer.register() (same pattern as dshmarket).
// Tracks: 1) active sessions via api-session/status, 2) unread session IDs, 3) background jobs.
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

  ctx.on('api-session/status', (sessionId, running) => {
    if (running) {
      activeSessions.add(sessionId)
    } else {
      activeSessions.delete(sessionId)
      unreadSessions.add(sessionId)
    }
  })

  ctx.on('api-session/activity', (sessionId) => {
    unreadSessions.add(sessionId)
  })

  // Client tells host it viewed a session → remove from unread
  function markViewed(sessionId) {
    if (sessionId) unreadSessions.delete(sessionId)
  }

  // === Background job tracking ===
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

  function getCounts() {
    try {
      let runningJobs = 0, unviewedJobs = 0
      jobMap.forEach((j) => {
        if (j.status === 'running') runningJobs++
        else if (j.status === 'completed' && !j.reported && !viewedJobIds.has(j.id)) unviewedJobs++
      })
      return {
        running: activeSessions.size + runningJobs,
        // Return the actual session IDs so client can manage read/unread locally
        unreadSessionIds: Array.from(unreadSessions),
        unviewedJobs
      }
    } catch (e) {
      return { running: 0, unreadSessionIds: [], unviewedJobs: 0 }
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
        markViewed(body.sessionId)
        sendJson(response, 200, { ok: true })
      }
    })

    console.log('[task-badge] HTTP routes registered')
  })

  console.log('[task-badge] Plugin initialized')
}

export { apply, inject, name }
