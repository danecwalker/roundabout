// Host-page script: `<script src="https://<roundabout>/widget/api.js" async defer>`.
// Renders widget iframes into `.roundabout` containers (or via `roundabout.render`)
// and keeps a hidden `roundabout-response` form field in sync with the token.

import type { FrameMessage, HostMessage } from "./protocol";

type Theme = "auto" | "light" | "dark";
type Size = "normal" | "compact" | "flexible";
type Appearance = "always" | "execute" | "interaction-only";

export interface RenderOptions {
  sitekey: string;
  theme?: Theme;
  size?: Size;
  /** When the widget is visible (default `always`). */
  appearance?: Appearance;
  /** `render` runs immediately; `execute` waits for `roundabout.execute()`. */
  execution?: "render" | "execute";
  language?: string;
  action?: string;
  cdata?: string;
  retry?: "auto" | "never";
  "retry-interval"?: number;
  /** Re-run automatically when a token expires (default `auto`). */
  "refresh-expired"?: "auto" | "never";
  /** Name of the hidden input (default `roundabout-response`), or false for none. */
  "response-field-name"?: string | false;
  callback?: (token: string) => void;
  "error-callback"?: (code: string) => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
  "before-interactive-callback"?: () => void;
  "after-interactive-callback"?: () => void;
  "unsupported-callback"?: () => void;
}

interface Widget {
  id: string;
  container: HTMLElement;
  iframe: HTMLIFrameElement;
  input: HTMLInputElement | null;
  opts: RenderOptions;
  token: string | null;
  expiryTimer?: number;
  ready: boolean;
  executePending: boolean;
  invisible: boolean;
}

declare global {
  interface Window {
    roundabout?: typeof api;
    [key: string]: unknown;
  }
}

const script = document.currentScript as HTMLScriptElement | null;
const scriptUrl = new URL(script?.src ?? location.href);
const BASE = scriptUrl.origin;
const widgets = new Map<string, Widget>();
let counter = 0;

const SIZES: Record<Size, [string, string]> = {
  normal: ["300px", "65px"],
  compact: ["150px", "140px"],
  flexible: ["100%", "65px"],
};
const HIDDEN_STYLE =
  "border:0;position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";

function resolveContainer(target: string | HTMLElement): HTMLElement {
  const el = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!el) throw new Error(`roundabout: container not found: ${String(target)}`);
  return el;
}

/** Resolve a `data-callback="fnName"` style global function reference. */
function globalFn<T extends (...args: never[]) => unknown>(name: string | undefined): T | undefined {
  if (!name) return undefined;
  const fn = window[name];
  return typeof fn === "function" ? (fn as T) : undefined;
}

const CALLBACK_ATTRS = {
  callback: "callback",
  errorCallback: "error-callback",
  expiredCallback: "expired-callback",
  timeoutCallback: "timeout-callback",
  beforeInteractiveCallback: "before-interactive-callback",
  afterInteractiveCallback: "after-interactive-callback",
  unsupportedCallback: "unsupported-callback",
} as const;

function optsFromDataset(el: HTMLElement): Partial<RenderOptions> {
  const d = el.dataset;
  const o: Record<string, unknown> = {};
  const plain = ["sitekey", "theme", "size", "appearance", "execution", "language", "action", "cdata", "retry"] as const;
  for (const k of plain) if (d[k]) o[k] = d[k];
  if (d.retryInterval) o["retry-interval"] = Number(d.retryInterval);
  if (d.refreshExpired) o["refresh-expired"] = d.refreshExpired;
  if (d.responseFieldName) o["response-field-name"] = d.responseFieldName;
  if (d.responseField === "false") o["response-field-name"] = false;
  // Resolve callbacks lazily so they can be defined after this script loads.
  for (const [attr, opt] of Object.entries(CALLBACK_ATTRS)) {
    const name = d[attr];
    if (name) o[opt] = (...args: unknown[]) => globalFn<(...a: unknown[]) => void>(name)?.(...args);
  }
  return o as Partial<RenderOptions>;
}

function frameSrc(w: Widget): string {
  const o = w.opts;
  const q = new URLSearchParams({
    sitekey: o.sitekey,
    wid: w.id,
    theme: o.theme ?? "auto",
    size: o.size ?? "normal",
    lang: o.language ?? "auto",
    retry: o.retry ?? "auto",
    origin: location.origin,
  });
  if (o["retry-interval"]) q.set("retry_interval", String(o["retry-interval"]));
  if (o.execution === "execute") q.set("exec", "1");
  if (o.action) q.set("action", o.action);
  if (o.cdata) q.set("cdata", o.cdata);
  q.set("_", String(Date.now()));
  return `${BASE}/v1/frame?${q}`;
}

function visibleStyle(w: Widget): string {
  const [width, height] = SIZES[w.opts.size ?? "normal"] ?? SIZES.normal;
  const flex = w.opts.size === "flexible" ? "min-width:300px;" : "";
  return `border:0;display:block;max-width:100%;color-scheme:normal;width:${width};height:${height};${flex}`;
}

function setVisible(w: Widget, visible: boolean) {
  w.iframe.style.cssText = visible && !w.invisible ? visibleStyle(w) : HIDDEN_STYLE;
}

function initiallyVisible(w: Widget): boolean {
  return (w.opts.appearance ?? "always") === "always";
}

function setToken(w: Widget, token: string | null) {
  w.token = token;
  if (w.input) w.input.value = token ?? "";
  if (w.expiryTimer) clearTimeout(w.expiryTimer);
  w.expiryTimer = undefined;
}

function supported(): boolean {
  return (
    typeof window.postMessage === "function" &&
    typeof fetch === "function" &&
    typeof Promise !== "undefined" &&
    typeof URLSearchParams !== "undefined"
  );
}

function render(target: string | HTMLElement, options?: Partial<RenderOptions>): string {
  const container = resolveContainer(target);
  if (container.dataset.roundaboutId && widgets.has(container.dataset.roundaboutId)) {
    return container.dataset.roundaboutId;
  }
  const opts = { ...optsFromDataset(container), ...options } as RenderOptions;
  if (!opts.sitekey) throw new Error("roundabout: sitekey is required");
  if (!supported()) {
    opts["unsupported-callback"]?.();
    return "";
  }

  const id = `rb${++counter}`;
  const iframe = document.createElement("iframe");
  iframe.title = "Roundabout security challenge";
  iframe.setAttribute("loading", "eager");

  const fieldName = opts["response-field-name"] ?? "roundabout-response";
  let input: HTMLInputElement | null = null;
  if (fieldName !== false) {
    input = document.createElement("input");
    input.type = "hidden";
    input.name = fieldName;
  }

  const w: Widget = { id, container, iframe, input, opts, token: null, ready: false, executePending: false, invisible: false };
  widgets.set(id, w);
  container.dataset.roundaboutId = id;
  setVisible(w, initiallyVisible(w));
  container.appendChild(iframe);
  if (input) container.appendChild(input);
  iframe.src = frameSrc(w);
  return id;
}

function postToFrame(w: Widget, msg: HostMessage) {
  w.iframe.contentWindow?.postMessage(msg, BASE);
}

function onMessage(e: MessageEvent) {
  if (e.origin !== BASE) return;
  const msg = e.data as FrameMessage;
  if (!msg || msg.__roundabout !== 1) return;
  const w = widgets.get(msg.wid);
  if (!w || e.source !== w.iframe.contentWindow) return;
  const o = w.opts;

  switch (msg.type) {
    case "ready":
      w.ready = true;
      if (w.executePending) {
        w.executePending = false;
        postToFrame(w, { __roundabout: 1, type: "execute" });
      }
      break;
    case "mode":
      w.invisible = msg.mode === "invisible";
      if (w.invisible) setVisible(w, false);
      break;
    case "interactive":
      if (o.appearance === "interaction-only") setVisible(w, true);
      o["before-interactive-callback"]?.();
      break;
    case "interactive_done":
      o["after-interactive-callback"]?.();
      break;
    case "timeout":
      setToken(w, null);
      o["timeout-callback"]?.();
      break;
    case "success":
      setToken(w, msg.token);
      // Pre-clearance: first-party cookie for this site's reverse proxy / middleware.
      if (msg.clearance && /^rbc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(msg.clearance.value)) {
        const secure = location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `rb_clearance=${msg.clearance.value}; Path=/; Max-Age=${Math.floor(msg.clearance.maxAge)}; SameSite=Lax${secure}`;
      }
      // Expire a few seconds early so a form submitted at the edge still verifies.
      w.expiryTimer = window.setTimeout(() => {
        setToken(w, null);
        o["expired-callback"]?.();
        if (o["refresh-expired"] !== "never") reset(w.id);
      }, Math.max(1, msg.expiresIn - 10) * 1000);
      o.callback?.(msg.token);
      break;
    case "error":
      setToken(w, null);
      o["error-callback"]?.(msg.code);
      break;
  }
}

function lookup(id?: string): Widget | undefined {
  if (id) return widgets.get(id);
  return widgets.values().next().value;
}

function reset(id?: string) {
  const w = lookup(id);
  if (!w) return;
  setToken(w, null);
  w.ready = false;
  w.executePending = false;
  setVisible(w, initiallyVisible(w));
  w.iframe.src = frameSrc(w);
}

/** Run a widget rendered with `execution: "execute"` (or show an `appearance: "execute"` one). */
function execute(id?: string) {
  const w = lookup(id);
  if (!w) return;
  if (w.opts.appearance === "execute") setVisible(w, true);
  if (w.opts.execution !== "execute") return;
  if (w.ready) postToFrame(w, { __roundabout: 1, type: "execute" });
  else w.executePending = true;
}

function remove(id?: string) {
  const w = lookup(id);
  if (!w) return;
  setToken(w, null);
  w.iframe.remove();
  w.input?.remove();
  delete w.container.dataset.roundaboutId;
  widgets.delete(w.id);
}

function getResponse(id?: string): string | undefined {
  return lookup(id)?.token ?? undefined;
}

function isExpired(id?: string): boolean {
  const w = lookup(id);
  return !!w && w.token === null;
}

function renderAll() {
  document.querySelectorAll<HTMLElement>(".roundabout").forEach((el) => {
    if (!el.dataset.roundaboutId) render(el);
  });
}

const readyQueue: Array<() => void> = [];
let isReady = false;

function ready(cb: () => void) {
  if (isReady) cb();
  else readyQueue.push(cb);
}

const api = { render, reset, remove, execute, getResponse, isExpired, ready };

if (!window.roundabout) {
  window.roundabout = api;
  window.addEventListener("message", onMessage);

  const boot = () => {
    if (scriptUrl.searchParams.get("render") !== "explicit") renderAll();
    isReady = true;
    readyQueue.splice(0).forEach((cb) => cb());
    globalFn<() => void>(scriptUrl.searchParams.get("onload") ?? undefined)?.();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
