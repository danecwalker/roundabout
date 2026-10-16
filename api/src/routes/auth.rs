use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{FromRequestParts, State},
    http::{request::Parts, StatusCode},
    response::IntoResponse,
    Json,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiJson, ApiResult},
    keys,
    models::User,
    routes::orgs,
    state::AppState,
};

const SESSION_COOKIE: &str = "rb_session";
const SESSION_TTL_SECS: u64 = 60 * 60 * 24 * 7;

/// A signed-in dashboard user (session cookie only; API keys act on an org, not a user).
pub struct AuthUser(pub Uuid);

/// Resolve `Authorization: Bearer rbk_…` to `(org, created_by)`; `None` when no header.
pub async fn api_key_org(st: &AppState, parts: &Parts) -> ApiResult<Option<(Uuid, Option<Uuid>)>> {
    let Some(auth) = parts.headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()) else {
        return Ok(None);
    };
    let token = auth.strip_prefix("Bearer ").ok_or(ApiError::Unauthorized)?.trim();
    if !token.starts_with("rbk_") {
        return Err(ApiError::Unauthorized);
    }
    let row: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 RETURNING org_id, created_by",
    )
    .bind(keys::sha256_hex(token))
    .fetch_optional(&st.db)
    .await?;
    row.map(Some).ok_or(ApiError::Unauthorized)
}

pub async fn session_user(st: &AppState, parts: &Parts) -> ApiResult<Uuid> {
    if parts.headers.contains_key(axum::http::header::AUTHORIZATION) {
        return Err(ApiError::Forbidden("this endpoint requires a dashboard session, not an API key".into()));
    }
    let jar = CookieJar::from_headers(&parts.headers);
    let sid = jar.get(SESSION_COOKIE).ok_or(ApiError::Unauthorized)?.value().to_string();
    let mut conn = st.redis.clone();
    let uid: Option<String> = conn.get(format!("sess:{sid}")).await?;
    uid.and_then(|u| u.parse().ok()).ok_or(ApiError::Unauthorized)
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        session_user(st, parts).await.map(AuthUser)
    }
}

#[derive(Deserialize)]
pub struct Credentials {
    email: String,
    password: String,
    invite: Option<String>,
}

fn validate(c: &Credentials) -> ApiResult<String> {
    let email = c.email.trim().to_ascii_lowercase();
    if email.len() > 254 || !email.contains('@') || email.starts_with('@') || email.ends_with('@') {
        return Err(ApiError::bad_request("enter a valid email address"));
    }
    if c.password.len() < 8 || c.password.len() > 256 {
        return Err(ApiError::bad_request("password must be 8–256 characters"));
    }
    Ok(email)
}

async fn start_session(st: &AppState, jar: CookieJar, user_id: Uuid) -> ApiResult<CookieJar> {
    let sid = keys::random_string(48);
    let mut conn = st.redis.clone();
    let _: () = conn.set_ex(format!("sess:{sid}"), user_id.to_string(), SESSION_TTL_SECS).await?;
    let cookie = Cookie::build((SESSION_COOKIE, sid))
        .path("/")
        .http_only(true)
        .secure(st.cfg.cookie_secure)
        .same_site(SameSite::Strict)
        .max_age(time::Duration::seconds(SESSION_TTL_SECS as i64))
        .build();
    Ok(jar.add(cookie))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct OrgRef {
    id: Uuid,
    name: String,
    role: String,
}

#[derive(Serialize)]
pub struct Me {
    #[serde(flatten)]
    user: User,
    orgs: Vec<OrgRef>,
}

async fn load_me(st: &AppState, uid: Uuid) -> ApiResult<Me> {
    let user: User = sqlx::query_as("SELECT id, email, created_at, is_admin FROM users WHERE id = $1")
        .bind(uid)
        .fetch_optional(&st.db)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let orgs = sqlx::query_as(
        "SELECT o.id, o.name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id \
         WHERE m.user_id = $1 ORDER BY m.created_at, o.id",
    )
    .bind(uid)
    .fetch_all(&st.db)
    .await?;
    Ok(Me { user, orgs })
}

/// Open signup is on, or this is a fresh instance that still needs its first
/// (admin) account, so `ALLOW_SIGNUP=false` can be set from day one.
async fn signup_open(st: &AppState) -> ApiResult<bool> {
    if st.cfg.allow_signup {
        return Ok(true);
    }
    let (has_users,): (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM users)").fetch_one(&st.db).await?;
    Ok(!has_users)
}

#[derive(Serialize)]
pub struct PublicConfig {
    signup_enabled: bool,
}

/// Unauthenticated instance settings the sign-in page needs.
pub async fn config(State(st): State<AppState>) -> ApiResult<Json<PublicConfig>> {
    Ok(Json(PublicConfig { signup_enabled: signup_open(&st).await? }))
}

pub async fn signup(
    State(st): State<AppState>,
    jar: CookieJar,
    ApiJson(c): ApiJson<Credentials>,
) -> ApiResult<impl IntoResponse> {
    let email = validate(&c)?;
    let invite = c.invite.as_deref().filter(|t| !t.is_empty());
    // A valid invite lets someone join even when open signup is off.
    if !signup_open(&st).await? {
        match invite {
            Some(t) if orgs::find_invite(&st.db, t).await?.is_some() => {}
            _ => return Err(ApiError::Forbidden("signups are disabled".into())),
        }
    }
    let password = c.password;
    let hash = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
    })
    .await
    .map_err(anyhow::Error::from)?
    .map_err(|e| anyhow::anyhow!("hash: {e}"))?;

    let mut tx = st.db.begin().await?;
    let uid = Uuid::new_v4();
    // The first account on an instance is its administrator.
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, is_admin) \
         VALUES ($1, $2, $3, NOT EXISTS (SELECT 1 FROM users))",
    )
    .bind(uid)
    .bind(&email)
    .bind(hash)
    .execute(&mut *tx)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(d) if d.is_unique_violation() => {
            ApiError::Conflict("an account with that email already exists".into())
        }
        _ => e.into(),
    })?;
    match invite {
        Some(t) => {
            orgs::redeem_invite_tx(&mut tx, t, uid).await?;
        }
        None => {
            orgs::create_org_tx(&mut tx, "Personal", uid).await?;
        }
    }
    tx.commit().await?;

    let jar = start_session(&st, jar, uid).await?;
    Ok((jar, (StatusCode::CREATED, Json(load_me(&st, uid).await?))))
}

// Verified against when the email is unknown, so response time doesn't reveal
// which accounts exist.
static DUMMY_HASH: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    Argon2::default()
        .hash_password(keys::random_string(32).as_bytes(), &SaltString::generate(&mut OsRng))
        .expect("argon2 hash")
        .to_string()
});

pub async fn login(
    State(st): State<AppState>,
    jar: CookieJar,
    ApiJson(c): ApiJson<Credentials>,
) -> ApiResult<impl IntoResponse> {
    let email = c.email.trim().to_ascii_lowercase();
    let row: Option<(Uuid, String)> = sqlx::query_as("SELECT id, password_hash FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&st.db)
        .await?;
    let (uid, hash) = match &row {
        Some((id, h)) => (Some(*id), h.clone()),
        None => (None, DUMMY_HASH.clone()),
    };
    let password = c.password;
    let ok = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
            .unwrap_or(false)
    })
    .await
    .map_err(anyhow::Error::from)?;

    let uid = uid.filter(|_| ok).ok_or(ApiError::Unauthorized)?;
    if let Some(t) = c.invite.as_deref().filter(|t| !t.is_empty()) {
        let mut tx = st.db.begin().await?;
        orgs::redeem_invite_tx(&mut tx, t, uid).await?;
        tx.commit().await?;
    }
    let jar = start_session(&st, jar, uid).await?;
    Ok((jar, Json(load_me(&st, uid).await?)))
}

pub async fn logout(State(st): State<AppState>, jar: CookieJar) -> ApiResult<impl IntoResponse> {
    if let Some(c) = jar.get(SESSION_COOKIE) {
        let mut conn = st.redis.clone();
        let _: () = conn.del(format!("sess:{}", c.value())).await?;
    }
    Ok((jar.remove(Cookie::build(SESSION_COOKIE).path("/")), StatusCode::NO_CONTENT))
}

pub async fn me(State(st): State<AppState>, AuthUser(uid): AuthUser) -> ApiResult<Json<Me>> {
    Ok(Json(load_me(&st, uid).await?))
}
