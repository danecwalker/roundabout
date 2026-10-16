import type { IncomingMessage, ServerResponse } from "node:http";

/** Decoded clearance payload, as signed by the Roundabout API. */
export interface ClearancePayload {
  v: 1;
  /** Signing key ID. */
  kid: string;
  /** Sitekey the clearance was issued for. */
  s: string;
  /** Hostname the clearance was issued on. */
  h: string;
  /** `uaHash(User-Agent)` of the browser that solved the challenge. */
  u: string;
  /** Issued at (unix seconds). */
  iat: number;
  /** Expires at (unix seconds). */
  exp: number;
}

export interface Jwk {
  kid: string;
  kty: "OKP";
  crv: "Ed25519";
  /** base64url public key. */
  x: string;
  alg?: "EdDSA";
  use?: "sig";
}

export interface Jwks {
  keys: Jwk[];
}

export type VerifyFailureReason =
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "wrong_site"
  | "wrong_host"
  | "wrong_user_agent"
  | "expired"
  | "not_yet_valid";

export type VerifyResult =
  | { ok: true; payload: ClearancePayload }
  | { ok: false; reason: VerifyFailureReason };

export interface VerifyOptions {
  sitekey: string;
  /** Request hostname; port and trailing dot are ignored, case-insensitive. */
  hostname: string;
  userAgent: string;
  /** Current time in unix seconds (default: now). */
  now?: number;
  /** Clock-skew allowance for `iat`/`exp` in seconds (default 60). */
  leewaySecs?: number;
}

export interface ParsedClearance {
  payload: ClearancePayload;
  /** `rbc1.<payload>`: the bytes the signature covers. */
  signedPart: string;
  signature: Buffer;
}

/** base64url (no padding) of the first 12 bytes of SHA-256(userAgent): 16 characters. */
export function uaHash(userAgent: string): string;

/** Split and decode a clearance value without verifying it. */
export function parseClearance(value: unknown): ParsedClearance | null;

/** Verify a clearance value against a known key set. */
export function verifyWithKeys(value: unknown, jwks: Jwks | Jwk[], opts: VerifyOptions): VerifyResult;

/** Only same-origin relative paths (`/x`, not `//x` or `/\x`) are returned; anything else becomes `/`. */
export function safeReturnPath(target: unknown): string;

export interface VerifierOptions {
  /** Roundabout origin, e.g. `https://challenges.example.com`. */
  endpoint: string;
  sitekey: string;
  /** How long fetched keys are trusted before refetching (default 1 hour). */
  cacheTtlMs?: number;
  /** Custom fetch implementation (default: global fetch). */
  fetch?: typeof globalThis.fetch;
  /** Clock in milliseconds, for tests (default: Date.now). */
  now?: () => number;
}

export interface Verifier {
  /**
   * Verify a clearance value. Fetches `{endpoint}/v1/clearance/keys` on first
   * use and caches them; an unknown `kid` triggers a refetch at most once a minute.
   * Rejects if no keys have ever been fetched successfully.
   */
  verify(value: unknown, ctx: { hostname: string; userAgent: string }): Promise<VerifyResult>;
}

export function createVerifier(options: VerifierOptions): Verifier;

export interface GateOptions {
  endpoint: string;
  sitekey: string;
  /** Cookie holding the clearance (default `rb_clearance`). */
  cookieName?: string;
  /** Path the interstitial page is served on (default `/__roundabout/gate`). */
  gatePath?: string;
  /** Return true to let a request through without a clearance (health checks, webhooks, assets). */
  exclude?: (req: IncomingMessage & { originalUrl?: string }) => boolean;
  /** Override the verifier (default: `createVerifier({ endpoint, sitekey })`). */
  verifier?: Pick<Verifier, "verify">;
}

/**
 * Connect/Express-compatible middleware. A valid clearance cookie continues to
 * `next()`; browsers (GET/HEAD accepting HTML) are redirected to the
 * interstitial; everything else gets `403 {"error":"clearance_required"}`.
 */
export function gate(
  options: GateOptions,
): (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: (err?: unknown) => void) => Promise<void>;
