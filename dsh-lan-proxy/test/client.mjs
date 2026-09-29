// Standalone test for the dsh-lan-proxy browser half.
// Run with: node test/client.mjs
// Materializes the client module exactly as the ModuleLoader does (stubbed
// window + stubbed require('react')), then exercises the CardModel state
// machine against a mock settings scope: staging, revision-fenced saves,
// conflict refusal, discard, reset-to-defaults, and allow-entry validation.

import assert from 'node:assert/strict'

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

const fakeReact = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  }),
  useState: () => {
    throw new Error('Card rendered without a renderer (expected: not rendered in this test)')
  },
  useSyncExternalStore: () => {
    throw new Error('Card rendered without a renderer (expected: not rendered in this test)')
  },
  useEffect: () => {
    throw new Error('Card rendered without a renderer (expected: not rendered in this test)')
  },
}

await import('../client/client.js')
assert.ok(descriptor, 'module registered a load descriptor')
assert.equal(descriptor.id, 'dsh-lan-proxy', 'load id equals the package name')

const exported = descriptor.factory((id) => {
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require: ${id}`)
})
const { CardModel, allowEntryReason, draftFromValue, equalsCurrent, opsFromDraft, parseAllowText, validateDraft } =
  exported.__test

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
  assert.deepEqual(captured.served, ['dsh-lan-proxy'])
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

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`)
process.exit(failures.length > 0 ? 1 : 0)
