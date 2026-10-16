use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

pub const MODES: [&str; 3] = ["managed", "non_interactive", "invisible"];

/// Columns selected for `Site` (everything except the secret hash).
pub const SITE_COLUMNS: &str =
    "id, name, sitekey, domains, mode, difficulty, created_at, updated_at, previous_secret_expires_at, \
     clearance_enabled, clearance_ttl_secs";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Site {
    pub id: Uuid,
    pub name: String,
    pub sitekey: String,
    pub domains: Vec<String>,
    pub mode: String,
    pub difficulty: i16,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Set while a rotated-out secret is still accepted.
    pub previous_secret_expires_at: Option<DateTime<Utc>>,
    pub clearance_enabled: bool,
    pub clearance_ttl_secs: i32,
}

impl Site {
    pub async fn by_sitekey(db: &PgPool, sitekey: &str) -> sqlx::Result<Option<Site>> {
        sqlx::query_as(&format!("SELECT {SITE_COLUMNS} FROM sites WHERE sitekey = $1"))
            .bind(sitekey)
            .fetch_optional(db)
            .await
    }

    pub async fn by_secret(db: &PgPool, secret: &str) -> sqlx::Result<Option<Site>> {
        // The previous secret keeps working until its grace period ends.
        sqlx::query_as(&format!(
            "SELECT {SITE_COLUMNS} FROM sites WHERE secret_hash = $1 \
             OR (previous_secret_hash = $1 AND previous_secret_expires_at > now()) LIMIT 1"
        ))
            .bind(crate::keys::sha256_hex(secret))
            .fetch_optional(db)
            .await
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub created_at: DateTime<Utc>,
    pub is_admin: bool,
}
