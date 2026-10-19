// dsh-lan-proxy — browser half: this plugin's configuration page in the Web GUI.
//
// Where it shows up (dsh >= 0.1.7):
//   * Settings → Plugins → “LAN Proxy” tab, and
//   * the Plugins manager page, as the item of the same plugin.
// Both come from one registration pair, registered unconditionally: a form the
// Host does not serve renders its own explanation rather than the page quietly
// disappearing.
//
// Contract facts this file is built on (verified against 0.1.7-rc.2 and
// re-checked against 0.2.0-rc.2):
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
//
// The QR hint near the top is the one place this file implements a wire format
// itself rather than calling a service: a byte-mode QR encoder (versions 1-10,
// ECC level M) feeding a hand-written PNG container. It is local by necessity —
// the phone loading the page is on the LAN precisely because the Host may not
// be reachable from the internet, so a QR image service is both unusable and a
// token leak. Its correctness is pinned by test/client.mjs and, independently,
// by test/qr-decode.py.

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
  /** Index global the Host publishes with the authenticated LAN URLs. */
  const LAN_URL_GLOBAL = "__DSH_LAN_PROXY_URLS__";

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
    footer: "The Host log reports proxy status with the [dsh-lan-proxy] prefix; invalid entries keep it closed.",
    lanUrlTitle: "LAN URL with token",
    lanUrlHint: "Open this URL on an allow-listed device. The token belongs to the current Host process and changes after a restart; reload this page after changing the listen host or port. Hover a URL for a QR code to scan with the phone.",
    qrAlt: "QR code for this LAN URL",
    qrCaption: "Scan with the phone camera",
    qrTooLong: "This URL is too long to encode as a QR code.",
    lanUrlDisabled: "The proxy is disabled — enable it and save to produce a URL.",
    lanUrlUnavailable: "No LAN URL yet: wait for the proxy to bind, then reload this page.",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed",
    reload: "Reload page",
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
    footer: "代理状态见 Host 日志的 [dsh-lan-proxy] 前缀；条目非法时保持关闭。",
    lanUrlTitle: "带 token 的 LAN 地址",
    lanUrlHint: "在白名单设备上打开这个地址。token 属于当前 Host 进程，重启后会变化；修改监听地址或端口后请刷新本页。把鼠标移到地址上可显示二维码，用手机扫一下即可。",
    qrAlt: "该 LAN 地址的二维码",
    qrCaption: "用手机相机扫码打开",
    qrTooLong: "该地址过长，无法生成二维码。",
    lanUrlDisabled: "代理未启用 —— 启用并保存后才会生成地址。",
    lanUrlUnavailable: "暂时没有可用的 LAN 地址：等待代理绑定成功后刷新本页。",
    copy: "复制",
    copied: "已复制",
    copyFailed: "复制失败",
    reload: "刷新页面",
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

  /** Read the Host-published LAN URL global, tolerating a missing/malformed row. */
  function readLanInfo() {
    const value = typeof window === "object" ? window[LAN_URL_GLOBAL] : undefined;
    if (!value || typeof value !== "object") {
      return { available: false, enabled: false, bound: false, urls: [] };
    }
    const urls = Array.isArray(value.urls)
      ? value.urls.filter(
          (entry) => entry && typeof entry.url === "string" && typeof entry.address === "string",
        )
      : [];
    return {
      available: true,
      enabled: value.enabled === true,
      bound: value.bound === true,
      urls,
    };
  }

  //#region QR encoder (byte mode, version 1-10, ECC level M)

  // Enough for every URL this card can publish: version 10/M holds 213 bytes,
  // while a token URL runs around 60. Encoded here rather than fetched from a
  // QR service because the whole point of the card is that the phone reaches
  // this Host over the LAN, where there may be no internet at all — and the
  // URL carries a token that must not be sent to a third party.
  const QR_MAX_BYTES = 213;

  /** Total codewords per version 1-10, and data codewords at ECC level M. */
  const QR_VERSIONS = [
    null,
    [26, 16], [44, 28], [70, 44], [100, 64], [134, 86],
    [172, 108], [196, 124], [242, 154], [292, 182], [346, 216],
  ];
  /** EC codewords per block, block counts, and the version-1 alignment grid. */
  const QR_ECC_M = [null, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const QR_BLOCKS_M = [null, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const QR_ALIGN = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];

  /** GF(256) log/antilog tables for the 0x11d primitive polynomial. */
  const QR_EXP = new Uint8Array(512);
  const QR_LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      QR_EXP[i] = x;
      QR_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) QR_EXP[i] = QR_EXP[i - 255];
  })();

  function qrMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return QR_EXP[QR_LOG[a] + QR_LOG[b]];
  }

  /** Generator polynomial for `count` EC codewords: ∏ (x - α^i). */
  function qrGenerator(count) {
    let poly = [1];
    for (let i = 0; i < count; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= qrMul(poly[j], 1);
        next[j + 1] ^= qrMul(poly[j], QR_EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  /** Reed-Solomon remainder of `data` under the generator of `count`. */
  function qrRemainder(data, count) {
    const gen = qrGenerator(count);
    const rem = new Array(count).fill(0);
    for (const byte of data) {
      const factor = byte ^ rem[0];
      rem.shift();
      rem.push(0);
      for (let i = 0; i < count; i++) rem[i] ^= qrMul(gen[i + 1], factor);
    }
    return rem;
  }

  /** UTF-8 bytes of `text`, without TextEncoder (the loader shims are minimal). */
  function utf8Bytes(text) {
    const out = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.codePointAt(i);
      if (code > 0xffff) i++;
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return out;
  }

  /** The smallest version 1-10 whose ECC-M capacity holds `length` bytes. */
  function qrVersionFor(length) {
    for (let version = 1; version <= 10; version++) {
      const dataCodewords = QR_VERSIONS[version][1];
      const lengthBits = version < 10 ? 8 : 16;
      const needed = Math.ceil((4 + lengthBits + length * 8) / 8);
      if (needed <= dataCodewords) return version;
    }
    return undefined;
  }

  /** Build the interleaved data+EC codeword stream for byte mode. */
  function qrCodewords(bytes, version) {
    const [total, dataCodewords] = QR_VERSIONS[version];
    const bits = [];
    const push = (value, width) => {
      for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    push(0b0100, 4); // byte mode
    push(bytes.length, version < 10 ? 8 : 16);
    for (const byte of bytes) push(byte, 8);

    const capacity = dataCodewords * 8;
    for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      data.push(byte);
    }
    const pad = [0xec, 0x11];
    for (let i = 0; data.length < dataCodewords; i++) data.push(pad[i % 2]);

    // Split into blocks, append that block's EC codewords, then interleave.
    const blocks = QR_BLOCKS_M[version];
    const ecPerBlock = QR_ECC_M[version];
    const shortLength = Math.floor(dataCodewords / blocks);
    const longBlocks = dataCodewords % blocks;
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (let i = 0; i < blocks; i++) {
      const size = shortLength + (i >= blocks - longBlocks ? 1 : 0);
      const block = data.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(qrRemainder(block, ecPerBlock));
    }
    const out = [];
    const longest = Math.max(...dataBlocks.map((block) => block.length));
    for (let i = 0; i < longest; i++) {
      for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (const block of ecBlocks) out.push(block[i]);
    }
    return out.slice(0, total);
  }

  /** The module matrix (true = dark) for `text`, or undefined if too long. */
  function qrMatrix(text) {
    const bytes = utf8Bytes(text);
    if (bytes.length > QR_MAX_BYTES) return undefined;
    const version = qrVersionFor(bytes.length);
    if (version === undefined) return undefined;
    const size = version * 4 + 17;
    const modules = [];
    const reserved = [];
    for (let i = 0; i < size; i++) {
      modules.push(new Array(size).fill(false));
      reserved.push(new Array(size).fill(false));
    }
    const set = (row, col, dark) => {
      if (row < 0 || col < 0 || row >= size || col >= size) return;
      modules[row][col] = dark;
      reserved[row][col] = true;
    };

    // Finder patterns and their separators.
    for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
          const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          set(row + r, col + c, inRing || inCore);
        }
      }
    }
    // Timing patterns.
    for (let i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    // Alignment patterns. The centre grid is the first and last row/column of
    // QR_ALIGN[version]; the three centres that would overlap a finder pattern
    // are omitted, and for versions 2-6 that leaves only the bottom-right one.
    const centers = QR_ALIGN[version];
    const lastCenter = centers[centers.length - 1];
    for (const row of centers) {
      for (const col of centers) {
        const topLeft = row === 6 && col === 6;
        const topRight = row === 6 && col === lastCenter;
        const bottomLeft = row === lastCenter && col === 6;
        if (topLeft || topRight || bottomLeft) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const ring = Math.max(Math.abs(r), Math.abs(c));
            set(row + r, col + c, ring !== 1);
          }
        }
      }
    }
    // Version information: two 18-bit blocks required from version 7 upward,
    // one beside the top-right finder and one beside the bottom-left finder.
    // They are pure function patterns here — the data zigzag must skip them.
    if (version >= 7) {
      const versionBits = qrVersionBits(version);
      for (let i = 0; i < 18; i++) {
        const dark = ((versionBits >>> i) & 1) === 1;
        set(Math.floor(i / 3), size - 11 + (i % 3), dark);
        set(size - 11 + (i % 3), Math.floor(i / 3), dark);
      }
    }

    // Reserve the format areas; the real bits are written once the mask is
    // known. Row 6 and column 6 belong to the timing patterns and stay clear.
    for (let i = 0; i <= 14; i++) {
      const row = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
      if (row !== 6) set(row, 8, false);
    }
    for (let i = 0; i <= 14; i++) {
      const col = i < 8 ? size - i - 1 : i < 9 ? 7 : 14 - i;
      if (col !== 6) set(8, col, false);
    }
    for (let i = 0; i < 8; i++) {
      set(8, size - 1 - i, false);
      set(size - 1 - i, 8, false);
    }
    set(size - 8, 8, true); // the always-dark module

    // Data modules in the standard two-column zigzag, skipping the vertical
    // timing column and any module a function pattern already claimed.
    const codewords = qrCodewords(bytes, version);
    const stream = [];
    for (const codeword of codewords) {
      for (let i = 7; i >= 0; i--) stream.push((codeword >>> i) & 1);
    }
    let index = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (let step = 0; step < size; step++) {
        const row = upward ? size - 1 - step : step;
        for (const current of [col, col - 1]) {
          if (reserved[row][current]) continue;
          modules[row][current] = index < stream.length && stream[index] === 1;
          index++;
        }
      }
      upward = !upward;
    }

    // Mask selection: apply each of the 8 masks to a copy, score the result,
    // and keep the lowest penalty (ISO/IEC 18004 rules 1-4).
    let best;
    for (let mask = 0; mask < 8; mask++) {
      const candidate = modules.map((row) => row.slice());
      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) if (!reserved[row][col] && qrMaskAt(mask, row, col)) candidate[row][col] = !candidate[row][col];
      }
      applyFormat(candidate, size, mask);
      const score = qrPenalty(candidate, size);
      if (best === undefined || score < best.score) best = { score, modules: candidate };
    }
    return best.modules;
  }

  /**
   * The 18-bit version information for version 7 and up: the 6-bit version
   * followed by a 12-bit BCH(18,6) remainder under 0b1111100100101.
   */
  function qrVersionBits(version) {
    let remainder = version << 12;
    for (let i = 17; i >= 12; i--) {
      if ((remainder >>> i) & 1) remainder ^= 0b1111100100101 << (i - 12);
    }
    return (version << 12) | remainder;
  }

  /** Mask selection helper — see qrMaskAt. */
  function qrMaskAt(mask, row, col) {
    switch (mask) {
      case 0: return (row + col) % 2 === 0;
      case 1: return row % 2 === 0;
      case 2: return col % 3 === 0;
      case 3: return (row + col) % 3 === 0;
      case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
      case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
      case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
      default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    }
  }

  /** Write both format-information copies for `mask` at ECC level M. */
  function applyFormat(target, size, mask) {
    // 5 data bits (ECC level M = 0b00, then the 3-bit mask) and 10 BCH bits.
    const data = (0b00 << 3) | mask;
    let remainder = data << 10;
    for (let i = 14; i >= 10; i--) {
      if ((remainder >>> i) & 1) remainder ^= 0b10100110111 << (i - 10);
    }
    const bits = (((data << 10) | remainder) ^ 0b101010000010010) & 0x7fff;
    const bit = (position) => ((bits >>> position) & 1) === 1;
    // ISO/IEC 18004 writes the 15 format bits twice. The vertical copy wraps
    // the top-left finder down column 8 and then continues up from the bottom
    // edge; the horizontal copy runs along row 8 from the right edge and then
    // resumes left of the timing column. Bit i maps to a fixed cell in each.
    for (let i = 0; i <= 14; i++) {
      const row = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
      target[row][8] = bit(i);
    }
    for (let i = 0; i <= 14; i++) {
      const col = i < 8 ? size - i - 1 : i < 9 ? 7 : 14 - i;
      target[8][col] = bit(i);
    }
    target[size - 8][8] = true;
  }

  /** The four standard mask-evaluation penalties; lower is better. */
  function qrPenalty(matrix, size) {
    let score = 0;
    // Rule 1: runs of five or more same-coloured modules in a line.
    for (let i = 0; i < size; i++) {
      for (const horizontal of [true, false]) {
        let run = 1;
        for (let j = 1; j < size; j++) {
          const current = horizontal ? matrix[i][j] : matrix[j][i];
          const previous = horizontal ? matrix[i][j - 1] : matrix[j - 1][i];
          if (current === previous) {
            run++;
          } else {
            if (run >= 5) score += run - 2;
            run = 1;
          }
        }
        if (run >= 5) score += run - 2;
      }
    }
    // Rule 2: every 2x2 block of one colour.
    for (let row = 0; row < size - 1; row++) {
      for (let col = 0; col < size - 1; col++) {
        const first = matrix[row][col];
        if (first === matrix[row][col + 1] && first === matrix[row + 1][col] && first === matrix[row + 1][col + 1]) score += 3;
      }
    }
    // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules beside it.
    const pattern = [true, false, true, true, true, false, true, false, false, false, false];
    const matches = (at) => {
      let forward = true;
      let backward = true;
      for (let i = 0; i < 11; i++) {
        if (at(i) !== pattern[i]) forward = false;
        if (at(10 - i) !== pattern[i]) backward = false;
      }
      return forward || backward;
    };
    for (let i = 0; i < size; i++) {
      for (let j = 0; j + 11 <= size; j++) {
        if (matches((k) => matrix[i][j + k])) score += 40;
        if (matches((k) => matrix[j + k][i])) score += 40;
      }
    }
    // Rule 4: deviation of the dark-module proportion from 50%.
    let dark = 0;
    for (const row of matrix) for (const cell of row) if (cell) dark++;
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return score;
  }

  //#endregion

  /** Copy text through the async clipboard API, with a selection fallback. */
  async function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through to the selection fallback.
    }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }

  //#region QR rendering

  /** Quiet zone, in modules, required on every side by the QR spec. */
  const QR_QUIET = 4;

  /** The 8-byte magic that opens every PNG stream. */
  const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  /**
   * A QR code for `text` as a PNG data URL — an `<img>` needs no canvas
   * permission and survives the strict page CSP, where a remote image URL from
   * a QR service would be blocked and would leak the token besides. Cached per
   * URL because the card re-renders on every keystroke elsewhere in the form.
   */
  const qrCache = new Map();

  function qrDataUrl(text) {
    const cached = qrCache.get(text);
    if (cached !== undefined) return cached;
    let result;
    try {
      result = qrEncodePng(text) ?? null;
    } catch {
      result = null;
    }
    qrCache.set(text, result);
    return result;
  }

  /** Render `text` as a scaled PNG. Returns undefined only if the text is too long. */
  function qrEncodePng(text) {
    const matrix = qrMatrix(text);
    if (matrix === undefined) return undefined;
    const size = matrix.length;
    const scale = size <= 33 ? 8 : size <= 57 ? 6 : 4;
    const side = (size + QR_QUIET * 2) * scale;
    const pixels = new Uint8Array(side * side).fill(255);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (!matrix[row][col]) continue;
        for (let y = 0; y < scale; y++) {
          const base = (row + QR_QUIET) * scale * side + (col + QR_QUIET) * scale + y * side;
          pixels.fill(0, base, base + scale);
        }
      }
    }
    return `data:image/png;base64,${pngDataUrl(pixels, side)}`;
  }

  /**
   * Wrap greyscale pixels in a PNG container: 8-bit colour type 0, one IDAT
   * holding zlib streams of stored (uncompressed) deflate blocks.
   */
  function pngDataUrl(pixels, side) {
    const raw = new Uint8Array((side + 1) * side);
    for (let row = 0; row < side; row++) {
      raw[row * (side + 1)] = 0; // filter type 0 (None)
      raw.set(pixels.subarray(row * side, (row + 1) * side), row * (side + 1) + 1);
    }
    const chunks = [
      PNG_SIGNATURE,
      pngChunk("IHDR", pngHeader(side)),
      pngChunk("IDAT", zlibStored(raw)),
      pngChunk("IEND", new Uint8Array(0)),
    ];
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return base64FromBytes(bytes);
  }

  /** The 13-byte IHDR payload: a square, 8-bit greyscale, non-interlaced image. */
  function pngHeader(side) {
    return Uint8Array.from([
      0, 0, (side >>> 8) & 0xff, side & 0xff, // width, big-endian
      0, 0, (side >>> 8) & 0xff, side & 0xff, // height
      8, // bit depth
      0, // colour type 0 (greyscale)
      0, // compression: deflate
      0, // filter method: adaptive
      0, // interlace: none
    ]);
  }

  /** One PNG chunk: length, type, payload, and the CRC over type+payload. */
  function pngChunk(type, payload) {
    const length = payload.length;
    const body = new Uint8Array(4 + length);
    for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
    body.set(payload, 4);
    const crc = crc32(body);
    const chunk = new Uint8Array(8 + length + 4);
    chunk[0] = (length >>> 24) & 0xff;
    chunk[1] = (length >>> 16) & 0xff;
    chunk[2] = (length >>> 8) & 0xff;
    chunk[3] = length & 0xff;
    chunk.set(body, 4);
    chunk[8 + length] = (crc >>> 24) & 0xff;
    chunk[9 + length] = (crc >>> 16) & 0xff;
    chunk[10 + length] = (crc >>> 8) & 0xff;
    chunk[11 + length] = crc & 0xff;
    return chunk;
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      table[i] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** A zlib stream whose deflate blocks are deliberately stored, not compressed. */
  function zlibStored(raw) {
    const blocks = [];
    const maxBlock = 0xffff;
    let offset = 0;
    do {
      const size = Math.min(maxBlock, raw.length - offset);
      const last = offset + size >= raw.length;
      const header = new Uint8Array(5);
      header[0] = last ? 1 : 0;
      header[1] = size & 0xff;
      header[2] = (size >>> 8) & 0xff;
      header[3] = ~size & 0xff;
      header[4] = (~size >>> 8) & 0xff;
      blocks.push(header, raw.subarray(offset, offset + size));
      offset += size;
    } while (offset < raw.length);
    return Uint8Array.from([0x78, 0x01, ...blocks.flatMap((part) => [...part]), ...adler32(raw)]);
  }

  function adler32(bytes) {
    let a = 1;
    let b = 0;
    for (const byte of bytes) {
      a = (a + byte) % 65521;
      b = (b + a) % 65521;
    }
    return [(b >>> 8) & 0xff, b & 0xff, (a >>> 8) & 0xff, a & 0xff];
  }

  const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function base64FromBytes(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = bytes[i + 1];
      const c = bytes[i + 2];
      out += BASE64[a >> 2];
      out += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)];
      out += b === undefined ? "=" : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)];
      out += c === undefined ? "=" : BASE64[c & 63];
    }
    return out;
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
    urlCard: {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      borderTop: "1px solid var(--dsw-alias-border-l1)",
      paddingTop: "12px",
    },
    urlHead: { fontSize: "12px", fontWeight: "600" },
    urlList: { display: "flex", flexDirection: "column", gap: "6px" },
    urlRow: { display: "flex", alignItems: "center", gap: "8px" },
    urlActions: { display: "flex", justifyContent: "flex-end" },
    urlAnchor: { position: "relative", display: "flex", flex: "1", minWidth: "0" },
    urlCode: {
      flex: "1",
      minWidth: "0",
      overflowWrap: "anywhere",
      fontFamily: "ui-monospace, monospace",
      fontSize: "11px",
      background: "var(--dsw-alias-bg-base)",
      border: "1px solid var(--dsw-alias-border-l1)",
      borderRadius: "6px",
      padding: "6px 8px",
      color: "var(--dsw-alias-label-primary)",
      cursor: "help",
    },
    qrPopover: {
      position: "absolute",
      zIndex: "30",
      top: "calc(100% + 6px)",
      left: "0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "6px",
      padding: "10px",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "10px",
      background: "var(--dsw-alias-bg-layer-1)",
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)",
      color: "var(--dsw-alias-label-primary)",
    },
    qrImage: {
      display: "block",
      width: "196px",
      height: "196px",
      // The code is drawn on white regardless of theme: a QR scanner needs the
      // light quiet zone, and a dark-mode inverted code reads as invalid.
      background: "#ffffff",
      borderRadius: "6px",
      imageRendering: "pixelated",
    },
    qrCaption: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
    qrTooLong: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)", maxWidth: "196px" },
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

  /**
   * Hover/focus target around one URL that reveals its QR code, so a phone can
   * pick the address up with a camera instead of typing a 60-character token.
   * Hover alone would exclude touch and keyboard, so focus and click open it
   * too, and clicking again closes it.
   */
  function QrHint(props) {
    const t = props.t;
    const url = props.url;
    const [open, setOpen] = React.useState(false);
    // The code is only built once the hint is open: encoding is cheap, but the
    // card re-renders on every keystroke in the form above it.
    const image = open ? qrDataUrl(url) : null;
    // One id per row: several addresses can be listed at once, and duplicate
    // ids would leave aria-describedby pointing at the wrong tooltip.
    const popoverId = `${ITEM_ID}-qr-${url.replace(/[^\w-]/g, "_")}`;
    return React.createElement(
      "span",
      {
        style: T.urlAnchor,
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
      },
      React.createElement(
        "code",
        {
          style: T.urlCode,
          title: url,
          tabIndex: 0,
          "aria-describedby": open ? popoverId : undefined,
          onFocus: () => setOpen(true),
          onBlur: () => setOpen(false),
          onClick: () => setOpen((value) => !value),
        },
        url,
      ),
      open
        ? React.createElement(
            "div",
            { style: T.qrPopover, role: "tooltip", id: popoverId },
            image
              ? React.createElement("img", { src: image, alt: t("qrAlt"), style: T.qrImage })
              : React.createElement("span", { style: T.qrTooLong }, t("qrTooLong")),
            React.createElement("span", { style: T.qrCaption }, t("qrCaption")),
          )
        : null,
    );
  }

  /**
   * Authenticated LAN URLs published by the Host, with one copy button per
   * address. The values come from the authenticated index document; a page
   * loaded before the proxy bound shows the unavailable message until reload.
   */
  function LanUrlCard(props) {
    const t = props.t;
    const info = props.info;
    const [result, setResult] = React.useState({ key: null, ok: true });
    const timer = React.useRef(null);
    React.useEffect(
      () => () => {
        if (timer.current !== null) clearTimeout(timer.current);
      },
      [],
    );
    const copy = (key, url) => {
      void copyText(url).then((ok) => {
        setResult({ key, ok });
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setResult({ key: null, ok: true }), 1800);
      });
    };
    const rows = info.urls.map((entry) =>
      React.createElement(
        "div",
        { key: entry.url, style: T.urlRow },
        React.createElement(QrHint, { key: entry.url, t, url: entry.url }),
        React.createElement(
          "button",
          {
            type: "button",
            style: { ...T.button, flexShrink: 0 },
            onClick: () => copy(entry.url, entry.url),
          },
          result.key === entry.url ? (result.ok ? t("copied") : t("copyFailed")) : t("copy"),
        ),
      ),
    );
    return React.createElement(
      "div",
      { style: T.urlCard },
      React.createElement("div", { style: T.urlHead }, t("lanUrlTitle")),
      React.createElement("p", { style: T.hint }, t("lanUrlHint")),
      info.urls.length === 0
        ? React.createElement(
            "p",
            { style: T.warn, role: "status" },
            info.available && !info.enabled ? t("lanUrlDisabled") : t("lanUrlUnavailable"),
          )
        : React.createElement("div", { style: T.urlList }, rows),
      React.createElement(
        "div",
        { style: T.urlActions },
        React.createElement(
          "button",
          { type: "button", style: T.button, onClick: () => window.location.reload() },
          t("reload"),
        ),
      ),
    );
  }

  function Card(props) {
    const form = props.form;
    const t = props.t;
    const [model] = React.useState(() => new CardModel(form));
    React.useEffect(() => () => model.dispose(), [model]);
    const warned = React.useRef(undefined);
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
      // The one console line worth keeping: a page that cannot be edited is
      // abnormal, and the form status is what makes it explainable. Logged
      // once per distinct reason so re-renders cannot turn it into a flood.
      const reason = `${view.status}/${view.mode}`;
      if (warned.current !== reason) {
        warned.current = reason;
        console.warn(`[dsh-lan-proxy] settings section unavailable (status: ${view.status}, mode: ${view.mode})`);
      }
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
      React.createElement(LanUrlCard, { t, info: readLanInfo() }),
    );
  }

  //#endregion

  function apply(ctx) {
    const t = ctx.locale.bind(NS);
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-lan-proxy: dictionaries");
    const form = ctx.configForms.get(ENTRY_ID);
    // One form, two homes: the Plugins settings tab and the Plugins manager
    // item. Both appear and disappear together with the served section.
    const page = (props) => React.createElement(Card, { form, t, view: props.view });
    const register = (slot) => () =>
      ctx.slots.register({ name: slot, id: ITEM_ID, order: 20, label: () => t("title"), locale: NS }, page);
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
  exports.LanUrlCard = LanUrlCard;
  exports.QrHint = QrHint;
  exports.__test = {
    Card,
    CardModel,
    LanUrlCard,
    QrHint,
    allowEntryReason,
    draftFromValue,
    equalsCurrent,
    opsFromDraft,
    parseAllowText,
    qrDataUrl,
    qrMatrix,
    readLanInfo,
    validateDraft,
  };
  return module.exports;
}});
