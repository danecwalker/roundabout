use rand::{distributions::Alphanumeric, Rng};
use sha2::{Digest, Sha256};

/// Cryptographically secure random alphanumeric string (`thread_rng` is ChaCha-based).
pub fn random_string(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

pub fn new_sitekey() -> String {
    format!("rk_{}", random_string(22))
}

pub fn new_secret() -> String {
    format!("rs_{}", random_string(40))
}

pub fn new_token() -> String {
    format!("rt_{}", random_string(64))
}

pub fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// Dummy keys for automated tests, mirroring Turnstile's testing keys.
pub mod test_keys {
    pub const SITEKEY_PASS: &str = "rk_test_pass";
    pub const SITEKEY_FAIL: &str = "rk_test_fail";
    pub const SITEKEY_INTERACTIVE: &str = "rk_test_interactive";
    pub const SECRET_PASS: &str = "rs_test_pass";
    pub const SECRET_FAIL: &str = "rs_test_fail";
    /// Always answers `timeout-or-duplicate`, as if the token were already redeemed.
    pub const SECRET_SPENT: &str = "rs_test_spent";

    #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum TestSite {
        Pass,
        Fail,
        Interactive,
    }

    pub fn sitekey(key: &str) -> Option<TestSite> {
        match key {
            SITEKEY_PASS => Some(TestSite::Pass),
            SITEKEY_FAIL => Some(TestSite::Fail),
            SITEKEY_INTERACTIVE => Some(TestSite::Interactive),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_shapes() {
        assert!(new_sitekey().starts_with("rk_") && new_sitekey().len() == 25);
        assert!(new_secret().starts_with("rs_") && new_secret().len() == 43);
        assert_ne!(new_token(), new_token());
    }
}
