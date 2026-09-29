// dsh-lan-proxy — browser half: this plugin's configuration page in the Web GUI.
//
// Where it shows up (dsh >= 0.1.7):
//   * Settings → Plugins → “LAN Proxy” tab, and
//   * the Plugins manager page, as the item of the same plugin.
// Both come from one registration pair, registered unconditionally: a form the
// Host does not serve renders its own explanation rather than the page quietly
// disappearing.
//
// Contract facts this file is built on (verified against 0.1.7-rc.2):
//   - The Host derives one settings section per active entry from its exported
//     `Config`, keyed by the entry id. There is no `installSection` and no
//     `settings.plugin.item` slot any more.
//   - `ctx.configForms.get(entryId)` returns the shared form for that section:
//     `getSnapshot()`, `subscribe()`, `set()`, `unset()` and
//     `mutate(ops, expectedRevision)` whose fence is the revision the editor
//     read. The snapshot is `{ status, value, base, user, revision, writable,
//     mode }`; a concurrent write is refused, never clobbered.
//   - On a page opened through a non-loopback URL, dsh keeps settings
//     persistence process-local (`remote.$host.isLoopback` is false), so the
//     snapshot reports unavailable and the form renders read-only.
//   - Visible copy goes through the Client locale service; other plugins'
//     components are not importable (client bundle purity).
//
// The state machine lives in CardModel (plain JS, headlessly testable in
// test/client.mjs); the React component only binds it to the form.

window.__ModuleLoader__.load({ id: "dsh-lan-proxy", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  let React = require("react");

  const name = "dsh-lan-proxy-client";
  const inject = ["slots", "locale", "configForms"];
  /** Locale dictionary namespace owned by this card. */
  const NS = "settings.lanProxy";
  /** Host entry id — also the settings section the form edits. */
  const ENTRY_ID = "dsh-lan-proxy";
  /** Slot item/tab id used in both registrations. */
  const ITEM_ID = "lan-proxy";

  //#region allow-entry validation (mirrors the host plugin's parser)

  function parseIPv4(text) {
    const parts = text.split(".");
    if (parts.length !== 4) return undefined;
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      if (!/^\d{1,3}$/.test(parts[i])) return undefined;
      const value = Number(parts[i]);
      if (value > 255) return undefined;
      out[i] = value;
    }
    return out;
  }

  function parseIPv6(text) {
    if (!/^[0-9a-f:.]+$/i.test(text) || text.includes("..")) return undefined;
    const halves = text.split("::");
    if (halves.length > 2) return undefined;
    const groups = (part) => {
      if (part === "") return [];
      const out = [];
      const pieces = part.split(":");
      for (const piece of pieces) {
        if (piece.includes(".")) {
          if (piece !== pieces[pieces.length - 1]) return undefined;
          const v4 = parseIPv4(piece);
          if (v4 === undefined) return undefined;
          out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        } else {
          if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
          out.push(Number.parseInt(piece, 16));
        }
      }
      return out;
    };
    const head = groups(halves[0]);
    if (head === undefined) return undefined;
    let merged;
    if (halves.length === 1) {
      if (head.length !== 8) return undefined;
      merged = head;
    } else {
      const tail = groups(halves[1]);
      if (tail === undefined) return undefined;
      const fill = 8 - head.length - tail.length;
      if (fill < 1) return undefined;
      merged = [...head, ...new Array(fill).fill(0), ...tail];
    }
    const out = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      out[i * 2] = (merged[i] >> 8) & 0xff;
      out[i * 2 + 1] = merged[i] & 0xff;
    }
    return out;
  }

  function normalizeIp(value) {
    if (typeof value !== "string") return undefined;
    let text = value.trim();
    if (text === "") return undefined;
    const zone = text.indexOf("%");
    if (zone !== -1) text = text.slice(0, zone);
    if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
    const v4 = parseIPv4(text);
    if (v4 !== undefined) return { family: 4, bytes: v4 };
    const v6 = parseIPv6(text);
    if (v6 === undefined) return undefined;
    let zeroPrefix = true;
    for (let i = 0; i < 10; i++) {
      if (v6[i] !== 0) {
        zeroPrefix = false;
        break;
      }
    }
    if (zeroPrefix && v6[10] === 0xff && v6[11] === 0xff) return { family: 4, bytes: v6.slice(12) };
    return { family: 6, bytes: v6 };
  }

  /**
   * Validate one allowlist line.
   * @returns a reason key (`empty`, `notIp`, `slashes`, `prefixNaN`,
   * `prefixRange`) or null when the entry is valid.
   */
  function allowEntryReason(entry) {
    const raw = typeof entry === "string" ? entry.trim() : "";
    if (raw === "") return "empty";
    const pieces = raw.split("/");
    if (pieces.length > 2) return "slashes";
    const parsed = normalizeIp(pieces[0]);
    if (parsed === undefined) return "notIp";
    if (pieces.length === 2) {
      if (!/^\d{1,3}$/.test(pieces[1])) return "prefixNaN";
      const prefix = Number(pieces[1]);
      const maximum = parsed.family === 4 ? 32 : 128;
      if (prefix > maximum) return "prefixRange";
    }
    return null;
  }

  //#endregion

  //#region field model: drafts, validation, write ops

  function parseAllowText(text) {
    return String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  function draftFromValue(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      enabled: source.enabled === true,
      host: typeof source.host === "string" ? source.host : "0.0.0.0",
      port: String(source.port ?? 3081),
      allowText: Array.isArray(source.allow) ? source.allow.join("\n") : "",
      targetHost: typeof source.targetHost === "string" ? source.targetHost : "127.0.0.1",
      targetPort: String(source.targetPort ?? 0),
    };
  }

  function validPort(text) {
    return /^\d+$/.test(String(text)) && Number(text) <= 65535;
  }

  /**
   * Per-field problems for a draft. Errors are locale-neutral descriptors
   * (`{ key, line?, entry?, reason? }`); the component turns them into copy.
   * @returns `{ ok, errors }`
   */
  function validateDraft(draft) {
    const errors = {};
    if (draft.host.trim() === "") errors.host = { key: "required" };
    if (!validPort(draft.port)) errors.port = { key: "portRange" };
    if (draft.targetHost.trim() === "") errors.targetHost = { key: "required" };
    if (!validPort(draft.targetPort)) errors.targetPort = { key: "portRange" };
    const entries = parseAllowText(draft.allowText);
    const seen = new Set();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (seen.has(entry)) {
        errors.allow = { key: "allowLine", line: index + 1, entry, reason: "duplicate" };
        break;
      }
      seen.add(entry);
      const reason = allowEntryReason(entry);
      if (reason !== null) {
        errors.allow = { key: "allowLine", line: index + 1, entry, reason };
        break;
      }
    }
    return { ok: Object.keys(errors).length === 0, errors };
  }

  /** Whether a saved value already equals what the draft would write. */
  function equalsCurrent(value, draft) {
    if (!value || typeof value !== "object") return false;
    if ((value.enabled === true) !== draft.enabled) return false;
    if (String(value.host) !== draft.host) return false;
    if (String(value.targetHost) !== draft.targetHost) return false;
    if (!validPort(draft.port) || Number(value.port) !== Number(draft.port)) return false;
    if (!validPort(draft.targetPort) || Number(value.targetPort) !== Number(draft.targetPort)) return false;
    const currentAllow = Array.isArray(value.allow) ? value.allow : [];
    const draftAllow = parseAllowText(draft.allowText);
    if (currentAllow.length !== draftAllow.length) return false;
    return currentAllow.every((entry, index) => String(entry) === draftAllow[index]);
  }

  function opsFromDraft(draft) {
    return [
      { op: "set", path: ["enabled"], value: draft.enabled },
      { op: "set", path: ["host"], value: draft.host },
      { op: "set", path: ["port"], value: Number(draft.port) },
      { op: "set", path: ["allow"], value: parseAllowText(draft.allowText) },
      { op: "set", path: ["targetHost"], value: draft.targetHost },
      { op: "set", path: ["targetPort"], value: Number(draft.targetPort) },
    ];
  }

  const RESET_OPS = ["enabled", "host", "port", "allow", "targetHost", "targetPort"].map((field) => ({
    op: "unset",
    path: [field],
  }));

  //#endregion

  //#region CardModel: the headless state machine

  class CardModel {
    constructor(form) {
      this.form = form;
      this.draft = null;
      this.saving = false;
      this.failed = false;
      this.conflict = false;
      this.saveGeneration = 0;
      this.listeners = new Set();
      this.unsubscribe = form.subscribe(() => this.onChange());
      this.view = this.computeView();
    }

    /** Register one React subscriber; returns its disposer. */
    subscribe(listener) {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }

    notify() {
      this.view = this.computeView();
      for (const listener of [...this.listeners]) listener();
    }

    /** Stop observing the form and ignore late settlements. */
    dispose() {
      this.saveGeneration += 1;
      this.listeners.clear();
      this.unsubscribe();
    }

    /** Fold external revision moves into the draft (never silently). */
    onChange() {
      const snapshot = this.form.getSnapshot();
      if (this.draft !== null && !this.saving && snapshot.revision !== this.draft.revision) {
        if (equalsCurrent(snapshot.value, this.draft)) {
          this.draft = null;
          this.conflict = false;
        } else {
          this.conflict = true;
        }
      }
      this.notify();
    }

    editable() {
      const snapshot = this.form.getSnapshot();
      return snapshot.status === "ready" && snapshot.writable === true && !this.saving;
    }

    /** Stage one field patch, beginning the draft (with its fence revision) on first edit. */
    edit(patch) {
      if (!this.editable()) return;
      const snapshot = this.form.getSnapshot();
      if (this.draft === null) {
        this.draft = { ...draftFromValue(snapshot.value), revision: snapshot.revision };
      }
      Object.assign(this.draft, patch);
      this.failed = false;
      this.conflict = false;
      if (equalsCurrent(snapshot.value, this.draft)) {
        this.draft = null;
      }
      this.notify();
    }

    discard() {
      if (this.saving) return;
      this.draft = null;
      this.failed = false;
      this.conflict = false;
      this.notify();
    }

    async save() {
      const snapshot = this.form.getSnapshot();
      const draft = this.draft;
      if (draft === null || this.saving || snapshot.status !== "ready" || snapshot.writable !== true) return;
      const validation = validateDraft(draft);
      if (!validation.ok) return;
      if (equalsCurrent(snapshot.value, draft)) {
        this.draft = null;
        this.notify();
        return;
      }
      if (snapshot.revision !== draft.revision) {
        this.conflict = true;
        this.notify();
        return;
      }
      const generation = ++this.saveGeneration;
      this.saving = true;
      this.failed = false;
      this.conflict = false;
      this.notify();
      await this.form.mutate(opsFromDraft(draft), draft.revision);
      if (generation !== this.saveGeneration) return;
      this.saving = false;
      const after = this.form.getSnapshot();
      const landed = equalsCurrent(after.value, draft);
      if (landed) {
        this.draft = null;
        this.failed = false;
      } else {
        this.failed = true;
      }
      this.notify();
    }

    /** Revert every field to the row's own defaults (fenced like a save). */
    async reset() {
      if (this.saving) return;
      const snapshot = this.form.getSnapshot();
      if (snapshot.status !== "ready" || snapshot.writable !== true) return;
      const fence = this.draft !== null ? this.draft.revision : snapshot.revision;
      if (snapshot.revision !== fence) {
        this.conflict = true;
        this.notify();
        return;
      }
      const generation = ++this.saveGeneration;
      this.saving = true;
      this.failed = false;
      this.conflict = false;
      this.notify();
      await this.form.mutate(RESET_OPS.slice(), fence);
      if (generation !== this.saveGeneration) return;
      this.saving = false;
      const after = this.form.getSnapshot();
      const base = after.base && typeof after.base === "object" ? after.base : {};
      this.draft = null;
      this.failed = !equalsCurrent(after.value, draftFromValue(base));
      this.notify();
    }

    computeView() {
      const snapshot = this.form.getSnapshot();
      const draft = this.draft;
      const fields = draft !== null ? draft : draftFromValue(snapshot.value);
      const validation = draft !== null ? validateDraft(draft) : { ok: true, errors: {} };
      return {
        status: snapshot.status,
        available: snapshot.status === "ready" || snapshot.status === "loading",
        writable: snapshot.status === "ready" && snapshot.writable === true,
        mode: snapshot.mode ?? "host",
        dirty: draft !== null,
        saving: this.saving,
        failed: this.failed,
        conflict: this.conflict,
        fields,
        errors: validation.errors,
        invalid: !validation.ok,
      };
    }
  }

  //#endregion

  //#region locale copy

  const en = {
    title: "LAN Proxy",
    description: "Reverse-proxy the loopback Web GUI to allowlisted LAN or Tailscale addresses",
    enabled: "Enabled — run the allowlisted reverse proxy (saves apply immediately)",
    host: "Listen host",
    hostHint: "0.0.0.0 exposes every interface (gated by the allow list); a specific address binds one interface.",
    port: "Listen port",
    portHint: "Proxy port; 0 lets the OS pick one.",
    allow: "Allow list — one source IP or CIDR per line",
    allowHint: "Empty keeps the port closed to non-loopback sources. Loopback is always allowed. No default addresses are pre-filled.",
    targetHost: "Target host",
    targetHostHint: "The Web server being proxied (loopback).",
    targetPort: "Target port",
    targetPortHint: "0 follows the composed Web server's actual port.",
    footer: "The Host log reports proxy status with the [lan-proxy] prefix; invalid entries keep it closed.",
    unsaved: "Unsaved",
    save: "Save",
    saving: "Saving…",
    discard: "Discard",
    reset: "Reset to defaults",
    readOnly: "These settings are read-only right now.",
    notServed: "The Host is not serving this plugin's configuration section yet — reload the page once the plugin row is active.",
    notServedStatus: "form status: {status} (persistence: {mode})",
    notServedRemote: "This page cannot edit the configuration: dsh keeps settings in memory on a non-loopback page. Open the local dsh web URL instead.",
    readOnlyRemote: "Settings are read-only on a non-loopback page — open the local dsh web URL to edit.",
    conflict: "The saved settings changed elsewhere — your edits are kept; review them before saving.",
    failed: "The write was refused (settings moved on). Review the values and try again.",
    errRequired: "required",
    errPortRange: "0-65535, digits only",
    errLine: "line {line}: {reason}",
    reasonEmpty: "empty entry",
    reasonNotIp: "not an IPv4 or IPv6 address",
    reasonSlashes: "expected <ip> or <ip>/<prefix>",
    reasonPrefixNaN: "prefix must be a number",
    reasonPrefixRange: "prefix out of range",
    reasonDuplicate: "duplicate entry",
  };

  const zh = {
    title: "LAN 代理",
    description: "按来源 IP 白名单把回环 Web GUI 反代到局域网 / Tailscale 设备",
    enabled: "启用 —— 按白名单启动反向代理（保存后立即生效）",
    host: "监听地址",
    hostHint: "0.0.0.0 暴露所有网卡（仍受白名单拦截）；填具体地址只绑定该接口。",
    port: "监听端口",
    portHint: "代理端口；填 0 由系统分配。",
    allow: "白名单 —— 每行一个来源 IP 或 CIDR",
    allowHint: "留空则对非回环来源完全关闭；回环始终放行；不预置任何默认地址。",
    targetHost: "目标地址",
    targetHostHint: "被代理的 Web 服务地址（回环）。",
    targetPort: "目标端口",
    targetPortHint: "填 0 表示跟随组合中 Web 服务实际端口。",
    footer: "代理状态见 Host 日志的 [lan-proxy] 前缀；条目非法时保持关闭。",
    unsaved: "未保存",
    save: "保存",
    saving: "保存中…",
    discard: "放弃",
    reset: "恢复默认值",
    readOnly: "当前为只读状态。",
    notServed: "Host 尚未提供本插件的配置段 —— 插件行生效后刷新一次页面即可。",
    notServedStatus: "表单状态：{status}（持久化：{mode}）",
    notServedRemote: "当前页面无法编辑该配置：dsh 在非回环页面上把设置只放在进程内。请改用本机 dsh web 地址打开。",
    readOnlyRemote: "非回环页面上的设置只读 —— 请在本机 dsh web 地址中编辑。",
    conflict: "已保存的配置在别处发生了变化 —— 你的修改已保留，请确认后再保存。",
    failed: "写入被拒绝（配置已被改动），请确认后重试。",
    errRequired: "必填",
    errPortRange: "0-65535，纯数字",
    errLine: "第 {line} 行：{reason}",
    reasonEmpty: "空条目",
    reasonNotIp: "不是合法的 IPv4 / IPv6 地址",
    reasonSlashes: "应为 <ip> 或 <ip>/<前缀>",
    reasonPrefixNaN: "前缀必须是数字",
    reasonPrefixRange: "前缀超出范围",
    reasonDuplicate: "重复条目",
  };

  /** Fill `{name}` placeholders in a localized string. */
  function format(template, args) {
    return String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in args ? String(args[key]) : whole));
  }

  //#endregion

  //#region card chrome (hand-built; other plugins' components are not importable)

  const T = {
    card: {
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      border: "1px solid var(--dsw-alias-border-l1)",
      borderRadius: "10px",
      background: "var(--dsw-alias-bg-layer-1)",
      color: "var(--dsw-alias-label-primary)",
      fontFamily: "inherit",
      padding: "14px",
    },
    head: { display: "flex", alignItems: "center", gap: "10px" },
    cardName: { fontSize: "13px", fontWeight: "600" },
    unsaved: {
      marginLeft: "auto",
      flexShrink: "0",
      fontSize: "11px",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "999px",
      padding: "1px 8px",
      color: "var(--dsw-alias-label-secondary)",
    },
    field: { display: "flex", flexDirection: "column", gap: "4px" },
    label: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
    control: {
      background: "var(--dsw-alias-bg-base)",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "6px",
      color: "var(--dsw-alias-label-primary)",
      padding: "6px 8px",
      font: "inherit",
      fontSize: "13px",
      width: "100%",
      boxSizing: "border-box",
    },
    controlDisabled: { opacity: "0.6" },
    textarea: { minHeight: "76px", resize: "vertical", fontFamily: "ui-monospace, monospace" },
    hint: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
    error: { fontSize: "11px", color: "var(--dsw-alias-state-error-primary)" },
    warn: { fontSize: "12px", color: "var(--dsw-alias-state-warn-primary)", margin: 0 },
    checkboxRow: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" },
    footer: { display: "flex", gap: "8px", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" },
    footerNote: { marginRight: "auto", fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
    button: {
      font: "inherit",
      fontSize: "13px",
      padding: "6px 12px",
      borderRadius: "6px",
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-base)",
      color: "var(--dsw-alias-label-primary)",
      cursor: "pointer",
    },
    buttonDisabled: { opacity: "0.5", cursor: "default" },
    buttonPrimary: {
      font: "inherit",
      fontSize: "13px",
      padding: "6px 12px",
      borderRadius: "6px",
      border: "1px solid transparent",
      background: "var(--dsw-alias-brand-primary)",
      color: "#ffffff",
      cursor: "pointer",
    },
  };

  function Field(props) {
    return React.createElement(
      "div",
      { style: T.field },
      React.createElement("label", { htmlFor: props.id, style: T.label }, props.label),
      props.control,
      props.error
        ? React.createElement("span", { style: T.error }, props.error)
        : React.createElement("span", { style: T.hint }, props.hint),
    );
  }

  function controlStyle(view, extra) {
    return { ...T.control, ...(!view.writable ? T.controlDisabled : null), ...(extra ?? null) };
  }

  /** Turn a locale-neutral error descriptor into copy. */
  function errorText(t, error) {
    if (error === undefined) return undefined;
    if (error.key === "allowLine") {
      const reason = error.reason[0].toUpperCase() + error.reason.slice(1);
      return format(t("errLine"), { line: String(error.line), reason: t(`reason${reason}`) });
    }
    return t(error.key === "portRange" ? "errPortRange" : "errRequired");
  }

  function Card(props) {
    const form = props.form;
    const t = props.t;
    const [model] = React.useState(() => new CardModel(form));
    React.useEffect(() => () => model.dispose(), [model]);
    const view = React.useSyncExternalStore(
      (listener) => model.subscribe(listener),
      () => model.view,
    );
    // The Plugins manager renders this slot twice: a one-liner in the list
    // (`summary`) and the real page once the card is opened.
    if (props.view === "summary") return t("description");
    // A panel that explains itself beats a blank one: the renderer's
    // SlotErrorBoundary turns any throw into an invisible empty div, so a
    // missing section is reported here rather than swallowed.
    if (!view.available) {
      console.warn(`[lan-proxy] settings section unavailable (status: ${view.status}, mode: ${view.mode})`);
      return React.createElement(
        "div",
        { style: T.card },
        React.createElement(
          "p",
          { style: T.warn, role: "status" },
          view.mode === "memory" ? t("notServedRemote") : t("notServed"),
        ),
        React.createElement(
          "p",
          { style: T.hint },
          format(t("notServedStatus"), { status: view.status, mode: view.mode }),
        ),
      );
    }

    const fields = view.fields;
    const controlsDisabled = !view.writable || view.saving;
    const saveDisabled = !view.dirty || !view.writable || view.saving || view.invalid;

    const input = (key, options) =>
      React.createElement("input", {
        id: `lan-proxy-${key}`,
        type: "text",
        value: fields[key],
        disabled: controlsDisabled,
        style: controlStyle(view, options),
        onChange: (event) => model.edit({ [key]: event.target.value }),
      });

    const field = (key, labelKey, hintKey, control) =>
      React.createElement(Field, {
        id: `lan-proxy-${key}`,
        label: t(labelKey),
        hint: t(hintKey),
        error: errorText(t, view.errors[key]),
        control,
      });

    return React.createElement(
      "div",
      { style: T.card },
      React.createElement(
        "div",
        { style: T.head },
        React.createElement("span", { style: T.cardName }, t("title")),
        view.dirty ? React.createElement("span", { style: T.unsaved }, t("unsaved")) : null,
      ),
      !view.writable
        ? React.createElement(
            "p",
            { style: T.warn, role: "status" },
            view.mode === "memory" ? t("readOnlyRemote") : t("readOnly"),
          )
        : null,
      React.createElement(
        "div",
        { style: T.checkboxRow },
        React.createElement("input", {
          id: "lan-proxy-enabled",
          type: "checkbox",
          checked: fields.enabled,
          disabled: controlsDisabled,
          onChange: (event) => model.edit({ enabled: event.target.checked }),
        }),
        React.createElement("label", { htmlFor: "lan-proxy-enabled" }, t("enabled")),
      ),
      field("host", "host", "hostHint", input("host")),
      field("port", "port", "portHint", input("port", { inputMode: "numeric" })),
      field(
        "allow",
        "allow",
        "allowHint",
        React.createElement("textarea", {
          id: "lan-proxy-allow",
          rows: 4,
          spellCheck: false,
          value: fields.allowText,
          disabled: controlsDisabled,
          style: controlStyle(view, T.textarea),
          onChange: (event) => model.edit({ allowText: event.target.value }),
        }),
      ),
      field("targetHost", "targetHost", "targetHostHint", input("targetHost")),
      field("targetPort", "targetPort", "targetPortHint", input("targetPort", { inputMode: "numeric" })),
      view.conflict ? React.createElement("p", { style: T.warn, role: "status" }, t("conflict")) : null,
      view.failed ? React.createElement("p", { style: T.error, role: "status" }, t("failed")) : null,
      React.createElement(
        "div",
        { style: T.footer },
        React.createElement("span", { style: T.footerNote }, t("footer")),
        React.createElement(
          "button",
          {
            type: "button",
            style: { ...T.button, ...(controlsDisabled ? T.buttonDisabled : null) },
            disabled: controlsDisabled,
            onClick: () => {
              model.reset();
            },
          },
          t("reset"),
        ),
        React.createElement(
          "button",
          {
            type: "button",
            style: { ...T.button, ...(view.dirty && !view.saving ? null : T.buttonDisabled) },
            disabled: !view.dirty || view.saving,
            onClick: () => model.discard(),
          },
          t("discard"),
        ),
        React.createElement(
          "button",
          {
            type: "button",
            style: { ...(saveDisabled ? T.button : T.buttonPrimary), ...(saveDisabled ? T.buttonDisabled : null) },
            disabled: saveDisabled,
            onClick: () => {
              model.save();
            },
          },
          view.saving ? t("saving") : t("save"),
        ),
      ),
    );
  }

  //#endregion

  function apply(ctx) {
    const t = ctx.locale.bind(NS);
    // Breadcrumbs: this half has no other visible surface, so the console is
    // where a missing settings page has to be explained from.
    console.info(`[lan-proxy] client half active, waiting for the Host to serve "${ENTRY_ID}"`);
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-lan-proxy: dictionaries");
    const form = ctx.configForms.get(ENTRY_ID);
    // One form, two homes: the Plugins settings tab and the Plugins manager
    // item. Both appear and disappear together with the served section.
    const page = (props) => React.createElement(Card, { form, t, view: props.view });
    const register = (slot) => () => {
      const off = ctx.slots.register({ name: slot, id: ITEM_ID, order: 20, label: () => t("title"), locale: NS }, page);
      console.info(`[lan-proxy] registered "${ITEM_ID}" in ${slot}`);
      return off;
    };
    // Registered unconditionally on purpose. The page ships with the bundle, and
    // a form whose section the Host is not serving renders its own explanation
    // (see `notServed`); gating the registration on `whileServed` instead made a
    // missing tab indistinguishable from a missing plugin, with no way to tell
    // the user which half was at fault.
    ctx.effect(
      () => {
        const offTab = ctx.slots.inject("settings.plugins.tab", register("settings.plugins.tab"));
        const offItem = ctx.slots.inject("plugins.item", register("plugins.item"));
        return () => {
          offTab();
          offItem();
        };
      },
      "dsh-lan-proxy: configuration pages",
    );
  }

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  exports.ENTRY_ID = ENTRY_ID;
  exports.Card = Card;
  exports.__test = {
    CardModel,
    allowEntryReason,
    draftFromValue,
    equalsCurrent,
    opsFromDraft,
    parseAllowText,
    validateDraft,
  };
  return module.exports;
}});
