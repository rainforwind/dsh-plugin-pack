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
        const t = r + u;
        if (t > 0) {
          cx.beginPath();
          cx.arc(24, 24, 10, 0, Math.PI * 2);
          cx.fillStyle = r > 0 ? "#3b82f6" : "#ef4444";
          cx.fill();
          cx.strokeStyle = "white";
          cx.lineWidth = 2;
          cx.stroke();
          cx.fillStyle = "white";
          cx.font = "bold 11px sans-serif";
          cx.textAlign = "center";
          cx.textBaseline = "middle";
          cx.fillText(t > 99 ? "99+" : String(t), 24, 24);
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
        const poll = async () => {
          try {
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
        return () => { alive = false; dispose(); clearFavicon(); };
      }, []);
      const total = counts.running + counts.completedUnviewed;
      if (total === 0) return null;
      const handleClick = async () => {
        try {
          const res = await fetch(api("/task-badge/mark-viewed"), { method: "POST" });
          const data = await res.json();
          setCounts({ running: data.running, completedUnviewed: data.completedUnviewed });
          setFavicon(data.running, data.completedUnviewed);
        } catch (e) {}
      };
      let label = "";
      if (counts.running > 0) label += counts.running + " running";
      if (counts.completedUnviewed > 0) { if (label) label += ", "; label += counts.completedUnviewed + " new"; }
      return React.createElement("button", {
        onClick: handleClick,
        title: label + " \u2014 click to mark all as viewed",
        style: { background: "none", border: "none", cursor: "pointer", padding: "4px 6px", display: "flex", alignItems: "center" }
      },
        React.createElement("span", {
          style: {
            background: counts.running > 0 ? "#3b82f6" : "#ef4444",
            color: "white", borderRadius: "10px", fontSize: "11px", fontWeight: "600",
            minWidth: "20px", height: "20px", display: "flex",
            alignItems: "center", justifyContent: "center", padding: "0 5px",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif"
          }
        }, label)
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
