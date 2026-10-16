//! Proof-of-work puzzles.
//!
//! A challenge of difficulty `d` is split into `PUZZLES` independent puzzles of
//! `d - log2(PUZZLES)` bits each. Total expected work stays ~2^d hashes, but
//! splitting it cuts the variance of solve time, so slow outliers are rarer.
//!
//! Puzzle `i` is solved by a nonce `n` where `SHA-256("{salt}:{i}:{n}")` has at
//! least `bits` leading zero bits.

use sha2::{Digest, Sha256};

pub const PUZZLES: usize = 4;
const PUZZLES_LOG2: u8 = 2;

/// Upper bound accepted for nonces; the JS solver works with safe integers.
const MAX_NONCE: u64 = (1 << 53) - 1;

pub fn puzzle_bits(difficulty: u8) -> u8 {
    difficulty.saturating_sub(PUZZLES_LOG2).max(1)
}

pub fn leading_zero_bits(hash: &[u8]) -> u32 {
    let mut n = 0;
    for b in hash {
        if *b == 0 {
            n += 8;
        } else {
            n += b.leading_zeros();
            break;
        }
    }
    n
}

pub fn check(salt: &str, index: usize, nonce: u64, bits: u8) -> bool {
    let h = Sha256::digest(format!("{salt}:{index}:{nonce}").as_bytes());
    leading_zero_bits(&h) >= u32::from(bits)
}

pub fn verify(salt: &str, bits: u8, nonces: &[u64]) -> bool {
    nonces.len() == PUZZLES
        && nonces
            .iter()
            .enumerate()
            .all(|(i, &n)| n <= MAX_NONCE && check(salt, i, n, bits))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solve(salt: &str, bits: u8) -> Vec<u64> {
        (0..PUZZLES)
            .map(|i| (0..).find(|&n| check(salt, i, n, bits)).unwrap())
            .collect()
    }

    #[test]
    fn leading_zeros() {
        assert_eq!(leading_zero_bits(&[0, 0, 0x0f]), 20);
        assert_eq!(leading_zero_bits(&[0x80]), 0);
        assert_eq!(leading_zero_bits(&[0, 0x01]), 15);
    }

    #[test]
    fn solves_and_verifies() {
        let salt = "abc123";
        let nonces = solve(salt, 8);
        assert!(verify(salt, 8, &nonces));
        // Solutions are bound to the salt.
        let other = solve("other", 8);
        assert!(verify("other", 8, &other));
    }

    #[test]
    fn rejects_wrong_count_and_bad_nonce() {
        let salt = "xyz";
        let mut nonces = solve(salt, 10);
        assert!(!verify(salt, 10, &nonces[..3]));
        // Find a nonce that definitely fails puzzle 0.
        nonces[0] = (0..).find(|&n| !check(salt, 0, n, 10)).unwrap();
        assert!(!verify(salt, 10, &nonces));
    }

    #[test]
    fn bits_split() {
        assert_eq!(puzzle_bits(16), 14);
        assert_eq!(puzzle_bits(1), 1);
    }
}
