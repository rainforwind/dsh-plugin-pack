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

  // Extract session id from URL hash
  function currentSessionId() {
    try {
      const hash = window.location.hash || "";
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
          if (r > 0 && u > 0) {
            drawBadge(cx, 22, 8, 8, "#3b82f6", r);
            drawBadge(cx, 24, 24, 9, "#ef4444", u);
          } else if (r > 0) {
            drawBadge(cx, 24, 24, 10, "#3b82f6", r);
          } else {
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

      React.useEffect(() => {
        let alive = true;
        let lastSession = null;

        // Notify host which session user is viewing
        const notifyViewing = async (sessionId) => {
          try {
            await fetch(api("/task-badge/viewing"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId })
            });
          } catch (e) {}
        };

        const poll = async () => {
          try {
            // Detect session switch via URL hash -> auto-mark as read
            const sid = currentSessionId();
            if (sid !== lastSession) {
              lastSession = sid;
              if (sid) await notifyViewing(sid);
            }

            // Pass current sessionId so host excludes it from unread count
            const countsUrl = sid
              ? api("/task-badge/counts") + "?sessionId=" + encodeURIComponent(sid)
              : api("/task-badge/counts");
            const res = await fetch(countsUrl);
            const data = await res.json();
            if (alive) {
              setCounts({ running: data.running, completedUnviewed: data.completedUnviewed });
              setFavicon(data.running, data.completedUnviewed);
            }
          } catch (e) {}
        };

        poll();
        const dispose = ctx.interval(poll, 3000);

        // Instant response on hash change
        const onHash = () => {
          const sid = currentSessionId();
          if (sid !== lastSession) {
            lastSession = sid;
            if (sid) notifyViewing(sid);
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

      // Read-only display, no click handler
      let label = "";
      if (counts.running > 0) label += counts.running + " running";
      if (counts.completedUnviewed > 0) { if (label) label += ", "; label += counts.completedUnviewed + " unread"; }

      return React.createElement("div", {
        title: label,
        style: { padding: "4px 6px", display: "flex", alignItems: "center", gap: "4px", userSelect: "none" }
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
