// Standalone test for the dsh-quick-actions browser half.
// Run with: node test/client.mjs
// Materializes the client module exactly as the ModuleLoader does (stubbed
// window/document + stubbed require('react') with per-component hook state +
// stubbed cordis context), then exercises: slot registration into both strips
// and the overlay, the buttons fetch with its session context, running a
// command and reading its output in the popover, the "+" configuration panel
// (add a row, save to the host), the failure path, and Escape dismissal.

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

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) }

// ── stub DOM and window ────────────────────────────────────────────────────

let loaded = null
const docListeners = []
globalThis.document = {
  baseURI: 'http://127.0.0.1:3080/',
  addEventListener(type, fn) { docListeners.push({ type, fn }) },
  removeEventListener(type, fn) {
    const i = docListeners.findIndex((l) => l.type === type && l.fn === fn)
    if (i >= 0) docListeners.splice(i, 1)
  },
  querySelectorAll() { return [] },
}
globalThis.window = {
  __ModuleLoader__: { load(mod) { loaded = mod } },
}

// ── stub React: real hook semantics per component instance ─────────────────

const instances = new Map()
let currentInst = null

function withHooks(inst, fn) {
  const previous = currentInst
  const previousCursor = inst.cursor
  currentInst = inst
  inst.cursor = 0
  try { return fn(); } finally { currentInst = previous; inst.cursor = previousCursor; }
}

const React = {
  useState(initial) {
    const inst = currentInst;
    const i = inst.cursor++;
    if (!(i in inst.state)) inst.state[i] = initial;
    const setter = (value) => { inst.state[i] = typeof value === 'function' ? value(inst.state[i]) : value; };
    return [inst.state[i], setter];
  },
  useRef(initial) {
    const inst = currentInst;
    const i = inst.cursor++;
    if (!(i in inst.state)) inst.state[i] = { current: initial };
    return inst.state[i];
  },
  useEffect(fn, deps) {
    const inst = currentInst;
    const i = inst.cursor++;
    const previous = inst.deps[i];
    const changed = !deps || previous === undefined || deps.length !== previous.length
      || deps.some((value, index) => !Object.is(value, previous[index]));
    if (!changed) return;
    if (inst.cleanups[i]) { try { inst.cleanups[i](); } catch (error) { /* ignore */ } inst.cleanups[i] = null; }
    const cleanup = fn();
    inst.cleanups[i] = typeof cleanup === 'function' ? cleanup : null;
    inst.deps[i] = deps ? deps.slice() : undefined;
  },
  createElement(type, props, ...children) {
    return { type, props: props || {}, children };
  },
}

// Render a tree: function components get their own hook container keyed by
// position, DOM nodes carry their rendered children.
function renderNode(node, key) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${key}/${index}`));
  if (typeof node !== 'object' || !('type' in node)) return node;
  const type = node.type;
  const props = node.props || {};
  const selfKey = `${key}|${typeof type === 'function' ? (type.name || 'anon') : String(type)}|${props.key === undefined ? '' : props.key}`;
  if (typeof type === 'function') {
    let inst = instances.get(selfKey);
    if (!inst) { inst = { state: [], deps: [], cleanups: [], cursor: 0 }; instances.set(selfKey, inst); }
    const output = withHooks(inst, () => type(props));
    return renderNode(output, selfKey);
  }
  return { type, props, children: (node.children || []).map((child, index) => renderNode(child, `${selfKey}/${index}`)) };
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, predicate, out)); return out; }
  if (typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  findAll(node.children, predicate, out);
  return out;
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object') return '';
  if (!('type' in node)) return '';
  return textOf(node.children);
}

const buttonsIn = (root) => findAll(root, (node) => node.type === 'button');
const buttonByText = (root, text) => buttonsIn(root).find((button) => textOf(button).includes(text));

// ── stub cordis context ────────────────────────────────────────────────────

const registered = []
const slots = {
  inject(hole, factory) { registered.push({ hole, slot: factory() }); },
  register(spec, component) { return { spec, component }; },
}

let sessionSnapshot = {
  ids: ['ses-1'],
  byId: {
    'ses-1': { id: 'ses-1', title: 'Main', retainedBy: { mainView: 1 } },
    'ses-2': { id: 'ses-2', title: 'Other', retainedBy: {} },
  },
}
const sessions = { list: { getSnapshot: () => sessionSnapshot } };
const workspaces = { list: { getSnapshot: () => ({ items: [
  { workspaceId: 'ws-a', title: 'Proj A', path: '/proj/a', sessionIds: ['ses-1'] },
] }) } };

const localeCalls = []
const locale = {
  register(ns, dicts) { localeCalls.push({ ns, dicts }); return () => {}; },
};

const intervals = []
const cleanups = []
const ctx = {
  get(name) {
    if (name === 'slots') return slots;
    if (name === 'sessions') return sessions;
    if (name === 'workspaces') return workspaces;
    if (name === 'locale') return locale;
    return undefined;
  },
  interval(fn, ms) { intervals.push({ fn, ms }); return () => {}; },
  effect(fn) { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d; },
};

// ── stub fetch ─────────────────────────────────────────────────────────────

let buttonsResponse = {}
let runGetResponse = { ok: true, run: null }
let runPostResponse = { ok: true, joined: false, instanceKey: 'g:clean', run: null }
let configResponse = { ok: true, buttons: [], configButtons: [], storePath: '/tmp/qa.json' }
let configPostResponse = { ok: true, buttons: [], configButtons: [] }
let runPostStatus = 200
const fetchCalls = []

globalThis.fetch = async (url, options) => {
  const method = (options && options.method) || 'GET';
  fetchCalls.push({ url, method, body: options && options.body });
  const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  if (url.includes('/quick-actions/buttons')) return reply(200, buttonsResponse);
  if (url.includes('/quick-actions/run')) {
    if (method === 'POST') return reply(runPostStatus, runPostResponse);
    return reply(200, runGetResponse);
  }
  if (url.includes('/quick-actions/kill')) return reply(200, { ok: true, run: null });
  if (url.includes('/quick-actions/config')) {
    if (method === 'POST') return reply(runPostStatus === 200 ? 200 : runPostStatus, configPostResponse);
    return reply(200, configResponse);
  }
  throw new Error(`unexpected url ${url}`);
};

// ── materialize the factory the way __ModuleLoader__ would ────────────────

const completedRun = {
  runId: 'run-1', buttonId: 'clean', instanceKey: 'w:clean:ws-a', status: 'completed',
  command: 'rm -rf dist', workdir: '/proj/a', startedAt: 1, endedAt: 2,
  exitCode: 0, signal: null, text: 'dist removed\n', dropped: 0,
}
const runningSummary = { runId: 'run-2', status: 'running', startedAt: 3, endedAt: null }

buttonsResponse = {
  ok: true,
  sessionId: 'ses-1',
  workspaceId: 'ws-a',
  buttons: [
    { id: 'clean', label: 'Clean', icon: '🧹', command: 'rm -rf dist', workdir: '', scope: 'workspace', target: '', source: 'store', instanceKey: 'w:clean:ws-a', run: { runId: 'run-1', status: 'completed', startedAt: 1, endedAt: 2 } },
    { id: 'serve', label: 'Serve', command: 'npm run dev', workdir: '', scope: 'session', target: '', source: 'store', instanceKey: 's:serve:ses-1', run: runningSummary },
    { id: 'status', label: 'Status', command: 'git -C {workspace} status', workdir: '', scope: 'global', target: '', source: 'store', instanceKey: 'g:status', run: null },
  ],
}
runPostResponse = {
  ok: true, joined: false, instanceKey: 'w:clean:ws-a',
  run: { ...completedRun, status: 'running', text: '', endedAt: null, exitCode: null },
}
runGetResponse = { ok: true, run: { ...completedRun, status: 'running', text: 'dist removed\n', endedAt: null, exitCode: null } }

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
new Function('window', 'document', source)(globalThis.window, globalThis.document);
assert.ok(loaded, 'module never loaded');
const plugin = loaded.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unknown module ${id}`);
});

plugin.apply(ctx);
await flush();

// The framework hands a session-scoped slot its `sessionId`; the stub does the
// same so both strips exercise their real prop contracts.
const slotProps = {
  'conversation.session.header.actions': { sessionId: 'ses-1' },
  'sidebar.footer.action': {},
  'shell.overlay': {},
};

const renderSlot = (hole) => {
  const entry = registered.find((r) => r.hole === hole);
  assert.ok(entry, `slot ${hole} was never registered`);
  // Build an element instead of calling the component: even the bare Overlay
  // must run inside the hook container renderNode provides.
  return renderNode({ type: entry.slot.component, props: slotProps[hole], children: [] }, hole);
};

// ── tests ──────────────────────────────────────────────────────────────────

await test('the plugin lands in both strips and the overlay slot', async () => {
  assert.deepEqual(registered.map((r) => r.hole).sort(), [
    'conversation.session.header.actions',
    'shell.overlay',
    'sidebar.footer.action',
  ]);
  for (const entry of registered) {
    assert.equal(entry.slot.spec.name, entry.hole);
    assert.equal(entry.slot.spec.id, 'quick-actions');
    assert.equal(entry.slot.spec.locale, 'quick-actions');
  }
});

await test('the dictionaries register under one namespace', async () => {
  assert.equal(localeCalls.length, 1);
  assert.equal(localeCalls[0].ns, 'quick-actions');
  assert.ok(localeCalls[0].dicts.zh['scope.global']);
  assert.ok(localeCalls[0].dicts.en['scope.global']);
});

let header = renderSlot('conversation.session.header.actions');
await flush();
header = renderSlot('conversation.session.header.actions');

await test('the header strip fetches buttons for its own session', async () => {
  assert.ok(fetchCalls.length > 0, 'no buttons fetch was issued');
  assert.match(fetchCalls[0].url, /\/quick-actions\/buttons\?sessionId=ses-1$/);
});

// The sidebar strip sits at the screen's left edge; a right-anchored 440px card
// slides under the app rail and gets clipped. The sidebar variant must anchor
// its popover left so the card grows into the chat area instead.
await test('the sidebar popover anchors left so it stays on screen', async () => {
  const styles = findAll(header, (node) => node.type === 'style');
  assert.ok(styles.length > 0, 'no style node was rendered');
  const css = styles.map((node) => node.children.join('')).join('');
  assert.match(css, /\.qa-strip\[data-variant="sidebar"\] \.qa-pop\{[^}]*left:0;right:auto/,
    'the sidebar popover must anchor left:0;right:auto or it overflows the screen');
});

// A fixed 440px card overshoots the strip that hosts it: the overshoot gets
// clipped by the sidebar's overflow (Run button lost) or slides under the
// sidebar panel (header title cut). Constraining width to the strip's own box
// keeps the card inside the slot's allocated space in every window size.
await test('the popover never exceeds the strip that anchors it', async () => {
  const styles = findAll(header, (node) => node.type === 'style');
  const css = styles.map((node) => node.children.join('')).join('');
  assert.match(css, /\.qa-pop\{[^}]*width:min\(440px,100%\)/,
    'the popover width must be min(440px,100%) so it stays inside the strip box');
});

// A narrowed footer squeezes the action button; without nowrap the label wraps
// to a second line inside the fixed 24px height and the card's overflow:hidden
// cuts it ("Run again" → "Run" + clipped "again"). And with a min-width floor
// on the command span the floor refuses to shrink, pushing the button past the
// card edge where the card clips it — the command must yield first.
await test('footer action buttons never wrap their label', async () => {
  const styles = findAll(header, (node) => node.type === 'style');
  const css = styles.map((node) => node.children.join('')).join('');
  assert.match(css, /\.qa-act\{[^}]*white-space:nowrap/,
    'the .qa-act rule must keep action labels on one line in a squeezed footer');
  assert.match(css, /\.qa-cmd\{[^}]*min-width:0[;,]/,
    'the .qa-cmd rule must have a 0 min-width floor so it shrinks before the button overflows the card');
});

// The head row is the footer's mirror image: its last item is the close button.
// The status span is nowrap without overflow, so its automatic min-width is the
// whole text — in a card sized to the chip row, that floor pushes ✕ past the
// card edge where overflow:hidden cuts it. The status must yield (ellipsis) and
// the icon buttons must stay pinned; the expanded sidebar strip additionally
// grows into the footer's full width so the head normally has room.
await test('the popover head never squeezes its close button', async () => {
  const styles = findAll(header, (node) => node.type === 'style');
  const css = styles.map((node) => node.children.join('')).join('');
  assert.match(css, /\.qa-status\{[^}]*min-width:0;overflow:hidden;text-overflow:ellipsis/,
    'the status must yield with an ellipsis instead of pushing the close button out');
  assert.match(css, /\.qa-iconbtn\{[^}]*flex:none/,
    'the head icon buttons must be pinned so they never shrink or distort');
  assert.match(css, /\.qa-strip\[data-variant="sidebar"\]:not\(\[data-compact="true"\]\)\{flex:1 1 auto;min-width:0\}/,
    'the expanded sidebar strip must grow into the footer width for head room');
});

// Three scope types get three light hue tints (toolbar fill mixed with the
// scope's state token), and the chevron joins its button — tinted, borderless
// on the left, matching end radius — so the two read as one split pill.
await test('each scope gets its own light tint and the chevron joins the pill', async () => {
  const styles = findAll(header, (node) => node.type === 'style');
  const css = styles.map((node) => node.children.join('')).join('');
  assert.match(css, /\.qa-cell\[data-scope="global"\]\{--qa-tint:color-mix\(in srgb, var\(--dsw-alias-state-business-primary\) 20%, var\(--dsw-alias-bg-layer-2\)\)/,
    'global chips must tint with the business hue over the LIGHT base');
  assert.match(css, /\.qa-cell\[data-scope="workspace"\]\{--qa-tint:color-mix\(in srgb, var\(--dsw-alias-state-success-primary\) 20%, var\(--dsw-alias-bg-layer-2\)\)/,
    'workspace chips must tint with the success hue over the LIGHT base');
  assert.match(css, /\.qa-cell\[data-scope="session"\]\{--qa-tint:color-mix\(in srgb, var\(--dsw-alias-state-warn-primary\) 20%, var\(--dsw-alias-bg-layer-2\)\)/,
    'session chips must tint with the warn hue over the LIGHT base');
  assert.match(css, /\.qa-btn\{[^}]*background:var\(--qa-tint, var\(--dsw-alias-button-tool-bar-fill\)\)/,
    'the chip must consume the scope tint with a neutral fallback');
  assert.match(css, /\.qa-btn\{[^}]*border-radius:6px 0 0 6px/,
    'the main button must square off against the chevron');
  assert.match(css, /\.qa-chev\{[^}]*border-radius:0 6px 6px 0;border:[^;]*;border-left:none;background:var\(--qa-tint, transparent\)/,
    'the chevron must join its button: tinted, no left border, matching end radius');
  assert.match(css, /\.qa-strip\[data-compact="true"\] \.qa-btn\{[^}]*border-radius:6px\}/,
    'rail chips have no chevron and keep the full radius');
  const cells = findAll(header, (node) => node.props
    && node.props.className === 'qa-cell' && node.props['data-scope'] === 'workspace');
  assert.ok(cells.length > 0, 'cells must carry their scope so the tint can apply');
});

await test('the strip renders every visible button with its status', async () => {
  const labels = buttonsIn(header).map(textOf);
  assert.ok(labels.some((text) => text.includes('Clean')), `missing clean button in ${JSON.stringify(labels)}`);
  assert.ok(labels.some((text) => text.includes('🧹')), 'the icon is missing');
  assert.ok(labels.some((text) => text.includes('Serve')), 'missing serve button');

  const dots = findAll(header, (node) => node.props && node.props.className === 'qa-dot');
  const states = dots.map((dot) => dot.props['data-state']);
  assert.ok(states.includes('running'), `no running dot in ${JSON.stringify(states)}`);
  assert.ok(states.includes('completed'), `no completed dot in ${JSON.stringify(states)}`);
  assert.ok(buttonByText(header, '+'), 'the "+" button is missing');
});

await test('clicking a button starts the run and opens its popover', async () => {
  const cleanButton = buttonByText(header, 'Clean');
  await cleanButton.props.onClick();
  await flush();

  const posts = fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('/quick-actions/run'));
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), { buttonId: 'clean', sessionId: 'ses-1' });

  header = renderSlot('conversation.session.header.actions');
  const popover = findAll(header, (node) => node.props && node.props.className === 'qa-pop');
  assert.equal(popover.length, 1, 'popover did not open');

  // The popover mounts its poll on this render; one more pass picks up the text.
  await flush();
  header = renderSlot('conversation.session.header.actions');
  const pre = findAll(header, (node) => node.props && node.props.className === 'qa-out');
  assert.equal(pre.length, 1);
  assert.ok(textOf(pre[0]).includes('dist removed'), `output missing: ${JSON.stringify(textOf(pre[0]))}`);
  assert.ok(buttonByText(header, 'Run again'), 'rerun control missing');
});

await test('the popover carries the command and an expand control', async () => {
  const command = findAll(header, (node) => node.props && node.props.className === 'qa-cmd');
  assert.ok(textOf(command[0]).includes('rm -rf dist'));
  const expand = buttonByText(header, '⤢');
  assert.ok(expand, 'expand button missing');
  await expand.props.onClick();
  await flush();

  let overlay = renderSlot('shell.overlay');
  const dialogs = findAll(overlay, (node) => node.props && node.props['aria-label'] === 'Quick action output');
  assert.equal(dialogs.length, 1, 'output modal did not render');
  assert.ok(textOf(overlay).includes('Clean'), 'output modal title missing');
  assert.ok(textOf(overlay).includes('dist removed'), 'output modal body missing');

  // Expanding closes the popover behind the mask.
  header = renderSlot('conversation.session.header.actions');
  assert.equal(findAll(header, (node) => node.props && node.props.className === 'qa-pop').length, 0);

  // Escape closes the overlay.
  const escape = docListeners.find((l) => l.type === 'keydown');
  assert.ok(escape, 'escape handler missing');
  escape.fn({ key: 'Escape' });
  overlay = renderSlot('shell.overlay');
  assert.equal(overlay, null, 'overlay should close on Escape');
});

await test('the "+" button opens the configuration panel', async () => {
  const plus = buttonByText(header, '+');
  await plus.props.onClick();
  await flush();

  let panel = renderSlot('shell.overlay');
  assert.ok(textOf(panel).includes('Quick actions'), 'panel title missing');

  // First pass still loads; after the config fetch the toolbar appears.
  panel = renderSlot('shell.overlay');
  assert.ok(buttonByText(panel, 'Add button'), 'add control missing');
  assert.ok(buttonByText(panel, 'Save changes'), 'save control missing');
  const configGets = fetchCalls.filter((c) => c.method === 'GET' && c.url.includes('/quick-actions/config'));
  assert.ok(configGets.length > 0, 'config was never loaded');
});

await test('a new button can be drafted and saved through the panel', async () => {
  const panel = () => renderSlot('shell.overlay');

  await buttonByText(panel(), 'Add button').props.onClick();
  let view = panel();
  const inputs = findAll(view, (node) => node.type === 'input' || node.type === 'textarea' || node.type === 'select');
  assert.ok(inputs.length >= 4, `form fields missing: ${String(inputs.length)}`);

  const textarea = findAll(view, (node) => node.type === 'textarea')[0];
  await textarea.props.onChange({ target: { value: 'ping -c1 example.com' } });
  view = panel();
  const labelInput = findAll(view, (node) => node.type === 'input')[0];
  await labelInput.props.onChange({ target: { value: 'Ping' } });
  view = panel();

  await buttonByText(view, 'Add to list').props.onClick();
  view = panel();
  assert.ok(textOf(view).includes('Ping'), 'the drafted row never joined the list');
  assert.ok(!buttonByText(view, 'Add to list'), 'the form should close after applying');

  configPostResponse = {
    ok: true,
    buttons: [{ id: 'ping', label: 'Ping', command: 'ping -c1 example.com', scope: 'global', target: '', workdir: '', icon: '' }],
    configButtons: [],
  };
  const before = fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('/quick-actions/config')).length;
  await buttonByText(view, 'Save changes').props.onClick();
  await flush();

  const saves = fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('/quick-actions/config'));
  assert.equal(saves.length, before + 1);
  const payload = JSON.parse(saves[saves.length - 1].body);
  assert.equal(payload.buttons.length, 1);
  assert.equal(payload.buttons[0].label, 'Ping');
  // The empty id was derived from the label.
  assert.equal(payload.buttons[0].id, 'ping');

  // Leave the panel closed for the tests that follow.
  docListeners.find((l) => l.type === 'keydown').fn({ key: 'Escape' });
});

await test('a failed start surfaces its reason inside the popover', async () => {
  runPostStatus = 500;
  runPostResponse = { ok: false, error: 'shell-unavailable' };

  const cleanButton = buttonByText(header, 'Clean');
  await cleanButton.props.onClick();
  await flush();
  runPostStatus = 200;

  header = renderSlot('conversation.session.header.actions');
  const pre = findAll(header, (node) => node.props && node.props.className === 'qa-out');
  assert.ok(textOf(pre[0]).includes('Could not start'), `reason missing: ${JSON.stringify(textOf(pre[0]))}`);
  assert.ok(textOf(pre[0]).includes('Shell executor unavailable'), 'the mapped reason is missing');
});

await test('the sidebar strip follows the session on screen', async () => {
  let sidebar = renderSlot('sidebar.footer.action');
  await flush();
  sidebar = renderSlot('sidebar.footer.action');
  const sidebarFetches = fetchCalls.filter((c) => c.url.includes('/quick-actions/buttons'));
  const last = sidebarFetches[sidebarFetches.length - 1];
  assert.match(last.url, /sessionId=ses-1$/, `sidebar asked for the wrong session: ${last.url}`);
  // The sidebar shows only global buttons by decision; the global "Status"
  // proves the strip still renders its buttons.
  assert.ok(buttonByText(sidebar, 'Status'), 'sidebar strip lost the buttons');

  // The session on screen changes → the next tick asks about the new one,
  // once the strip re-renders and resolves its session again.
  sessionSnapshot = {
    ids: ['ses-2'],
    byId: { 'ses-2': { id: 'ses-2', title: 'Other', retainedBy: { mainView: 1 } } },
  };
  for (const entry of intervals) entry.fn();
  await flush();
  sidebar = renderSlot('sidebar.footer.action');
  await flush();
  sidebar = renderSlot('sidebar.footer.action');
  const after = fetchCalls.filter((c) => c.url.includes('/quick-actions/buttons'));
  assert.match(after[after.length - 1].url, /sessionId=ses-2$/);
});

await test('Escape also dismisses an open popover', async () => {
  header = renderSlot('conversation.session.header.actions');
  assert.equal(findAll(header, (node) => node.props && node.props.className === 'qa-pop').length, 1);

  const escape = docListeners.find((l) => l.type === 'keydown');
  escape.fn({ key: 'Escape' });
  header = renderSlot('conversation.session.header.actions');
  assert.equal(findAll(header, (node) => node.props && node.props.className === 'qa-pop').length, 0);
});

// The restricted client context only exposes ctx.interval to a fiber that
// declares `timer` in its inject list; calling it without the declaration is a
// synchronous throw that kills the whole boot (web boot: N entries did not
// activate / dsh-quick-actions: failed). The plain stub above always answers
// ctx.interval, so it stays blind to that guard — this one enforces it.
await test('apply licenses ctx.interval through the declared timer inject', async () => {
  assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('slots'),
    'client inject must declare slots');
  assert.ok(plugin.inject.includes('timer'),
    'client inject must declare "timer": the restricted ctx denies ctx.interval without it');

  const guardIntervals = [];
  const guardedCtx = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'interval') {
        return (fn, ms) => {
          if (!plugin.inject.includes('timer')) {
            throw new Error('service "timer" is not declared by your plugin. Declare it on the plugin you return: { inject: [\'timer\', …] }');
          }
          guardIntervals.push({ fn, ms });
          return target.interval(fn, ms);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  plugin.apply(guardedCtx);   // must not throw
  assert.ok(guardIntervals.length >= 1,
    'the 3s poll never reached the guarded ctx.interval path');
});

// The sidebar hands its footer slot `wide: false` while collapsed: the footer
// shrinks to the icon rail, so labels and the popover chevron disappear, chips
// stay runnable, and the click opens the output modal (fixed, centered) instead
// of a popover that could not render in a ~40px column.
await test('the collapsed rail renders icon-only chips that open the overlay', async () => {
  sessionSnapshot = {
    ids: ['ses-1'],
    byId: {
      'ses-1': { id: 'ses-1', title: 'Main', retainedBy: { mainView: 1 } },
    },
  };
  const sidebar = registered.find((r) => r.hole === 'sidebar.footer.action');
  const rail = renderNode({ type: sidebar.slot.component, props: { wide: false }, children: [] }, 'rail');
  // The rail's footer row is [task-badge] + our strip inside ~92px with
  // justify-content:center: a row-mode strip (chip+add ≈ 70px) overflows that
  // box and spills out both edges (badge cut left, chip past the rail's right
  // edge). Column mode shrinks the strip's cross size to one chip (~40px) so
  // the row fits and everything stays centered under the rail's icon column.
  const railCss = findAll(rail, (n) => n.type === 'style').map((n) => n.children.join('')).join('');
  assert.match(railCss, /\.qa-strip\[data-compact="true"\]\{[^}]*flex-direction:column/,
    'the rail strip must stack as a narrow centered column to fit the icon rail');
  // The hole anchor (display:contents) drops task-badge's global badge beside
  // our pills; in the rail it must become OUR column so the badge gets its own
  // line above the stack — keyed on stable attributes, never hashed classes.
  assert.match(railCss, /\[data-slot="sidebar\.footer\.action"\]:has\(\.qa-strip\[data-compact="true"\]\)\{display:flex !important;flex-direction:column/,
    'the hole anchor must become a column so the badge does not share our row');
  assert.equal(findAll(rail, (n) => n.props && n.props.className === 'qa-label').length, 0,
    'rail chips must hide their label');
  // Iconless buttons would collapse to empty pills in the rail; the compact
  // chip falls back to the first character of the label (fixture: the global
  // "Status", the only scope the sidebar shows).
  const glyphs = findAll(rail, (n) => n.props && n.props.className === 'qa-glyph');
  assert.equal(glyphs.length, 1, 'every visible rail chip needs a glyph');
  assert.equal(glyphs[0].children[0], 'S', 'the glyph must be the label first character');
  assert.equal(findAll(rail, (n) => n.props && n.props.className === 'qa-chev').length, 0,
    'rail strips must hide the popover chevron');
  assert.equal(findAll(rail, (n) => n.props && n.props.className === 'qa-pop').length, 0,
    'the popover must not render in the collapsed rail');

  const chip = findAll(rail, (n) => n.props && n.props.className === 'qa-btn')[0];
  assert.ok(chip, 'no runnable chip rendered in the rail');
  chip.props.onClick();
  await flush();
  const overlay = renderSlot('shell.overlay');
  assert.ok(findAll(overlay, (n) => n.props && n.props.className === 'qa-modal').length > 0,
    'a rail click must open the output overlay for live output');
  const wide = renderNode({ type: sidebar.slot.component, props: { wide: true }, children: [] }, 'wide-after-rail');
  assert.equal(findAll(wide, (n) => n.props && n.props.className === 'qa-pop').length, 0,
    'no popover may be left open by a rail click');
});

// Decision (user): the sidebar badge reads as ONE global instance, so the
// sidebar shows only global buttons; workspace- and session-scoped buttons
// are instance-level and live in the top row (which hides global instead).
await test('the sidebar shows only global buttons while the header keeps the rest', async () => {
  const sidebar = renderSlot('sidebar.footer.action');
  const header = renderSlot('conversation.session.header.actions');
  const labels = (tree) => findAll(tree, (n) => n.props && n.props.className === 'qa-label')
    .map((n) => n.children[0]);
  const sidebarLabels = labels(sidebar);
  assert.ok(sidebarLabels.includes('Status'), 'the sidebar must show the global button');
  assert.ok(!sidebarLabels.includes('Clean'), 'workspace buttons stay out of the sidebar');
  assert.ok(!sidebarLabels.includes('Serve'),
    'session buttons stay out of the sidebar (an even narrower scope than workspace)');
  const headerLabels = labels(header);
  assert.ok(headerLabels.includes('Clean') && headerLabels.includes('Serve'),
    'the header keeps the instance-level buttons');
  assert.ok(!headerLabels.includes('Status'), 'the header hides the global button');
});

// Mirror of the sidebar's any-workspace decision: the sidebar strip always
// shows global buttons, so the header drops them to save the top row's space.
await test('the header drops global buttons that the sidebar already shows', async () => {
  const original = buttonsResponse;
  buttonsResponse = { buttons: [...original.buttons, { id: 'g-clock', label: 'Clock', icon: '', scope: 'global', target: '', command: 'date' }] };
  for (const entry of intervals) entry.fn();
  await flush();
  const headerAfter = renderSlot('conversation.session.header.actions');
  const sidebarAfter = renderSlot('sidebar.footer.action');
  const labels = (tree) => findAll(tree, (n) => n.props && n.props.className === 'qa-label')
    .map((n) => n.children[0]);
  assert.ok(!labels(headerAfter).includes('Clock'),
    'the header must hide the global button the sidebar already shows');
  assert.ok(buttonByText(sidebarAfter, 'Clock'),
    'the sidebar must keep showing the global button');
  buttonsResponse = original;
  for (const entry of intervals) entry.fn();
  await flush();
  renderSlot('conversation.session.header.actions');
  renderSlot('sidebar.footer.action');
});

// The chip's green dot means "a finished result you have not looked at".
// Displaying the result — in the popover or the output overlay — is the read
// receipt; without that receipt the dot would stay green forever after every
// run, and the receipt must only clear the button it belongs to.
await test('reading a finished result clears the green dot', async () => {
  runGetResponse = { ok: true, run: completedRun };
  const hole = 'conversation.session.header.actions';
  const dots = (root) => findAll(root, (n) => n.props && n.props.className === 'qa-dot');
  let tree = renderSlot(hole);
  assert.ok(dots(tree).some((n) => n.props['data-state'] === 'completed'),
    'an unread completed run must show its green dot');
  assert.ok(dots(tree).some((n) => n.props['data-state'] === 'running'),
    'the running button keeps its own dot');

  const chev = findAll(tree, (n) => n.props && n.props.className === 'qa-chev')[0];
  assert.ok(chev, 'no popover toggle rendered');
  chev.props.onClick();                 // open the popover on the completed button
  await flush();
  tree = renderSlot(hole);              // popover mounts, its poll lands completed
  await flush();
  tree = renderSlot(hole);              // markRead runs inside the popover effect
  tree = renderSlot(hole);              // next pass renders the cleared dot
  assert.ok(!dots(tree).some((n) => n.props['data-state'] === 'completed'),
    'displaying the result must clear the green dot');
  assert.ok(dots(tree).some((n) => n.props['data-state'] === 'running'),
    'a read receipt must not clear a different button\'s running dot');
});

// Both strips share skeys on the main session, so the popover state carries
// the opening strip's variant: the header popover left open above must not pop
// a card in the sidebar, which shows a different scope set and may not even
// display that button.
await test('an open popover stays in the strip that opened it', async () => {
  const headerNow = renderSlot('conversation.session.header.actions');
  assert.ok(findAll(headerNow, (n) => n.props && n.props.className === 'qa-pop').length > 0,
    'the popover must render in the strip that opened it');
  const sidebar = renderSlot('sidebar.footer.action');
  assert.equal(findAll(sidebar, (n) => n.props && n.props.className === 'qa-pop').length, 0,
    'the sidebar must not pop a card for a button it does not show');
});

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`)
process.exit(failures.length > 0 ? 1 : 0)
