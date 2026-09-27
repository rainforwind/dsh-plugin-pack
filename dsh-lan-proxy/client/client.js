// dsh-lan-proxy — browser half: the plugin's card on
// Settings → Plugins → Plugin configuration, keyed to the `lan-proxy`
// settings namespace the Host half registers.
//
// Contract facts this file is built on (verified against the live slot tree
// and the shipped cards):
//   - `settings.plugin.item` is a root keyed slot; its only registration
//     option is `key` (the settings namespace), and the component draws its
//     own chrome — value imports from other plugins fail the client
//     bundle-purity gate, so everything here is self-contained.
//   - Reads/writes ride `ctx.settingsScope.bind({ namespace })`: the snapshot
//     carries { status, value, base, user, revision, writable, mode }, and
//     `mutate(ops, expectedRevision)` fences each write against the revision
//     the draft began at, so a concurrent change is refused, never clobbered.
//   - On a page opened through a non-loopback URL, DSH keeps settings
//     persistence process-local (`remote.$host.isLoopback` is false), so the
//     snapshot reports unavailable and this card renders nothing there;
//     configure from the local loopback URL.
//
// The state machine lives in CardModel (plain JS, headlessly testable in
// test/client.mjs); the React component only binds it to the scope.

window.__ModuleLoader__.load({ id: "dsh-lan-proxy", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  let React = require("react");

  const name = "dsh-lan-proxy-client";
  const inject = ["slots", "settingsScope"];
  /** Settings namespace this card edits (must match the Host registration). */
  const NS = "lan-proxy";

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

  /** Validate one allowlist line; returns an error message or null when valid. */
  function allowEntryError(entry) {
    const raw = typeof entry === "string" ? entry.trim() : "";
    if (raw === "") return "empty entry";
    const pieces = raw.split("/");
    if (pieces.length > 2) return "expected <ip> or <ip>/<prefix>";
    if (normalizeIp(pieces[0]) === undefined) return "not an IPv4 or IPv6 address";
    if (pieces.length === 2) {
      if (!/^\d{1,3}$/.test(pieces[1])) return "prefix must be a number";
      const prefix = Number(pieces[1]);
      const maximum = normalizeIp(pieces[0]).family === 4 ? 32 : 128;
      if (prefix > maximum) return `prefix must be 0-${String(maximum)}`;
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

  /** Per-field error messages for a draft; `{ ok, errors }`. */
  function validateDraft(draft) {
    const errors = {};
    if (draft.host.trim() === "") errors.host = "required";
    if (!validPort(draft.port)) errors.port = "0-65535, digits only";
    if (draft.targetHost.trim() === "") errors.targetHost = "required";
    if (!validPort(draft.targetPort)) errors.targetPort = "0-65535, digits only";
    const entries = parseAllowText(draft.allowText);
    const seen = new Set();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (seen.has(entry)) {
        errors.allow = `line ${String(index + 1)}: duplicate "${entry}"`;
        break;
      }
      seen.add(entry);
      const message = allowEntryError(entry);
      if (message !== null) {
        errors.allow = `line ${String(index + 1)}: ${message}`;
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
    constructor(scope) {
      this.scope = scope;
      this.draft = null;
      this.saving = false;
      this.failed = false;
      this.conflict = false;
      this.open = false;
      this.saveGeneration = 0;
      this.listeners = new Set();
      this.unsubscribe = scope.subscribe(() => this.onChange());
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

    /** Stop observing the scope and ignore late settlements. */
    dispose() {
      this.saveGeneration += 1;
      this.listeners.clear();
      this.unsubscribe();
    }

    /** Fold external revision moves into the draft (never silently). */
    onChange() {
      const snapshot = this.scope.getSnapshot();
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
      const snapshot = this.scope.getSnapshot();
      return snapshot.status === "ready" && snapshot.writable === true && !this.saving;
    }

    /** Stage one field patch, beginning the draft (with its fence revision) on first edit. */
    edit(patch) {
      if (!this.editable()) return;
      const snapshot = this.scope.getSnapshot();
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
      const snapshot = this.scope.getSnapshot();
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
      await this.scope.mutate(opsFromDraft(draft), draft.revision);
      if (generation !== this.saveGeneration) return;
      this.saving = false;
      const after = this.scope.getSnapshot();
      const landed = equalsCurrent(after.value, draft);
      if (landed) {
        this.draft = null;
        this.failed = false;
        this.open = false;
      } else {
        this.failed = true;
      }
      this.notify();
    }

    /** Revert every field to the composition defaults (fenced like a save). */
    async reset() {
      if (this.saving) return;
      const snapshot = this.scope.getSnapshot();
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
      await this.scope.mutate(RESET_OPS.slice(), fence);
      if (generation !== this.saveGeneration) return;
      this.saving = false;
      const after = this.scope.getSnapshot();
      const base = after.base && typeof after.base === "object" ? after.base : {};
      const landed = equalsCurrent(after.value, draftFromValue(base));
      this.draft = null;
      this.failed = !landed;
      this.notify();
    }

    toggleOpen() {
      // Unsaved drafts survive collapsing — the header tag keeps saying so.
      this.open = !this.open;
      this.notify();
    }

    computeView() {
      const snapshot = this.scope.getSnapshot();
      const draft = this.draft;
      const fields = draft !== null ? draft : draftFromValue(snapshot.value);
      const validation = draft !== null ? validateDraft(draft) : { ok: true, errors: {} };
      return {
        available: snapshot.status !== "unavailable",
        writable: snapshot.status === "ready" && snapshot.writable === true,
        mode: snapshot.mode ?? "host",
        open: this.open,
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

  //#region card chrome (hand-built; other plugins' components are not importable)

  const T = {
    card: {
      listStyle: "none",
      border: "1px solid var(--dsw-alias-border-l1)",
      borderRadius: "10px",
      background: "var(--dsw-alias-bg-layer-1)",
      color: "var(--dsw-alias-label-primary)",
      fontFamily: "inherit",
    },
    header: {
      display: "flex",
      width: "100%",
      alignItems: "center",
      gap: "10px",
      padding: "10px 14px",
      background: "transparent",
      border: 0,
      color: "inherit",
      font: "inherit",
      cursor: "pointer",
      textAlign: "left",
      borderRadius: "10px",
    },
    headText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" },
    cardName: { fontSize: "13px", fontWeight: "600" },
    cardDescription: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
    unsaved: {
      marginLeft: "auto",
      flexShrink: "0",
      fontSize: "11px",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "999px",
      padding: "1px 8px",
      color: "var(--dsw-alias-label-secondary)",
    },
    chevron: {
      flexShrink: "0",
      width: "14px",
      height: "14px",
      color: "var(--dsw-alias-label-secondary)",
      transform: "rotate(0deg)",
      transition: "transform 120ms ease",
    },
    chevronOpen: { transform: "rotate(180deg)" },
    body: {
      borderTop: "1px solid var(--dsw-alias-border-l1)",
      padding: "12px 14px 14px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
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

  function Chevron(props) {
    return React.createElement(
      "svg",
      { viewBox: "0 0 14 14", "aria-hidden": "true", style: { ...T.chevron, ...(props.open ? T.chevronOpen : null) } },
      React.createElement("path", {
        d: "M3 5l4 4 4-4",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
    );
  }

  function Field(props) {
    return React.createElement(
      "div",
      { style: T.field },
      React.createElement("label", { htmlFor: props.id, style: T.label }, props.label),
      props.control,
      props.error
        ? React.createElement("span", { style: T.error }, props.error)
        : props.hint
          ? React.createElement("span", { style: T.hint }, props.hint)
          : null,
    );
  }

  function inputStyle(view, extra) {
    return { ...T.control, ...(!view.writable ? T.controlDisabled : null), ...(extra ?? null) };
  }

  function Card(props) {
    const scope = props.scope;
    const [model] = React.useState(() => new CardModel(scope));
    React.useEffect(() => () => model.dispose(), [model]);
    const view = React.useSyncExternalStore(
      (listener) => model.subscribe(listener),
      () => model.view,
    );
    if (!view.available) return null;
    const fields = view.fields;
    const errors = view.errors;
    const controlsDisabled = !view.writable || view.saving;

    const text = (key, patchKey) =>
      React.createElement("input", {
        id: `lan-proxy-${key}`,
        type: "text",
        value: fields[key],
        disabled: controlsDisabled,
        style: inputStyle(view),
        onChange: (event) => model.edit({ [patchKey ?? key]: event.target.value }),
      });

    return React.createElement(
      "li",
      { style: T.card },
      React.createElement(
        "button",
        {
          type: "button",
          style: T.header,
          "aria-expanded": view.open,
          onClick: () => model.toggleOpen(),
        },
        React.createElement(
          "span",
          { style: T.headText },
          React.createElement("span", { style: T.cardName }, "LAN Proxy"),
          React.createElement(
            "span",
            { style: T.cardDescription },
            "Reverse-proxy the Web GUI to allowlisted addresses (dsh-lan-proxy)",
          ),
        ),
        view.dirty ? React.createElement("span", { style: T.unsaved }, "Unsaved") : null,
        React.createElement(Chevron, { open: view.open }),
      ),
      view.open
        ? React.createElement(
            "div",
            { style: T.body },
            !view.writable
              ? React.createElement(
                  "p",
                  { style: T.warn, role: "status" },
                  view.mode === "memory"
                    ? "Settings are read-only on a non-loopback page — open the local dsh web URL to edit."
                    : "Settings are read-only right now.",
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
              React.createElement(
                "label",
                { htmlFor: "lan-proxy-enabled" },
                "Enabled — run the allowlisted reverse proxy (saves apply immediately)",
              ),
            ),
            React.createElement(Field, {
              id: "lan-proxy-host",
              label: "Listen host",
              hint: "0.0.0.0 exposes every interface (gated by the allow list); a specific address binds one interface.",
              error: errors.host,
              control: text("host"),
            }),
            React.createElement(Field, {
              id: "lan-proxy-port",
              label: "Listen port",
              hint: "Proxy port; 0 lets the OS pick one.",
              error: errors.port,
              control: React.createElement("input", {
                id: "lan-proxy-port",
                type: "text",
                inputMode: "numeric",
                value: fields.port,
                disabled: controlsDisabled,
                style: inputStyle(view),
                onChange: (event) => model.edit({ port: event.target.value }),
              }),
            }),
            React.createElement(Field, {
              id: "lan-proxy-allow",
              label: "Allow list — one source IP or CIDR per line",
              hint: "Empty keeps the port closed to non-loopback sources. Loopback is always allowed.",
              error: errors.allow,
              control: React.createElement("textarea", {
                id: "lan-proxy-allow",
                rows: 4,
                spellCheck: false,
                value: fields.allowText,
                disabled: controlsDisabled,
                style: inputStyle(view, T.textarea),
                onChange: (event) => model.edit({ allowText: event.target.value }),
              }),
            }),
            React.createElement(Field, {
              id: "lan-proxy-targetHost",
              label: "Target host",
              hint: "The Web server being proxied (loopback).",
              error: errors.targetHost,
              control: text("targetHost"),
            }),
            React.createElement(Field, {
              id: "lan-proxy-target-port",
              label: "Target port",
              hint: "0 follows the composed Web server's actual port.",
              error: errors.targetPort,
              control: React.createElement("input", {
                id: "lan-proxy-target-port",
                type: "text",
                inputMode: "numeric",
                value: fields.targetPort,
                disabled: controlsDisabled,
                style: inputStyle(view),
                onChange: (event) => model.edit({ targetPort: event.target.value }),
              }),
            }),
            view.conflict
              ? React.createElement(
                  "p",
                  { style: T.warn, role: "status" },
                  "The saved settings changed elsewhere — your edits are kept; review them before saving.",
                )
              : null,
            view.failed
              ? React.createElement(
                  "p",
                  { style: T.error, role: "status" },
                  "The write was refused (settings moved on). Review the values and try again.",
                )
              : null,
            React.createElement(
              "div",
              { style: T.footer },
              React.createElement(
                "span",
                { style: T.footerNote },
                "Host logs report proxy status ([lan-proxy] …); bad entries keep it closed.",
              ),
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
                "Reset to defaults",
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  style: { ...T.button, ...(view.dirty && !view.saving ? null : T.buttonDisabled) },
                  disabled: !view.dirty || view.saving,
                  onClick: () => model.discard(),
                },
                "Discard",
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  style: {
                    ...(view.dirty && view.writable && !view.saving && !view.invalid ? T.buttonPrimary : T.button),
                    ...(view.dirty && view.writable && !view.saving && !view.invalid ? null : T.buttonDisabled),
                  },
                  disabled: !view.dirty || !view.writable || view.saving || view.invalid,
                  onClick: () => {
                    model.save();
                  },
                },
                view.saving ? "Saving…" : "Save",
              ),
            ),
          )
        : null,
    );
  }

  //#endregion

  function apply(ctx) {
    ctx.inject(["settingsScope"], (scoped) => {
      const scope = scoped.settingsScope.bind({ namespace: NS });
      ctx.slots.inject("settings.plugin.item", () =>
        ctx.slots.register({ name: "settings.plugin.item", key: NS }, () =>
          React.createElement(Card, { scope }),
        ),
      );
    });
  }

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  exports.Card = Card;
  exports.__test = {
    CardModel,
    allowEntryError,
    draftFromValue,
    equalsCurrent,
    opsFromDraft,
    parseAllowText,
    validateDraft,
  };
  return module.exports;
}});
