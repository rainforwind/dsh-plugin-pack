// Standalone test for the dsh-lan-proxy browser half.
// Run with: node test/client.mjs
// Materializes the client module exactly as the ModuleLoader does (stubbed
// window + stubbed require('react')), then exercises the CardModel state
// machine against a mock settings scope: staging, revision-fenced saves,
// conflict refusal, discard, reset-to-defaults, and allow-entry validation.

import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'

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

// ── materialize the factory the way __ModuleLoader__ would ─────────────────

let descriptor
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      descriptor = value
    },
  },
}

// A minimal hook host: enough of React's contract to render a function
// component, hold its useState slots across re-renders, and re-render when an
// event handler calls a setter. Anything more (a real reconciler) would not
// tell us more than the assertions on the returned element tree do.
let hookCursor = 0
const hookSlots = []
const effects = []
const fakeReact = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  }),
  useState: (initial) => {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = typeof initial === 'function' ? initial() : initial
    return [
      hookSlots[index],
      (next) => {
        hookSlots[index] = typeof next === 'function' ? next(hookSlots[index]) : next
      },
    ]
  },
  useRef: (initial) => {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = { current: initial }
    return hookSlots[index]
  },
  useEffect: (effect) => {
    effects.push(effect)
  },
  useSyncExternalStore: () => {
    throw new Error('Component used useSyncExternalStore without a renderer')
  },
}

/** Render a component, then re-render it after each hook-state change. */
function renderHook(Component, props) {
  const render = () => {
    hookCursor = 0
    effects.length = 0
    const tree = Component(props)
    for (const effect of effects) effect()
    return tree
  }
  const handle = {
    tree: render(),
    // Events are driven by calling the props the tree declared; a re-render is
    // what makes the resulting state observable.
    act(fn) {
      fn()
      handle.tree = render()
    },
  }
  return handle
}

await import('../client/client.js')
assert.ok(descriptor, 'module registered a load descriptor')
assert.equal(descriptor.id, 'dsh-lan-proxy', 'load id equals the package name')

const exported = descriptor.factory((id) => {
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require: ${id}`)
})
const {
  Card,
  CardModel,
  LanUrlCard,
  QrHint,
  allowEntryReason,
  draftFromValue,
  equalsCurrent,
  opsFromDraft,
  parseAllowText,
  qrDataUrl,
  qrMatrix,
  readLanInfo,
  validateDraft,
} = exported.__test

// ── mock config form (Host write semantics: revision-fenced, folded) ───────

const DEFAULTS = { enabled: false, host: '0.0.0.0', port: 3081, allow: [], targetHost: '127.0.0.1', targetPort: 0 }

function makeForm(initial = {}, options = {}) {
  let base = { ...DEFAULTS, ...(options.base ?? {}) }
  const userFields = { ...initial }
  let revision = 1
  let status = options.status ?? 'ready'
  const listeners = new Set()
  const calls = []
  const value = () => ({ ...base, ...userFields })
  const snapshot = () => ({ status, value: value(), base, user: Object.keys(userFields), revision, writable: status === 'ready', mode: status === 'ready' ? 'host' : 'memory' })
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    calls,
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(ops, expectedRevision) {
      calls.push({ ops: ops.map((op) => ({ ...op, path: [...op.path] })), expectedRevision })
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        return { ok: false, reason: 'revision' }
      }
      for (const op of ops) {
        const field = op.path[0]
        if (op.op === 'set') userFields[field] = op.value
        else if (op.op === 'unset') delete userFields[field]
        else throw new Error(`unexpected op ${op.op}`)
      }
      revision += 1
      notify()
      return { ok: true }
    },
    // Simulate another page writing the same namespace.
    externalSet(field, fieldValue) {
      userFields[field] = fieldValue
      revision += 1
      notify()
    },
    setStatus(next) {
      status = next
      notify()
    },
  }
}

// ── module surface ─────────────────────────────────────────────────────────

await test('module exports the cordis plugin surface', () => {
  assert.equal(exported.name, 'dsh-lan-proxy-client')
  assert.deepEqual(exported.inject, ['slots', 'locale', 'configForms'])
  assert.equal(exported.ENTRY_ID, 'dsh-lan-proxy')
  assert.equal(typeof exported.apply, 'function')
  assert.equal(typeof exported.Card, 'function')
})

await test('apply edits the entry form and registers both pages', () => {
  const form = makeForm()
  const captured = { get: null, served: null, injected: [], registered: [], dictionaries: null, effects: 0 }
  const unserved = { whileServed: false }
  const ctx = {
    effect(fn) {
      captured.effects++
      return fn()
    },
    locale: {
      register(ns, dict) {
        captured.dictionaries = { ns, dict }
        return () => {}
      },
      bind(ns) {
        return (key) => `${String(ns)}:${String(key)}`
      },
    },
    configForms: {
      get(entryId) {
        captured.get = entryId
        return form
      },
      whileServed(namespaces, register) {
        // The page must not depend on this gate any more: it used to make a
        // missing tab look like a missing plugin.
        unserved.whileServed = true
        captured.served = namespaces
        return register(new Set(namespaces))
      },
    },
    slots: {
      inject(name, callback) {
        captured.injected.push({ name, off: callback() })
        return () => {}
      },
      register(options, factory) {
        captured.registered.push({ ...options, element: factory({ view: undefined }) })
        return () => {}
      },
    },
  }
  exported.apply(ctx)

  // The form is the Host section of this very entry, not a legacy namespace.
  assert.equal(captured.get, 'dsh-lan-proxy')
  assert.equal(unserved.whileServed, false, 'registration does not wait for the section')
  assert.equal(captured.dictionaries.ns, 'settings.lanProxy')
  assert.ok(captured.dictionaries.dict.zh.title)
  assert.ok(captured.dictionaries.dict.en.title)

  assert.deepEqual(
    captured.injected.map((entry) => entry.name),
    ['settings.plugins.tab', 'plugins.item'],
  )
  for (const entry of captured.registered) {
    assert.equal(entry.id, 'lan-proxy')
    assert.equal(entry.locale, 'settings.lanProxy')
    assert.equal(entry.label(), 'settings.lanProxy:title')
    assert.equal(entry.element.type, exported.Card)
  }
})

// ── allow-entry validation ─────────────────────────────────────────────────

await test('valid allow entries pass', () => {
  for (const entry of ['192.168.0.102', '100.64.0.1', '10.0.0.0/8', '255.255.255.255/32', 'fd7a:115c:a1e0::1', 'fd00::/8', 'fe80::1%eth0', '[::1]', '0.0.0.0/0']) {
    assert.equal(allowEntryReason(entry), null, `${entry} should be valid`)
  }
})

await test('invalid allow entries are rejected with messages', () => {
  assert.notEqual(allowEntryReason(''), null)
  assert.notEqual(allowEntryReason('banana'), null)
  assert.notEqual(allowEntryReason('1.2.3'), null)
  assert.notEqual(allowEntryReason('1.2.3.999'), null)
  assert.notEqual(allowEntryReason('10.0.0.0/33'), null)
  assert.notEqual(allowEntryReason('fd00::1/129'), null)
  assert.notEqual(allowEntryReason('10.0.0.0/8/9'), null)
  assert.notEqual(allowEntryReason('192.168.0.5, 10.0.0.1'), null)
})

await test('parseAllowText trims, splits lines, drops blanks', () => {
  assert.deepEqual(parseAllowText(' 10.0.0.1 \n\n10.0.0.2\r\n'), ['10.0.0.1', '10.0.0.2'])
  assert.deepEqual(parseAllowText(''), [])
  assert.deepEqual(parseAllowText(undefined), [])
})

await test('validateDraft reports locale-neutral per-field errors', () => {
  const draft = { ...draftFromValue({}), host: '', port: 'abc', targetPort: '70000', allowText: 'bad-entry' }
  const result = validateDraft(draft)
  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.host, { key: 'required' })
  assert.deepEqual(result.errors.port, { key: 'portRange' })
  assert.deepEqual(result.errors.targetPort, { key: 'portRange' })
  assert.deepEqual(result.errors.allow, { key: 'allowLine', line: 1, entry: 'bad-entry', reason: 'notIp' })
  const clean = validateDraft({ ...draftFromValue({}), port: '3081', targetPort: '0' })
  assert.equal(clean.ok, true)
})

await test('validateDraft names the offending allow line and reason', () => {
  const errors = validateDraft({ ...draftFromValue({}), allowText: '10.0.0.1\n10.0.0.0/99' }).errors
  assert.equal(errors.allow.key, 'allowLine')
  assert.equal(errors.allow.line, 2)
  assert.equal(errors.allow.reason, 'prefixRange')
  const duplicate = validateDraft({ ...draftFromValue({}), allowText: '10.0.0.1\n10.0.0.1' }).errors
  assert.equal(duplicate.allow.reason, 'duplicate')
})

// ── draft helpers ──────────────────────────────────────────────────────────

await test('equalsCurrent compares normalized values', () => {
  const value = { ...DEFAULTS, allow: ['10.0.0.1', '10.0.0.2'], port: 3081 }
  assert.equal(equalsCurrent(value, draftFromValue(value)), true)
  const draft = { ...draftFromValue(value), port: '3081 ' }
  assert.equal(equalsCurrent(value, draft), false)
  assert.equal(equalsCurrent(value, { ...draftFromValue(value), allowText: '10.0.0.1' }), false)
  assert.equal(equalsCurrent({ ...value, enabled: true }, draftFromValue(value)), false)
})

await test('opsFromDraft writes every field with typed values', () => {
  const draft = { ...draftFromValue({}), enabled: true, port: '9999', allowText: '10.0.0.1\n10.0.0.2', targetPort: '0' }
  const ops = opsFromDraft(draft)
  assert.equal(ops.length, 6)
  const byField = Object.fromEntries(ops.map((op) => [op.path[0], op.value]))
  assert.equal(byField.enabled, true)
  assert.equal(byField.port, 9999)
  assert.deepEqual(byField.allow, ['10.0.0.1', '10.0.0.2'])
  assert.equal(byField.targetPort, 0)
})

// ── CardModel lifecycle ────────────────────────────────────────────────────

await test('initial view is clean and available', () => {
  const model = new CardModel(makeForm())
  const view = model.view
  assert.equal(view.available, true)
  assert.equal(view.writable, true)
  assert.equal(view.dirty, false)
  assert.equal(view.saving, false)
  assert.equal(view.invalid, false)
  assert.equal(view.fields.host, '0.0.0.0')
  assert.equal(view.fields.allowText, '')
  model.dispose()
})

await test('edit stages a draft and marks the card dirty', async () => {
  const scope = makeForm()
  const model = new CardModel(scope)
  model.edit({ port: '9999' })
  assert.equal(model.view.dirty, true)
  assert.equal(model.view.fields.port, '9999')
  assert.equal(scope.calls.length, 0)
  await model.save()
  assert.equal(scope.calls.length, 1)
  assert.equal(scope.calls[0].expectedRevision, 1)
  const setOps = scope.calls[0].ops.filter((op) => op.op === 'set')
  assert.equal(setOps.length, 6)
  assert.equal(model.view.dirty, false)
  assert.equal(scope.getSnapshot().value.port, 9999)
  model.dispose()
})

await test('editing back to the current value clears the draft', () => {
  const model = new CardModel(makeForm())
  model.edit({ port: '3081' })
  assert.equal(model.view.dirty, false, 'no-op edit stages nothing')
  model.edit({ port: '9999' })
  model.edit({ port: '3081' })
  assert.equal(model.view.dirty, false, 'returning to the saved value clears the draft')
  model.dispose()
})

await test('an external write raises conflict and fences the save', async () => {
  const scope = makeForm()
  const model = new CardModel(scope)
  model.edit({ port: '9999' })
  scope.externalSet('port', 4000)
  assert.equal(model.view.conflict, true, 'conflict flagged when the revision moves')
  assert.equal(model.view.dirty, true, 'edits are kept')
  await model.save()
  assert.equal(scope.calls.length, 0, 'fenced save never reaches the Host')
  assert.equal(model.view.conflict, true)
  model.dispose()
})

await test('an external write equal to the draft clears it silently', () => {
  const scope = makeForm()
  const model = new CardModel(scope)
  model.edit({ port: '9999' })
  scope.externalSet('port', 9999)
  assert.equal(model.view.dirty, false)
  assert.equal(model.view.conflict, false)
  model.dispose()
})

await test('discard drops the draft without writing', () => {
  const scope = makeForm()
  const model = new CardModel(scope)
  model.edit({ allowText: '10.0.0.1' })
  assert.equal(model.view.dirty, true)
  model.discard()
  assert.equal(model.view.dirty, false)
  assert.equal(scope.calls.length, 0)
  assert.equal(scope.getSnapshot().value.allow.length, 0)
  model.dispose()
})

await test('an invalid draft refuses to save', async () => {
  const scope = makeForm()
  const model = new CardModel(scope)
  model.edit({ port: 'not-a-port' })
  assert.equal(model.view.invalid, true)
  await model.save()
  assert.equal(scope.calls.length, 0)
  model.dispose()
})

await test('reset unsets every field back to the composition defaults', async () => {
  const scope = makeForm({ enabled: true, port: 9999, allow: ['10.0.0.1'] })
  const model = new CardModel(scope)
  await model.reset()
  assert.equal(scope.calls.length, 1)
  assert.ok(scope.calls[0].ops.every((op) => op.op === 'unset'))
  assert.deepEqual(scope.getSnapshot().value, DEFAULTS)
  assert.equal(model.view.failed, false)
  assert.equal(model.view.dirty, false)
  model.dispose()
})

await test('a read-only snapshot disables staging', () => {
  const scope = makeForm({}, { status: 'unavailable' })
  const model = new CardModel(scope)
  model.edit({ port: '9999' })
  assert.equal(model.view.available, false)
  assert.equal(model.view.dirty, false, 'unavailable scope stages nothing')
  model.dispose()
})

await test('dispose detaches the form subscription', () => {
  const scope = makeForm()
  const model = new CardModel(scope)
  model.dispose()
  scope.externalSet('port', 1234)
  assert.equal(model.view.dirty, false)
  assert.equal(model.view.fields.port, '3081', 'disposed model no longer follows the scope')
})

await test('readLanInfo treats a missing global as unavailable', () => {
  delete globalThis.window.__DSH_LAN_PROXY_URLS__
  const info = readLanInfo()
  assert.equal(info.available, false)
  assert.equal(info.enabled, false)
  assert.equal(info.bound, false)
  assert.deepEqual(info.urls, [])
})

await test('readLanInfo keeps only address/url rows and the flags', () => {
  globalThis.window.__DSH_LAN_PROXY_URLS__ = {
    enabled: true,
    bound: true,
    urls: [
      { address: '100.64.0.1', url: 'http://100.64.0.1:3082/?token=a', family: 4 },
      { address: '192.168.1.2' },
      null,
      { address: '10.0.0.1', url: 'http://10.0.0.1:3082/?token=b', family: 4 },
    ],
  }
  const info = readLanInfo()
  assert.equal(info.available, true)
  assert.equal(info.enabled, true)
  assert.equal(info.bound, true)
  assert.deepEqual(
    info.urls.map((entry) => entry.address),
    ['100.64.0.1', '10.0.0.1'],
  )
  delete globalThis.window.__DSH_LAN_PROXY_URLS__
})

// ── QR encoding for the LAN URL hover hint ─────────────────────────────────
//
// Structural checks only: these cannot prove a camera will read the code, so a
// real URL is decoded independently in test/qr-decode.py when zbar is present.

await test('qrMatrix picks the smallest version that fits the payload', () => {
  // Version 1/M holds 16 data codewords: 4 bits mode + 8 bits length leaves
  // 14 bytes of payload.
  assert.equal(qrMatrix('a'.repeat(14)).length, 21, '14 bytes still fits version 1')
  assert.equal(qrMatrix('a'.repeat(15)).length, 25, '15 bytes needs version 2')
})

await test('qrMatrix encodes a real token URL', () => {
  const url = 'http://100.64.0.1:3081/?token=0123456789abcdef0123456789abcdef'
  assert.equal(Buffer.byteLength(url), 62, 'the sample is a realistic 62-byte URL')
  // Version 3/M holds 42 payload bytes and version 4/M holds 62, so this lands
  // exactly at the version-4 boundary.
  const matrix = qrMatrix(url)
  assert.equal(matrix.length, 33, 'a 62-byte URL fits version 4')
  for (const row of matrix) assert.equal(row.length, 33, 'the matrix is square')
})

await test('qrMatrix lays out finder, timing and dark modules', () => {
  const matrix = qrMatrix('http://10.0.0.1:3081/?token=abc')
  const size = matrix.length
  // Finder pattern: 7x7 ring with a 3x3 core, at three corners.
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(matrix[row][col], true, 'finder outer corner is dark')
    assert.equal(matrix[row + 1][col + 1], false, 'finder ring is light inside')
    assert.equal(matrix[row + 3][col + 3], true, 'finder core is dark')
  }
  // Timing patterns alternate along row 6 and column 6.
  for (let i = 8; i < size - 8; i++) {
    assert.equal(matrix[6][i], i % 2 === 0, `row-6 timing at ${String(i)}`)
    assert.equal(matrix[i][6], i % 2 === 0, `column-6 timing at ${String(i)}`)
  }
  assert.equal(matrix[size - 8][8], true, 'the format area keeps its always-dark module')
})

await test('qrMatrix refuses a payload beyond version 10', () => {
  assert.equal(qrMatrix('a'.repeat(214)), undefined, 'one byte past the 213-byte ceiling')
  assert.notEqual(qrMatrix('a'.repeat(213)), undefined, 'the ceiling itself still encodes')
})

await test('qrMatrix encodes multi-byte text as UTF-8', () => {
  // 19 characters, but 58 UTF-8 bytes: the version must follow the byte count,
  // since byte mode stores bytes. Version 3/M holds 42 payload bytes and
  // version 4/M holds 62, so a character-counted length (which would be 19
  // bytes) would wrongly have produced a 25x25 matrix here.
  const text = '地址地址地址地址地址地址地址地址地址𐍈'
  assert.equal(Buffer.byteLength(text, 'utf8'), 58)
  assert.equal(qrMatrix(text).length, 33, 'utf8 byte length drives the version choice')
  // The 4-byte astral character must survive as one code point, not two lone
  // surrogates, which would encode 3 bytes each instead of 4.
  const astralOnly = '𐍈'
  assert.equal([...astralOnly].length, 1)
  assert.equal(Buffer.byteLength(astralOnly, 'utf8'), 4)
})

await test('qrDataUrl emits a PNG data URL and caches by payload', () => {
  const url = 'http://100.64.0.1:3081/?token=deadbeef'
  const first = qrDataUrl(url)
  assert.match(first, /^data:image\/png;base64,/, 'the hint renders a PNG image')
  assert.equal(qrDataUrl(url), first, 'a repeated render reuses the cached string')
  const png = Buffer.from(first.slice('data:image/png;base64,'.length), 'base64')
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'carries the PNG signature',
  )
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR', 'starts with an IHDR chunk')
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('latin1'), 'IEND', 'ends with IEND')
  // The IHDR width must match the matrix plus the 4-module quiet zone each side.
  const side = png.readUInt32BE(16)
  assert.equal(side, (qrMatrix(url).length + 8) * 8, 'canvas covers matrix plus quiet zone')
})

await test('qrMatrix returns null rather than throwing on an oversized payload', () => {
  assert.equal(qrDataUrl(`http://10.0.0.1/?token=${'a'.repeat(300)}`), null)
})

// The encoder was validated module-for-module against an independent
// implementation (the Python `qrcode` library) for every payload length from 1
// to 213 bytes, covering versions 1-10 and every Reed-Solomon block split. The
// checks below pin the specific structures that validation caught, so a
// regression fails here without needing that reference installed.

await test('qrMatrix draws the alignment patterns, including the version-2 one', () => {
  // A version-2 code has one alignment pattern, at (18,18). Until version 7 it
  // is the only one, and skipping it by treating it as a finder overlap was a
  // real defect: the data zigzag then wrote into those modules.
  const matrix = qrMatrix('a'.repeat(15))
  assert.equal(matrix.length, 25, '15 bytes is the first payload that reaches version 2')
  const ring = (row, col) => {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const expected = Math.max(Math.abs(r), Math.abs(c)) !== 1
        assert.equal(matrix[row + r][col + c], expected, `alignment module (${String(row + r)},${String(col + c)})`)
      }
    }
  }
  ring(18, 18)
})

await test('qrMatrix draws all six alignment patterns of a 3x3 grid', () => {
  // Version 8 has centres [6,24,42]: nine combinations minus the three that
  // collide with a finder pattern leaves six.
  const matrix = qrMatrix('a'.repeat(151))
  assert.equal(matrix.length, 49, 'a 151-byte payload is version 8')
  for (const row of [6, 24, 42]) {
    for (const col of [6, 24, 42]) {
      if ((row === 6 && col === 6) || (row === 6 && col === 42) || (row === 42 && col === 6)) {
        continue
      }
      assert.equal(matrix[row - 2][col - 2], true, `alignment ring start (${String(row - 2)},${String(col - 2)})`)
      assert.equal(matrix[row - 1][col - 1], false, `alignment ring gap (${String(row - 1)},${String(col - 1)})`)
      assert.equal(matrix[row][col], true, `alignment core (${String(row)},${String(col)})`)
    }
  }
})

await test('qrMatrix reserves the version-information blocks from version 7', () => {
  // Versions 7+ carry an 18-bit version block beside the top-right and
  // bottom-left finders. Omitting them let the data zigzag write into those
  // modules, which corrupted every code at version 7 and above.
  const matrix = qrMatrix('a'.repeat(151))
  const size = matrix.length
  const bits = []
  for (let i = 0; i < 18; i++) bits.push(matrix[Math.floor(i / 3)][size - 11 + (i % 3)])
  // Version 8 information reads as the spec's printed codeword when the block
  // is walked i = 0..17 across the three columns.
  const expected = '001111011010000100'.split('').map((digit) => digit === '1')
  assert.deepEqual(bits, expected, 'top-right version block encodes version 8')
  for (let i = 0; i < 18; i++) {
    assert.equal(
      matrix[size - 11 + (i % 3)][Math.floor(i / 3)],
      expected[i],
      `bottom-left version block bit ${String(i)}`,
    )
  }
})

await test('qrMatrix keeps the timing patterns free of format bits', () => {
  // The format-information arms run along row 8 and column 8, which cross the
  // row-6 and column-6 timing patterns. Writing format bits into those
  // crossings silently broke the timing pattern in every code.
  for (const length of [1, 65, 201]) {
    const matrix = qrMatrix('a'.repeat(length))
    const size = matrix.length
    for (let i = 8; i < size - 8; i++) {
      assert.equal(matrix[6][i], i % 2 === 0, `row-6 timing at ${String(i)} (payload ${String(length)})`)
      assert.equal(matrix[i][6], i % 2 === 0, `column-6 timing at ${String(i)} (payload ${String(length)})`)
    }
  }
})

await test('qrMatrix carries the version bits for every version 7-10', () => {
  // Each version's BCH(18,6) codeword, walked the way a scanner reads it.
  const expected = new Map([
    [7, '001010010011111000'],
    [8, '001111011010000100'],
    [9, '100110010101100100'],
    [10, '110010110010010100'],
  ])
  // The first payload length that reaches each version, so the search below
  // knows a size is actually reachable before scanning for it.
  const reached = new Map()
  for (let length = 1; length <= 213; length++) {
    const size = qrMatrix('a'.repeat(length)).length
    if (!reached.has(size)) reached.set(size, length)
  }
  for (const [version, codeword] of expected) {
    const size = version * 4 + 17
    const length = reached.get(size)
    assert.ok(length, `some payload produces version ${String(version)}`)
    const matrix = qrMatrix('a'.repeat(length))
    const bits = []
    for (let i = 0; i < 18; i++) bits.push(matrix[Math.floor(i / 3)][size - 11 + (i % 3)] ? '1' : '0')
    assert.equal(bits.join(''), codeword, `version ${String(version)} information block`)
    // The bottom-left block carries the same 18 bits, transposed.
    for (let i = 0; i < 18; i++) {
      assert.equal(
        matrix[size - 11 + (i % 3)][Math.floor(i / 3)],
        codeword[i] === '1',
        `version ${String(version)} bottom-left bit ${String(i)}`,
      )
    }
  }
})

await test('qrDataUrl emits a spec-shaped PNG', () => {
  const png = Buffer.from(
    qrDataUrl('http://100.64.0.1:3081/?token=deadbeef').slice('data:image/png;base64,'.length),
    'base64',
  )
  // IHDR must be 13 bytes: width, height, bit depth, colour type, and three
  // reserved bytes. A shorter header produced a file no decoder would open.
  assert.equal(png.readUInt32BE(8), 13, 'IHDR payload length')
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20), 'the image is square')
  assert.equal(png[24], 8, 'bit depth 8')
  assert.equal(png[25], 0, 'greyscale colour type')
  assert.equal(png[26], 0, 'deflate compression')
  assert.equal(png[27], 0, 'adaptive filtering')
  assert.equal(png[28], 0, 'no interlace')
  // The IDAT payload must be a zlib stream a decoder accepts, and it must hold
  // the unfiltered greyscale scanlines. inflate() verifies the Adler-32 trailer
  // itself, so a successful inflate proves the checksum is right.
  const side = png.readUInt32BE(16)
  assert.equal(png.readUInt32BE(33), png.length - 57, 'one IDAT chunk holds the whole image')
  assert.equal(png[41], 0x78, 'zlib header')
  const idat = png.subarray(41, png.length - 12)
  const raw = inflateSync(Buffer.from(idat))
  assert.equal(raw.length, (side + 1) * side, 'one filter byte plus one scanline per row')
  for (let row = 0; row < side; row++) {
    assert.equal(raw[row * (side + 1)], 0, `row ${String(row)} uses filter type 0`)
  }
  // Every pixel is pure black or pure white: a greyscale QR image with no
  // anti-aliased greys, which is what keeps the modules crisp when scaled.
  const pixels = new Set(raw.subarray(1))
  assert.deepEqual([...pixels].sort((left, right) => left - right), [0, 255])
})

await test('QrHint reveals the code on hover and hides it again', () => {
  const url = 'http://100.64.0.1:3081/?token=deadbeef'
  const t = (key) => key
  const hint = renderHook(QrHint, { t, url })
  // Closed: only the URL is in the tree, so no PNG is encoded on idle renders.
  assert.equal(hint.tree.type, 'span')
  assert.equal(hint.tree.props.children[1], null, 'nothing is rendered while closed')
  hint.act(() => hint.tree.props.onMouseEnter())
  const popover = hint.tree.props.children[1]
  assert.equal(popover.type, 'div')
  assert.equal(popover.props.role, 'tooltip')
  const image = popover.props.children[0]
  assert.equal(image.type, 'img')
  assert.match(image.props.src, /^data:image\/png;base64,/, 'the popover holds the rendered PNG')
  assert.equal(image.props.alt, 'qrAlt', 'the image alt text is localized')
  hint.act(() => hint.tree.props.onMouseLeave())
  assert.equal(hint.tree.props.children[1], null, 'leaving the hint closes it again')
})

await test('QrHint opens for keyboard and click, and toggles on a second click', () => {
  const t = (key) => key
  const hint = renderHook(QrHint, { t, url: 'http://10.0.0.1:3081/?token=abc' })
  const code = () => hint.tree.props.children[0]
  assert.equal(code().props.tabIndex, 0, 'the URL is reachable by Tab')
  assert.equal(code().props['aria-describedby'], undefined, 'nothing to describe while closed')
  hint.act(() => code().props.onFocus())
  assert.equal(hint.tree.props.children[1].type, 'div', 'focus opens the tooltip')
  assert.equal(typeof code().props['aria-describedby'], 'string', 'the open tooltip is described')
  hint.act(() => code().props.onBlur())
  assert.equal(hint.tree.props.children[1], null, 'blur closes it')
  hint.act(() => code().props.onClick())
  assert.equal(hint.tree.props.children[1].type, 'div', 'a click opens it for touch users')
  hint.act(() => code().props.onClick())
  assert.equal(hint.tree.props.children[1], null, 'a second click closes it')
})

await test('QrHint gives each address a distinct tooltip id', () => {
  const t = (key) => key
  const first = renderHook(QrHint, { t, url: 'http://100.64.0.1:3081/?token=a' })
  const second = renderHook(QrHint, { t, url: 'http://100.64.0.1:3081/?token=b' })
  first.act(() => first.tree.props.children[0].props.onFocus())
  second.act(() => second.tree.props.children[0].props.onFocus())
  const firstId = first.tree.props.children[1].props.id
  const secondId = second.tree.props.children[1].props.id
  assert.notEqual(firstId, secondId, 'duplicate ids would misdirect aria-describedby')
  assert.equal(first.tree.props.children[0].props['aria-describedby'], firstId)
  assert.equal(second.tree.props.children[0].props['aria-describedby'], secondId)
})

await test('QrHint reports an unencodable URL instead of a broken image', () => {
  const t = (key) => key
  const hint = renderHook(QrHint, { t, url: `http://10.0.0.1/?token=${'a'.repeat(300)}` })
  hint.act(() => hint.tree.props.children[0].props.onFocus())
  const child = hint.tree.props.children[1].props.children[0]
  assert.equal(child.type, 'span', 'no <img> is emitted')
  assert.equal(child.props.children, 'qrTooLong', 'the card explains why')
})

await test('LanUrlCard lists every address with a copy button and a QR hint', () => {
  const t = (key) => key
  const urls = [
    { address: '100.64.0.1', url: 'http://100.64.0.1:3081/?token=a' },
    { address: '10.0.0.1', url: 'http://10.0.0.1:3081/?token=b' },
  ]
  const card = renderHook(LanUrlCard, { t, info: { available: true, enabled: true, bound: true, urls } })
  const list = card.tree.props.children[2]
  assert.equal(list.props.children.length, 2, 'one row per address')
  for (const [index, row] of list.props.children.entries()) {
    const [hint, button] = row.props.children
    assert.equal(hint.type, QrHint, `row ${String(index)} carries the QR hint`)
    assert.equal(hint.props.url, urls[index].url)
    assert.equal(button.type, 'button', `row ${String(index)} carries a copy button`)
    assert.equal(button.props.children, 'copy', 'the button reads as the copy action')
  }
})

await test('LanUrlCard explains an empty list instead of rendering nothing', () => {
  const t = (key) => key
  const empty = { available: true, enabled: true, bound: false, urls: [] }
  const card = renderHook(LanUrlCard, { t, info: empty })
  const message = card.tree.props.children[2]
  assert.equal(message.props.children, 'lanUrlUnavailable', 'binding not ready yet')
  const disabled = renderHook(LanUrlCard, { t, info: { available: true, enabled: false, bound: false, urls: [] } })
  assert.equal(disabled.tree.props.children[2].props.children, 'lanUrlDisabled', 'proxy switched off')
})

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`)
process.exit(failures.length > 0 ? 1 : 0)
