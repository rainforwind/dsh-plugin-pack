// Standalone test for the dsh-session-manager browser half.
// Run with: node test/client.test.mjs
//
// The bug this suite pins: the plugin used to declare only `slots` in its
// client inject list, so the restricted client context never handed it the
// locale service. The dictionaries were never registered, the host translator
// bound to `dsh-session-manager` fell through to the shared `common` namespace
// (which knows `cancel` and nothing else), and the dialog rendered
// `confirm.title`, `confirm.desc`, `err.resident`, ... plus a translated
// "Cancel" — exactly the mixture users saw.
//
// Two worlds are exercised on a materialized module (stubbed window/document,
// stubbed React hooks, stubbed cordis context):
//   * the old broken wiring (no locale service reachable) must still show
//     legible copy from the built-in dictionaries, never raw keys;
//   * the fixed wiring (`inject: ['slots', 'locale']` -> ctx.locale) must
//     register both dictionaries and follow the app language through bind(),
//     including the resident-refusal -> force path from the report.

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
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)) }

// ── stub DOM and window ────────────────────────────────────────────────────

const docListeners = []

function resetDom() {
  docListeners.length = 0
  // Node ships a read-only `navigator`; replace it with the browser shape.
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN', languages: ['zh-CN'] },
    configurable: true,
    writable: true,
  })
  globalThis.document = {
    baseURI: 'http://127.0.0.1:54800/',
    activeElement: null,
    addEventListener(type, fn) { docListeners.push({ type, fn }) },
    removeEventListener(type, fn) {
      const i = docListeners.findIndex((l) => l.type === type && l.fn === fn)
      if (i >= 0) docListeners.splice(i, 1)
    },
  }
  globalThis.window = { __ModuleLoader__: { load(mod) { loaded = mod } } }
}

// ── stub React: real hook semantics per component instance ─────────────────

let instances = new Map()
let currentInst = null
let loaded = null

function withHooks(inst, fn) {
  const previous = currentInst
  const previousCursor = inst.cursor
  currentInst = inst
  inst.cursor = 0
  try { return fn() } finally { currentInst = previous; inst.cursor = previousCursor }
}

const React = {
  useState(initial) {
    const inst = currentInst
    const i = inst.cursor++
    if (!(i in inst.state)) inst.state[i] = initial
    const setter = (value) => { inst.state[i] = typeof value === 'function' ? value(inst.state[i]) : value }
    return [inst.state[i], setter]
  },
  useRef(initial) {
    const inst = currentInst
    const i = inst.cursor++
    if (!(i in inst.state)) inst.state[i] = { current: initial }
    return inst.state[i]
  },
  useEffect(fn, deps) {
    const inst = currentInst
    const i = inst.cursor++
    const previous = inst.deps[i]
    const changed = !deps || previous === undefined || deps.length !== previous.length
      || deps.some((value, index) => !Object.is(value, previous[index]))
    if (!changed) return
    if (inst.cleanups[i]) { try { inst.cleanups[i]() } catch (error) { /* ignore */ } inst.cleanups[i] = null }
    const cleanup = fn()
    inst.cleanups[i] = typeof cleanup === 'function' ? cleanup : null
    inst.deps[i] = deps ? deps.slice() : undefined
  },
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
}

function renderNode(node, key) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${key}/${index}`))
  if (typeof node !== 'object' || !('type' in node)) return node
  const type = node.type
  const props = node.props || {}
  const selfKey = `${key}|${typeof type === 'function' ? (type.name || 'anon') : String(type)}`
  if (typeof type === 'function') {
    let inst = instances.get(selfKey)
    if (!inst) { inst = { state: [], deps: [], cleanups: [], cursor: 0 }; instances.set(selfKey, inst) }
    const output = withHooks(inst, () => type(props))
    return renderNode(output, selfKey)
  }
  return { type, props, children: (node.children || []).map((child, index) => renderNode(child, `${selfKey}/${index}`)) }
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, predicate, out)); return out }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object' || !('type' in node)) return ''
  if (node.type === 'style') return ''
  return textOf(node.children)
}

const buttonsIn = (root) => findAll(root, (node) => node.type === 'button')
const buttonByText = (root, text) => buttonsIn(root).find((button) => textOf(button).includes(text))

function unmount(prefix) {
  for (const [key, inst] of instances) {
    if (!key.startsWith(prefix)) continue
    for (const cleanup of inst.cleanups) { try { if (typeof cleanup === 'function') cleanup() } catch (error) { /* ignore */ } }
  }
}

// A raw key must never reach the screen: every visible string is either real
// copy or, at worst, a word without the namespace.key shape.
const RAW_KEY = /\b(?:menu|confirm|err|toast|cancel|pending)\.[a-z][\w.-]*/i
function assertNoRawKeys(root, label) {
  const text = textOf(root)
  assert.ok(!RAW_KEY.test(text), `${label}: raw locale key leaked into the UI: ${JSON.stringify(text)}`)
  return text
}

// ── host locale service, faithful to LocaleRuntime.translate ───────────────

const COMMON = { zh: { cancel: '取消' }, en: { cancel: 'Cancel' } }

function substitute(text, params) {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

function makeLocaleService() {
  const dicts = new Map()
  const registrations = []
  let active = 'en'
  const service = {
    registrations,
    get active() { return active },
    setActive(id) { active = id },
    register(ns, localeOrDicts, dict) {
      const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts)
      let locales = dicts.get(ns)
      if (!locales) { locales = new Map(); dicts.set(ns, locales) }
      for (const [locale] of pairs) if (locales.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
      for (const [locale, entries] of pairs) locales.set(locale, entries)
      registrations.push({ ns, locales: pairs.map(([locale]) => locale) })
      return () => { for (const [locale] of pairs) if (locales.get(locale) === (dicts.get(ns) || new Map()).get(locale)) locales.delete(locale) }
    },
    bind(ns) {
      return (key, params) => {
        const dict = dicts.get(ns) || new Map()
        let text = (dict.get(active) || {})[key]
        if (text === undefined) text = (dict.get('en') || {})[key]
        if (text === undefined && ns !== 'common') {
          text = (COMMON[active] || {})[key]
          if (text === undefined) text = COMMON.en[key]
        }
        if (text === undefined) return key
        return substitute(text, params)
      }
    },
    has(ns, locale) { return !!(dicts.get(ns) && dicts.get(ns).has(locale)) },
  }
  return service
}

// ── stub cordis context / slots ────────────────────────────────────────────

function makeSlots(table) {
  return {
    inject(hole, factory) { table.push({ hole, slot: factory() }); return () => {} },
    register(spec, component) { return { spec, component } },
  }
}

function makeCtx({ locale, slots }) {
  const cleanups = []
  const ctx = {
    ctxEffects: cleanups,
    get(name) {
      if (name === 'slots') return slots
      // The restricted client context only exposes injected services. With
      // `locale` missing from `inject` (the bug), this is what the plugin saw.
      if (name === 'locale') return locale
      return undefined
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose); return dispose },
    locale,
  }
  // A context that never declares locale has no `ctx.locale` either; apply()
  // reads ctx.locale first and falls back to ctx.get.
  if (!locale) delete ctx.locale
  return ctx
}

// ── stubbed host routes ────────────────────────────────────────────────────

let stateReply = { exists: true, archived: true, live: false }
let deleteReply = () => ({ status: 200, body: { ok: true, ghost: false, forced: false } })
const fetchCalls = []

function installFetch() {
  fetchCalls.length = 0
  globalThis.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET'
    fetchCalls.push({ url, method, body: options && options.body })
    const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
    if (url.includes('/dsh-session-manager/state')) return reply(200, { ok: true, state: stateReply })
    if (url.includes('/dsh-session-manager/delete')) {
      const next = deleteReply({ url, method, body: options && options.body })
      return reply(next.status, next.body)
    }
    return reply(404, {})
  }
}

// ── module materialization ─────────────────────────────────────────────────

const SOURCE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

function materialize() {
  instances = new Map()
  loaded = null
  resetDom()
  installFetch()
  new Function('window', 'document', SOURCE)(globalThis.window, globalThis.document)
  assert.ok(loaded, 'module never loaded')
  return loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  })
}

function registration(table, id) {
  const found = table.find((row) => row.slot.spec.id === id)
  assert.ok(found, `slot registration ${id} missing`)
  return found.slot
}

// The host turns a registration's `hooks` into selector hooks and spreads the
// rest of `inject()` onto the component props.
function propsFor(slot, extra) {
  const injected = slot.spec.inject ? slot.spec.inject() : {}
  const { hooks, ...rest } = injected
  const props = { ...rest, ...extra }
  for (const [name, observable] of Object.entries(hooks || {})) {
    props[`use${name[0].toUpperCase()}${name.slice(1)}`] = (selector) => selector(observable.getSnapshot())
  }
  return props
}

const echoT = (key) => (key === 'cancel' ? 'Cancel' : key)
const menuOpenState = () => [true, () => {}]

// ── tests ──────────────────────────────────────────────────────────────────

await test('client declares the locale service in its inject list', () => {
  const plugin = materialize()
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
})

await test('broken wiring (no locale service) still shows copy, never keys', async () => {
  const plugin = materialize()
  const table = []
  const ctx = makeCtx({ slots: makeSlots(table) })
  plugin.apply(ctx)

  const menuSlot = registration(table, 'dsh-session-manager.delete')
  const props = propsFor(menuSlot, { sessionId: 'ses-1', displayTitle: 'Old session', useMenuOpenState: menuOpenState, t: echoT })
  let tree = renderNode(React.createElement(menuSlot.component, props), 'bug/menu')
  await flush()
  tree = renderNode(React.createElement(menuSlot.component, props), 'bug/menu')
  const menuText = assertNoRawKeys(tree, 'menu item')
  assert.ok(menuText.includes('删除…'), `menu item should be localized: ${JSON.stringify(menuText)}`)
  assert.ok(!menuText.includes('menu.delete'), 'menu.delete leaked')

  // Open the dialog the way the row does.
  const button = buttonsIn(tree)[0]
  assert.ok(button, 'delete row did not render a button')
  button.props.onClick()
  unmount('bug/menu')

  const dialogSlot = registration(table, 'dsh-session-manager.delete-confirm')
  dialogSlot.spec.inject()
  const dialogProps = () => propsFor(dialogSlot, { t: echoT })
  let dialog = renderNode(React.createElement(dialogSlot.component, dialogProps()), 'bug/dialog')
  let dialogText = assertNoRawKeys(dialog, 'dialog (open, no locale service)')
  assert.ok(dialogText.includes('删除已归档会话？'), `dialog title not localized: ${JSON.stringify(dialogText)}`)
  assert.ok(dialogText.includes('Old session'), 'dialog lost the session title')
  assert.ok(dialogText.includes('Cancel'), 'the shared cancel copy should still resolve')
  assert.ok(!dialogText.includes('confirm.title') && !dialogText.includes('confirm.action'), 'raw dialog keys leaked')
  unmount('bug/dialog')
})

await test('fixed wiring registers both dictionaries and follows the app language', async () => {
  const plugin = materialize()
  const locale = makeLocaleService()
  const table = []
  const ctx = makeCtx({ locale, slots: makeSlots(table) })
  plugin.apply(ctx)

  assert.equal(locale.registrations.length, 1, 'dictionaries were not registered')
  assert.equal(locale.registrations[0].ns, 'dsh-session-manager')
  assert.deepEqual(locale.registrations[0].locales.sort(), ['en', 'zh'])
  assert.ok(locale.has('dsh-session-manager', 'en') && locale.has('dsh-session-manager', 'zh'))
  // The app language is English even though the browser reports zh-CN: the
  // bound translator wins over navigator.language.
  assert.equal(locale.active, 'en')

  const t = locale.bind('dsh-session-manager')
  assert.equal(t('confirm.title'), 'Delete archived session?')
  assert.equal(t('err.resident').includes('still open somewhere'), true)

  const menuSlot = registration(table, 'dsh-session-manager.delete')
  const menuProps = propsFor(menuSlot, { sessionId: 'ses-1', displayTitle: 'Old session', useMenuOpenState: menuOpenState, t })
  let menu = renderNode(React.createElement(menuSlot.component, menuProps), 'ok/menu')
  await flush()
  menu = renderNode(React.createElement(menuSlot.component, menuProps), 'ok/menu')
  const menuText = assertNoRawKeys(menu, 'menu item (fixed)')
  assert.ok(menuText.includes('Delete…'), `menu item should follow the app language: ${JSON.stringify(menuText)}`)
  buttonsIn(menu)[0].props.onClick()
  unmount('ok/menu')

  const dialogSlot = registration(table, 'dsh-session-manager.delete-confirm')
  const dialogProps = () => propsFor(dialogSlot, { t })
  let dialog = renderNode(React.createElement(dialogSlot.component, dialogProps()), 'ok/dialog')
  const dialogText = assertNoRawKeys(dialog, 'dialog (fixed)')
  assert.ok(dialogText.includes('Delete archived session?'), `title: ${JSON.stringify(dialogText)}`)
  assert.ok(dialogText.includes('Delete permanently'), `action: ${JSON.stringify(dialogText)}`)
  assert.ok(dialogText.includes('Cancel'), 'cancel label')
  unmount('ok/dialog')
})

await test('resident refusal offers force with localized copy and no raw keys', async () => {
  const plugin = materialize()
  const locale = makeLocaleService()
  const table = []
  const ctx = makeCtx({ locale, slots: makeSlots(table) })
  plugin.apply(ctx)
  const t = locale.bind('dsh-session-manager')

  const dialogSlot = registration(table, 'dsh-session-manager.delete-confirm')
  const dialogProps = () => propsFor(dialogSlot, { t })
  const pending = dialogSlot.spec.inject().hooks.pending
  pending.set({ sessionId: 'ses-1', displayTitle: 'Old session', exists: true })

  let dialog = renderNode(React.createElement(dialogSlot.component, dialogProps()), 'resident/dialog')
  assert.ok(textOf(dialog).includes('Delete archived session?'))

  deleteReply = () => ({ status: 409, body: { error: 'resident', message: 'session is still resident' } })
  const danger = buttonByText(dialog, 'Delete permanently')
  assert.ok(danger, 'delete action button missing')
  danger.props.onClick()
  await flush()

  dialog = renderNode(React.createElement(dialogSlot.component, dialogProps()), 'resident/dialog')
  const dialogText = assertNoRawKeys(dialog, 'dialog (resident refusal)')
  assert.ok(dialogText.includes('This session is still open somewhere'), `expected the resident copy: ${JSON.stringify(dialogText)}`)
  assert.ok(dialogText.includes('Force delete (held instance)'), 'force escape hatch missing')
  assert.ok(!dialogText.includes('err.resident'), 'raw err.resident leaked — the reported bug')
  assert.equal(fetchCalls.filter((call) => call.method === 'POST').length, 1)

  // Force succeeds: the dialog closes and the toast explains the caveat.
  deleteReply = () => ({ status: 200, body: { ok: true, ghost: false, forced: true } })
  buttonByText(dialog, 'Force delete (held instance)').props.onClick()
  await flush()
  assert.equal(pending.getSnapshot(), null, 'dialog did not dismiss after a forced delete')

  const toastSlot = registration(table, 'dsh-session-manager.delete-toast')
  const toastProps = propsFor(toastSlot, { t })
  const toast = renderNode(React.createElement(toastSlot.component, toastProps), 'resident/toast')
  const toastText = assertNoRawKeys(toast, 'toast (forced)')
  assert.ok(toastText.includes('Force-deleted'), `toast title: ${JSON.stringify(toastText)}`)
  assert.ok(toastText.includes('Old session'), 'toast lost the session title')
  const forcedPost = fetchCalls.filter((call) => call.method === 'POST').pop()
  assert.deepEqual(JSON.parse(forcedPost.body), { sessionId: 'ses-1', force: true })
  unmount('resident/toast')
  unmount('resident/dialog')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`\n${label}\n${error.stack ?? error}`)
  process.exitCode = 1
}
