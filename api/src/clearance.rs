//! Pre-clearance: a successful solve on a site with clearance enabled also
//! yields a signed `rb_clearance` cookie for the customer's domain. Reverse
//! proxies and middleware let the visitor through without re-challenging,
//! verifying either offline (Ed25519 public keys at `/v1/clearance/keys`) or
//! via `/v1/clearance/check` (nginx `auth_request`, Caddy `forward_auth`).
//!
//! Token: `rbc1.<b64url(payload)>.<b64url(sig)>`, where `sig` is Ed25519 over
//! `rbc1.<b64url(payload)>` and the payload is
//! `{v, kid, s: sitekey, h: hostname, u: uaHash, iat, exp}`.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;

pub const COOKIE_NAME: &str = "rb_clearance";
const PREFIX: &str = "rbc1";
const LEEWAY_SECS: i64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Payload {
    pub v: u8,
    pub kid: String,
    pub s: String,
    pub h: String,
    pub u: String,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    Malformed,
    UnknownKey,
    BadSignature,
    WrongSite,
    WrongHost,
    WrongUserAgent,
    Expired,
    NotYetValid,
}

impl Reject {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::UnknownKey => "unknown_key",
            Self::BadSignature => "bad_signature",
            Self::WrongSite => "wrong_site",
            Self::WrongHost => "wrong_host",
            Self::WrongUserAgent => "wrong_user_agent",
            Self::Expired => "expired",
            Self::NotYetValid => "not_yet_valid",
        }
    }
}

/// First 12 bytes of SHA-256(User-Agent), base64url (16 chars).
pub fn ua_hash(user_agent: &str) -> String {
    URL_SAFE_NO_PAD.encode(&Sha256::digest(user_agent.as_bytes())[..12])
}

pub struct ClearanceSigner {
    kid: String,
    key: SigningKey,
}

impl ClearanceSigner {
    /// Load the newest clearance key, creating one on first boot.
    pub async fn load_or_create(db: &PgPool) -> anyhow::Result<Self> {
        let row: Option<(String, Vec<u8>)> = sqlx::query_as(
            "SELECT kid, secret FROM server_keys WHERE purpose = 'clearance' ORDER BY created_at DESC LIMIT 1",
        )
        .fetch_optional(db)
        .await?;
        if let Some((kid, secret)) = row {
            let bytes: [u8; 32] = secret.as_slice().try_into().map_err(|_| anyhow::anyhow!("bad clearance key length"))?;
            return Ok(Self { kid, key: SigningKey::from_bytes(&bytes) });
        }
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        let kid = format!("rbk1-{}", &crate::keys::random_string(10));
        sqlx::query("INSERT INTO server_keys (kid, purpose, secret) VALUES ($1, 'clearance', $2) ON CONFLICT DO NOTHING")
            .bind(&kid)
            .bind(key.to_bytes().to_vec())
            .execute(db)
            .await?;
        tracing::info!("generated clearance signing key {kid}");
        Ok(Self { kid, key })
    }

    #[cfg(test)]
    pub fn for_tests() -> Self {
        Self { kid: "test".into(), key: SigningKey::generate(&mut rand::rngs::OsRng) }
    }

    pub fn issue(&self, sitekey: &str, hostname: &str, user_agent: &str, ttl_secs: i64) -> String {
        let now = chrono::Utc::now().timestamp();
        let payload = Payload {
            v: 1,
            kid: self.kid.clone(),
            s: sitekey.to_string(),
            h: hostname.to_string(),
            u: ua_hash(user_agent),
            iat: now,
            exp: now + ttl_secs,
        };
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("payload json"));
        let signed = format!("{PREFIX}.{body}");
        let sig = self.key.sign(signed.as_bytes());
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    pub fn verify(&self, token: &str, sitekey: &str, hostname: &str, user_agent: Option<&str>) -> Result<Payload, Reject> {
        let mut parts = token.trim().split('.');
        let (Some(PREFIX), Some(body), Some(sig), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
            return Err(Reject::Malformed);
        };
        let payload: Payload = URL_SAFE_NO_PAD
            .decode(body)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or(Reject::Malformed)?;
        if payload.kid != self.kid {
            return Err(Reject::UnknownKey);
        }
        let sig = URL_SAFE_NO_PAD
            .decode(sig)
            .ok()
            .and_then(|b| Signature::from_slice(&b).ok())
            .ok_or(Reject::Malformed)?;
        self.key
            .verifying_key()
            .verify(format!("{PREFIX}.{body}").as_bytes(), &sig)
            .map_err(|_| Reject::BadSignature)?;
        if payload.s != sitekey {
            return Err(Reject::WrongSite);
        }
        let host = crate::domains::normalize_domain(hostname).unwrap_or_default();
        if payload.h != host {
            return Err(Reject::WrongHost);
        }
        if let Some(ua) = user_agent {
            if payload.u != ua_hash(ua) {
                return Err(Reject::WrongUserAgent);
            }
        }
        let now = chrono::Utc::now().timestamp();
        if payload.exp <= now {
            return Err(Reject::Expired);
        }
        if payload.iat > now + LEEWAY_SECS {
            return Err(Reject::NotYetValid);
        }
        Ok(payload)
    }

    /// JWKS for offline verification.
    pub fn jwks(&self) -> serde_json::Value {
        let vk: VerifyingKey = self.key.verifying_key();
        serde_json::json!({
            "keys": [{
                "kid": self.kid,
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "use": "sig",
                "x": URL_SAFE_NO_PAD.encode(vk.to_bytes()),
            }]
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_and_verify() {
        let s = ClearanceSigner::for_tests();
        let ua = "Mozilla/5.0 test";
        let t = s.issue("rk_abc", "shop.example.com", ua, 600);
        assert!(t.starts_with("rbc1."));
        assert!(s.verify(&t, "rk_abc", "Shop.Example.com:443", Some(ua)).is_ok());
        assert_eq!(s.verify(&t, "rk_other", "shop.example.com", Some(ua)), Err(Reject::WrongSite));
        assert_eq!(s.verify(&t, "rk_abc", "evil.io", Some(ua)), Err(Reject::WrongHost));
        assert_eq!(s.verify(&t, "rk_abc", "shop.example.com", Some("curl/8")), Err(Reject::WrongUserAgent));
        assert!(s.verify(&t, "rk_abc", "shop.example.com", None).is_ok());

        let expired = s.issue("rk_abc", "shop.example.com", ua, -1);
        assert_eq!(s.verify(&expired, "rk_abc", "shop.example.com", Some(ua)), Err(Reject::Expired));

        let mut tampered = t.clone();
        let i = tampered.len() - 3;
        tampered.replace_range(i..i + 1, if &t[i..i + 1] == "A" { "B" } else { "A" });
        assert!(matches!(s.verify(&tampered, "rk_abc", "shop.example.com", Some(ua)), Err(Reject::BadSignature | Reject::Malformed)));
        assert_eq!(s.verify("garbage", "rk_abc", "x", None), Err(Reject::Malformed));
        assert_eq!(ua_hash(ua).len(), 16);
    }
}
