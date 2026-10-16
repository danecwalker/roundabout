// Runs inside the widget iframe (served from the Roundabout origin). Fetches a
// challenge, then in parallel: tries a Private Access Token, runs the
// per-challenge probe script, collects a fingerprint and solves the
// proof-of-work in a worker. The solve payload is encrypted with a key that
// only exists inside the probe. Posts the resulting token to the host page.

import { collect as collectFingerprint, type Fingerprint } from "./fp";
import { resolveLanguage, translator, type MsgKey } from "./i18n";
import type { FrameEvent, FrameMessage, HostMessage } from "./protocol";
import { sha256Bytes, solvePuzzle } from "./sha256";
import type { SolveJob, WorkerMsg } from "./worker";

interface Challenge {
  id: string;
  salt: string;
  puzzles: number;
  bits: number;
  mode: "managed" | "non_interactive" | "invisible";
  expires_in: number;
  pat: boolean;
}

type SolveResult =
  | { status: "ok"; token: string; expires_in: number; clearance?: { value: string; max_age: number } }
  | { status: "interaction_required" }
  | { status: "failed"; reason: string };

/** Everything needed to (re)submit a solved challenge. */
interface Attempt {
  ch: Challenge;
  nonces: number[];
  fp: Fingerprint;
  probe: number | null;
  key: number[] | null;
  issuedAt: number;
}

const params = new URLSearchParams(location.search);
const sitekey = params.get("sitekey") ?? "";
const wid = params.get("wid") ?? "";
const action = params.get("action") || undefined;
const cdata = params.get("cdata") || undefined;
const theme = params.get("theme") ?? "auto";
const size = params.get("size") ?? "normal";
const retryMode = params.get("retry") === "never" ? "never" : "auto";
const retryInterval = Math.min(Math.max(Number(params.get("retry_interval")) || 8000, 1000), 900_000);
const waitForExecute = params.get("exec") === "1";
const lang = resolveLanguage(params.get("lang"));
const t = translator(lang);
document.documentElement.lang = lang;

/** Errors that retrying won't fix. */
const FATAL = new Set(["invalid_sitekey", "hostname_not_allowed", "no_parent", "invalid_hostname"]);

/** The embedding page's origin. Browser-provided values win over the URL param. */
function resolveParentOrigin(): string | null {
  const ao = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (ao && ao.length > 0) return ao[0];
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      /* fall through */
    }
  }
  return params.get("origin");
}

const parentOrigin = resolveParentOrigin();

function emit(ev: FrameEvent) {
  if (!parentOrigin || window.parent === window) return;
  // targetOrigin pins delivery to the embedding origin, so a token can't leak elsewhere.
  window.parent.postMessage({ ...ev, __roundabout: 1, wid } satisfies FrameMessage, parentOrigin);
}

// ---------------------------------------------------------------------------
// UI

const ERROR_KEY: Record<string, MsgKey> = {
  invalid_sitekey: "invalid_sitekey",
  hostname_not_allowed: "domain_not_allowed",
  rate_limited: "rate_limited",
  rejected: "failed",
  invalid_solution: "failed",
  network: "network",
  no_parent: "no_parent",
};

const root = document.getElementById("rb-root")!;
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
document.documentElement.dataset.size = size;
// The control is a checkbox semantically: unchecked until verification succeeds.
root.innerHTML = `
  <div class="rb" data-state="loading">
    <button class="rb-box" type="button" role="checkbox" aria-checked="false" aria-disabled="true" aria-labelledby="rb-label">
      <span class="rb-spinner" aria-hidden="true"></span>
      <svg class="rb-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
      <svg class="rb-cross" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 7l10 10M17 7L7 17"/></svg>
    </button>
    <div class="rb-text">
      <span id="rb-label" class="rb-label"></span>
      <button class="rb-retry" type="button" hidden></button>
    </div>
    <div class="rb-brand" aria-hidden="true">
      <svg viewBox="0 0 64 64" focusable="false"><path d="M12.08 20.5A23 23 0 0 1 51.07 19.14" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round"/><path d="M53.87 24.89L56.71 15.34L45.43 22.94Z" fill="currentColor" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"/><path d="M51.92 43.5A23 23 0 0 1 12.93 44.86" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round"/><path d="M10.13 39.11L7.29 48.66L18.57 41.06Z" fill="currentColor" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"/><defs><mask id="rb-brand-mask"><rect width="64" height="64" fill="#fff"/><rect x="25" y="26" width="4.4" height="10" rx="2.2" fill="#000"/><rect x="34.6" y="26" width="4.4" height="10" rx="2.2" fill="#000"/></mask></defs><g mask="url(#rb-brand-mask)"><circle cx="32" cy="32" r="13.5" fill="currentColor"/></g></svg>
      <span>Roundabout</span>
    </div>
    <div class="rb-sr" role="status" aria-live="polite" aria-atomic="true"></div>
  </div>`;

const card = root.querySelector<HTMLDivElement>(".rb")!;
const box = root.querySelector<HTMLButtonElement>(".rb-box")!;
const label = root.querySelector<HTMLSpanElement>(".rb-label")!;
const retry = root.querySelector<HTMLButtonElement>(".rb-retry")!;
const live = root.querySelector<HTMLDivElement>(".rb-sr")!;

type State = "loading" | "interactive" | "success" | "error" | "expired";

function setState(state: State, text: string) {
  card.dataset.state = state;
  label.textContent = text;
  // Keep the control focusable at all times (aria-disabled, not disabled) so
  // keyboard focus isn't lost when the state changes underneath the user.
  box.setAttribute("aria-disabled", state === "interactive" ? "false" : "true");
  box.setAttribute("aria-checked", state === "success" ? "true" : "false");
  box.setAttribute("aria-busy", state === "loading" ? "true" : "false");
  retry.hidden = !(state === "error" || state === "expired");
  retry.textContent = state === "expired" ? t("refresh") : t("retry");
  // Announce meaningful transitions once (WCAG 4.1.3).
  if (live.textContent !== text) live.textContent = text;
}

// ---------------------------------------------------------------------------
// Signals

let pointerMoves = 0;
document.addEventListener("pointermove", () => pointerMoves++, { passive: true });
document.addEventListener("pointerdown", () => pointerMoves++, { passive: true });
let keyboardActivation = false;

function signals(interacted: boolean) {
  return {
    webdriver: navigator.webdriver === true,
    headless_ua: /HeadlessChrome|PhantomJS/.test(navigator.userAgent),
    languages: navigator.languages?.length ?? 0,
    hardware_concurrency: navigator.hardwareConcurrency || 0,
    screen_w: screen.width,
    screen_h: screen.height,
    // Keyboard users never move a pointer; a trusted key press counts as activity.
    touch: navigator.maxTouchPoints > 0 || keyboardActivation,
    pointer_moves: pointerMoves,
    interacted,
  };
}

// ---------------------------------------------------------------------------
// Network

class CodedError extends Error {}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    });
  } catch {
    throw new CodedError("network");
  }
  if (res.status === 429) throw new CodedError("rate_limited");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new CodedError((data as { error?: string }).error ?? `http_${res.status}`);
  return data as T;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

/** Load the single-use probe script; it exports [result, k0, k1, k2, k3]. */
function runProbe(id: string): Promise<number[] | null> {
  return withTimeout(
    new Promise<number[] | null>((resolve) => {
      const s = document.createElement("script");
      s.src = `/v1/probe/${encodeURIComponent(id)}.js`;
      s.onload = () => {
        const out = (self as unknown as { __rbp?: Record<string, number[]> }).__rbp;
        const r = out?.[id];
        resolve(Array.isArray(r) && r.length === 5 ? r : null);
        if (out) delete out[id];
        s.remove();
      };
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    }),
    5000,
    null,
  );
}

/** XOR with keystream blocks SHA-256("{key hex}:{i}"), then base64. */
function encrypt(key: number[], plain: string): string {
  const khex = key.map((k) => (k >>> 0).toString(16).padStart(8, "0")).join("");
  const data = new TextEncoder().encode(plain);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 32) {
    const ks = sha256Bytes(`${khex}:${i / 32}`);
    for (let j = 0; j < 32 && i + j < data.length; j++) out[i + j] = data[i + j] ^ ks[j];
  }
  let bin = "";
  for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
  return btoa(bin);
}

/**
 * Private Access Token: the server answers 401 + WWW-Authenticate; a
 * supporting browser (e.g. Safari) transparently fetches a token and retries.
 */
async function tryPat(id: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const res = await fetch(`/v1/pat/${encodeURIComponent(id)}`, { credentials: "omit", cache: "no-store", signal: ctl.signal });
    return res.ok && ((await res.json()) as { pat?: boolean }).pat === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startSolve(job: SolveJob): { result: Promise<number[]>; cancel: () => void } {
  let worker: Worker | null = null;
  const result = new Promise<number[]>((resolve, reject) => {
    try {
      worker = new Worker("/widget/worker.js");
    } catch {
      // No worker support: solve on the main thread (blocks this frame only).
      const nonces: number[] = [];
      for (let i = 0; i < job.puzzles; i++) nonces.push(solvePuzzle(job.salt, i, job.bits));
      return resolve(nonces);
    }
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      if (e.data.type === "done") {
        worker?.terminate();
        resolve(e.data.nonces);
      }
    };
    worker.onerror = (e) => {
      worker?.terminate();
      reject(new CodedError(`worker: ${e.message}`));
    };
    worker.postMessage(job);
  });
  return { result, cancel: () => worker?.terminate() };
}

function submit(a: Attempt, interacted: boolean): Promise<SolveResult> {
  const payload = a.key ? encrypt(a.key, JSON.stringify({ signals: signals(interacted), fp: a.fp, probe: a.probe })) : "";
  return post<SolveResult>("/v1/solve", { id: a.ch.id, nonces: a.nonces, payload });
}

// ---------------------------------------------------------------------------
// Flow

let runId = 0;
let retryTimer: number | undefined;
let extendTimer: number | undefined;
let current: Attempt | null = null;

/** Fetch and solve a fresh challenge. Returns null if superseded. */
async function attempt(id: number): Promise<{ a: Attempt; res: SolveResult } | null> {
  const hostname = new URL(parentOrigin!).hostname;
  const ch = await post<Challenge>("/v1/challenge", { sitekey, hostname, action, cdata });
  if (id !== runId) return null;
  const issuedAt = Date.now();
  emit({ type: "mode", mode: ch.mode });

  const probe = runProbe(ch.id);
  const fp = collectFingerprint();
  const solver = startSolve({ salt: ch.salt, puzzles: ch.puzzles, bits: ch.bits });
  const PAT = Symbol("pat");
  const patWin: Promise<typeof PAT> = ch.pat
    ? tryPat(ch.id).then((ok) => (ok ? PAT : new Promise<typeof PAT>(() => {})))
    : new Promise(() => {});
  const winner = await Promise.race([solver.result, patWin]);
  if (winner === PAT) solver.cancel();
  const p = await probe;
  const a: Attempt = {
    ch,
    nonces: winner === PAT ? [] : (winner as number[]),
    fp: await fp,
    probe: p ? p[0] : null,
    key: p ? p.slice(1) : null,
    issuedAt,
  };
  if (id !== runId) return null;
  return { a, res: await submit(a, false) };
}

async function run() {
  const id = ++runId;
  clearTimeout(retryTimer);
  clearTimeout(extendTimer);
  setState("loading", t("verifying"));
  if (!parentOrigin) return fail("no_parent");
  try {
    const r = await attempt(id);
    if (r && id === runId) handle(r.a, r.res);
  } catch (e) {
    if (id === runId) fail(e instanceof CodedError ? e.message : "internal");
  }
}

/**
 * WCAG 2.2.1 (Timing Adjustable): an open checkbox must not expire on the
 * user. Shortly before the challenge would time out, quietly fetch and solve a
 * new one in the background and keep the checkbox as it is.
 */
function scheduleExtend(a: Attempt) {
  clearTimeout(extendTimer);
  const remaining = a.ch.expires_in * 1000 - (Date.now() - a.issuedAt);
  extendTimer = window.setTimeout(async () => {
    emit({ type: "timeout" });
    const id = runId;
    try {
      const r = await attempt(id);
      if (!r || id !== runId || card.dataset.state !== "interactive") return;
      if (r.res.status === "interaction_required") {
        current = r.a;
        scheduleExtend(r.a);
      } else {
        handle(r.a, r.res);
      }
    } catch {
      scheduleExtend(a); // try again later; the box stays usable until it truly expires
    }
  }, Math.max(remaining - 15_000, 1000));
}

function handle(a: Attempt, res: SolveResult) {
  switch (res.status) {
    case "ok":
      clearTimeout(extendTimer);
      setState("success", t("success"));
      emit({
        type: "success",
        token: res.token,
        expiresIn: res.expires_in,
        clearance: res.clearance ? { value: res.clearance.value, maxAge: res.clearance.max_age } : undefined,
      });
      return;
    case "interaction_required":
      current = a;
      setState("interactive", t("verify_human"));
      emit({ type: "interactive" });
      scheduleExtend(a);
      return;
    case "failed":
      clearTimeout(extendTimer);
      if (res.reason === "expired") {
        setState("expired", t("expired"));
        emit({ type: "error", code: "expired" });
      } else {
        fail(res.reason);
      }
  }
}

async function onActivate(ev: Event) {
  if (!ev.isTrusted || card.dataset.state !== "interactive" || !current) return;
  const a = current;
  current = null;
  clearTimeout(extendTimer);
  emit({ type: "interactive_done" });
  setState("loading", t("verifying"));
  try {
    handle(a, await submit(a, true));
  } catch (e) {
    fail(e instanceof CodedError ? e.message : "internal");
  }
}

box.addEventListener("click", (ev) => void onActivate(ev));
box.addEventListener("keydown", (ev) => {
  // Native buttons fire click on Enter/Space; remember it was the keyboard.
  if (ev.key === " " || ev.key === "Enter") keyboardActivation = ev.isTrusted;
});

function fail(code: string) {
  const willRetry = retryMode === "auto" && !FATAL.has(code);
  setState("error", t(ERROR_KEY[code] ?? "generic"));
  emit({ type: "error", code });
  if (willRetry) {
    retryTimer = window.setTimeout(() => {
      label.textContent = t("retrying");
      void run();
    }, retryInterval);
  }
}

retry.addEventListener("click", () => void run());

window.addEventListener("message", (e: MessageEvent<HostMessage>) => {
  if (e.source !== window.parent || e.origin !== parentOrigin) return;
  if (e.data?.__roundabout === 1 && e.data.type === "execute") void run();
});

emit({ type: "ready" });
if (waitForExecute) setState("loading", t("verifying"));
else void run();
