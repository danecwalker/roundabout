import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex, solvePuzzle } from "../src/sha256.ts";

const ref = (s: string) => createHash("sha256").update(s).digest("hex");

test("matches node:crypto across block boundaries", () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 183]) {
    const s = "x".repeat(len);
    assert.equal(sha256Hex(s), ref(s), `len ${len}`);
  }
  assert.equal(sha256Hex("abc"), ref("abc"));
});

test("solved nonces satisfy the difficulty", () => {
  const salt = "Zq3k9TbPq0aXr2LmN8vYc1Hs7JdWf4Ge";
  for (let i = 0; i < 4; i++) {
    const n = solvePuzzle(salt, i, 12);
    const hex = ref(`${salt}:${i}:${n}`);
    assert.ok(hex.startsWith("000"), `${hex} should have ≥12 zero bits`);
  }
});
