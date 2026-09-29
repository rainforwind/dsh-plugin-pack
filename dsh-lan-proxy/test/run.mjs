// Standalone test for the dsh-lan-proxy proxy core.
// Run with: node test/run.mjs
// Exercises allowlist matching, Host/Origin rewriting, HTTP proxying,
// SSE streaming, WebSocket upgrade forwarding, and the safety refusals.

import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import {
  Config,
  addressPending,
  apply,
  assertStartable,
  compileAllowlist,
  matchesAllowlist,
  nextRetryDelay,
  normalizeIp,
  rewriteRequestHeaders,
  startProxy,
  transientBindReason,
} from '../lib/index.js'

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

function waitFor(predicate, description, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      let value
      try {
        value = predicate()
      } catch (error) {
        reject(error)
        return
      }
      if (value) resolve(value)
      else if (Date.now() - started > timeoutMs) reject(new Error(`timeout waiting for ${description}`))
      else setTimeout(tick, 20)
    }
    tick()
  })
}

function requestOnce({ port, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

function socketBuffer(socket) {
  const state = { text: '' }
  socket.on('data', (chunk) => {
    state.text += chunk.toString('utf8')
  })
  socket.on('error', () => {})
  return state
}

// ── unit: address parsing, allowlist, header rewriting ─────────────────────

await test('allowlist matching covers v4/v6, CIDR, mapped, loopback', () => {
  const { rules, errors } = compileAllowlist(['100.64.0.0/10', '192.0.2.1', 'fd7a:115c:a1e0::/48'])
  assert.deepEqual(errors, [])
  assert.ok(matchesAllowlist(rules, normalizeIp('100.64.0.5')), 'tailscale range in')
  assert.ok(matchesAllowlist(rules, normalizeIp('::ffff:100.64.0.5')), 'ipv4-mapped in')
  assert.ok(matchesAllowlist(rules, normalizeIp('100.127.255.254')), 'range upper edge in')
  assert.ok(!matchesAllowlist(rules, normalizeIp('100.128.0.1')), 'just above range out')
  assert.ok(!matchesAllowlist(rules, normalizeIp('192.168.1.1')), 'other lan out')
  assert.ok(matchesAllowlist(rules, normalizeIp('192.0.2.1')), 'exact ip in')
  assert.ok(!matchesAllowlist(rules, normalizeIp('192.0.2.2')), 'neighbor of exact ip out')
  assert.ok(matchesAllowlist(rules, normalizeIp('fd7a:115c:a1e0::9')), 'ipv6 cidr in')
  assert.ok(!matchesAllowlist(rules, normalizeIp('fd7a:115c:a1e1::9')), 'ipv6 neighbor out')
  assert.ok(matchesAllowlist(rules, normalizeIp('127.0.0.1')), 'loopback always in')
  assert.ok(matchesAllowlist(rules, normalizeIp('::1')), 'ipv6 loopback always in')
  assert.ok(!matchesAllowlist(rules, normalizeIp('8.8.8.8')), 'internet out')
  assert.ok(!matchesAllowlist(rules, undefined), 'unparsable out')
  assert.ok(matchesAllowlist([], normalizeIp('127.5.5.5')), 'loopback in even with empty list')
})

await test('invalid allowlist entries are reported, not silently dropped', () => {
  const { errors } = compileAllowlist(['10.0.0.0/33', 'nope', '1.2.3.4/24/1', '999.1.1.1', '  '])
  assert.equal(errors.length, 5)
})

await test('non-loopback bind with empty allowlist refuses to start', async () => {
  assert.throws(() => assertStartable('0.0.0.0', []), /allowlist is empty/)
  assert.throws(() => assertStartable('100.64.0.5', []), /allowlist is empty/)
  assert.doesNotThrow(() => assertStartable('127.0.0.1', []))
  await assert.rejects(
    startProxy({ bindHost: '0.0.0.0', bindPort: 0, targetHost: '127.0.0.1', targetPort: 9, rules: [] }),
    /allowlist is empty/,
  )
})

await test('request header rewrite: Host/Origin to loopback, cross-origin untouched, hop-by-hop dropped', () => {
  const info = { targetAuthority: '127.0.0.1:3080', incomingAuthority: '100.64.0.5:3081', source: '100.64.0.5' }
  const out = rewriteRequestHeaders(
    {
      host: '100.64.0.5:3081',
      origin: 'http://100.64.0.5:3081',
      connection: 'keep-alive, X-Hop',
      'x-hop': 'drop-me',
      cookie: 'a=b',
    },
    info,
    false,
  )
  assert.equal(out.host, '127.0.0.1:3080')
  assert.equal(out.origin, 'http://127.0.0.1:3080')
  assert.equal(out['x-hop'], undefined)
  assert.equal(out.connection, undefined)
  assert.equal(out.cookie, 'a=b')
  assert.equal(out['x-forwarded-for'], '100.64.0.5')
  assert.equal(out['x-forwarded-host'], '100.64.0.5:3081')

  const cross = rewriteRequestHeaders({ host: '100.64.0.5:3081', origin: 'https://evil.example' }, info, false)
  assert.equal(cross.origin, 'https://evil.example')

  const upgrade = rewriteRequestHeaders({ host: '100.64.0.5:3081', connection: 'Upgrade', upgrade: 'websocket' }, info, true)
  assert.equal(upgrade.connection, 'Upgrade')
  assert.equal(upgrade.upgrade, 'websocket')
})

await test('composition schema defaults and bounds', () => {
  const defaults = Config({})
  assert.equal(defaults.enabled, false)
  assert.equal(defaults.host, '0.0.0.0')
  assert.equal(defaults.port, 3081)
  assert.deepEqual(defaults.allow, [])
  assert.equal(defaults.targetPort, 0)
  assert.throws(() => Config({ port: 65536 }))
})

// ── integration: mock target + live proxy ──────────────────────────────────

const targetState = { requests: [], upgrade: undefined, expectedAuthority: undefined }
const targetUpgradedSockets = new Set()

const target = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://x').pathname
  targetState.requests.push({ path, headers: { ...request.headers } })
  if (path === '/') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('hello')
    return
  }
  if (path === '/fence') {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const host = request.headers.host
      const origin = request.headers.origin
      const trustedHost = host === targetState.expectedAuthority
      const sameOrigin = origin === undefined || origin === `http://${host}`
      const notCrossSite = request.headers['sec-fetch-site'] !== 'cross-site'
      if (!trustedHost || !sameOrigin || !notCrossSite) {
        response.writeHead(403, { 'content-type': 'text/plain' })
        response.end('forbidden')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ host, origin, body: Buffer.concat(chunks).toString('utf8') }))
    })
    return
  }
  if (path === '/sse') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    let index = 0
    const timer = setInterval(() => {
      response.write(`data: event-${String(index)}\n\n`)
      index += 1
      if (index >= 5) {
        clearInterval(timer)
        response.end()
      }
    }, 80)
    response.on('close', () => clearInterval(timer))
    return
  }
  response.writeHead(404)
  response.end('not found')
})

target.on('upgrade', (request, socket, head) => {
  targetState.upgrade = {
    url: request.url,
    host: request.headers.host,
    origin: request.headers.origin,
  }
  targetUpgradedSockets.add(socket)
  socket.on('close', () => targetUpgradedSockets.delete(socket))
  if (request.url !== '/ws') {
    socket.destroy()
    return
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  if (head !== undefined && head.length > 0) socket.write(head)
  socket.on('data', (chunk) => socket.write(chunk))
})

await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
const targetPort = target.address().port
targetState.expectedAuthority = `127.0.0.1:${String(targetPort)}`

const proxyA = await startProxy({
  bindHost: '127.0.0.1',
  bindPort: 0,
  targetHost: '127.0.0.1',
  targetPort,
  rules: compileAllowlist(['192.0.2.1']).rules,
})
const proxyDenied = await startProxy({
  bindHost: '127.0.0.1',
  bindPort: 0,
  targetHost: '127.0.0.1',
  targetPort,
  rules: compileAllowlist(['192.0.2.1']).rules,
  resolveSource: () => '203.0.113.9',
})

const fakeAuthority = `100.64.0.5:${String(proxyA.port)}`

await test('proxies HTTP and rewrites Host to the loopback target authority', async () => {
  const result = await requestOnce({
    port: proxyA.port,
    path: '/',
    headers: { host: fakeAuthority, connection: 'keep-alive, X-Test-Hop', 'x-test-hop': 'drop-me' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.body, 'hello')
  const seen = targetState.requests.findLast((entry) => entry.path === '/')
  assert.equal(seen.headers.host, targetState.expectedAuthority)
  assert.equal(seen.headers['x-forwarded-host'], fakeAuthority)
  assert.ok(seen.headers['x-forwarded-for'], 'source recorded')
  assert.equal(seen.headers['x-test-hop'], undefined, 'connection token dropped')
  assert.ok(!String(seen.headers.connection ?? '').includes('X-Test-Hop'), 'original connection list dropped')
})

await test('same-origin POST passes the target Host/Origin fence through the proxy', async () => {
  const result = await requestOnce({
    port: proxyA.port,
    path: '/fence',
    method: 'POST',
    headers: {
      host: fakeAuthority,
      origin: `http://${fakeAuthority}`,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ ping: 1 }),
  })
  assert.equal(result.status, 200)
  const payload = JSON.parse(result.body)
  assert.equal(payload.host, targetState.expectedAuthority)
  assert.equal(payload.origin, `http://${targetState.expectedAuthority}`)
  assert.deepEqual(JSON.parse(payload.body), { ping: 1 })
})

await test('cross-site Origin is NOT laundered and the target fence rejects it', async () => {
  const result = await requestOnce({
    port: proxyA.port,
    path: '/fence',
    method: 'POST',
    headers: { host: fakeAuthority, origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(result.status, 403)
  const seen = targetState.requests.findLast((entry) => entry.path === '/fence')
  assert.equal(seen.headers.origin, 'https://evil.example', 'foreign origin forwarded verbatim')
})

await test('SSE streams through incrementally (no buffering)', async () => {
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: proxyA.port, path: '/sse', headers: { host: fakeAuthority } }, (response) => {
      const arrivals = []
      response.on('data', (chunk) => arrivals.push({ at: Date.now(), text: chunk.toString('utf8') }))
      response.on('end', () => resolve({ status: response.statusCode, contentType: response.headers['content-type'], arrivals }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
  assert.equal(result.status, 200)
  assert.equal(result.contentType, 'text/event-stream')
  const text = result.arrivals.map((entry) => entry.text).join('')
  assert.equal((text.match(/data: event-/g) ?? []).length, 5)
  assert.ok(result.arrivals.length >= 2, 'multiple chunks observed')
  const first = result.arrivals[0].at
  const last = result.arrivals[result.arrivals.length - 1].at
  assert.ok(last - first >= 150, `first chunk arrived ${String(last - first)}ms before the last — expected streaming`)
})

await test('WebSocket upgrade forwards and echoes, with rewritten Host/Origin', async () => {
  const socket = netConnect(proxyA.port, '127.0.0.1')
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const buffer = socketBuffer(socket)
  socket.write(
    [
      'GET /ws HTTP/1.1',
      `Host: ${fakeAuthority}`,
      `Origin: http://${fakeAuthority}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'),
  )
  await waitFor(() => buffer.text.includes('101 Switching Protocols'), 'upgrade response')
  assert.equal(targetState.upgrade.host, targetState.expectedAuthority, 'upgrade Host rewritten')
  assert.equal(targetState.upgrade.origin, `http://${targetState.expectedAuthority}`, 'upgrade Origin rewritten')
  socket.write('ping-through-proxy')
  await waitFor(() => buffer.text.includes('ping-through-proxy'), 'echoed upgrade payload')
  socket.destroy()
})

await test('disallowed source gets 403 on HTTP', async () => {
  const result = await requestOnce({ port: proxyDenied.port, path: '/', headers: { host: `100.64.0.5:${String(proxyDenied.port)}` } })
  assert.equal(result.status, 403)
  assert.match(result.body, /not in the allowlist/)
})

await test('disallowed source gets 403 on upgrade', async () => {
  const socket = netConnect(proxyDenied.port, '127.0.0.1')
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const buffer = socketBuffer(socket)
  socket.write('GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  await waitFor(() => buffer.text.includes('403'), 'denied upgrade response')
  socket.destroy()
})

// ── waiting for a bind that cannot succeed yet ──────────────────────────────

await test('an unavailable VPN address is a transient reason, not a dead end', () => {
  const reason = transientBindReason({ code: 'EADDRNOTAVAIL' }, '100.64.0.1')
  assert.match(reason, /100\.64\.0\.1 is not an address of this machine/)
  assert.match(reason, /Tailscale/)
})

await test('other temporary listen failures are transient too', () => {
  assert.equal(transientBindReason({ code: 'EADDRINUSE' }, '0.0.0.0'), 'that port is already in use')
  assert.equal(transientBindReason({ code: 'EACCES' }, '0.0.0.0'), 'this process may not bind that port')
  assert.equal(transientBindReason({ code: 'EAFNOSUPPORT' }, 'fe80::1'), 'the address family of fe80::1 is not available here')
  assert.equal(transientBindReason({ code: 'ENETDOWN' }, '0.0.0.0'), 'the network is down')
  // A missing wildcard address is odd but still worth another attempt.
  assert.equal(transientBindReason({ code: 'EADDRNOTAVAIL' }, '0.0.0.0'), 'the address 0.0.0.0 cannot be bound')
})

await test('a broken configuration is not retried', () => {
  assert.equal(transientBindReason(new Error('boom'), '0.0.0.0'), undefined)
  assert.equal(transientBindReason({ code: 'EPERM' }, '0.0.0.0'), undefined)
  assert.equal(transientBindReason(undefined, '0.0.0.0'), undefined)
})

await test('the retry backoff ramps up and stops at its ceiling', () => {
  assert.equal(nextRetryDelay(5000), 10000)
  assert.equal(nextRetryDelay(10000), 20000)
  assert.equal(nextRetryDelay(30000), 60000)
  assert.equal(nextRetryDelay(60000), 60000)
  assert.equal(nextRetryDelay(1), 5000, 'never polls faster than the floor')
  // A link that is merely down is polled tightly enough to feel instant.
  assert.equal(nextRetryDelay(10000, 15000), 15000)
  assert.equal(nextRetryDelay(1000, 15000), 5000)
})

await test('a missing interface is retried tightly, a busy port lazily', () => {
  assert.equal(addressPending('EADDRNOTAVAIL'), true)
  assert.equal(addressPending('EAFNOSUPPORT'), true)
  assert.equal(addressPending('ENETDOWN'), true)
  assert.equal(addressPending('EADDRINUSE'), false)
  assert.equal(addressPending('EACCES'), false)
  assert.equal(addressPending(undefined), false)
})

// ── the listener waits instead of giving up ─────────────────────────────────

await test('a busy port is waited out, not abandoned', async () => {
  // Squat the port so the first bind cannot succeed, exactly like a VPN
  // address that is not assigned yet.
  const squatter = createServer(() => {})
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve))
  const port = squatter.address().port

  const lines = []
  const realLog = console.log
  console.log = (line) => lines.push(String(line))
  const disposers = []
  const ctx = {
    get: (service) => (service === 'webServer' ? { port: 1 } : undefined),
    inject: (list, callback) => {
      callback()
      return () => {}
    },
    effect: (fn) => {
      disposers.push(fn())
      return () => {}
    },
  }
  apply(ctx, Config({ enabled: true, host: '127.0.0.1', port, allow: [] }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  console.log = realLog
  try {
    assert.ok(
      lines.some((line) => line.includes('waiting to serve') && line.includes('already in use')),
      `expected one waiting line, got ${JSON.stringify(lines)}`,
    )
    assert.equal(lines.length, 1, 'the wait is announced once, not on every attempt')

    // Release the port; the plugin must take it on its own within the backoff.
    await new Promise((resolve) => squatter.close(resolve))
    const deadline = Date.now() + 20000
    for (;;) {
      const reachable = await new Promise((resolve) => {
        const socket = netConnect(port, '127.0.0.1')
        socket.once('connect', () => {
          socket.destroy()
          resolve(true)
        })
        socket.once('error', () => resolve(false))
      })
      if (reachable) break
      if (Date.now() > deadline) assert.fail('the listener never took the freed port')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  } finally {
    console.log = realLog
    for (const dispose of disposers) dispose()
  }
  // Disposal releases the port again, so a waiting row never pins it.
  await new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve())
    probe.listen(port, '127.0.0.1', () => probe.close(resolve))
  })
})

// ── teardown ───────────────────────────────────────────────────────────────

await proxyA.close()
await proxyDenied.close()
for (const socket of targetUpgradedSockets) socket.destroy()
await new Promise((resolve) => {
  target.closeAllConnections()
  target.close(resolve)
})

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`)
process.exit(failures.length > 0 ? 1 : 0)
