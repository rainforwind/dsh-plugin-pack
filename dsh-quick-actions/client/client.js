// Browser half of Quick Actions.
//
// Two strips carry the buttons: the session header (`conversation.session.header
// .actions`, session-scoped props) and the sidebar footer (`sidebar.footer
// .action`, resolves the session on screen itself). Both end with a "+" that
// opens the definition panel rendered through `shell.overlay`. Output is shown
// in a popover anchored to the strip, expandable to a modal in the same
// overlay slot.
//
// The client never computes scope: it sends only the session it renders for,
// and the host answers with the visible buttons, each carrying its instance
// key and run state. Run instances are shared exactly as the host says, so two
// surfaces watching one instance see one execution.
window.__ModuleLoader__.load({ id: 'dsh-quick-actions', factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

  const React = require('react');
  const h = React.createElement;

  const NS = 'quick-actions';
  const name = 'dsh-quick-actions-client';
  // `timer` is a hard dependency: the restricted client context only lets the
  // timer helpers through when the fiber declares them, and apply() reads
  // ctx.interval for the 3s poll (and every popover poll reuses it).
  const inject = ['slots', 'timer'];

  // ── locale ───────────────────────────────────────────────────────────────

  const en = {
    'strip.empty': 'No quick actions — press + to add one',
    'add.title': 'Add or edit quick actions',
    'run.none': 'Not run yet',
    'run.empty': 'No output yet',
    'run.startFailed': 'Could not start: {reason}',
    'status.running': 'Running…',
    'status.exit0': 'Exit 0',
    'status.exit': 'Exit {code}',
    'status.signal': 'Killed by {signal}',
    'status.killed': 'Stopped',
    'status.failed': 'Failed',
    'err.shell-unavailable': 'Shell executor unavailable in this profile',
    'err.unknown-button': 'This button no longer exists',
    'err.not-visible': 'This button is not visible here',
    'err.http': 'Request failed ({code})',
    'err.network': 'Cannot reach the host',
    'pop.toggle': 'Show or hide output',
    'pop.close': 'Close output',
    'pop.expand': 'Expand',
    'pop.kill': 'Stop',
    'pop.rerun': 'Run again',
    'pop.run': 'Run',
    'pop.command': 'Command',
    'overlay.output': 'Quick action output',
    'config.title': 'Quick actions',
    'config.add': 'Add button',
    'config.save': 'Save changes',
    'config.saving': 'Saving…',
    'config.saved': 'Saved',
    'config.close': 'Close',
    'config.empty': 'No buttons yet — add one below.',
    'config.readonly': 'From cordis.patch.yml (read-only)',
    'config.store': 'Stored in {path}',
    'config.deleteConfirm': 'Delete “{label}”?',
    'config.edit': 'Edit {label}',
    'config.delete': 'Delete {label}',
    'config.moveUp': 'Move {label} up',
    'config.moveDown': 'Move {label} down',
    'config.formNew': 'New button',
    'config.formEdit': 'Edit button',
    'config.cancel': 'Cancel',
    'config.apply': 'Add to list',
    'config.update': 'Update',
    'config.loading': 'Loading…',
    'field.id': 'ID',
    'field.label': 'Label',
    'field.icon': 'Icon',
    'field.command': 'Command',
    'field.workdir': 'Working directory',
    'field.scope': 'Scope',
    'field.target': 'Applies to',
    'field.idHint': 'Lowercase letters, digits, - _ . — the button’s identity',
    'field.workdirHint': 'Empty = run in the workspace directory',
    'field.commandHint': 'Supports the {workspace} and {session} placeholders',
    'scope.global': 'Global',
    'scope.workspace': 'Workspace',
    'scope.session': 'Session',
    'target.anyWorkspace': 'Any workspace',
    'target.anySession': 'Any session',
    'target.custom': 'Custom id…',
    'hint.global': 'Visible everywhere; every viewer shares one run instance.',
    'hint.workspace': 'Visible in that workspace’s sessions; one shared run per workspace.',
    'hint.session': 'Visible in that session; one run per session.',
    'err.form.id': 'ID is required: lowercase letters, digits, - _ .',
    'err.form.label': 'Label is required',
    'err.form.command': 'Command is required',
  };

  const zh = {
    'strip.empty': '还没有快捷操作，点 + 添加',
    'add.title': '添加或编辑快捷操作',
    'run.none': '尚未运行',
    'run.empty': '暂无输出',
    'run.startFailed': '无法启动：{reason}',
    'status.running': '运行中…',
    'status.exit0': '退出码 0',
    'status.exit': '退出码 {code}',
    'status.signal': '被信号 {signal} 终止',
    'status.killed': '已停止',
    'status.failed': '失败',
    'err.shell-unavailable': '当前 profile 没有可用的 shell 执行器',
    'err.unknown-button': '该按钮已不存在',
    'err.not-visible': '此按钮在当前上下文中不可见',
    'err.http': '请求失败（{code}）',
    'err.network': '无法连接宿主进程',
    'pop.toggle': '显示或隐藏输出',
    'pop.close': '关闭输出',
    'pop.expand': '放大',
    'pop.kill': '停止',
    'pop.rerun': '再次运行',
    'pop.run': '运行',
    'pop.command': '命令',
    'overlay.output': '快捷操作输出',
    'config.title': '快捷操作',
    'config.add': '添加按钮',
    'config.save': '保存修改',
    'config.saving': '保存中…',
    'config.saved': '已保存',
    'config.close': '关闭',
    'config.empty': '还没有按钮，在下方添加。',
    'config.readonly': '来自 cordis.patch.yml（只读）',
    'config.store': '存储于 {path}',
    'config.deleteConfirm': '删除「{label}」？',
    'config.edit': '编辑 {label}',
    'config.delete': '删除 {label}',
    'config.moveUp': '上移 {label}',
    'config.moveDown': '下移 {label}',
    'config.formNew': '新建按钮',
    'config.formEdit': '编辑按钮',
    'config.cancel': '取消',
    'config.apply': '加入列表',
    'config.update': '更新',
    'config.loading': '加载中…',
    'field.id': 'ID',
    'field.label': '名称',
    'field.icon': '图标',
    'field.command': '命令',
    'field.workdir': '工作目录',
    'field.scope': '作用范围',
    'field.target': '限定于',
    'field.idHint': '小写字母、数字、- _ .，作为按钮的唯一标识',
    'field.workdirHint': '留空则在 workspace 目录中执行',
    'field.commandHint': '支持 {workspace} 与 {session} 占位符',
    'scope.global': '全局',
    'scope.workspace': 'Workspace',
    'scope.session': '会话',
    'target.anyWorkspace': '任意 workspace',
    'target.anySession': '任意会话',
    'target.custom': '自定义 id…',
    'hint.global': '任何位置可见；所有视图共享同一次运行实例。',
    'hint.workspace': '该 workspace 的会话可见；每个 workspace 独立运行。',
    'hint.session': '该会话可见；每个会话独立运行。',
    'err.form.id': 'ID 必填：小写字母、数字、- _ .',
    'err.form.label': '名称必填',
    'err.form.command': '命令必填',
  };

  function makeT(dict) {
    return (key, params) => {
      let text = dict[key] != null ? dict[key] : (en[key] != null ? en[key] : key);
      if (params) {
        for (const name of Object.keys(params)) {
          text = text.split(`{${name}}`).join(String(params[name]));
        }
      }
      return text;
    };
  }

  function preferredDict() {
    try {
      if (typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')) return zh;
    } catch (error) { /* no navigator */ }
    return en;
  }

  // Fallback when the locale service does not hand the component a `t`.
  const localT = makeT(preferredDict());

  function api(path) {
    const relative = path.replace(/^\/+/, '');
    if (typeof document === 'undefined' || !document.baseURI) return `/${relative}`;
    // Keep the query: `URL.pathname` alone would drop `?sessionId=…`, and the
    // host scopes every answer by it.
    const url = new URL(relative, document.baseURI);
    return url.pathname + url.search;
  }

  // ── shared state ─────────────────────────────────────────────────────────

  const services = { sessions: null, workspaces: null };
  let intervalFn = (fn, ms) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  };

  const store = {
    contexts: new Map(),   // context key -> { sessionId, workspaceId, buttons, error? }
    active: new Map(),     // context key -> { sessionId, count } (mounted strips)
    runs: new Map(),       // `key::buttonId` -> run view with text
    reads: new Map(),      // `key::buttonId` -> run token whose result was displayed
    popover: null,         // { skey, sessionId, buttonId }
    overlay: null,         // { kind: 'config' } | { kind: 'output', skey, sessionId, buttonId }
    config: null,          // { buttons, configButtons, storePath }
    configBusy: false,
    configError: null,
    savedFlash: false,
    listeners: new Set(),
  };

  const ctxKey = (sessionId) => (sessionId == null ? '@none' : String(sessionId));
  const runKey = (skey, buttonId) => `${skey}::${buttonId}`;

  function notify() {
    for (const listener of store.listeners) {
      try { listener(); } catch (error) { /* one bad subscriber must not stop the rest */ }
    }
  }

  function useStore() {
    const [, bump] = React.useState(0);
    React.useEffect(() => {
      const listener = () => bump((value) => value + 1);
      store.listeners.add(listener);
      return () => { store.listeners.delete(listener); };
    }, []);
  }

  // ── host communication ───────────────────────────────────────────────────

  async function requestJson(path, options) {
    let response;
    try {
      response = await fetch(api(path), options);
    } catch (error) {
      const wrapped = new Error(localT('err.network'));
      wrapped.cause = error;
      throw wrapped;
    }
    let data = {};
    try { data = await response.json(); } catch (error) { data = {}; }
    if (!response.ok) {
      const failure = new Error(data.message || data.error || localT('err.http', { code: response.status }));
      failure.data = data;
      failure.status = response.status;
      throw failure;
    }
    return data;
  }

  const getJson = (path) => requestJson(path);
  const postJson = (path, body) => requestJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  function errorText(error) {
    const code = error && error.data && error.data.error;
    if (code && en[`err.${code}`]) return localT(`err.${code}`);
    if (error && error.message) return error.message;
    return String(error);
  }

  async function refresh(sessionId) {
    const skey = ctxKey(sessionId);
    try {
      const data = await getJson(`/quick-actions/buttons?sessionId=${encodeURIComponent(sessionId == null ? '' : sessionId)}`);
      store.contexts.set(skey, {
        sessionId: data.sessionId == null ? null : data.sessionId,
        workspaceId: data.workspaceId || '',
        buttons: Array.isArray(data.buttons) ? data.buttons : [],
      });
    } catch (error) {
      store.contexts.set(skey, {
        sessionId: sessionId == null ? null : sessionId,
        workspaceId: '',
        buttons: [],
        error: errorText(error),
      });
    }
    notify();
  }

  function setRunDetail(skey, buttonId, run) {
    const key = runKey(skey, buttonId);
    if (run) store.runs.set(key, run);
    else store.runs.delete(key);
  }

  // Start or join the run. Never throws: a failed start becomes a local failed
  // run record so the popover can show the reason instead of vanishing.
  async function startRun(sessionId, buttonId, variant) {
    const skey = ctxKey(sessionId);
    try {
      const data = await postJson('/quick-actions/run', { buttonId, sessionId: sessionId == null ? null : sessionId });
      setRunDetail(skey, buttonId, data.run || null);
    } catch (error) {
      setRunDetail(skey, buttonId, {
        runId: 'local-error',
        buttonId,
        instanceKey: '',
        status: 'failed',
        command: null,
        workdir: null,
        startedAt: Date.now(),
        endedAt: Date.now(),
        exitCode: null,
        signal: null,
        text: localT('run.startFailed', { reason: errorText(error) }),
        dropped: 0,
      });
    }
    // The expanded output view is already showing this run; a popover behind
    // its mask would be invisible noise. The popover belongs to the strip that
    // opened it (header and sidebar share skeys on the main session).
    if (!(store.overlay && store.overlay.kind === 'output')) {
      store.popover = { skey, sessionId, buttonId, variant };
    }
    notify();
  }

  async function pollRun(sessionId, buttonId) {
    const skey = ctxKey(sessionId);
    try {
      const data = await getJson(`/quick-actions/run?buttonId=${encodeURIComponent(buttonId)}&sessionId=${encodeURIComponent(sessionId == null ? '' : sessionId)}`);
      setRunDetail(skey, buttonId, data.run || null);
    } catch (error) { /* keep the last known view; the next tick retries */ }
    notify();
  }

  async function killRun(sessionId, buttonId) {
    const skey = ctxKey(sessionId);
    try {
      const data = await postJson('/quick-actions/kill', { buttonId, sessionId: sessionId == null ? null : sessionId });
      setRunDetail(skey, buttonId, data.run || store.runs.get(runKey(skey, buttonId)) || null);
    } catch (error) { /* a raced kill is not an error worth surfacing */ }
    notify();
  }

  async function loadConfig() {
    const data = await getJson('/quick-actions/config');
    store.config = {
      buttons: Array.isArray(data.buttons) ? data.buttons : [],
      configButtons: Array.isArray(data.configButtons) ? data.configButtons : [],
      storePath: data.storePath || '',
    };
    store.configError = null;
    notify();
    return store.config;
  }

  function refreshActiveContexts() {
    for (const entry of store.active.values()) refresh(entry.sessionId);
  }

  async function saveConfig(buttons) {
    store.configBusy = true;
    store.configError = null;
    store.savedFlash = false;
    notify();
    try {
      const data = await postJson('/quick-actions/config', { buttons });
      store.config = {
        buttons: Array.isArray(data.buttons) ? data.buttons : buttons,
        configButtons: Array.isArray(data.configButtons)
          ? data.configButtons
          : ((store.config && store.config.configButtons) || []),
        storePath: (store.config && store.config.storePath) || '',
      };
      store.savedFlash = true;
      setTimeout(() => { store.savedFlash = false; notify(); }, 2500);
      refreshActiveContexts();
    } catch (error) {
      store.configError = error.data && error.data.errors
        ? error.data.errors.join('\n')
        : errorText(error);
    } finally {
      store.configBusy = false;
      notify();
    }
  }

  function openConfigPanel() {
    store.popover = null;
    store.overlay = { kind: 'config' };
    notify();
    if (!store.config) loadConfig().catch(() => {});
  }

  function expandOutput(entry) {
    store.overlay = { kind: 'output', ...entry };
    store.popover = null;
    notify();
  }

  // ── context helpers ──────────────────────────────────────────────────────

  // The sidebar strip follows the session retained by the main view; the
  // snapshot carries no `.current` field.
  function mainSessionId() {
    try {
      const byId = services.sessions && services.sessions.list
        && services.sessions.list.getSnapshot
        && services.sessions.list.getSnapshot().byId;
      if (!byId) return null;
      for (const row of Object.values(byId)) {
        if (row && (row.retainedBy && row.retainedBy.mainView || 0) > 0) return row.id || null;
      }
    } catch (error) { /* sessions store unavailable */ }
    return null;
  }

  function statusText(run, t) {
    if (!run) return t('run.none');
    if (run.status === 'running') return t('status.running');
    if (run.status === 'completed') return t('status.exit0');
    if (run.status === 'killed') return t('status.killed');
    if (run.signal) return t('status.signal', { signal: run.signal });
    if (run.exitCode !== null && run.exitCode !== undefined) return t('status.exit', { code: run.exitCode });
    return t('status.failed');
  }

  // Identity of one finished run for read-receipt tracking: two polls describe
  // the same result only when their tokens match.
  function runToken(run) {
    if (!run) return '';
    return String(run.runId || run.startedAt || run.endedAt || '');
  }

  // A terminal result becomes "read" the first time the popover or the output
  // modal displays it; the chip's status dot then disappears until a new run
  // (new token) finishes unread.
  function markRead(skey, buttonId, run) {
    if (!run || run.status === 'running') return;
    const token = runToken(run);
    if (!token) return;
    const key = runKey(skey, buttonId);
    if (store.reads.get(key) === token) return;
    store.reads.set(key, token);
    notify();
  }

  function runDotState(run, readToken) {
    if (!run) return null;
    if (run.status === 'running') return 'running';
    if (readToken && readToken === runToken(run)) return null;
    return run.status || null;
  }

  // ── styles (tokens only; component-local, unmounted with the tree) ───────

  const CSS = `
.qa-strip{position:relative;display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.qa-btn{display:inline-flex;align-items:center;gap:5px;height:26px;max-width:220px;padding:0 9px;border-radius:6px 0 0 6px;border:1px solid var(--dsw-alias-border-l2);background:var(--qa-tint, var(--dsw-alias-button-tool-bar-fill));color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;cursor:pointer;font-family:inherit}
.qa-btn:hover{background:var(--qa-tint-hover, var(--dsw-alias-button-tool-bar-hover))}
.qa-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qa-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.qa-dot[data-state="running"]{background:none;border:1.5px solid var(--dsw-alias-state-warn-primary);border-right-color:transparent;animation:qa-spin .9s linear infinite}
.qa-dot[data-state="completed"]{background:var(--dsw-alias-state-success-primary)}
.qa-dot[data-state="failed"],.qa-dot[data-state="killed"]{background:var(--dsw-alias-state-error-primary)}
.qa-chev{width:18px;height:26px;padding:0;border-radius:0 6px 6px 0;border:1px solid var(--dsw-alias-border-l2);border-left:none;background:var(--qa-tint, transparent);color:var(--dsw-alias-label-secondary);font-size:10px;cursor:pointer;font-family:inherit}
.qa-chev:hover{background:var(--qa-tint-hover, var(--dsw-alias-interactive-bg-hover))}
/* Each scope carries its own light but saturated hue so global / workspace /
   session chips are distinguishable at a glance: the state token mixed over
   the LIGHT layer color — mixing over the gray toolbar fill only produced
   gray-on-gray. Hover deepens the same hue; unknown scopes keep the neutral
   fill. The chevron shares the cell tint and abuts the button — no left
   border, square-off radii — so the two read as one split pill. */
.qa-cell[data-scope="global"]{--qa-tint:color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, var(--dsw-alias-bg-layer-2));--qa-tint-hover:color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, var(--dsw-alias-bg-layer-2))}
.qa-cell[data-scope="workspace"]{--qa-tint:color-mix(in srgb, var(--dsw-alias-state-success-primary) 20%, var(--dsw-alias-bg-layer-2));--qa-tint-hover:color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, var(--dsw-alias-bg-layer-2))}
.qa-cell[data-scope="session"]{--qa-tint:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, var(--dsw-alias-bg-layer-2));--qa-tint-hover:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, var(--dsw-alias-bg-layer-2))}
.qa-add{min-width:24px;height:26px;padding:0 4px;border-radius:6px;border:1px dashed var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;cursor:pointer;line-height:1;font-family:inherit}
.qa-add:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.qa-empty{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:0 4px}
.qa-pop{position:absolute;top:calc(100% + 6px);right:0;z-index:60;width:min(440px,100%);max-width:78vw;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.32);display:flex;flex-direction:column;overflow:hidden;text-align:left}
.qa-strip[data-variant="sidebar"] .qa-pop{top:auto;bottom:calc(100% + 6px);left:0;right:auto}
/* The footer slot container is a full-width flex row, but this strip as a flex
   item sizes to its content — so the popover card was only as wide as the chip
   row and the head's floor pushed the close button past the edge. Grow the
   expanded strip into the leftover width (basis stays auto: never below
   content); the compact rail opts out via :not(). */
.qa-strip[data-variant="sidebar"]:not([data-compact="true"]){flex:1 1 auto;min-width:0}
.qa-strip[data-compact="true"]{flex-direction:column;align-items:center;justify-content:center;row-gap:6px}
.qa-strip[data-compact="true"] .qa-btn{padding:0 6px;max-width:none;border-radius:6px}
.qa-strip[data-compact="true"] .qa-empty{display:none}
/* The slot anchor is display:contents (inline), which drops both footer entries
   straight into the sidebar's flex row — the global badge forced onto the same
   line as our pills. In the collapsed rail, take OUR hole's anchor back as a
   column so the badge gets its own line above the stack. :has ties the rule to
   our compact state; !important beats the anchor's inline display. Stable hooks
   only (slot key + our own class) — no hashed sidebar selectors. */
[data-slot="sidebar.footer.action"]:has(.qa-strip[data-compact="true"]){display:flex !important;flex-direction:column;align-items:center;row-gap:6px}
.qa-pop-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-primary)}
.qa-pop-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px}
.qa-status{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
.qa-iconbtn{height:22px;min-width:22px;padding:0 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:1;font-family:inherit;flex:none}
.qa-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.qa-out{margin:0;padding:10px;min-height:64px;max-height:260px;overflow:auto;background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.qa-pop-foot{display:flex;align-items:center;gap:6px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.qa-cmd{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-dimmed);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qa-act{height:24px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.qa-act:hover{background:var(--dsw-alias-button-tool-bar-hover)}
.qa-act[data-kind="primary"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.qa-act[data-kind="primary"]:hover{background:var(--dsw-alias-button-primary-hover)}
.qa-act[data-kind="danger"]{color:var(--dsw-alias-state-error-primary)}
.qa-act:disabled{opacity:.55;cursor:default}
.qa-mask{position:fixed;inset:0;z-index:80;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;padding:24px}
.qa-modal{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.4);display:flex;flex-direction:column;max-height:86vh;width:min(880px,92vw);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.qa-modal[data-size="output"]{width:min(760px,92vw)}
.qa-modal-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.qa-modal-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;padding:12px 14px;overflow:auto}
.qa-modal-body .qa-out{max-height:none;flex:1;min-height:180px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.qa-modal-foot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.qa-form{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.qa-field{display:flex;flex-direction:column;gap:4px}
.qa-fieldlabel{font-size:11px;color:var(--dsw-alias-label-secondary)}
.qa-input{width:100%;box-sizing:border-box;height:28px;padding:0 8px;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit}
textarea.qa-input{height:76px;padding:6px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;line-height:1.45;resize:vertical}
.qa-fieldhint{font-size:10px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.qa-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.qa-row[data-readonly="true"]{opacity:.72}
.qa-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.qa-row-title{font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qa-row-meta{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qa-row-actions{display:flex;gap:4px;flex:none}
.qa-list{display:flex;flex-direction:column;gap:6px}
.qa-toolbar{display:flex;align-items:center;gap:8px}
.qa-sectiontitle{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.qa-hint{font-size:11px;color:var(--dsw-alias-label-dimmed);line-height:1.5}
.qa-error{font-size:11px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}
.qa-flash{font-size:11px;color:var(--dsw-alias-state-success-primary)}
@keyframes qa-spin{to{transform:rotate(360deg)}}
`;

  // ── components ───────────────────────────────────────────────────────────

  function RunOutput({ run, t, outputRef }) {
    const text = run && run.text ? run.text : '';
    const marker = run && run.dropped ? `…(${String(run.dropped)} earlier characters dropped)\n` : '';
    React.useEffect(() => {
      const element = outputRef && outputRef.current;
      if (!element) return;
      const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
      if (nearBottom) element.scrollTop = element.scrollHeight;
    }, [text]);
    return h('pre', { className: 'qa-out', ref: outputRef },
      text || marker ? marker + text : t('run.empty'));
  }

  function Popover({ sessionId, skey, buttonId, variant, t }) {
    useStore();
    const context = store.contexts.get(skey);
    const button = ((context && context.buttons) || []).find((entry) => entry.id === buttonId);
    const run = store.runs.get(runKey(skey, buttonId)) || null;
    const outputRef = React.useRef(null);

    React.useEffect(() => {
      pollRun(sessionId, buttonId);
      const dispose = intervalFn(() => { pollRun(sessionId, buttonId); }, 700);
      return dispose;
    }, [skey, buttonId]);

    // Displaying a finished result counts as reading it: the chip's status dot
    // clears as soon as the popover shows this run (open-after-completion or
    // completion-while-viewing — the deps change either way).
    React.useEffect(() => {
      markRead(skey, buttonId, run);
    }, [runToken(run), run && run.status]);

    // Clicking outside the strip dismisses the popover.
    React.useEffect(() => {
      if (typeof document === 'undefined' || !document.addEventListener) return undefined;
      const onDown = (event) => {
        const strip = event.target && event.target.closest ? event.target.closest('[data-qa-strip]') : null;
        if (!strip) { store.popover = null; notify(); }
      };
      document.addEventListener('mousedown', onDown);
      return () => document.removeEventListener('mousedown', onDown);
    }, []);

    if (!button) return null;
    const running = !!run && run.status === 'running';

    return h('div', { className: 'qa-pop', role: 'dialog', 'aria-label': t('pop.toggle') },
      h('div', { className: 'qa-pop-head' },
        h('span', { className: 'qa-pop-title' }, button.label),
        h('span', { className: 'qa-status' }, statusText(run, t)),
        h('button', {
          className: 'qa-iconbtn',
          title: t('pop.expand'),
          'aria-label': t('pop.expand'),
          onClick: () => expandOutput({ skey, sessionId, buttonId }),
        }, '⤢'),
        h('button', {
          className: 'qa-iconbtn',
          title: t('pop.close'),
          'aria-label': t('pop.close'),
          onClick: () => { store.popover = null; notify(); },
        }, '✕')
      ),
      h(RunOutput, { run, t, outputRef }),
      h('div', { className: 'qa-pop-foot' },
        h('span', { className: 'qa-cmd', title: button.command }, button.command),
        h('button', {
          className: 'qa-act',
          'data-kind': 'primary',
          onClick: () => startRun(sessionId, buttonId),
        }, run ? t('pop.rerun') : t('pop.run')),
        running
          ? h('button', { className: 'qa-act', 'data-kind': 'danger', onClick: () => killRun(sessionId, buttonId) }, t('pop.kill'))
          : null
      )
    );
  }

  function ButtonCell({ button, sessionId, skey, compact, variant, t }) {
    useStore();
    const detail = store.runs.get(runKey(skey, button.id));
    // The 3-second buttons refresh carries the authoritative status; the cached
    // detail carries text and may describe an older run.
    const summary = button.run || (detail && {
      runId: detail.runId, status: detail.status, startedAt: detail.startedAt, endedAt: detail.endedAt,
    });
    const dotState = runDotState(summary, store.reads.get(runKey(skey, button.id)));
    // The popover belongs to one strip: both strips share skeys on the main
    // session, so the variant must match too.
    const open = !!store.popover && store.popover.skey === skey
      && store.popover.buttonId === button.id && store.popover.variant === variant;

    const togglePopover = () => {
      if (open) { store.popover = null; notify(); return; }
      store.popover = { skey, sessionId, buttonId: button.id, variant };
      notify();
      pollRun(sessionId, button.id);
    };

    // In the collapsed rail there is no room for the popover, so a click runs
    // and jumps straight to the overlay modal, which carries its own Run/Stop.
    const onCellClick = () => {
      startRun(sessionId, button.id, variant);
      if (compact) expandOutput({ skey, sessionId, buttonId: button.id });
    };

    // Compact chips are icon-only; a button without an icon would collapse to
    // an empty pill (it may not even have a dot before its first run), so fall
    // back to the first character of its label.
    const glyph = button.icon || (compact ? ((button.label || '').trim().charAt(0) || '') : '');

    return h('span', { className: 'qa-cell', 'data-scope': button.scope, style: { display: 'inline-flex', alignItems: 'center' } },
      h('button', {
        className: 'qa-btn',
        title: `${button.label} — ${button.command}`,
        onClick: onCellClick,
      },
        dotState ? h('i', { className: 'qa-dot', 'data-state': dotState }) : null,
        glyph ? h('span', { className: 'qa-glyph' }, glyph) : null,
        compact ? null : h('span', { className: 'qa-label' }, button.label)
      ),
      compact ? null : h('button', {
        className: 'qa-chev',
        title: t('pop.toggle'),
        'aria-label': t('pop.toggle'),
        'aria-expanded': open,
        onClick: togglePopover,
      }, '▾')
    );
  }

  function Strip({ sessionId, variant, wide, t: tProp }) {
    useStore();
    const t = tProp || localT;
    const sid = variant === 'sidebar' ? mainSessionId() : sessionId;
    const skey = ctxKey(sid);
    // The sidebar hands its slots `wide: false` while collapsed: the footer
    // shrinks to the icon rail, so the strip goes icon-only and routes output
    // to the overlay instead of the (unrenderable) popover.
    const compact = variant === 'sidebar' && wide === false;

    React.useEffect(() => {
      const existing = store.active.get(skey);
      if (existing) existing.count += 1;
      else store.active.set(skey, { sessionId: sid, count: 1 });
      refresh(sid);
      return () => {
        const entry = store.active.get(skey);
        if (!entry) return;
        entry.count -= 1;
        if (entry.count <= 0) store.active.delete(skey);
      };
    }, [skey]);

    const context = store.contexts.get(skey);
    const allButtons = (context && context.buttons) || [];
    // Decisions:
    // - The sidebar is the GLOBAL surface (its badge reads as one global
    //   instance), so it shows only global buttons; workspace- and
    //   session-scoped buttons are instance-level and belong to the top row.
    // - The header hides global buttons: the sidebar already shows them, so
    //   the top row spends its space on session/workspace buttons only.
    const buttons = variant === 'sidebar'
      ? allButtons.filter((button) => button.scope === 'global')
      : variant === 'header'
        ? allButtons.filter((button) => button.scope !== 'global')
        : allButtons;
    // The popover renders only in the strip that opened it: header and sidebar
    // share skeys on the main session, so without the variant check a header
    // click would pop the sidebar card too (for a button the sidebar does not
    // even show).
    const popover = store.popover && store.popover.skey === skey && store.popover.variant === variant
      ? store.popover
      : null;

    return h('div', { className: 'qa-strip', 'data-variant': variant, 'data-compact': compact ? 'true' : 'false', 'data-qa-strip': '' },
      h('style', null, CSS),
      buttons.length === 0
        ? h('span', { className: 'qa-empty' }, context && context.error ? context.error : t('strip.empty'))
        : null,
      buttons.map((button) => h(ButtonCell, {
        key: button.id,
        button,
        sessionId: sid,
        skey,
        compact,
        variant,
        t,
      })),
      popover && !compact ? h(Popover, {
        sessionId: popover.sessionId,
        skey: popover.skey,
        buttonId: popover.buttonId,
        variant: popover.variant,
        t,
      }) : null,
      h('button', {
        className: 'qa-add',
        title: t('add.title'),
        'aria-label': t('add.title'),
        onClick: openConfigPanel,
      }, '+')
    );
  }

  function OutputModal({ skey, sessionId, buttonId, t }) {
    useStore();
    const context = store.contexts.get(skey);
    const button = ((context && context.buttons) || []).find((entry) => entry.id === buttonId);
    const run = store.runs.get(runKey(skey, buttonId)) || null;
    const outputRef = React.useRef(null);

    React.useEffect(() => {
      pollRun(sessionId, buttonId);
      const dispose = intervalFn(() => { pollRun(sessionId, buttonId); }, 700);
      return dispose;
    }, [skey, buttonId]);

    // The overlay is the other place a finished result is displayed — reading
    // it here clears the chip's status dot just like the popover does.
    React.useEffect(() => {
      markRead(skey, buttonId, run);
    }, [runToken(run), run && run.status]);

    const running = !!run && run.status === 'running';
    const label = button ? button.label : buttonId;

    return h('div', { className: 'qa-mask', onClick: (event) => {
      if (event.target === event.currentTarget) { store.overlay = null; notify(); }
    } },
      // The overlay renders outside any strip, so it carries its own styles.
      h('style', null, CSS),
      h('div', { className: 'qa-modal', 'data-size': 'output', role: 'dialog', 'aria-label': t('overlay.output') },
        h('div', { className: 'qa-modal-head' },
          h('span', null, label),
          h('span', { className: 'qa-status' }, statusText(run, t)),
          h('button', {
            className: 'qa-iconbtn',
            title: t('config.close'),
            'aria-label': t('config.close'),
            onClick: () => { store.overlay = null; notify(); },
          }, '✕')
        ),
        h('div', { className: 'qa-modal-body' },
          h(RunOutput, { run, t, outputRef })
        ),
        h('div', { className: 'qa-modal-foot' },
          h('span', { className: 'qa-cmd', title: run ? run.command || '' : '' },
            run && run.command ? run.command : (button ? button.command : '')),
          h('button', {
            className: 'qa-act',
            'data-kind': 'primary',
            onClick: () => startRun(sessionId, buttonId, variant),
          }, run ? t('pop.rerun') : t('pop.run')),
          running
            ? h('button', { className: 'qa-act', 'data-kind': 'danger', onClick: () => killRun(sessionId, buttonId) }, t('pop.kill'))
            : null
        )
      )
    );
  }

  function targetOptions(scope) {
    if (scope === 'workspace') {
      try {
        const snapshot = services.workspaces && services.workspaces.list && services.workspaces.list.getSnapshot();
        const items = snapshot && snapshot.items;
        if (Array.isArray(items)) {
          return items.map((workspace) => ({
            value: String(workspace.workspaceId),
            label: workspace.title || workspace.path || String(workspace.workspaceId),
          }));
        }
      } catch (error) { /* picker unavailable → free text */ }
      return null;
    }
    if (scope === 'session') {
      try {
        const snapshot = services.sessions && services.sessions.list && services.sessions.list.getSnapshot();
        const byId = snapshot && snapshot.byId;
        if (byId) {
          return Object.values(byId)
            .filter((row) => row && row.id && row.origin !== 'subagent')
            .map((row) => ({ value: String(row.id), label: row.title || String(row.id) }));
        }
      } catch (error) { /* picker unavailable → free text */ }
      return null;
    }
    return [];
  }

  const blankForm = () => ({ index: -1, id: '', label: '', icon: '', command: '', workdir: '', scope: 'global', target: '' });

  function ConfigPanel({ t }) {
    useStore();
    const config = store.config;
    const [rows, setRows] = React.useState(null);
    const [form, setForm] = React.useState(null);

    React.useEffect(() => {
      if (!store.config) loadConfig().catch(() => {});
    }, []);

    React.useEffect(() => {
      if (rows === null && store.config) setRows(store.config.buttons.map((button) => ({ ...button })));
    }, [rows, store.config]);

    const setField = (field, value) => setForm((current) => (current ? { ...current, [field]: value } : current));

    const validate = (candidate) => {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate.id || '')) return t('err.form.id');
      if (!(candidate.label || '').trim()) return t('err.form.label');
      if (!(candidate.command || '').trim()) return t('err.form.command');
      return null;
    };

    const applyForm = () => {
      if (!form) return;
      // An empty id is derived from the label so the user is not forced to
      // invent a slug; an entered id must still pass the pattern check.
      const candidate = { ...form, id: (form.id || '').trim() || uniqueId(form.label, rows || []) };
      const problem = validate(candidate);
      if (problem) { store.configError = problem; notify(); return; }
      const entry = {
        id: candidate.id,
        label: form.label.trim(),
        command: form.command,
        scope: form.scope,
        target: form.scope === 'global' ? '' : (form.target || ''),
        workdir: (form.workdir || '').trim(),
        icon: (form.icon || '').trim(),
      };
      const next = rows ? rows.slice() : [];
      if (form.index < 0) next.push(entry);
      else next[form.index] = entry;
      setRows(next);
      setForm(null);
      store.configError = null;
      notify();
    };

    const startNew = () => setForm(blankForm());

    const startEdit = (index) => {
      const source = rows[index];
      setForm({
        index,
        id: source.id,
        label: source.label,
        icon: source.icon || '',
        command: source.command,
        workdir: source.workdir || '',
        scope: source.scope || 'global',
        target: source.target || '',
      });
    };

    const move = (index, delta) => {
      const next = rows.slice();
      const target = index + delta;
      if (target < 0 || target >= next.length) return;
      const keep = next[index];
      next[index] = next[target];
      next[target] = keep;
      setRows(next);
      notify();
    };

    const remove = (index) => {
      const label = rows[index].label;
      if (typeof confirm === 'function' && !confirm(t('config.deleteConfirm', { label }))) return;
      setRows(rows.filter((_, position) => position !== index));
      if (form && form.index === index) setForm(null);
      notify();
    };

    const scopeOptions = ['global', 'workspace', 'session'];
    const targets = form ? targetOptions(form.scope) : [];

    return h('div', { className: 'qa-mask', onClick: (event) => {
      if (event.target === event.currentTarget) { store.overlay = null; notify(); }
    } },
      h('style', null, CSS),
      h('div', { className: 'qa-modal', role: 'dialog', 'aria-label': t('config.title') },
        h('div', { className: 'qa-modal-head' },
          h('span', null, t('config.title')),
          h('span', { className: 'qa-status' },
            store.configBusy ? t('config.saving') : store.savedFlash ? t('config.saved') : ''),
          h('button', {
            className: 'qa-iconbtn',
            title: t('config.close'),
            'aria-label': t('config.close'),
            onClick: () => { store.overlay = null; notify(); },
          }, '✕')
        ),
        h('div', { className: 'qa-modal-body' },
          h('div', { className: 'qa-toolbar' },
            h('button', { className: 'qa-act', onClick: startNew, disabled: !!form }, t('config.add')),
            h('button', {
              className: 'qa-act',
              'data-kind': 'primary',
              disabled: store.configBusy || !rows,
              onClick: () => { if (rows) saveConfig(rows); },
            }, store.configBusy ? t('config.saving') : t('config.save')),
            store.configError ? h('span', { className: 'qa-error' }, store.configError) : null
          ),
          rows === null ? h('span', { className: 'qa-hint' }, t('config.loading'))
            : rows.length === 0 ? h('span', { className: 'qa-hint' }, t('config.empty'))
            : h('div', { className: 'qa-list' }, rows.map((row, index) => h('div', {
              className: 'qa-row',
              key: row.id,
            },
              h('div', { className: 'qa-row-main' },
                h('span', { className: 'qa-row-title' }, row.icon ? `${row.icon} ` : '', row.label),
                h('span', { className: 'qa-row-meta' },
                  `${t(`scope.${row.scope || 'global'}`)} · ${row.command}`)
              ),
              h('div', { className: 'qa-row-actions' },
                h('button', { className: 'qa-iconbtn', title: t('config.moveUp', { label: row.label }), disabled: index === 0, onClick: () => move(index, -1) }, '↑'),
                h('button', { className: 'qa-iconbtn', title: t('config.moveDown', { label: row.label }), disabled: index === rows.length - 1, onClick: () => move(index, 1) }, '↓'),
                h('button', { className: 'qa-iconbtn', title: t('config.edit', { label: row.label }), onClick: () => startEdit(index) }, '✎'),
                h('button', { className: 'qa-iconbtn', title: t('config.delete', { label: row.label }), onClick: () => remove(index) }, '✕')
              )
            ))),
          form ? h('div', { className: 'qa-form' },
            h('div', { className: 'qa-sectiontitle' }, form.index < 0 ? t('config.formNew') : t('config.formEdit')),
            h('div', { className: 'qa-field' },
              h('span', { className: 'qa-fieldlabel' }, t('field.label')),
              h('input', {
                className: 'qa-input',
                value: form.label,
                onChange: (event) => setField('label', event.target.value),
              })
            ),
            h('div', { style: { display: 'flex', gap: '8px' } },
              h('div', { className: 'qa-field', style: { flex: '2' } },
                h('span', { className: 'qa-fieldlabel' }, t('field.id')),
                h('input', {
                  className: 'qa-input',
                  value: form.id,
                  onChange: (event) => setField('id', event.target.value),
                }),
                h('span', { className: 'qa-fieldhint' }, t('field.idHint'))
              ),
              h('div', { className: 'qa-field', style: { flex: '1' } },
                h('span', { className: 'qa-fieldlabel' }, t('field.icon')),
                h('input', {
                  className: 'qa-input',
                  value: form.icon,
                  onChange: (event) => setField('icon', event.target.value),
                })
              )
            ),
            h('div', { className: 'qa-field' },
              h('span', { className: 'qa-fieldlabel' }, t('field.command')),
              h('textarea', {
                className: 'qa-input',
                value: form.command,
                onChange: (event) => setField('command', event.target.value),
              }),
              h('span', { className: 'qa-fieldhint' }, t('field.commandHint'))
            ),
            h('div', { className: 'qa-field' },
              h('span', { className: 'qa-fieldlabel' }, t('field.workdir')),
              h('input', {
                className: 'qa-input',
                value: form.workdir,
                onChange: (event) => setField('workdir', event.target.value),
              }),
              h('span', { className: 'qa-fieldhint' }, t('field.workdirHint'))
            ),
            h('div', { style: { display: 'flex', gap: '8px' } },
              h('div', { className: 'qa-field', style: { flex: '1' } },
                h('span', { className: 'qa-fieldlabel' }, t('field.scope')),
                h('select', {
                  className: 'qa-input',
                  value: form.scope,
                  onChange: (event) => setForm({ ...form, scope: event.target.value, target: '' }),
                }, scopeOptions.map((scope) => h('option', { key: scope, value: scope }, t(`scope.${scope}`))))
              ),
              form.scope === 'global' ? null : h('div', { className: 'qa-field', style: { flex: '1' } },
                h('span', { className: 'qa-fieldlabel' }, t('field.target')),
                targets === null
                  ? h('input', {
                    className: 'qa-input',
                    value: form.target,
                    placeholder: t('target.custom'),
                    onChange: (event) => setField('target', event.target.value),
                  })
                  : h('select', {
                    className: 'qa-input',
                    value: form.target,
                    onChange: (event) => setField('target', event.target.value),
                  },
                  h('option', { key: '', value: '' },
                    form.scope === 'workspace' ? t('target.anyWorkspace') : t('target.anySession')),
                  targets.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
              )
            ),
            h('span', { className: 'qa-hint' }, t(`hint.${form.scope}`)),
            h('div', { className: 'qa-toolbar' },
              h('button', { className: 'qa-act', 'data-kind': 'primary', onClick: applyForm },
                form.index < 0 ? t('config.apply') : t('config.update')),
              h('button', { className: 'qa-act', onClick: () => setForm(null) }, t('config.cancel'))
            )
          ) : null,
          config && config.configButtons && config.configButtons.length
            ? h('div', { className: 'qa-list' },
              h('span', { className: 'qa-sectiontitle' }, t('config.readonly')),
              config.configButtons.map((row) => h('div', {
                className: 'qa-row',
                'data-readonly': 'true',
                key: row.id,
              },
                h('div', { className: 'qa-row-main' },
                  h('span', { className: 'qa-row-title' }, row.icon ? `${row.icon} ` : '', row.label),
                  h('span', { className: 'qa-row-meta' }, `${t(`scope.${row.scope || 'global'}`)} · ${row.command}`)
                )
              )))
            : null
        ),
        h('div', { className: 'qa-modal-foot' },
          h('span', { className: 'qa-hint' },
            config && config.storePath ? t('config.store', { path: config.storePath }) : '')
        )
      )
    );
  }

  // A slugified label, made unique against the rows already in the list;
  // labels without usable ASCII (e.g. Chinese) fall back to `btn`, `btn-2`, …
  function uniqueId(label, siblings) {
    const taken = new Set(siblings.map((row) => row.id));
    let base = String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    if (!/^[a-z0-9]/.test(base)) base = 'btn';
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base}-${String(suffix)}`)) suffix += 1;
    return `${base}-${String(suffix)}`;
  }

  function Overlay({ t: tProp }) {
    useStore();
    const t = tProp || localT;
    const overlay = store.overlay;
    if (!overlay) return null;
    if (overlay.kind === 'output') {
      return h(OutputModal, {
        skey: overlay.skey,
        sessionId: overlay.sessionId,
        buttonId: overlay.buttonId,
        t,
      });
    }
    return h(ConfigPanel, { t });
  }

  // ── plugin entry ─────────────────────────────────────────────────────────

  function apply(ctx) {
    const slots = ctx.get('slots');
    if (!slots || typeof slots.inject !== 'function') {
      console.log('[quick-actions] slots unavailable; nothing to render');
      return;
    }

    services.sessions = ctx.get('sessions') || null;
    services.workspaces = ctx.get('workspaces') || null;

    // Route static strings through the host locale when it exists; components
    // fall back to `localT` otherwise.
    const locale = ctx.get('locale');
    if (locale && typeof locale.register === 'function') {
      try {
        ctx.effect(() => locale.register(NS, { zh, en }), 'quick-actions: dictionaries');
      } catch (error) { console.log('[quick-actions] locale registration failed:', String(error)); }
    }

    if (typeof ctx.interval === 'function') {
      intervalFn = (fn, ms) => ctx.interval(fn, ms);
    }

    // Mounted strips refresh their context every three seconds; that is also
    // what re-renders the sidebar when the session on screen changes.
    ctx.effect(() => {
      const dispose = intervalFn(() => { refreshActiveContexts(); }, 3000);
      return dispose;
    }, 'quick-actions: poll');

    if (typeof document !== 'undefined' && document.addEventListener) {
      ctx.effect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          if (store.overlay) { store.overlay = null; notify(); return; }
          if (store.popover) { store.popover = null; notify(); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, 'quick-actions: escape');
    }

    const injectSlot = (hole, spec, Component) => {
      try {
        slots.inject(hole, () => {
          try { return slots.register(spec, Component); } catch (error) {
            console.log(`[quick-actions] register ${hole} failed:`, String(error && error.message || error));
            return null;
          }
        });
      } catch (error) {
        console.log(`[quick-actions] slot ${hole} unavailable:`, String(error && error.message || error));
      }
    };

    injectSlot('conversation.session.header.actions', {
      name: 'conversation.session.header.actions',
      id: 'quick-actions',
      order: 30,
      locale: NS,
    }, (props) => h(Strip, { ...props, variant: 'header' }));

    injectSlot('sidebar.footer.action', {
      name: 'sidebar.footer.action',
      id: 'quick-actions',
      order: 10,
      locale: NS,
    }, (props) => h(Strip, { ...props, sessionId: null, variant: 'sidebar' }));

    injectSlot('shell.overlay', {
      name: 'shell.overlay',
      id: 'quick-actions',
      locale: NS,
    }, Overlay);

    console.log('[quick-actions] Client plugin initialized');
  }

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  return module.exports;
}});
