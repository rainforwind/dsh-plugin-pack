// dsh-lan-proxy — HOST plugin (profile bundle).
//
// DSH binds its Web GUI to 127.0.0.1 by design (`dsh --host 0.0.0.0` is
// refused on purpose). This plugin adds a second, explicitly-configured
// front door instead of widening the original bind: a source-allowlisted
// reverse proxy that listens on its own host:port and forwards HTTP,
// SSE, and WebSocket traffic to the loopback Web server.
//
// Two details make proxied browsers pass DSH's own defences without
// touching any other plugin's composition row:
//
//   1. Host/Origin fence — `/api` requests must carry a loopback Host (or a
//      declared trustedHosts authority), and an attached Origin must equal
//      that Host. The proxy rewrites `Host` to the loopback target authority
//      and rewrites `Origin` only when it equals the incoming authority
//      (same-origin traffic arriving through the proxy). A cross-site Origin
//      is forwarded untouched so the target's fence still rejects it.
//   2. Authority-bound auth cookie — the browser-session cookie is named and
//      signed for the authority the server sees. Because every proxied
//      request sees the same rewritten loopback authority, a cookie minted
//      through the proxy stays consistent for the whole session.
//
// Access itself is gated per source address: `allow` (IPs and CIDRs, e.g.
// a Tailscale device or 100.64.0.0/10) decides who may connect at all;
// loopback sources are always accepted because they could reach the
// original bind anyway. Configuration lives in the `lan-proxy` settings
// namespace (`$DSH_HOME/settings.yaml`, hot-reloaded) — enabling,
// retargeting, or narrowing the allowlist takes effect without a restart.

import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { networkInterfaces } from 'node:os'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
const name = 'dsh-lan-proxy'
/**
 * Row id declared in `cordis.patch.yml`. Since dsh 0.1.7 the Host derives one
 * settings section per active entry from its exported `Config`, keyed by this
 * id — the browser half edits that section through `configForms.get(ENTRY_ID)`.
 */
const ENTRY_ID = name
/** Prefix on every line this plugin prints. */
const LOG_PREFIX = '[lan-proxy]'
/** How long `waitForTargetPort` waits for the Web server to bind before giving up. */
const TARGET_PORT_TIMEOUT_MS = 15000
/** Delay between target-port polls. */
const TARGET_PORT_POLL_MS = 100
/** Maximum LAN URLs printed on one banner (one line each, keeps the boot log short). */
const MAX_BANNER_URLS = 6
/**
 * Close started by the previous fiber instance. dsh restarts a row on every
 * configuration change, and a disposer cannot be awaited, so the next bind
 * waits for it instead of racing its own predecessor on the same port.
 */
let closing = Promise.resolve()

/**
 * Composition/settings schema for this plugin. Every field has a default, so
 * an unconfigured row mounts inert (`enabled: false`) and never opens a port.
 */
const Config = z.object({
  /** Start the proxy when true; false keeps this plugin entirely passive. */
  enabled: z.boolean().default(false),
  /** Bind address of the proxy listener (`0.0.0.0`, a LAN/Tailscale IP, …). */
  host: z.string().default('0.0.0.0'),
  /** Bind port of the proxy listener; 0 lets the OS pick one. */
  port: z.natural().max(65535).default(3081),
  /** Source addresses allowed through: exact IPs or CIDRs (`100.64.0.5`, `100.64.0.0/10`). */
  allow: z.array(z.string()).default([]),
  /** Target host of the proxied Web server. */
  targetHost: z.string().default('127.0.0.1'),
  /** Target port; 0 follows the composed Web server's actual bound port. */
  targetPort: z.natural().max(65535).default(0),
})

//#region address parsing / matching

/** Parse a dotted-quad into 4 bytes, or undefined when it is not one. */
function parseIPv4(text) {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return undefined
    const value = Number(parts[i])
    if (value > 255) return undefined
    out[i] = value
  }
  return out
}

/** Parse an IPv6 literal (with `::` and an optional trailing dotted-quad) into 16 bytes. */
function parseIPv6(text) {
  if (!/^[0-9a-f:.]+$/i.test(text) || text.includes('..')) return undefined
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const groups = (part) => {
    if (part === '') return []
    const out = []
    const pieces = part.split(':')
    for (const piece of pieces) {
      if (piece.includes('.')) {
        if (piece !== pieces[pieces.length - 1]) return undefined
        const v4 = parseIPv4(piece)
        if (v4 === undefined) return undefined
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined
        out.push(Number.parseInt(piece, 16))
      }
    }
    return out
  }
  const head = groups(halves[0])
  if (head === undefined) return undefined
  let merged
  if (halves.length === 1) {
    if (head.length !== 8) return undefined
    merged = head
  } else {
    const tail = groups(halves[1])
    if (tail === undefined) return undefined
    const fill = 8 - head.length - tail.length
    if (fill < 1) return undefined
    merged = [...head, ...new Array(fill).fill(0), ...tail]
  }
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (merged[i] >> 8) & 0xff
    out[i * 2 + 1] = merged[i] & 0xff
  }
  return out
}

/**
 * Normalize one address string into `{ family, bytes }`, or undefined when it
 * is not an address. IPv4-mapped IPv6 (`::ffff:100.64.0.5`) collapses to IPv4,
 * which is how Node reports remote addresses on a dual-stack listener.
 * @param value - the raw address (may carry a zone id or brackets).
 */
function normalizeIp(value) {
  if (typeof value !== 'string') return undefined
  let text = value.trim()
  if (text === '') return undefined
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const v4 = parseIPv4(text)
  if (v4 !== undefined) return { family: 4, bytes: v4 }
  const v6 = parseIPv6(text)
  if (v6 === undefined) return undefined
  let zeroPrefix = true
  for (let i = 0; i < 10; i++) {
    if (v6[i] !== 0) {
      zeroPrefix = false
      break
    }
  }
  if (zeroPrefix && v6[10] === 0xff && v6[11] === 0xff) return { family: 4, bytes: v6.slice(12) }
  return { family: 6, bytes: v6 }
}

/** Whether an address is loopback (127.0.0.0/8 or ::1). */
function isLoopback(ip) {
  if (ip === undefined) return false
  if (ip.family === 4) return ip.bytes[0] === 127
  return ip.bytes.slice(0, 15).every((byte) => byte === 0) && ip.bytes[15] === 1
}

/** Whether the first `prefix` bits of two same-family addresses agree. */
function bitsMatch(a, b, prefix) {
  const fullBytes = prefix >> 3
  for (let i = 0; i < fullBytes; i++) {
    if (a[i] !== b[i]) return false
  }
  const remainder = prefix & 7
  if (remainder === 0) return true
  const mask = (0xff << (8 - remainder)) & 0xff
  return (a[fullBytes] & mask) === (b[fullBytes] & mask)
}

/**
 * Compile one allowlist entry into a matcher rule.
 * @param entry - exact IP or CIDR literal.
 * @returns `{ rule }` on success, `{ error }` with a reason on failure.
 */
function compileAllowEntry(entry) {
  const raw = typeof entry === 'string' ? entry.trim() : ''
  if (raw === '') return { error: 'empty entry' }
  const pieces = raw.split('/')
  if (pieces.length > 2) return { error: 'expected <ip> or <ip>/<prefix>' }
  const address = normalizeIp(pieces[0])
  if (address === undefined) return { error: 'not an IPv4 or IPv6 address' }
  if (pieces.length === 1) return { rule: { kind: 'ip', address } }
  if (!/^\d{1,3}$/.test(pieces[1])) return { error: 'prefix must be a number' }
  const prefix = Number(pieces[1])
  const maximum = address.family === 4 ? 32 : 128
  if (prefix > maximum) return { error: `prefix must be 0-${String(maximum)}` }
  return { rule: { kind: 'cidr', address, prefix } }
}

/**
 * Compile a whole allowlist.
 * @param entries - configured allow entries.
 * @returns `{ rules, errors }`; any error means the caller must not start.
 */
function compileAllowlist(entries) {
  const rules = []
  const errors = []
  for (const entry of entries) {
    const compiled = compileAllowEntry(entry)
    if (compiled.error !== undefined) errors.push(`"${String(entry)}": ${compiled.error}`)
    else rules.push(compiled.rule)
  }
  return { rules, errors }
}

/**
 * Whether one source address passes an allowlist. Loopback always passes:
 * a local process could reach the original bind anyway, so refusing it would
 * break local testing without protecting anything.
 * @param rules - compiled allowlist rules.
 * @param ip - normalized source address, or undefined when unparsable.
 */
function matchesAllowlist(rules, ip) {
  if (ip === undefined) return false
  if (isLoopback(ip)) return true
  return rules.some((rule) => {
    if (rule.address.family !== ip.family) return false
    if (rule.kind === 'ip') return rule.address.bytes.every((byte, i) => ip.bytes[i] === byte)
    return bitsMatch(ip.bytes, rule.address.bytes, rule.prefix)
  })
}

/** Whether a bind host refers to loopback only. */
function isLoopbackBind(host) {
  const value = String(host).trim().toLowerCase()
  if (value === 'localhost' || value.endsWith('.localhost')) return true
  if (value === '::1' || value === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

//#endregion

//#region header rewriting

/** Hop-by-hop headers RFC 9110 forbids forwarding (plus the Connection token list). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Lowercased tokens listed in a Connection header. */
function connectionTokens(headers) {
  const value = headers['connection']
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '')
}

/** `host:port` authority with IPv6 brackets. */
function formatAuthority(host, port) {
  const text = String(host)
  const bracketed = text.includes(':') && !text.startsWith('[') ? `[${text}]` : text
  return `${bracketed}:${String(port)}`
}

/**
 * Rewrite one proxied request's headers for the loopback target.
 *
 * @param headers - incoming headers (Node lowercases keys already).
 * @param info - `targetAuthority` (what the target must see as Host),
 *   `incomingAuthority` (what the browser asked for), and `source` (the
 *   allowed client address, recorded in X-Forwarded-For).
 * @param keepHopByHop - true for the upgrade path, which must carry
 *   Connection/Upgrade through verbatim.
 * @returns the forwarded header object.
 */
function rewriteRequestHeaders(headers, info, keepHopByHop) {
  const drop = keepHopByHop ? new Set() : new Set([...HOP_BY_HOP, ...connectionTokens(headers)])
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (lower === 'host' || drop.has(lower)) continue
    out[lower] = value
  }
  out['host'] = info.targetAuthority
  const origin = headers['origin']
  if (typeof origin === 'string' && origin !== '') {
    // Only a same-origin request arriving through the proxy is rewritten; any
    // other Origin is forwarded verbatim so the target's fence still judges it.
    try {
      if (new URL(origin).host === info.incomingAuthority) out['origin'] = `http://${info.targetAuthority}`
    } catch {
      /* unparsable Origin: forward unchanged, the target rejects it */
    }
  }
  const prior = headers['x-forwarded-for']
  const priorText = typeof prior === 'string' && prior.trim() !== '' ? `${prior.trim()}, ` : ''
  out['x-forwarded-for'] = `${priorText}${info.source}`
  out['x-forwarded-host'] = info.incomingAuthority
  out['x-forwarded-proto'] = 'http'
  return out
}

/** Strip hop-by-hop headers (and anything the Connection header names) from a response. */
function filterResponseHeaders(headers) {
  const drop = new Set([...HOP_BY_HOP, ...connectionTokens(headers)])
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (drop.has(lower)) continue
    out[lower] = value
  }
  return out
}

/** Serialize headers into raw HTTP/1.1 text for an upgrade handshake. */
function serializeHeaders(headers) {
  const lines = []
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${key}: ${item}`)
    } else {
      lines.push(`${key}: ${value}`)
    }
  }
  return `${lines.join('\r\n')}\r\n`
}

//#endregion

//#region proxy server

/** Addresses worth printing on the banner: non-internal, non-link-local. */
function lanAddresses() {
  const out = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      const family = String(entry.family)
      if (family === 'IPv4' || family === '4') out.push({ family: 4, text: entry.address })
      else if (family === 'IPv6' || family === '6') {
        if (/^fe[89ab]/i.test(entry.address)) continue
        out.push({ family: 6, text: entry.address })
      }
    }
  }
  out.sort((a, b) => a.family - b.family)
  const seen = new Set()
  return out.filter((entry) => {
    if (seen.has(entry.text)) return false
    seen.add(entry.text)
    return true
  })
}

/** Sleep used by the target-port wait; unref'd so it never holds the process open. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/** Close one listener and every socket still attached to it. */
function closeListener(server, sockets) {
  return new Promise((resolve) => {
    for (const entry of sockets) {
      entry.client.destroy()
      entry.upstream?.destroy()
    }
    sockets.clear()
    if (!server.listening) {
      resolve()
      return
    }
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    server.close(() => resolve())
  })
}

/**
 * Refuse a start that would open a non-loopback listener with no allowlist.
 * @param bindHost - configured bind address.
 * @param rules - compiled allowlist rules.
 * @throws {Error} when the configuration would expose the port beyond loopback with nothing gating it.
 */
function assertStartable(bindHost, rules) {
  if (rules.length === 0 && !isLoopbackBind(bindHost)) {
    throw new Error(`bind ${bindHost} is not loopback and the allowlist is empty; add the source IPs/CIDRs you want to open`)
  }
}

/**
 * Start one proxy instance.
 *
 * @param options - bind/target facts plus the compiled allowlist:
 *   `bindHost`, `bindPort`, `targetHost`, `targetPort`, `rules`,
 *   `log(line)`, and an optional `resolveSource(request)` override (a test seam).
 * @returns a handle with the bound `port` and `close()`.
 * @throws when the configuration or the listen is invalid (port in use, address unavailable).
 */
async function startProxy(options) {
  const { bindHost, bindPort, targetHost, targetPort, rules, log = () => {}, resolveSource } = options
  assertStartable(bindHost, rules)
  const targetAuthority = formatAuthority(targetHost, targetPort)
  const upgradedSockets = new Set()

  const sourceOf = resolveSource ?? ((request) => request.socket.remoteAddress)
  const allowedFor = (request) => {
    const raw = sourceOf(request)
    const address = normalizeIp(raw)
    return { allowed: matchesAllowlist(rules, address), source: typeof raw === 'string' ? raw : String(raw ?? 'unknown') }
  }

  const server = createHttpServer((request, response) => {
    const gate = allowedFor(request)
    if (!gate.allowed) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('dsh-lan-proxy: source address is not in the allowlist\n')
      return
    }
    const incomingAuthority = typeof request.headers['host'] === 'string' ? request.headers['host'] : ''
    const info = { targetAuthority, incomingAuthority, source: gate.source }
    const headers = rewriteRequestHeaders(request.headers, info, false)
    const upstream = httpRequest(
      {
        host: targetHost,
        port: targetPort,
        method: request.method,
        path: request.url,
        headers,
        agent: false,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, filterResponseHeaders(upstreamResponse.headers))
        upstreamResponse.pipe(response)
        upstreamResponse.on('error', () => response.destroy())
      },
    )
    upstream.on('error', (error) => {
      if (response.headersSent) {
        response.destroy()
        return
      }
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`dsh-lan-proxy: upstream unreachable: ${error.message}\n`)
    })
    response.on('close', () => {
      if (!upstream.destroyed) upstream.destroy()
    })
    request.pipe(upstream)
  })

  server.on('upgrade', (request, socket, head) => {
    const gate = allowedFor(request)
    if (!gate.allowed) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const incomingAuthority = typeof request.headers['host'] === 'string' ? request.headers['host'] : ''
    const info = { targetAuthority, incomingAuthority, source: gate.source }
    const headers = rewriteRequestHeaders(request.headers, info, true)
    const upstream = netConnect(targetPort, targetHost, () => {
      upstream.write(`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1\r\n${serializeHeaders(headers)}\r\n`)
      if (head !== undefined && head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    const entry = { client: socket, upstream }
    upgradedSockets.add(entry)
    const drop = () => {
      upgradedSockets.delete(entry)
      socket.destroy()
      upstream.destroy()
    }
    socket.on('error', drop)
    upstream.on('error', drop)
    socket.on('close', () => {
      upgradedSockets.delete(entry)
      upstream.destroy()
    })
    upstream.on('close', () => {
      upgradedSockets.delete(entry)
      socket.destroy()
    })
  })

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(bindPort, bindHost, () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.on('error', (error) => log(`listener error: ${error.message}`))

  const address = server.address()
  return {
    host: typeof address === 'object' && address !== null ? address.address : bindHost,
    port: typeof address === 'object' && address !== null ? address.port : bindPort,
    close: () => closeListener(server, upgradedSockets),
  }
}

//#endregion

//#region plugin wiring

/** Read this plugin's current configuration through a `source()` sink. */
function applyPlugin(ctx, entryConfig) {
  let generation = 0
  /** Active listener as `{ handle, config, targetPort, urlsPrinted }`, or null. */
  let listener = null
  const log = (message) => console.log(`${LOG_PREFIX} ${message}`)

  const targetPortNow = () => {
    if (entryConfig.targetPort > 0) return entryConfig.targetPort
    const port = ctx.get('webServer')?.port
    return typeof port === 'number' && port > 0 ? port : undefined
  }

  const waitForTargetPort = async (mine) => {
    const deadline = Date.now() + TARGET_PORT_TIMEOUT_MS
    for (;;) {
      if (mine !== generation) return undefined
      const port = targetPortNow()
      if (port !== undefined) return port
      if (Date.now() >= deadline) return undefined
      await sleep(TARGET_PORT_POLL_MS)
    }
  }

  /**
   * Print the reachable LAN URLs once, carrying the process token so a remote
   * device can complete the same `?token=` → cookie exchange. Deferred until
   * the Connection service exists, because it owns the token.
   */
  const printLanUrls = () => {
    const active = listener
    if (active === null || active.urlsPrinted) return
    const connection = ctx.get('connection')
    if (connection === undefined) {
      log('LAN URLs pending: waiting for the Connection service to supply the auth token')
      return
    }
    active.urlsPrinted = true
    const urls = lanAddresses().slice(0, MAX_BANNER_URLS)
    for (const address of urls) {
      const plain = `http://${address.family === 6 ? `[${address.text}]` : address.text}:${String(active.handle.port)}/`
      log(`LAN: ${connection.authenticatedUrl(plain)}`)
    }
    if (urls.length === 0) log('no non-internal addresses found for LAN URLs')
  }

  const printBanner = (config, handle, targetPort) => {
    log(`listening on ${formatAuthority(config.host, handle.port)} → ${formatAuthority(config.targetHost, targetPort)}`)
    log(`allowed sources: ${config.allow.length > 0 ? config.allow.join(', ') : '(loopback only)'}${isLoopbackBind(config.host) ? ' [loopback bind]' : ''}`)
    printLanUrls()
  }

  const reconfigure = async () => {
    const mine = ++generation
    const config = entryConfig
    const previous = listener
    listener = null
    if (previous !== null) {
      await previous.handle.close()
      if (mine !== generation) return
    }
    if (config.enabled !== true) {
      log('disabled (config: dsh-lan-proxy.enabled)')
      return
    }
    const { rules, errors } = compileAllowlist(config.allow)
    if (errors.length > 0) {
      log('refusing to start; fix these allow entries:')
      for (const error of errors) log(`  - ${error}`)
      return
    }
    if (rules.length === 0 && !isLoopbackBind(config.host)) {
      log(`refusing to start: bind ${config.host} is not loopback and allow[] is empty — add the source IPs/CIDRs you want to open (config: dsh-lan-proxy.allow)`)
      return
    }
    const targetPort = await waitForTargetPort(mine)
    if (mine !== generation) return
    if (targetPort === undefined) {
      log(`target ${config.targetHost} port never became available; not starting`)
      return
    }
    await closing
    if (mine !== generation) return
    let handle
    try {
      handle = await startProxy({
        bindHost: config.host,
        bindPort: config.port,
        targetHost: config.targetHost,
        targetPort,
        rules,
        log,
      })
    } catch (error) {
      log(`failed to listen on ${formatAuthority(config.host, config.port)}: ${error.message}`)
      return
    }
    if (mine !== generation) {
      await handle.close()
      return
    }
    listener = { handle, config, targetPort, urlsPrinted: false }
    printBanner(config, handle, targetPort)
  }

  // Configuration now arrives as this entry's resolved Config: dsh 0.1.7
  // derives the settings section from the exported schema and restarts the
  // fiber when a value changes, so a fresh apply is the hot-reload path.
  ctx.inject(['webServer'], () => {
    void reconfigure()
  })
  // The Connection service owns the process token; print deferred LAN URLs
  // as soon as it appears (its row usually settles after ours).
  ctx.inject(['connection'], () => {
    printLanUrls()
  })

  ctx.effect(
    () => () => {
      generation++
      const active = listener
      listener = null
      if (active !== null) closing = active.handle.close()
    },
    'lan-proxy listener',
  )
}

/**
 * Mount the proxy.
 * @param ctx - plugin context (webServer/settings/connection read optionally).
 * @param entryConfig - composition entry configuration for this row.
 */
function apply(ctx, entryConfig = {}) {
  applyPlugin(ctx, Config(entryConfig ?? {}))
}

//#endregion

export {
  Config,
  ENTRY_ID,
  apply,
  assertStartable,
  bitsMatch,
  compileAllowlist,
  filterResponseHeaders,
  formatAuthority,
  isLoopback,
  matchesAllowlist,
  name,
  normalizeIp,
  rewriteRequestHeaders,
  startProxy,
}
