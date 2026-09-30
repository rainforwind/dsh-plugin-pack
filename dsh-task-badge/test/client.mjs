// Standalone test for the dsh-task-badge browser half.
// Run with: node test/client.mjs
// Materializes the client module exactly as the ModuleLoader does (stubbed
// window/document/Image + stubbed require('react') + stubbed cordis context),
// then exercises: resolving the session on screen, ordering mark-viewed ahead
// of the counts read, the unread arithmetic, click-to-navigate, and the
// favicon badge across both color schemes.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

// ── stub DOM: the shell ships one icon link per color scheme ───────────────

let prefersDark = false

function makeLink(attrs) {
  const store = { ...attrs }
  return {
    parentNode: null,
    isConnected: true,
    get href() { return store.href ?? '' },
    set href(v) { store.href = v },
    get type() { return store.type ?? '' },
    set type(v) { store.type = v },
    getAttribute(n) { return n in store ? store[n] : null },
    setAttribute(n, v) { store[n] = v },
    removeAttribute(n) { delete store[n] },
    store,
  }
}

const darkLink = makeLink({
  rel: 'icon', type: 'image/svg+xml',
  href: 'http://127.0.0.1:3080/favicon-dark.svg',
  media: '(prefers-color-scheme: dark)',
})
const lightLink = makeLink({
  rel: 'icon', type: 'image/svg+xml',
  href: 'http://127.0.0.1:3080/favicon.svg',
  media: '(prefers-color-scheme: light)',
})
const original = new Map([
  [darkLink, { href: darkLink.href, type: darkLink.getAttribute('type') }],
  [lightLink, { href: lightLink.href, type: lightLink.getAttribute('type') }],
])

const head = {
  children: [],
  appendChild(node) { node.parentNode = head; node.isConnected = true; head.children.push(node) },
  removeChild(node) {
    const i = head.children.indexOf(node)
    if (i >= 0) head.children.splice(i, 1)
    node.parentNode = null; node.isConnected = false
  },
}

const drawCalls = []
function makeCanvas() {
  return {
    width: 0, height: 0,
    getContext() {
      const ctx = {}
      for (const m of ['beginPath', 'arc', 'fill', 'stroke', 'fillText', 'drawImage']) {
        ctx[m] = (...args) => { if (m === 'drawImage') drawCalls.push(args) }
      }
      return ctx
    },
    toDataURL() { return 'data:image/png;base64,BADGE' },
  }
}

const images = []
function FakeImage() {
  const img = { onload: null, onerror: null, _src: '' }
  Object.defineProperty(img, 'src', {
    get() { return img._src },
    set(v) { img._src = v; images.push(v); queueMicrotask(() => img.onload && img.onload()) },
  })
  return img
}

let loaded = null
globalThis.document = {
  baseURI: 'http://127.0.0.1:3080/',
  head,
  querySelectorAll(sel) { return sel.includes('rel*=') ? [darkLink, lightLink] : [] },
  // `querySelector` yields the FIRST match, which is the trap this plugin
  // fell into: only the dark-scheme link ever got patched.
  querySelector(sel) {
    if (sel.includes("rel*='icon'")) return darkLink
    if (sel.includes("rel='icon'")) return darkLink
    return null
  },
  createElement(tag) { return tag === 'canvas' ? makeCanvas() : makeLink({}) },
}
globalThis.window = {
  __ModuleLoader__: { load(mod) { loaded = mod } },
  matchMedia(query) { return { matches: query.includes('dark') ? prefersDark : !prefersDark } },
}
globalThis.Image = FakeImage

// ── stub React (hooks run once per render, state persists like the real thing)

let hookState = []
let hookIndex = 0
const React = {
  useState(initial) {
    const i = hookIndex++
    if (!(i in hookState)) hookState[i] = initial
    const setter = (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v }
    return [hookState[i], setter]
  },
  useEffect(fn) { hookIndex++; fn() },
  createElement(type, props, ...children) { return { type, props, children } },
}
const require_ = (id) => {
  if (id === 'react') return React
  throw new Error(`unknown module ${id}`)
}

// ── stub cordis context, sessions store and job counts ─────────────────────

let snapshot = { ids: [], byId: {}, phase: 'ready' }
const sessions = { list: { getSnapshot: () => snapshot } }
const opened = []
const uiWorkspace = { openSession(id) { opened.push(id) } }
const intervalMs = []
const disposers = []
const registered = []
const slots = {
  inject(hole, factory) { registered.push({ hole, slot: factory() }) },
  register(spec, render) { return { spec, render } },
}
const ctx = {
  get(name) {
    if (name === 'sessions') return sessions
    if (name === 'uiWorkspace') return uiWorkspace
    if (name === 'slots') return slots
    return undefined
  },
  interval(fn, ms) { intervalMs.push(ms); disposers.push(fn); return () => {} },
  effect(fn) { const d = fn(); disposers.push(d); return d },
}

let countsResponse = {}
const calls = []
globalThis.fetch = async (url, opts) => {
  calls.push({ url, method: opts ? opts.method : 'GET', body: opts && opts.body })
  if (url.endsWith('/task-badge/mark-viewed')) return { ok: true, json: async () => ({ ok: true }) }
  if (url.endsWith('/task-badge/counts')) return { ok: true, json: async () => countsResponse }
  throw new Error(`unexpected url ${url}`)
}

// ── materialize the factory the way __ModuleLoader__ would ─────────────────

snapshot = {
  ids: ['ses-current', 'ses-other', 'child'],
  byId: {
    'ses-current': { id: 'ses-current', retainedBy: { mainView: 1 } },
    'ses-other': { id: 'ses-other', retainedBy: {} },
    'child': { id: 'child', retainedBy: {}, origin: 'subagent' },
  },
  phase: 'ready',
}
countsResponse = {
  running: 0,
  unreadSessionIds: ['ses-current', 'ses-other', 'child'],
  unviewedJobs: 0,
  unviewedJobSessionIds: [],
}

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
new Function('window', 'document', 'Image', source)(globalThis.window, globalThis.document, globalThis.Image)
assert.ok(loaded, 'module never loaded')
const plugin = loaded.factory(require_)

plugin.apply(ctx)
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) }
const runPoll = async () => { await disposers[0](); await flush() }
await flush()

// Mount the sidebar badge — the favicon and poll have to survive this.
const descriptor = registered[0].slot.render()
const render = () => { hookIndex = 0; return descriptor.type() }
let element = render()
await flush()
element = render()
await flush()

const posted = () => calls.filter((c) => c.method === 'POST')

// ── tests ──────────────────────────────────────────────────────────────────

await test('the slot lands on the sidebar footer', async () => {
  assert.equal(registered[0].hole, 'sidebar.footer.action')
  assert.equal(intervalMs[0], 3000)
})

await test('the session on screen resolves from byId / retainedBy.mainView', async () => {
  // The snapshot has no `.current`; reading one used to yield null always.
  assert.ok(posted().length > 0, 'mark-viewed was never sent')
  assert.equal(JSON.parse(posted()[0].body).sessionId, 'ses-current')
})

await test('mark-viewed is issued before the counts read', async () => {
  assert.deepEqual([calls[0].method, calls[1].method], ['POST', 'GET'])
})

await test('the badge drops the session on screen and the subagent child', async () => {
  assert.ok(element, 'badge did not render')
  assert.equal(element.props.title, '1 unread — click to view')
})

await test('clicking opens a real unread session, never the one on screen', async () => {
  opened.length = 0
  await element.props.onClick()
  await flush()
  assert.deepEqual(opened, ['ses-other'])
})

await test('the favicon badge reaches both icon links (light scheme)', async () => {
  assert.equal(images[0], 'http://127.0.0.1:3080/favicon.svg', 'base art must follow the scheme on screen')
  assert.equal(darkLink.href, 'data:image/png;base64,BADGE')
  assert.equal(lightLink.href, 'data:image/png;base64,BADGE')
  assert.equal(darkLink.getAttribute('type'), 'image/png')
  assert.equal(lightLink.getAttribute('type'), 'image/png')
})

await test('the favicon badge reaches both icon links (dark scheme)', async () => {
  prefersDark = true
  countsResponse = { running: 1, unreadSessionIds: ['ses-other'], unviewedJobs: 0, unviewedJobSessionIds: [] }
  await runPoll()

  assert.equal(images[images.length - 1], 'http://127.0.0.1:3080/favicon-dark.svg')
  assert.equal(darkLink.href, 'data:image/png;base64,BADGE')
  assert.equal(lightLink.href, 'data:image/png;base64,BADGE')
})

await test('zero counts restore both original favicons', async () => {
  prefersDark = false
  countsResponse = { running: 0, unreadSessionIds: [], unviewedJobs: 0, unviewedJobSessionIds: [] }
  await runPoll()

  assert.equal(darkLink.href, original.get(darkLink).href)
  assert.equal(lightLink.href, original.get(lightLink).href)
  assert.equal(darkLink.getAttribute('type'), original.get(darkLink).type)
  assert.equal(lightLink.getAttribute('type'), original.get(lightLink).type)
})

await test('with nothing selected the host is told to release it', async () => {
  snapshot = { ids: {}, byId: {}, phase: 'ready' }
  countsResponse = { running: 0, unreadSessionIds: ['ses-other'], unviewedJobs: 0, unviewedJobSessionIds: [] }
  calls.length = 0
  await runPoll()

  assert.equal(posted().length, 1)
  assert.equal(JSON.parse(posted()[0].body).sessionId, null)
})

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`)
process.exit(failures.length > 0 ? 1 : 0)
