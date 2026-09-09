window.__ModuleLoader__.load({ id: "dsh-task-badge", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  let React = require("react");

  const name = "dsh-task-badge-client";
  const inject = ["timer"];

  function api(path) {
    const relative = path.replace(/^\/+/, "");
    if (typeof document === "undefined") return "/" + relative;
    return new URL(relative, document.baseURI).pathname;
  }

  // Extract session id from URL hash like "#/session/abc123" or "#abc123"
  function currentSessionId() {
    try {
      const hash = window.location.hash || "";
      // Match patterns: #/session/xxx, #xxx, #/xxx
      const m = hash.match(/[#/]+(?:session[/]+)?([a-zA-Z0-9_-]+)/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  function apply(ctx) {
    const slots = ctx.get("slots");
    if (!slots) return;

    var origSrc = null;
    var origImg = null;
    try {
      const existingLink = document.querySelector("link[rel*='icon']");
      if (existingLink) {
        origSrc = existingLink.href;
        const faviconImg = new Image();
        faviconImg.crossOrigin = "anonymous";
        faviconImg.onload = function () { origImg = faviconImg; };
        faviconImg.onerror = function () { origImg = null; };
        faviconImg.src = origSrc;
      }
    } catch (e) {}

    function setFavicon(r, u) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const cx = canvas.getContext("2d");
        if (origImg) { try { cx.drawImage(origImg, 0, 0, 32, 32); } catch (e) {} }

        if (r + u > 0) {
          // Draw two separate badges: running (blue, top-left) + unread (red, bottom-right)
          if (r > 0 && u > 0) {
            // Running badge - top left
            drawBadge(cx, 22, 8, 8, "#3b82f6", r);
            // Unread badge - bottom right
            drawBadge(cx, 24, 24, 9, "#ef4444", u);
          } else if (r > 0) {
            // Only running - top right
            drawBadge(cx, 24, 24, 10, "#3b82f6", r);
          } else {
            // Only unread - top right
            drawBadge(cx, 24, 24, 10, "#ef4444", u);
          }
        }

        const link = document.querySelector("link[rel='icon']") || document.querySelector("link[rel='shortcut icon']");
        if (!link) {
          const newLink = document.createElement("link");
          newLink.rel = "icon";
          document.head.appendChild(newLink);
          newLink.type = "image/png";
          newLink.href = canvas.toDataURL("image/png");
        } else {
          link.type = "image/png";
          link.href = canvas.toDataURL("image/png");
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
      try {
        const link = document.querySelector("link[rel='icon']");
        if (link && origSrc) { link.href = origSrc; link.type = ""; }
      } catch (e) {}
    }

    function TaskBadge() {
      const [counts, setCounts] = React.useState({ running: 0, completedUnviewed: 0 });

      // Poll counts + auto-clear unread when session changes
      React.useEffect(() => {
        let alive = true;
        let lastSession = null;

        const notifySession = async (sessionId) => {
          try {
            await fetch(api("/task-badge/mark-viewed"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId })
            });
          } catch (e) {}
        };

        const poll = async () => {
          try {
            // Detect session switch via URL hash
            const sid = currentSessionId();
            if (sid && sid !== lastSession) {
              lastSession = sid;
              // Tell host user is now viewing this session
              await notifySession(sid);
            }

            const res = await fetch(api("/task-badge/counts"));
            const data = await res.json();
            if (alive) {
              setCounts({ running: data.running, completedUnviewed: data.completedUnviewed });
              setFavicon(data.running, data.completedUnviewed);
            }
          } catch (e) {}
        };

        poll();
        const dispose = ctx.interval(poll, 3000);

        // Also listen for hashchange for instant response
        const onHash = () => {
          const sid = currentSessionId();
          if (sid && sid !== lastSession) {
            lastSession = sid;
            notifySession(sid);
          }
        };
        window.addEventListener("hashchange", onHash);

        return () => {
          alive = false;
          dispose();
          clearFavicon();
          window.removeEventListener("hashchange", onHash);
        };
      }, []);

      const total = counts.running + counts.completedUnviewed;
      if (total === 0) return null;

      const handleClick = async () => {
        try {
          // Only mark the current session as viewed, not all
          const sid = currentSessionId();
          const res = await fetch(api("/task-badge/mark-viewed"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sid })
          });
          const data = await res.json();
          setCounts({ running: data.running, completedUnviewed: data.completedUnviewed });
          setFavicon(data.running, data.completedUnviewed);
        } catch (e) {}
      };

      // Build label with colored indicators
      return React.createElement("button", {
        onClick: handleClick,
        title: (counts.running > 0 ? counts.running + " running" : "") +
               (counts.running > 0 && counts.completedUnviewed > 0 ? ", " : "") +
               (counts.completedUnviewed > 0 ? counts.completedUnviewed + " unread" : "") +
               " \u2014 click to clear",
        style: { background: "none", border: "none", cursor: "pointer", padding: "4px 6px", display: "flex", alignItems: "center", gap: "4px" }
      },
        counts.running > 0 ? React.createElement("span", {
          style: {
            background: "#3b82f6", color: "white", borderRadius: "10px", fontSize: "11px", fontWeight: "600",
            minWidth: "18px", height: "18px", display: "inline-flex",
            alignItems: "center", justifyContent: "center", padding: "0 4px",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif"
          }
        }, String(counts.running)) : null,
        counts.completedUnviewed > 0 ? React.createElement("span", {
          style: {
            background: "#ef4444", color: "white", borderRadius: "10px", fontSize: "11px", fontWeight: "600",
            minWidth: "18px", height: "18px", display: "inline-flex",
            alignItems: "center", justifyContent: "center", padding: "0 4px",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif"
          }
        }, String(counts.completedUnviewed)) : null
      );
    }

    slots.inject("sidebar.footer.action", () => slots.register(
      { name: "sidebar.footer.action", id: "task-badge", order: -1, label: "Task Badge" },
      () => React.createElement(TaskBadge)
    ));
  }

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  return module.exports;
}});
