window.__ModuleLoader__.load({ id: "dsh-task-badge", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  let React = require("react");

  const name = "dsh-task-badge-client";
  const inject = ["timer", "sessions"];

  // ── locale ───────────────────────────────────────────────────────────────

  const NS = "task-badge";

  const en = {
    "card.title": "Task status",
    "badge.running": "{n} running",
    "badge.unread": "{n} unread",
    "badge.tip": "{parts} — click for details",
    "sec.running": "Running",
    "sec.unread": "Unread",
    "row.onscreen": "on screen",
    "row.jobsDone": "finished job",
    "row.inSession": "in {title}",
    "row.noOwner": "no session",
    "card.empty": "Nothing to report",
    "card.close": "Close",
  };

  const zh = {
    "card.title": "任务状态",
    "badge.running": "{n} 个运行中",
    "badge.unread": "{n} 个未读",
    "badge.tip": "{parts} — 点击查看详情",
    "sec.running": "运行中",
    "sec.unread": "未读",
    "row.onscreen": "当前会话",
    "row.jobsDone": "已完成任务",
    "row.inSession": "在 {title}",
    "row.noOwner": "无所属会话",
    "card.empty": "暂无内容",
    "card.close": "关闭",
  };

  function makeT(dict) {
    return (key, params) => {
      let text = dict[key] != null ? dict[key] : (en[key] != null ? en[key] : key);
      if (params) {
        for (const name of Object.keys(params)) {
          text = text.split("{" + name + "}").join(String(params[name]));
        }
      }
      return text;
    };
  }

  function preferredDict() {
    try {
      if (typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "")) return zh;
    } catch (e) { /* no navigator */ }
    return en;
  }

  // Fallback when the locale service does not hand the component a `t`.
  const localT = makeT(preferredDict());

  // ── styles (tokens only; component-local, unmounted with the tree) ───────

  const CSS = `
.tb-wrap{position:relative;display:inline-flex}
.tb-badge{display:flex;align-items:center;gap:4px;padding:4px 6px;border-radius:6px;cursor:pointer}
.tb-badge:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tb-pill{border-radius:10px;font-size:11px;font-weight:600;min-width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0 4px;color:var(--dsw-alias-label-primary-foreground);font-family:-apple-system,BlinkMacSystemFont,sans-serif}
.tb-pill[data-kind="running"]{background:var(--dsw-alias-state-business-primary)}
.tb-pill[data-kind="unread"]{background:var(--dsw-alias-state-error-primary)}
/* The badge sits in the sidebar footer, so the card opens upward like the
   quick-actions strip does — anchored to the badge's left edge. */
.tb-pop{position:absolute;bottom:calc(100% + 6px);left:0;z-index:60;width:min(340px,78vw);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.32);display:flex;flex-direction:column;overflow:hidden;text-align:left;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.tb-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.tb-close{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;border-radius:4px;font-family:inherit}
.tb-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tb-body{display:flex;flex-direction:column;padding:6px 0;max-height:50vh;overflow:auto}
.tb-sectiontitle{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:4px 12px 2px}
.tb-row{display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary)}
.tb-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tb-row[data-clickable="false"]{cursor:default}
.tb-row[data-clickable="false"]:hover{background:transparent}
.tb-dot{width:7px;height:7px;border-radius:50%;flex:none}
.tb-dot[data-kind="running"]{background:none;border:1.5px solid var(--dsw-alias-state-business-primary);border-right-color:transparent;animation:tb-spin .9s linear infinite}
.tb-dot[data-kind="unread"]{background:var(--dsw-alias-state-error-primary)}
.tb-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-sub{flex:none;max-width:45%;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-empty{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:8px 12px}
@keyframes tb-spin{to{transform:rotate(360deg)}}
`;

  function api(path) {
    const relative = path.replace(/^\/+/, "");
    if (typeof document === "undefined") return "/" + relative;
    return new URL(relative, document.baseURI).pathname;
  }

  function apply(ctx) {
    const slots = ctx.get("slots");
    const sessions = ctx.get("sessions");

    function getCurrentSessionId() {
      if (!sessions) return null;
      try {
        // The live main session is the `byId` row still retained by
        // `mainView` — the snapshot is `{ ids, byId, phase, ... }` and has no
        // `current` field, so reading `.current` always yielded null.
        const byId = sessions.list?.getSnapshot?.()?.byId;
        if (!byId) return null;
        const rows = Object.values(byId);
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (row && (row.retainedBy?.mainView ?? 0) > 0) return row.id ?? null;
        }
        return null;
      } catch (e) { return null; }
    }

    // Subagent children are projected into `byId` alongside real
    // conversations. `origin` is `'subagent'` or absent, nothing else, so
    // this test cannot hit a user's own session.
    function isSubagentSession(id) {
      if (!sessions || !id) return false;
      try {
        return sessions.list?.getSnapshot?.()?.byId?.[id]?.origin === "subagent";
      } catch (e) { return false; }
    }

    // Display name for a session: the projected list row carries both a
    // human title and a derived `displayTitle`; fall back to a short id so a
    // card row is never an opaque UUID.
    function sessionTitle(id) {
      if (!sessions || !id) return String(id ?? "");
      try {
        const row = sessions.list?.getSnapshot?.()?.byId?.[id];
        const title = row && (row.displayTitle || row.title);
        if (title) return String(title);
      } catch (e) {}
      return String(id).replace(/^session-/, "").slice(0, 8);
    }

    // Navigation lives on `uiWorkspace`, not on the sessions store —
    // `sessions` exposes retain/using/binding and has no `open()`.
    function openSession(id) {
      if (!id) return;
      try {
        const navigation = ctx.get("uiWorkspace");
        if (navigation && typeof navigation.openSession === "function") {
          navigation.openSession(id);
        }
      } catch (e) {}
    }

    // Route static strings through the host locale when it exists; components
    // fall back to `localT` otherwise.
    try {
      const locale = ctx.get("locale");
      if (locale && typeof locale.register === "function") {
        ctx.effect(() => locale.register(NS, { zh, en }), "dsh-task-badge: dictionaries");
      }
    } catch (e) {}

    // The shell ships one icon link per color scheme
    //   <link rel="icon" ... href="favicon-dark.svg" media="(prefers-color-scheme: dark)">
    //   <link rel="icon" ... href="favicon.svg"      media="(prefers-color-scheme: light)">
    // so patching only the first `link[rel=icon]` updates the tab for one
    // scheme and leaves the other untouched. Remember every one of them.
    var iconLinks = [];
    var origImg = null;
    var baseSrc = null;
    var lastDraw = null;   // [running, unread] last painted, null when cleared

    function rememberIcons() {
      try {
        const links = document.querySelectorAll("link[rel*='icon']");
        for (let i = 0; i < links.length; i++) {
          iconLinks.push({
            link: links[i],
            href: links[i].href,
            type: links[i].getAttribute("type"),
            owned: false
          });
        }
      } catch (e) {}
    }
    rememberIcons();

    // Artwork to draw under the badge: the variant the reader's scheme picks.
    function schemeIconHref() {
      if (iconLinks.length === 0) return null;
      let dark = false;
      try { dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); } catch (e) {}
      for (let i = 0; i < iconLinks.length; i++) {
        const media = iconLinks[i].link.getAttribute("media") || "";
        if (dark && media.indexOf("dark") >= 0) return iconLinks[i].href;
        if (!dark && media.indexOf("light") >= 0) return iconLinks[i].href;
      }
      return iconLinks[0].href;
    }

    function loadBaseImage() {
      try {
        const src = schemeIconHref();
        if (!src || src === baseSrc) return;
        baseSrc = src;
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = function () {
          if (baseSrc !== src) return;
          origImg = img;
          // The first badge may have been painted before this arrived; put the
          // artwork behind it now rather than waiting a whole poll.
          if (lastDraw) setFavicon(lastDraw[0], lastDraw[1]);
        };
        img.onerror = function () { origImg = null; };
        img.src = src;
      } catch (e) {}
    }

    function setFavicon(r, u) {
      try {
        loadBaseImage();
        if (r + u <= 0) { lastDraw = null; clearFavicon(); return; }
        lastDraw = [r, u];

        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const cx = canvas.getContext("2d");
        if (origImg) { try { cx.drawImage(origImg, 0, 0, 32, 32); } catch (e) {} }

        if (r > 0 && u > 0) {
          drawBadge(cx, 22, 8, 8, "#3b82f6", r);
          drawBadge(cx, 24, 24, 9, "#ef4444", u);
        } else if (r > 0) {
          drawBadge(cx, 24, 24, 10, "#3b82f6", r);
        } else {
          drawBadge(cx, 24, 24, 10, "#ef4444", u);
        }

        const dataUrl = canvas.toDataURL("image/png");
        if (iconLinks.length === 0) {
          const link = document.createElement("link");
          link.rel = "icon";
          link.type = "image/png";
          link.href = dataUrl;
          document.head.appendChild(link);
          iconLinks.push({ link: link, href: null, type: null, owned: true });
          return;
        }
        // Same artwork on every icon link: the browser then shows the badge
        // whichever color scheme is active.
        for (let i = 0; i < iconLinks.length; i++) {
          const entry = iconLinks[i];
          if (entry.owned && !entry.link.isConnected) continue;
          entry.link.type = "image/png";
          entry.link.href = dataUrl;
        }
      } catch (e) {}
    }

    function drawBadge(cx, x, y, radius, color, count) {
      cx.beginPath();
      cx.arc(x, y, radius, 0, Math.PI * 2);
      cx.fillStyle = color;
      cx.fill();
      cx.strokeStyle = "white";
      cx.lineWidth = 1.5;
      cx.stroke();
      cx.fillStyle = "white";
      cx.font = "bold " + (radius > 8 ? 10 : 8) + "px sans-serif";
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.fillText(count > 99 ? "99+" : String(count), x, y);
    }

    function clearFavicon() {
      const keep = [];
      for (let i = 0; i < iconLinks.length; i++) {
        const entry = iconLinks[i];
        try {
          if (entry.owned) {
            // We created it for a shell that ships no icon link at all.
            if (entry.link.parentNode) entry.link.parentNode.removeChild(entry.link);
            continue;
          }
          if (entry.href) entry.link.setAttribute("href", entry.href);
          if (entry.type === null || entry.type === undefined) entry.link.removeAttribute("type");
          else entry.link.setAttribute("type", entry.type);
        } catch (e) {}
        keep.push(entry);
      }
      iconLinks = keep;
    }

    // Polling is a document-level concern, not a component's: the favicon has
    // to keep updating whether or not the sidebar footer happens to be
    // mounted. `TaskBadge` only subscribes to this state.
    const badgeState = { running: 0, unread: 0 };
    const listeners = new Set();
    let alive = true;

    // The detail card: closed by default, refreshed from the read-only state
    // route whenever it is open (once on open, then on every poll tick).
    const card = { open: false, data: null };

    function notify() {
      listeners.forEach(function (fn) {
        try { fn(); } catch (e) {}
      });
    }

    function publishState(running, unread) {
      // Unchanged counts must not wake React up every three seconds.
      const changed = badgeState.running !== running || badgeState.unread !== unread;
      badgeState.running = running;
      badgeState.unread = unread;
      if (!changed) return;
      notify();
    }

    // One fetch behind the card: `/task-badge/state` names the exact sessions
    // and jobs behind every number, so the card and the badge can never
    // disagree about what they are counting.
    async function refreshCard() {
      try {
        const res = await fetch(api("/task-badge/state"));
        const data = await res.json();
        if (!alive) return;
        card.data = data;
        notify();
      } catch (e) {}
    }

    function setCardOpen(open) {
      if (card.open === open) return;
      card.open = open;
      if (open) refreshCard();
      notify();
    }

    async function poll() {
      try {
        const cur = getCurrentSessionId();

        // Tell the host which session is on screen — and wait for it.
        // Sending this fire-and-forget let the counts request overtake it, so
        // the host answered with the stale "unread" it had not cleared yet.
        // A null sessionId releases the host's remembered session.
        try {
          await fetch(api("/task-badge/mark-viewed"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: cur })
          });
        } catch (e) {}

        const res = await fetch(api("/task-badge/counts"));
        const data = await res.json();
        if (!alive) return;

        const unreadIds = data.unreadSessionIds || [];

        // Compute unread: drop what is already on screen, and subagent
        // children — those are never the user's own conversation.
        let count = 0;
        for (let i = 0; i < unreadIds.length; i++) {
          if (unreadIds[i] === cur || isSubagentSession(unreadIds[i])) continue;
          count++;
        }
        count += (data.unviewedJobs || 0);

        const running = data.running || 0;
        publishState(running, count);
        setFavicon(running, count);
        // An open card stays truthful as jobs start and finish.
        if (card.open) refreshCard();
      } catch (e) {}
    }

    poll();
    const disposeInterval = ctx.interval(poll, 3000);
    ctx.effect(() => () => {
      alive = false;
      disposeInterval();
      clearFavicon();
    }, "dsh-task-badge: badge poll");

    // Click outside the badge (or Escape) dismisses the card; registered at
    // apply level so the handler exists whether or not the badge is mounted.
    if (typeof document !== "undefined" && document.addEventListener) {
      ctx.effect(() => {
        const onPointer = (event) => {
          if (!card.open) return;
          const target = event && event.target;
          if (target && typeof target.closest === "function" && target.closest("[data-tb-badge]")) return;
          setCardOpen(false);
        };
        const onKey = (event) => {
          if (event && event.key === "Escape") setCardOpen(false);
        };
        document.addEventListener("mousedown", onPointer);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onPointer);
          document.removeEventListener("keydown", onKey);
        };
      }, "dsh-task-badge: card dismiss");
    }

    // The detail card: every row explains one count and jumps to the session
    // behind it -- the badge number alone left users hunting for which
    // conversation was actually running a background job.
    function TaskCard() {
      const t = localT;
      const data = card.data;
      const cur = getCurrentSessionId();

      // Subagent work is never the user's; the current session carries its
      // own badge, so a row for it only says "you are here".
      const runningSessions = ((data && data.runningSessions) || []).filter((id) => !isSubagentSession(id));
      const runningJobs = (data && data.runningJobs) || [];

      // Unread mirrors the badge arithmetic: drop the session on screen and
      // subagent children, and merge the two sources so one session is one
      // row (a finished job in an already-unread session is the same thing
      // to look at).
      const unreadRows = [];
      const seen = Object.create(null);
      const pushUnread = (id, subKey) => {
        if (!id || id === cur || isSubagentSession(id) || seen[id]) return;
        seen[id] = true;
        unreadRows.push({ id: id, subKey: subKey || null });
      };
      ((data && data.unreadSessions) || []).forEach((id) => pushUnread(id, null));
      ((data && data.unviewedJobSessionIds) || []).forEach((id) => pushUnread(id, "row.jobsDone"));

      const runningRows = [];
      runningSessions.forEach((id) => {
        runningRows.push(React.createElement("div", {
          className: "tb-row", key: "s:" + id, "data-clickable": "true",
          onClick: () => { openSession(id); setCardOpen(false); }
        },
          React.createElement("span", { className: "tb-dot", "data-kind": "running" }),
          React.createElement("span", { className: "tb-title" }, sessionTitle(id)),
          id === cur ? React.createElement("span", { className: "tb-sub" }, t("row.onscreen")) : null
        ));
      });
      runningJobs.forEach((job) => {
        const owner = job && job.owner;
        runningRows.push(React.createElement("div", {
          className: "tb-row", key: "j:" + (job && job.id),
          "data-clickable": owner ? "true" : "false",
          onClick: owner ? () => { openSession(owner); setCardOpen(false); } : undefined
        },
          React.createElement("span", { className: "tb-dot", "data-kind": "running" }),
          React.createElement("span", { className: "tb-title" }, String(job && job.id)),
          React.createElement("span", { className: "tb-sub" },
            owner ? t("row.inSession", { title: sessionTitle(owner) }) : t("row.noOwner"))
        ));
      });

      const unread = unreadRows.map((entry) => React.createElement("div", {
        className: "tb-row", key: "u:" + entry.id, "data-clickable": "true",
        onClick: () => { openSession(entry.id); setCardOpen(false); }
      },
        React.createElement("span", { className: "tb-dot", "data-kind": "unread" }),
        React.createElement("span", { className: "tb-title" }, sessionTitle(entry.id)),
        entry.subKey ? React.createElement("span", { className: "tb-sub" }, t(entry.subKey)) : null
      ));

      const empty = runningRows.length + unread.length === 0;
      const section = (labelKey, rows) => rows.length === 0 ? [] : [
        React.createElement("div", { className: "tb-sectiontitle", key: labelKey + "-head" }, t(labelKey)),
      ].concat(rows);

      return React.createElement("div", {
        className: "tb-pop", role: "dialog", "aria-label": t("card.title")
      },
        React.createElement("div", { className: "tb-head" },
          React.createElement("span", null, t("card.title")),
          React.createElement("button", {
            className: "tb-close", title: t("card.close"),
            onClick: () => setCardOpen(false)
          }, "\u00d7")
        ),
        React.createElement("div", { className: "tb-body" },
          empty ? React.createElement("div", { className: "tb-empty" }, t("card.empty")) : null,
          section("sec.running", runningRows),
          section("sec.unread", unread)
        )
      );
    }

    function TaskBadge() {
      const [, bump] = React.useState(0);

      React.useEffect(() => {
        const notifyFn = () => bump((value) => value + 1);
        listeners.add(notifyFn);
        return () => { listeners.delete(notifyFn); };
      }, []);

      const running = badgeState.running;
      const unreadCount = badgeState.unread;
      const total = running + unreadCount;
      // Stay mounted while the card is open, or the popover loses its anchor
      // the moment the last count clears underneath it.
      if (total === 0 && !card.open) return null;

      const parts = [];
      if (running > 0) parts.push(localT("badge.running", { n: running }));
      if (unreadCount > 0) parts.push(localT("badge.unread", { n: unreadCount }));

      return React.createElement("div", { className: "tb-wrap", "data-tb-badge": "1" },
        React.createElement("style", null, CSS),
        React.createElement("div", {
          className: "tb-badge",
          title: parts.length > 0 ? localT("badge.tip", { parts: parts.join(", ") }) : localT("card.empty"),
          onClick: () => setCardOpen(!card.open)
        },
          running > 0 ? React.createElement("span", {
            className: "tb-pill", "data-kind": "running"
          }, String(running)) : null,
          unreadCount > 0 ? React.createElement("span", {
            className: "tb-pill", "data-kind": "unread"
          }, String(unreadCount)) : null
        ),
        card.open ? React.createElement(TaskCard) : null
      );
    }

    // The sidebar entry is optional: without it the favicon badge still works.
    if (slots) {
      slots.inject("sidebar.footer.action", () => slots.register(
        { name: "sidebar.footer.action", id: "task-badge", order: -1, label: "Task Badge" },
        () => React.createElement(TaskBadge)
      ));
    } else {
      console.log("[task-badge] sidebar slots unavailable; favicon badge only");
    }
  }

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  return module.exports;
}});
