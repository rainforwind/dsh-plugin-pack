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
const { CardModel, allowEntryError, draftFromValue, equalsCurrent, opsFromDraft, parseAllowText, validateDraft } =
  exported.__test

// ── mock settings scope (Host write semantics: revision-fenced, folded) ────

const DEFAULTS = { enabled: false, host: '0.0.0.0', port: 3081, allow: [], targetHost: '127.0.0.1', targetPort: 0 }

function makeScope(initial = {}, options = {}) {
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
  assert.deepEqual(exported.inject, ['slots', 'settingsScope'])
  assert.equal(typeof exported.apply, 'function')
  assert.equal(typeof exported.Card, 'function')
})

await test('apply binds the lan-proxy namespace and registers the keyed slot', () => {
  const scope = makeScope()
  const captured = { bind: null, slot: null, register: null }
  const ctx = {
    inject(list, callback) {
      assert.deepEqual(list, ['settingsScope'])
      callback({
        settingsScope: {
          bind(spec) {
            captured.bind = spec
            return scope
          },
        },
      })
    },
    slots: {
      inject(key, callback) {
        assert.equal(key, 'settings.plugin.item')
        captured.slot = callback()
      },
      register(options, factory) {
        captured.register = { options, element: factory() }
        return () => {}
      },
    },
  }
  exported.apply(ctx)
  assert.deepEqual(captured.bind, { namespace: 'lan-proxy' })
  assert.equal(captured.register.options.key, 'lan-proxy')
  assert.equal(captured.register.options.name, 'settings.plugin.item')
  assert.equal(captured.register.element.type, exported.Card)
})

// ── allow-entry validation ─────────────────────────────────────────────────

await test('valid allow entries pass', () => {
  for (const entry of ['192.168.0.102', '100.64.0.1', '10.0.0.0/8', '255.255.255.255/32', 'fd7a:115c:a1e0::1', 'fd00::/8', 'fe80::1%eth0', '[::1]', '0.0.0.0/0']) {
    assert.equal(allowEntryError(entry), null, `${entry} should be valid`)
  }
})

await test('invalid allow entries are rejected with messages', () => {
  assert.notEqual(allowEntryError(''), null)
  assert.notEqual(allowEntryError('banana'), null)
  assert.notEqual(allowEntryError('1.2.3'), null)
  assert.notEqual(allowEntryError('1.2.3.999'), null)
  assert.notEqual(allowEntryError('10.0.0.0/33'), null)
  assert.notEqual(allowEntryError('fd00::1/129'), null)
  assert.notEqual(allowEntryError('10.0.0.0/8/9'), null)
  assert.notEqual(allowEntryError('192.168.0.5, 10.0.0.1'), null)
})

await test('parseAllowText trims, splits lines, drops blanks', () => {
  assert.deepEqual(parseAllowText(' 10.0.0.1 \n\n10.0.0.2\r\n'), ['10.0.0.1', '10.0.0.2'])
  assert.deepEqual(parseAllowText(''), [])
  assert.deepEqual(parseAllowText(undefined), [])
})

await test('validateDraft reports per-field errors', () => {
  const draft = { ...draftFromValue({}), host: '', port: 'abc', targetPort: '70000', allowText: 'bad-entry' }
  const result = validateDraft(draft)
  assert.equal(result.ok, false)
  assert.ok(result.errors.host)
  assert.ok(result.errors.port)
  assert.ok(result.errors.targetPort)
  assert.ok(result.errors.allow)
  const clean = validateDraft({ ...draftFromValue({}), port: '3081', targetPort: '0' })
  assert.equal(clean.ok, true)
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

await test('initial view is clean, available, closed', () => {
  const model = new CardModel(makeScope())
  const view = model.view
  assert.equal(view.available, true)
  assert.equal(view.writable, true)
  assert.equal(view.dirty, false)
  assert.equal(view.open, false)
  assert.equal(view.saving, false)
  model.dispose()
})

await test('edit stages a draft and marks the card dirty', async () => {
  const scope = makeScope()
  const model = new CardModel(scope)
  model.toggleOpen()
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
  assert.equal(model.view.open, false, 'card collapses after a successful save')
  assert.equal(scope.getSnapshot().value.port, 9999)
  model.dispose()
})

await test('editing back to the current value clears the draft', () => {
  const model = new CardModel(makeScope())
  model.edit({ port: '3081' })
  assert.equal(model.view.dirty, false, 'no-op edit stages nothing')
  model.edit({ port: '9999' })
  model.edit({ port: '3081' })
  assert.equal(model.view.dirty, false, 'returning to the saved value clears the draft')
  model.dispose()
})

await test('an external write raises conflict and fences the save', async () => {
  const scope = makeScope()
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
  const scope = makeScope()
  const model = new CardModel(scope)
  model.edit({ port: '9999' })
  scope.externalSet('port', 9999)
  assert.equal(model.view.dirty, false)
  assert.equal(model.view.conflict, false)
  model.dispose()
})

await test('discard drops the draft without writing', () => {
  const scope = makeScope()
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
  const scope = makeScope()
  const model = new CardModel(scope)
  model.edit({ port: 'not-a-port' })
  assert.equal(model.view.invalid, true)
  await model.save()
  assert.equal(scope.calls.length, 0)
  model.dispose()
})

await test('reset unsets every field back to the composition defaults', async () => {
  const scope = makeScope({ enabled: true, port: 9999, allow: ['10.0.0.1'] })
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
  const scope = makeScope({}, { status: 'unavailable' })
  const model = new CardModel(scope)
  model.edit({ port: '9999' })
  assert.equal(model.view.available, false)
  assert.equal(model.view.dirty, false, 'unavailable scope stages nothing')
  model.dispose()
})

await test('dispose detaches the scope subscription', () => {
  const scope = makeScope()
  const model = new CardModel(scope)
  model.dispose()
  scope.externalSet('port', 1234)
  assert.equal(model.view.dirty, false)
  assert.equal(model.view.fields.port, '3081', 'disposed model no longer follows the scope')
})

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`)
process.exit(failures.length > 0 ? 1 : 0)
