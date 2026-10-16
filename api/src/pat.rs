//! Private Access Tokens (Privacy Pass, RFC 9576/9577/9578).
//!
//! Apple devices (and other attesters) can prove "this is a real, unmodified
//! device in good standing" without revealing identity. We act as the origin:
//! the frame requests `/v1/pat/{challenge}`, we answer 401 with a
//! `WWW-Authenticate: PrivateToken` challenge naming a public issuer, and a
//! supporting browser fetches a token from that issuer (via its attester) and
//! retries with `Authorization: PrivateToken token=...`. We verify the token's
//! blind-RSA signature against the issuer's published key.
//!
//! Only token type 0x0002 (Blind RSA 2048, RSABSSA-SHA384-PSS-Deterministic) is
//! supported, which is what Apple's attester and the public issuers use.

use std::{
    sync::{Arc, RwLock},
    time::Duration,
};

use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use rsa::{
    pkcs1::DecodeRsaPublicKey,
    pkcs8::spki::{der::Decode, SubjectPublicKeyInfoRef},
    pss::{Signature, VerifyingKey},
    signature::Verifier,
    traits::PublicKeyParts,
    RsaPublicKey,
};
use serde::Deserialize;
use sha2::{Digest, Sha256, Sha384};

pub const TOKEN_TYPE_BLIND_RSA: u16 = 0x0002;
const NK: usize = 256;

#[derive(Clone)]
pub struct IssuerKey {
    /// SPKI DER bytes exactly as published (also sent as `token-key`).
    pub spki: Vec<u8>,
    pub key_id: [u8; 32],
    pub public: RsaPublicKey,
}

impl IssuerKey {
    pub fn from_spki(spki: Vec<u8>) -> anyhow::Result<Self> {
        // The SPKI uses the id-RSASSA-PSS OID, which the `rsa` crate's SPKI
        // decoder rejects, so pull the PKCS#1 key out of the BIT STRING.
        let info = SubjectPublicKeyInfoRef::from_der(&spki).map_err(|e| anyhow::anyhow!("spki: {e}"))?;
        let pkcs1 = info.subject_public_key.raw_bytes();
        let public = RsaPublicKey::from_pkcs1_der(pkcs1).map_err(|e| anyhow::anyhow!("pkcs1: {e}"))?;
        anyhow::ensure!(public.size() == NK, "unsupported modulus size {}", public.size());
        let key_id = Sha256::digest(&spki).into();
        Ok(Self { spki, key_id, public })
    }
}

/// RFC 9577 §2.1 TokenChallenge.
pub fn build_challenge(issuer_name: &str, redemption_context: &[u8; 32], origin_info: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(2 + 2 + issuer_name.len() + 1 + 32 + 2 + origin_info.len());
    v.extend_from_slice(&TOKEN_TYPE_BLIND_RSA.to_be_bytes());
    v.extend_from_slice(&(issuer_name.len() as u16).to_be_bytes());
    v.extend_from_slice(issuer_name.as_bytes());
    v.push(32);
    v.extend_from_slice(redemption_context);
    v.extend_from_slice(&(origin_info.len() as u16).to_be_bytes());
    v.extend_from_slice(origin_info.as_bytes());
    v
}

pub fn www_authenticate(challenge: &[u8], key: &IssuerKey) -> String {
    format!(
        "PrivateToken challenge=\"{}\", token-key=\"{}\"",
        URL_SAFE.encode(challenge),
        URL_SAFE.encode(&key.spki)
    )
}

/// Extract the token from `Authorization: PrivateToken token="..."`.
pub fn parse_authorization(header: &str) -> Option<Vec<u8>> {
    let rest = header.trim().strip_prefix("PrivateToken")?.trim();
    let value = rest.split(',').map(str::trim).find_map(|p| p.strip_prefix("token="))?;
    let value = value.trim_matches('"');
    URL_SAFE
        .decode(value)
        .or_else(|_| URL_SAFE_NO_PAD.decode(value.trim_end_matches('=')))
        .ok()
}

/// RFC 9577 §2.2 Token verification.
pub fn verify_token(token: &[u8], challenge: &[u8], keys: &[IssuerKey]) -> bool {
    if token.len() != 2 + 32 + 32 + 32 + NK {
        return false;
    }
    if u16::from_be_bytes([token[0], token[1]]) != TOKEN_TYPE_BLIND_RSA {
        return false;
    }
    let challenge_digest: [u8; 32] = Sha256::digest(challenge).into();
    if token[34..66] != challenge_digest {
        return false;
    }
    let key_id = &token[66..98];
    let Some(key) = keys.iter().find(|k| k.key_id == key_id) else { return false };
    let Ok(sig) = Signature::try_from(&token[98..]) else { return false };
    VerifyingKey::<Sha384>::new_with_salt_len(key.public.clone(), 48)
        .verify(&token[..98], &sig)
        .is_ok()
}

#[derive(Deserialize)]
struct Directory {
    #[serde(rename = "token-keys")]
    token_keys: Vec<DirectoryKey>,
}

#[derive(Deserialize)]
struct DirectoryKey {
    #[serde(rename = "token-type")]
    token_type: u16,
    #[serde(rename = "token-key")]
    token_key: String,
    #[serde(rename = "not-before", default)]
    not_before: Option<i64>,
}

pub struct PatIssuer {
    pub name: String,
    keys: RwLock<Vec<IssuerKey>>,
}

impl PatIssuer {
    pub fn new(name: String) -> Self {
        Self { name, keys: RwLock::new(Vec::new()) }
    }

    pub fn keys(&self) -> Vec<IssuerKey> {
        self.keys.read().unwrap().clone()
    }

    /// The newest currently-valid key, advertised in challenges.
    pub fn current_key(&self) -> Option<IssuerKey> {
        self.keys.read().unwrap().first().cloned()
    }

    async fn refresh(&self, http: &reqwest::Client) -> anyhow::Result<usize> {
        let url = format!("https://{}/.well-known/private-token-issuer-directory", self.name);
        let dir: Directory = http.get(url).send().await?.error_for_status()?.json().await?;
        let now = chrono::Utc::now().timestamp();
        let mut entries: Vec<_> = dir
            .token_keys
            .into_iter()
            .filter(|k| k.token_type == TOKEN_TYPE_BLIND_RSA && k.not_before.is_none_or(|nb| nb <= now))
            .collect();
        entries.sort_by_key(|k| std::cmp::Reverse(k.not_before.unwrap_or(0)));
        let mut keys = Vec::new();
        for k in entries {
            let der = URL_SAFE.decode(&k.token_key).or_else(|_| URL_SAFE_NO_PAD.decode(k.token_key.trim_end_matches('=')))?;
            match IssuerKey::from_spki(der) {
                Ok(key) => keys.push(key),
                Err(e) => tracing::warn!("pat: skipping issuer key: {e}"),
            }
        }
        let n = keys.len();
        if n > 0 {
            *self.keys.write().unwrap() = keys;
        }
        Ok(n)
    }

    pub fn spawn_refresh(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("http client");
            loop {
                match me.refresh(&http).await {
                    Ok(n) => tracing::info!("pat: loaded {n} key(s) from issuer {}", me.name),
                    Err(e) => tracing::warn!("pat: issuer directory fetch failed: {e}"),
                }
                tokio::time::sleep(Duration::from_secs(12 * 3600)).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::{
        pkcs1::EncodeRsaPublicKey,
        pss::BlindedSigningKey,
        signature::{RandomizedSigner, SignatureEncoding},
        RsaPrivateKey,
    };

    /// Build an SPKI with the id-RSASSA-PSS OID (1.2.840.113549.1.1.10) like real issuers publish.
    fn pss_spki(public: &RsaPublicKey) -> Vec<u8> {
        use rsa::pkcs8::spki::{der::{asn1::BitStringRef, Encode}, AlgorithmIdentifierRef, ObjectIdentifier};
        let pkcs1 = public.to_pkcs1_der().unwrap();
        let spki = rsa::pkcs8::spki::SubjectPublicKeyInfo {
            algorithm: AlgorithmIdentifierRef {
                oid: ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.10"),
                parameters: None,
            },
            subject_public_key: BitStringRef::from_bytes(pkcs1.as_bytes()).unwrap(),
        };
        spki.to_der().unwrap()
    }

    #[test]
    fn token_roundtrip() {
        let mut rng = rand::thread_rng();
        let sk = RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let key = IssuerKey::from_spki(pss_spki(&sk.to_public_key())).unwrap();

        let ctx = [7u8; 32];
        let challenge = build_challenge("issuer.example", &ctx, "challenges.example.com");
        let mut msg = Vec::new();
        msg.extend_from_slice(&TOKEN_TYPE_BLIND_RSA.to_be_bytes());
        msg.extend_from_slice(&[1u8; 32]); // nonce
        msg.extend_from_slice(&Sha256::digest(&challenge));
        msg.extend_from_slice(&key.key_id);
        // A blind-RSA signature unblinds to a standard PSS signature over the message.
        let signer = BlindedSigningKey::<Sha384>::new_with_salt_len(sk, 48);
        let sig = signer.sign_with_rng(&mut rng, &msg).to_vec();
        let token = [msg.clone(), sig].concat();

        let keys = vec![key.clone()];
        assert!(verify_token(&token, &challenge, &keys));

        let header = format!("PrivateToken token=\"{}\"", URL_SAFE.encode(&token));
        assert_eq!(parse_authorization(&header).unwrap(), token);

        let other = build_challenge("issuer.example", &[8u8; 32], "challenges.example.com");
        assert!(!verify_token(&token, &other, &keys), "bound to the challenge");
        let mut tampered = token.clone();
        tampered[5] ^= 1;
        assert!(!verify_token(&tampered, &challenge, &keys), "nonce is signed");

        let hdr = www_authenticate(&challenge, &key);
        assert!(hdr.starts_with("PrivateToken challenge=\"AAI"));
    }
}
