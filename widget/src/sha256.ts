// Minimal synchronous SHA-256 tuned for the proof-of-work loop: no allocation
// per hash, and it only needs the leading-zero-bit count of the digest.
// crypto.subtle is async-only and far too slow for millions of tiny hashes.

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const W = new Int32Array(64);
const H = new Int32Array(8);
const pad = new Uint8Array(192);

function compress(buf: Uint8Array, off: number): void {
  for (let i = 0; i < 16; i++) {
    const j = off + i * 4;
    W[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const w15 = W[i - 15];
    const w2 = W[i - 2];
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}

/** Hash `msg[0..len]` into the shared state `H`. Messages up to 183 bytes. */
function digest(msg: Uint8Array, len: number): Int32Array {
  for (let i = 0; i < 8; i++) H[i] = H0[i];
  const blocks = ((len + 8) >> 6) + 1;
  pad.fill(0, 0, blocks * 64);
  pad.set(msg.subarray(0, len));
  pad[len] = 0x80;
  const bitLen = len * 8;
  const end = blocks * 64;
  pad[end - 4] = (bitLen >>> 24) & 0xff;
  pad[end - 3] = (bitLen >>> 16) & 0xff;
  pad[end - 2] = (bitLen >>> 8) & 0xff;
  pad[end - 1] = bitLen & 0xff;
  for (let b = 0; b < blocks; b++) compress(pad, b * 64);
  return H;
}

export function leadingZeroBits(msg: Uint8Array, len: number): number {
  const h = digest(msg, len);
  let n = 0;
  for (let i = 0; i < 8; i++) {
    if (h[i] === 0) {
      n += 32;
      continue;
    }
    return n + Math.clz32(h[i]);
  }
  return n;
}

/** SHA-256 of a short (≤183 byte) string, as bytes. */
export function sha256Bytes(str: string): Uint8Array {
  const bytes = new TextEncoder().encode(str);
  const h = digest(bytes, bytes.length);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = h[i] >>> 24;
    out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
    out[i * 4 + 3] = h[i] & 0xff;
  }
  return out;
}

export function sha256Hex(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const h = digest(bytes, bytes.length);
  let out = "";
  for (let i = 0; i < 8; i++) out += (h[i] >>> 0).toString(16).padStart(8, "0");
  return out;
}

/** Find the smallest nonce n with SHA-256("{salt}:{index}:{n}") having ≥ bits leading zeros. */
export function solvePuzzle(salt: string, index: number, bits: number): number {
  const prefix = new TextEncoder().encode(`${salt}:${index}:`);
  const buf = new Uint8Array(prefix.length + 16);
  buf.set(prefix);
  const digits = new Uint8Array(16);
  for (let n = 0; n < Number.MAX_SAFE_INTEGER; n++) {
    // Write n's decimal digits after the prefix.
    let len = 0;
    let x = n;
    do {
      digits[len++] = 48 + (x % 10);
      x = Math.floor(x / 10);
    } while (x > 0);
    for (let i = 0; i < len; i++) buf[prefix.length + i] = digits[len - 1 - i];
    if (leadingZeroBits(buf, prefix.length + len) >= bits) return n;
  }
  throw new Error("nonce space exhausted");
}
