// Host plugin for Task Badge — HOST level (profile bundle).
// Uses HTTP routes via webServer.register() (same pattern as dshmarket).
// Tracks: 1) active sessions via api-session/status, 2) completed-unread sessions, 3) background jobs.
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
  const completedUnread = new Set()     // session ids that finished but user hasn't seen

  ctx.on('api-session/status', (sessionId, running) => {
    if (running) {
      activeSessions.add(sessionId)
      // User sent a message → mark as viewed (they're looking at it)
      completedUnread.delete(sessionId)
    } else {
      activeSessions.delete(sessionId)
      // Session just finished → it's now unread until user views it
      completedUnread.add(sessionId)
    }
  })

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

  function getCounts() {
    try {
      let runningJobs = 0, unviewedJobs = 0
      jobMap.forEach((j) => {
        if (j.status === 'running') runningJobs++
        else if (j.status === 'completed' && !j.reported && !viewedJobIds.has(j.id)) unviewedJobs++
      })
      const running = activeSessions.size + runningJobs
      const unviewed = completedUnread.size + unviewedJobs
      return { running, completedUnviewed: unviewed, total: running + unviewed }
    } catch (e) {
      return { running: 0, completedUnviewed: 0, total: 0 }
    }
  }

  function markViewed(sessionId) {
    // Mark a specific session as viewed, or all if no id given
    if (sessionId) {
      completedUnread.delete(sessionId)
    } else {
      completedUnread.clear()
    }
    // Also mark all completed jobs as viewed
    jobMap.forEach((j, id) => {
      if (j.status === 'completed' || j.status === 'killed' || j.status === 'failed') viewedJobIds.add(id)
    })
    return getCounts()
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

    // Parse JSON body for POST
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
        sendJson(response, 200, markViewed(body.sessionId))
      }
    })

    console.log('[task-badge] HTTP routes registered')
  })

  console.log('[task-badge] Plugin initialized')
}

export { apply, inject, name }
