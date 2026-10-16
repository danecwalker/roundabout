use std::env;

use anyhow::{Context, Result};

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub redis_url: String,
    pub bind_addr: String,
    /// Origin the API (and therefore the widget frame) is served from.
    pub public_url: String,
    /// Extra origin always allowed to embed widgets (dashboard dev server).
    pub dashboard_origin: Option<String>,
    pub widget_dir: String,
    pub dashboard_dir: String,
    pub cookie_secure: bool,
    pub allow_signup: bool,
    /// Trust `X-Forwarded-For` for the client IP (only behind a proxy you control).
    pub trust_proxy: bool,
    pub token_ttl_secs: u64,
    pub challenge_ttl_secs: u64,
    /// HMAC key for device and ephemeral IDs.
    pub server_secret: Vec<u8>,
    pub netrep_fetch: bool,
    pub maxmind_asn_db: Option<String>,
    pub maxmind_city_db: Option<String>,
    pub netrep_extra_file: Option<String>,
    pub pat_enabled: bool,
    pub pat_issuer: String,
}

fn opt_var(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn var_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn bool_var(key: &str, default: bool) -> bool {
    env::var(key)
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
        .unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            database_url: env::var("DATABASE_URL").context("DATABASE_URL must be set")?,
            redis_url: var_or("REDIS_URL", "redis://localhost:6379"),
            bind_addr: var_or("BIND_ADDR", "0.0.0.0:8790"),
            public_url: var_or("PUBLIC_URL", "http://localhost:8790")
                .trim_end_matches('/')
                .to_string(),
            dashboard_origin: env::var("DASHBOARD_ORIGIN")
                .ok()
                .filter(|v| !v.is_empty())
                .map(|v| v.trim_end_matches('/').to_string()),
            widget_dir: var_or("WIDGET_DIR", "../widget/dist"),
            dashboard_dir: var_or("DASHBOARD_DIR", "../dashboard/dist"),
            cookie_secure: bool_var("COOKIE_SECURE", false),
            allow_signup: bool_var("ALLOW_SIGNUP", true),
            trust_proxy: bool_var("TRUST_PROXY", false),
            token_ttl_secs: var_or("TOKEN_TTL_SECS", "300").parse().context("TOKEN_TTL_SECS")?,
            challenge_ttl_secs: var_or("CHALLENGE_TTL_SECS", "120")
                .parse()
                .context("CHALLENGE_TTL_SECS")?,
            server_secret: match opt_var("SERVER_SECRET") {
                Some(s) => s.into_bytes(),
                None => {
                    tracing::warn!("SERVER_SECRET not set; using a random key (ephemeral IDs reset on restart)");
                    crate::keys::random_string(64).into_bytes()
                }
            },
            netrep_fetch: bool_var("NETREP_FETCH", true),
            maxmind_asn_db: opt_var("MAXMIND_ASN_DB"),
            maxmind_city_db: opt_var("MAXMIND_CITY_DB"),
            netrep_extra_file: opt_var("NETREP_EXTRA_FILE"),
            pat_enabled: bool_var("PAT_ENABLED", true),
            pat_issuer: var_or("PAT_ISSUER", "demo-pat.issuer.cloudflare.com"),
        })
    }

    /// Origins that may embed any widget regardless of a site's domain list.
    pub fn trusted_embed_origins(&self) -> Vec<String> {
        let mut v = vec![self.public_url.clone()];
        v.extend(self.dashboard_origin.clone());
        v
    }

    pub fn trusted_embed_hosts(&self) -> Vec<String> {
        self.trusted_embed_origins()
            .iter()
            .filter_map(|o| crate::domains::normalize_domain(o))
            .collect()
    }
}
