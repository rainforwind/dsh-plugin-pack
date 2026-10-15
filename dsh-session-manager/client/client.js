// Browser half of Session Manager.
//
// Two contributions over one pending-request store:
//   * a `sidebar.workspaces.session.menu.item` row (order 500, after the
//     shipped Archive at 400) that asks the Host whether the row's session is
//     archived and renders nothing otherwise,
//   * a `shell.overlay` confirmation dialog that states the irreversibility,
//     performs the delete through the Host route, and surfaces refusals.
//
// The Host owns every decision: the row only asks `GET /dsh-session-manager/
// state`, and the delete revalidates existence, archived state, and liveness
// at execution time. The client renders its own controls (no ui-primitives
// import) with host theme tokens, following the plugin-pack convention.
window.__ModuleLoader__.load({ id: 'dsh-session-manager', factory: (require) => {
  const React = require('react')
  const h = React.createElement

  const NS = 'dsh-session-manager'
  const inject = ['slots']

  // ── locale ───────────────────────────────────────────────────────────────

  const en = {
    'menu.delete': 'Delete…',
    'confirm.title': 'Delete archived session?',
    'confirm.desc': 'Permanently deletes “{title}” and its session log. This cannot be undone.',
    'confirm.desc.ghost': 'Removes the leftover entry for “{title}” — its session files are already gone. This cannot be undone.',
    'confirm.action': 'Delete permanently',
    'cancel': 'Cancel',
    'pending': 'Deleting…',
    'err.invalid-id': 'No session was selected.',
    'err.not-found': 'This session no longer exists.',
    'err.not-archived': 'This session is no longer archived.',
    'err.live': 'This session is still running and would not stop; try again once it settles.',
    'err.resident': 'This session is still open somewhere; close it and retry.',
    'err.no-backend': 'Session storage does not support deletion here.',
    'err.no-registry': 'The workspace registry is unavailable.',
    'err.io': 'Could not remove the session files.',
    'err.registry': 'Could not update the archive list.',
    'err.origin': 'Request refused by the host.',
    'err.http': 'Request failed ({code}).',
    'err.network': 'Cannot reach the host.',
    'err.generic': 'Delete failed.',
  }

  const zh = {
    'menu.delete': '删除…',
    'confirm.title': '删除已归档会话？',
    'confirm.desc': '将永久删除“{title}”及其会话日志，此操作无法撤销。',
    'confirm.desc.ghost': '将清除“{title}”的残留归档记录——其会话文件早已不存在，无法撤销。',
    'confirm.action': '永久删除',
    'cancel': '取消',
    'pending': '正在删除…',
    'err.invalid-id': '未选择任何会话。',
    'err.not-found': '该会话已不存在。',
    'err.not-archived': '该会话已不在归档中。',
    'err.live': '该会话仍在运行且未能停止，请稍后重试。',
    'err.resident': '该会话仍被某处占用（视图未关闭），请关闭后重试。',
    'err.no-backend': '当前会话存储不支持删除。',
    'err.no-registry': '工作区注册表不可用。',
    'err.io': '无法删除会话文件。',
    'err.registry': '无法更新归档列表。',
    'err.origin': '请求被主机拒绝。',
    'err.http': '请求失败（{code}）。',
    'err.network': '无法连接主机。',
    'err.generic': '删除失败。',
  }

  function preferredDict() {
    try {
      const languages = (typeof navigator !== 'undefined' && (navigator.languages || [navigator.language])) || []
      for (const language of languages) {
        if (typeof language === 'string' && language.toLowerCase().startsWith('zh')) return zh
      }
    } catch (error) { /* no navigator */ }
    return en
  }

  function makeT(dict) {
    return (key, params) => {
      let text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
      if (params) {
        for (const name of Object.keys(params)) {
          text = text.split('{' + name + '}').join(String(params[name]))
        }
      }
      return text
    }
  }

  // Fallback when the locale service does not hand the component a `t`.
  const localT = makeT(preferredDict())

  // ── tiny observable (getSnapshot/subscribe, uSES-compatible) ──────────────

  function makeStore(initial) {
    let value = initial
    const listeners = new Set()
    return {
      getSnapshot: () => value,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set(next) {
        if (Object.is(value, next)) return
        value = next
        for (const listener of [...listeners]) {
          try { listener() } catch (error) { /* isolated listener failure */ }
        }
      },
    }
  }

  // ── host communication ───────────────────────────────────────────────────

  function api(path) {
    const relative = path.replace(/^\/+/, '')
    if (typeof document === 'undefined' || !document.baseURI) return '/' + relative
    const url = new URL(relative, document.baseURI)
    return url.pathname + url.search
  }

  async function requestJson(path, options) {
    let response
    try {
      response = await fetch(api(path), options)
    } catch (error) {
      const wrapped = new Error(localT('err.network'))
      wrapped.code = 'network'
      throw wrapped
    }
    let data = {}
    try { data = await response.json() } catch (error) { data = {} }
    if (!response.ok) {
      const failure = new Error(data.message || localT('err.http', { code: response.status }))
      failure.code = typeof data.error === 'string' ? data.error : 'http'
      failure.status = response.status
      throw failure
    }
    return data
  }

  const getState = (sessionId, signal) =>
    requestJson(`/dsh-session-manager/state?sessionId=${encodeURIComponent(sessionId)}`, { signal }).then((data) => data.state)

  const postDelete = (sessionId) =>
    requestJson('/dsh-session-manager/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })

  // ── styles (theme tokens only; component-local, unmount with the tree) ────

  const CSS = `
.sm-wrap{position:relative}
.sm-sep{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2)}
.sm-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md,6px);background:transparent;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);text-align:left;font-family:inherit}
.sm-item:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.sm-item:focus-visible:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);outline:none}
.sm-item:disabled{opacity:.55;cursor:default}
.sm-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center}
.sm-icon svg{width:14px;height:14px}
.sm-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-mask{position:fixed;inset:0;z-index:80;background:color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent);display:flex;align-items:center;justify-content:center;padding:24px}
.sm-dialog{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.4);display:flex;flex-direction:column;width:min(440px,92vw);max-height:86vh;overflow:hidden}
.sm-dialog-head{padding:14px 16px 4px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sm-dialog-body{padding:4px 16px 14px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow:auto}
.sm-status{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sm-error{margin-top:8px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.sm-dialog-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.sm-btn{height:28px;padding:0 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.sm-btn:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, var(--dsw-alias-bg-layer-2))}
.sm-btn:focus-visible:not(:disabled){outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sm-btn[data-kind="danger"]{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}
.sm-btn[data-kind="danger"]:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 85%, var(--dsw-alias-bg-base))}
.sm-btn:disabled{opacity:.55;cursor:default}
`

  function Styles() {
    return h('style', undefined, CSS)
  }

  // Own 14px trash glyph; no ui-primitives import.
  function TrashIcon() {
    return h('svg', {
      viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    },
    h('path', { d: 'M2.5 4.5h11' }),
    h('path', { d: 'M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3' }),
    h('path', { d: 'M4 4.5l.6 8.3c.05.6.5 1.2 1.1 1.2h4.6c.6 0 1.05-.6 1.1-1.2l.6-8.3' }),
    h('path', { d: 'M6.6 7v4M9.4 7v4' }))
  }

  // ── the row menu entry ───────────────────────────────────────────────────

  function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
    const [, setMenuOpen] = useMenuOpenState()
    const [state, setState] = React.useState(null)
    React.useEffect(() => {
      let alive = true
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const signal = controller ? controller.signal : undefined
      getState(sessionId, signal)
        .then((next) => {
          // Archived is the only gate: a running turn is settled by the Host's
          // delete flow (stop-then-delete), and a ghost (files gone, archive
          // entry left behind) must stay deletable — it cleans the residue.
          if (alive) setState(next || null)
        })
        .catch((error) => {
          if (!alive) return
          setState(null)
          console.log('[session-manager] state lookup failed for', sessionId, String(error && error.message || error))
        })
      return () => { alive = false; if (controller) controller.abort() }
    }, [sessionId])
    if (!state || !state.archived) return null
    const tFn = t || localT
    return h('div', { className: 'sm-wrap' },
      h(Styles),
      h('div', { className: 'sm-sep', role: 'separator' }),
      h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'sm-item',
        onClick: () => {
          setMenuOpen(false)
          requestDelete(sessionId, displayTitle || sessionId, state.exists !== false)
        },
      },
      h('span', { className: 'sm-icon' }, h(TrashIcon)),
      h('span', { className: 'sm-label' }, tFn('menu.delete'))))
  }

  // ── the confirmation dialog ──────────────────────────────────────────────

  function DeleteConfirmDialog({ usePending, dismissPending, t }) {
    const pending = usePending((value) => value)
    const [deleting, setDeleting] = React.useState(false)
    const [error, setError] = React.useState(null)
    const cancelRef = React.useRef(null)
    const restoreRef = React.useRef(null)
    const tFn = t || localT
    React.useEffect(() => {
      if (!pending) return undefined
      setDeleting(false)
      setError(null)
      restoreRef.current = typeof document !== 'undefined' ? document.activeElement : null
      const focusTimer = setTimeout(() => {
        try { if (cancelRef.current) cancelRef.current.focus() } catch (error) { /* no focus */ }
      }, 0)
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          dismissPending()
        }
      }
      if (typeof document !== 'undefined') document.addEventListener('keydown', onKey, true)
      return () => {
        clearTimeout(focusTimer)
        if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey, true)
        const restore = restoreRef.current
        if (restore && typeof restore.isConnected === 'function' && restore.isConnected) {
          try { restore.focus() } catch (error) { /* no focus */ }
        }
      }
    }, [pending])
    if (!pending) return null
    const close = () => { if (!deleting) dismissPending() }
    const confirm = () => {
      setDeleting(true)
      setError(null)
      postDelete(pending.sessionId)
        .then(() => { setDeleting(false); dismissPending() })
        .catch((reason) => {
          setDeleting(false)
          // Known refusal codes get the localized copy; requestJson already
          // localized network/HTTP failures in its message.
          const code = reason && reason.code
          if (code && Object.prototype.hasOwnProperty.call(en, 'err.' + code)) setError(tFn('err.' + code))
          else setError((reason && reason.message) || tFn('err.generic'))
        })
    }
    const titleId = 'sm-delete-dialog-title'
    return h('div', {
      className: 'sm-mask',
      onMouseDown: (event) => { if (event.target === event.currentTarget) close() },
    },
    h(Styles),
    h('div', {
      className: 'sm-dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    },
    h('div', { className: 'sm-dialog-head', id: titleId }, tFn('confirm.title')),
    h('div', { className: 'sm-dialog-body' },
      pending.exists === false
        ? tFn('confirm.desc.ghost', { title: pending.displayTitle })
        : tFn('confirm.desc', { title: pending.displayTitle }),
      deleting && h('div', { className: 'sm-status', role: 'status' }, tFn('pending')),
      error && h('div', { className: 'sm-error', role: 'alert' }, error)),
    h('div', { className: 'sm-dialog-foot' },
      h('button', {
        type: 'button', className: 'sm-btn', disabled: deleting, ref: cancelRef, onClick: close,
      }, tFn('cancel')),
      h('button', {
        type: 'button', className: 'sm-btn', 'data-kind': 'danger', disabled: deleting, onClick: confirm,
      }, tFn('confirm.action')))))
  }

  // ── activation ───────────────────────────────────────────────────────────

  function apply(ctx) {
    const slots = ctx.get('slots')
    if (!slots || typeof slots.inject !== 'function') {
      console.log('[session-manager] slots unavailable; nothing to render')
      return
    }

    const locale = ctx.get('locale')
    if (locale && typeof locale.register === 'function') {
      try {
        ctx.effect(() => locale.register(NS, { en, zh }), 'dsh-session-manager: dictionaries')
      } catch (error) { console.log('[session-manager] locale registration failed:', String(error)) }
    }

    // One pending request links the menu row to the overlay dialog.
    const pending = makeStore(null)
    const requestDelete = (sessionId, displayTitle, exists) => pending.set({ sessionId, displayTitle, exists })
    const dismissPending = () => pending.set(null)

    ctx.effect(() => slots.inject('sidebar.workspaces.session.menu.item', () => {
      try {
        return slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-session-manager.delete',
          order: 500,
          locale: NS,
          inject: () => ({ requestDelete }),
        }, DeleteMenuItem)
      } catch (error) {
        console.log('[session-manager] register FAILED:', String(error && error.message || error))
        throw error
      }
    }), 'dsh-session-manager: menu item')

    ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
      name: 'shell.overlay',
      id: 'dsh-session-manager.delete-confirm',
      locale: NS,
      inject: () => ({ hooks: { pending }, dismissPending }),
    }, DeleteConfirmDialog)), 'dsh-session-manager: delete dialog')

    console.log('[session-manager] client active')
  }

  return { inject, apply }
} })
