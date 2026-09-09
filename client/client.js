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
      const [running, setRunning] = React.useState(0);
      const [unreadCount, setUnreadCount] = React.useState(0);
      // Client-side seen set: tracks which unread sessions the user has viewed
      const seenRef = React.useRef(new Set());
      // Track previous unreadSessionIds to detect new entries
      const prevUnreadRef = React.useRef([]);

      React.useEffect(() => {
        let alive = true;

        const poll = async () => {
          try {
            const res = await fetch(api("/task-badge/counts"));
            const data = await res.json();
            if (!alive) return;

            const newUnreadIds = data.unreadSessionIds || [];

            // Add any newly appeared unread sessions (don't auto-add to seen)
            // The seen set only grows when user clicks badge or navigates

            // Compute unread: sessions in unreadSessionIds that aren't in seenSet
            let count = 0;
            for (let i = 0; i < newUnreadIds.length; i++) {
              if (!seenRef.current.has(newUnreadIds[i])) count++;
            }
            count += (data.unviewedJobs || 0);

            setRunning(data.running || 0);
            setUnreadCount(count);
            setFavicon(data.running || 0, count);
            prevUnreadRef.current = newUnreadIds;
          } catch (e) {}
        };

        poll();
        const dispose = ctx.interval(poll, 3000);

        return () => {
          alive = false;
          dispose();
          clearFavicon();
        };
      }, []);

      const total = running + unreadCount;
      if (total === 0) return null;

      // Click badge → mark all as read (client-side, matches native behavior)
      const handleClick = async () => {
        try {
          const res = await fetch(api("/task-badge/counts"));
          const data = await res.json();
          const ids = data.unreadSessionIds || [];
          // Add all current unread IDs to seen set
          for (let i = 0; i < ids.length; i++) seenRef.current.add(ids[i]);
          setUnreadCount(data.unviewedJobs || 0);
          setFavicon(data.running || 0, data.unviewedJobs || 0);
        } catch (e) {}
      };

      return React.createElement("div", {
        onClick: handleClick,
        title: (running > 0 ? running + " running" : "") +
               (running > 0 && unreadCount > 0 ? ", " : "") +
               (unreadCount > 0 ? unreadCount + " unread" : "") +
               " \u2014 click to mark read",
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
