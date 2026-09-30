window.__ModuleLoader__.load({ id: "dsh-task-badge", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  let React = require("react");

  const name = "dsh-task-badge-client";
  const inject = ["timer", "sessions"];

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

    // Which session a click should open: the first unread conversation, or —
    // when every unread conversation is already on screen — a session holding
    // a background job that has not been read yet.
    function pickTarget(data, cur) {
      const ids = (data && data.unreadSessionIds) || [];
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== cur && !isSubagentSession(ids[i])) return ids[i];
      }
      const jobOwners = (data && data.unviewedJobSessionIds) || [];
      for (let i = 0; i < jobOwners.length; i++) {
        if (jobOwners[i] !== cur && !isSubagentSession(jobOwners[i])) return jobOwners[i];
      }
      return null;
    }

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

    function publishState(running, unread) {
      // Unchanged counts must not wake React up every three seconds.
      const changed = badgeState.running !== running || badgeState.unread !== unread;
      badgeState.running = running;
      badgeState.unread = unread;
      if (!changed) return;
      listeners.forEach(function (notify) {
        try { notify(); } catch (e) {}
      });
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
      } catch (e) {}
    }

    poll();
    const disposeInterval = ctx.interval(poll, 3000);
    ctx.effect(() => () => {
      alive = false;
      disposeInterval();
      clearFavicon();
    }, "dsh-task-badge: badge poll");

    function TaskBadge() {
      const [, bump] = React.useState(0);

      React.useEffect(() => {
        const notify = () => bump((value) => value + 1);
        listeners.add(notify);
        return () => { listeners.delete(notify); };
      }, []);

      const running = badgeState.running;
      const unreadCount = badgeState.unread;
      const total = running + unreadCount;
      if (total === 0) return null;

      // Click badge → navigate to first unread session
      const handleClick = async () => {
        try {
          const cur = getCurrentSessionId();
          const res = await fetch(api("/task-badge/counts"));
          const data = await res.json();
          const targetId = pickTarget(data, cur);
          if (!targetId) return;

          // Navigation lives on `uiWorkspace`, not on the sessions store —
          // `sessions` exposes retain/using/binding and has no `open()`.
          const navigation = ctx.get("uiWorkspace");
          if (navigation && typeof navigation.openSession === "function") {
            navigation.openSession(targetId);
          }
        } catch (e) {}
      };

      return React.createElement("div", {
        onClick: handleClick,
        title: (running > 0 ? running + " running" : "") +
               (running > 0 && unreadCount > 0 ? ", " : "") +
               (unreadCount > 0 ? unreadCount + " unread \u2014 click to view" : ""),
        style: { padding: "4px 6px", display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }
      },
        running > 0 ? React.createElement("span", {
          style: {
            background: "#3b82f6", color: "white", borderRadius: "10px", fontSize: "11px", fontWeight: "600",
            minWidth: "18px", height: "18px", display: "inline-flex",
            alignItems: "center", justifyContent: "center", padding: "0 4px",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif"
          }
        }, String(running)) : null,
        unreadCount > 0 ? React.createElement("span", {
          style: {
            background: "#ef4444", color: "white", borderRadius: "10px", fontSize: "11px", fontWeight: "600",
            minWidth: "18px", height: "18px", display: "inline-flex",
            alignItems: "center", justifyContent: "center", padding: "0 4px",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif"
          }
        }, String(unreadCount)) : null
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
