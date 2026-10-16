use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    domains,
    error::{ApiError, ApiJson, ApiResult},
    keys,
    models::{Site, MODES, SITE_COLUMNS},
    routes::{
        orgs::{OrgCtx, Role},
        siteverify::{verify_token, VerifyResult},
    },
    state::AppState,
};

fn validate_name(name: &str) -> ApiResult<String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 100 {
        return Err(ApiError::bad_request("name must be 1–100 characters"));
    }
    Ok(n.to_string())
}

fn validate_domains(input: &[String]) -> ApiResult<Vec<String>> {
    if input.is_empty() {
        return Err(ApiError::bad_request("add at least one domain"));
    }
    let mut out: Vec<String> = Vec::with_capacity(input.len());
    for d in input {
        // `*` (any hostname) subsumes everything else.
        if d.trim() == domains::ANY_HOST {
            return Ok(vec![domains::ANY_HOST.to_string()]);
        }
        let n = domains::normalize_domain(d).ok_or_else(|| ApiError::bad_request(format!("invalid domain: {d}")))?;
        if !out.contains(&n) {
            out.push(n);
        }
    }
    Ok(out)
}

fn validate_mode(mode: &str) -> ApiResult<()> {
    if MODES.contains(&mode) {
        Ok(())
    } else {
        Err(ApiError::bad_request("mode must be managed, non_interactive or invisible"))
    }
}

fn validate_clearance_ttl(t: i32) -> ApiResult<()> {
    if (300..=86_400).contains(&t) {
        Ok(())
    } else {
        Err(ApiError::bad_request("clearance_ttl_secs must be between 300 and 86400"))
    }
}

fn validate_difficulty(d: i16) -> ApiResult<()> {
    if (8..=24).contains(&d) {
        Ok(())
    } else {
        Err(ApiError::bad_request("difficulty must be between 8 and 24"))
    }
}

async fn owned_site(st: &AppState, org: Uuid, id: Uuid) -> ApiResult<Site> {
    sqlx::query_as(&format!("SELECT {SITE_COLUMNS} FROM sites WHERE id = $1 AND org_id = $2"))
        .bind(id)
        .bind(org)
        .fetch_optional(&st.db)
        .await?
        .ok_or(ApiError::NotFound)
}

pub async fn list(State(st): State<AppState>, ctx: OrgCtx) -> ApiResult<Json<Vec<Site>>> {
    ctx.require(Role::Viewer)?;
    let uid = ctx.org_id;
    let sites = sqlx::query_as(&format!(
        "SELECT {SITE_COLUMNS} FROM sites WHERE org_id = $1 ORDER BY created_at DESC"
    ))
    .bind(uid)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(sites))
}

#[derive(Deserialize)]
pub struct CreateSite {
    name: String,
    domains: Vec<String>,
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_difficulty")]
    difficulty: i16,
    #[serde(default)]
    clearance_enabled: bool,
    #[serde(default = "default_clearance_ttl")]
    clearance_ttl_secs: i32,
}

fn default_clearance_ttl() -> i32 {
    1800
}

fn default_mode() -> String {
    "managed".into()
}

fn default_difficulty() -> i16 {
    16
}

#[derive(Serialize)]
pub struct SiteWithSecret {
    site: Site,
    secret: String,
}

pub async fn create(
    State(st): State<AppState>,
    ctx: OrgCtx,
    ApiJson(req): ApiJson<CreateSite>,
) -> ApiResult<(StatusCode, Json<SiteWithSecret>)> {
    ctx.require(Role::Member)?;
    let uid = ctx.org_id;
    let name = validate_name(&req.name)?;
    let domains = validate_domains(&req.domains)?;
    validate_mode(&req.mode)?;
    validate_difficulty(req.difficulty)?;
    validate_clearance_ttl(req.clearance_ttl_secs)?;
    let secret = keys::new_secret();
    let site: Site = sqlx::query_as(&format!(
        "INSERT INTO sites (id, org_id, name, sitekey, secret_hash, domains, mode, difficulty, \
         clearance_enabled, clearance_ttl_secs) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING {SITE_COLUMNS}"
    ))
    .bind(Uuid::new_v4())
    .bind(uid)
    .bind(name)
    .bind(keys::new_sitekey())
    .bind(keys::sha256_hex(&secret))
    .bind(domains)
    .bind(req.mode)
    .bind(req.difficulty)
    .bind(req.clearance_enabled)
    .bind(req.clearance_ttl_secs)
    .fetch_one(&st.db)
    .await?;
    Ok((StatusCode::CREATED, Json(SiteWithSecret { site, secret })))
}

pub async fn get(
    State(st): State<AppState>,
    ctx: OrgCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Site>> {
    ctx.require(Role::Viewer)?;
    let uid = ctx.org_id;
    Ok(Json(owned_site(&st, uid, id).await?))
}

#[derive(Deserialize)]
pub struct UpdateSite {
    name: Option<String>,
    domains: Option<Vec<String>>,
    mode: Option<String>,
    difficulty: Option<i16>,
    clearance_enabled: Option<bool>,
    clearance_ttl_secs: Option<i32>,
}

pub async fn update(
    State(st): State<AppState>,
    ctx: OrgCtx,
    Path(id): Path<Uuid>,
    ApiJson(req): ApiJson<UpdateSite>,
) -> ApiResult<Json<Site>> {
    ctx.require(Role::Member)?;
    let uid = ctx.org_id;
    let name = req.name.as_deref().map(validate_name).transpose()?;
    let domains = req.domains.as_deref().map(validate_domains).transpose()?;
    if let Some(m) = &req.mode {
        validate_mode(m)?;
    }
    if let Some(d) = req.difficulty {
        validate_difficulty(d)?;
    }
    if let Some(t) = req.clearance_ttl_secs {
        validate_clearance_ttl(t)?;
    }
    let site: Option<Site> = sqlx::query_as(&format!(
        "UPDATE sites SET name = COALESCE($3, name), domains = COALESCE($4, domains), \
         mode = COALESCE($5, mode), difficulty = COALESCE($6, difficulty), \
         clearance_enabled = COALESCE($7, clearance_enabled), clearance_ttl_secs = COALESCE($8, clearance_ttl_secs), \
         updated_at = now() \
         WHERE id = $1 AND org_id = $2 RETURNING {SITE_COLUMNS}"
    ))
    .bind(id)
    .bind(uid)
    .bind(name)
    .bind(domains)
    .bind(req.mode)
    .bind(req.difficulty)
    .bind(req.clearance_enabled)
    .bind(req.clearance_ttl_secs)
    .fetch_optional(&st.db)
    .await?;
    site.map(Json).ok_or(ApiError::NotFound)
}

pub async fn delete(
    State(st): State<AppState>,
    ctx: OrgCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    ctx.require(Role::Admin)?;
    let uid = ctx.org_id;
    let res = sqlx::query("DELETE FROM sites WHERE id = $1 AND org_id = $2")
        .bind(id)
        .bind(uid)
        .execute(&st.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
pub struct RotateSecret {
    grace_hours: Option<i32>,
}

/// Issue a new secret. The old one keeps working for `grace_hours` (default
/// 24, max 168) so deployments can roll over without failed verifications.
pub async fn rotate_secret(
    State(st): State<AppState>,
    ctx: OrgCtx,
    Path(id): Path<Uuid>,
    ApiJson(req): ApiJson<RotateSecret>,
) -> ApiResult<Json<serde_json::Value>> {
    ctx.require(Role::Admin)?;
    let uid = ctx.org_id;
    let grace = req.grace_hours.unwrap_or(24);
    if !(0..=168).contains(&grace) {
        return Err(ApiError::bad_request("grace_hours must be between 0 and 168"));
    }
    let secret = keys::new_secret();
    let row: Option<(Option<chrono::DateTime<chrono::Utc>>,)> = sqlx::query_as(
        "UPDATE sites SET \
            previous_secret_hash = CASE WHEN $4 > 0 THEN secret_hash END, \
            previous_secret_expires_at = CASE WHEN $4 > 0 THEN now() + make_interval(hours => $4) END, \
            secret_hash = $3, updated_at = now() \
         WHERE id = $1 AND org_id = $2 RETURNING previous_secret_expires_at",
    )
    .bind(id)
    .bind(uid)
    .bind(keys::sha256_hex(&secret))
    .bind(grace)
    .fetch_optional(&st.db)
    .await?;
    let (expires,) = row.ok_or(ApiError::NotFound)?;
    Ok(Json(json!({ "secret": secret, "previous_secret_expires_at": expires })))
}

pub async fn revoke_previous_secret(
    State(st): State<AppState>,
    ctx: OrgCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    ctx.require(Role::Admin)?;
    let uid = ctx.org_id;
    let res = sqlx::query(
        "UPDATE sites SET previous_secret_hash = NULL, previous_secret_expires_at = NULL, updated_at = now() \
         WHERE id = $1 AND org_id = $2",
    )
    .bind(id)
    .bind(uid)
    .execute(&st.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct StatsQuery {
    days: Option<i32>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct DayStats {
    day: NaiveDate,
    issued: i64,
    solved: i64,
    failed: i64,
    interactive: i64,
    verified: i64,
    verify_failed: i64,
    reported: i64,
    pat: i64,
}

pub async fn stats(
    State(st): State<AppState>,
    ctx: OrgCtx,
    Path(id): Path<Uuid>,
    Query(q): Query<StatsQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    ctx.require(Role::Viewer)?;
    let uid = ctx.org_id;
    let site = owned_site(&st, uid, id).await?;
    let days = q.days.unwrap_or(30).clamp(1, 90);
    let rows: Vec<DayStats> = sqlx::query_as(
        "SELECT d::date AS day, \
                COALESCE(s.issued, 0) AS issued, COALESCE(s.solved, 0) AS solved, \
                COALESCE(s.failed, 0) AS failed, COALESCE(s.interactive, 0) AS interactive, \
                COALESCE(s.verified, 0) AS verified, COALESCE(s.verify_failed, 0) AS verify_failed, \
                COALESCE(s.reported, 0) AS reported, COALESCE(s.pat, 0) AS pat \
         FROM generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, interval '1 day') AS d \
         LEFT JOIN site_stats_daily s ON s.site_id = $1 AND s.day = d::date \
         ORDER BY d",
    )
    .bind(site.id)
    .bind(days)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(json!({ "days": rows })))
}

#[derive(Deserialize)]
pub struct TestVerify {
    response: String,
}

/// Lets the dashboard's "Try it" panel redeem a token without exposing the secret.
pub async fn test_verify(
    State(st): State<AppState>,
    ctx: OrgCtx,
    Path(id): Path<Uuid>,
    ApiJson(req): ApiJson<TestVerify>,
) -> ApiResult<Json<VerifyResult>> {
    ctx.require(Role::Member)?;
    let uid = ctx.org_id;
    let site = owned_site(&st, uid, id).await?;
    if req.response.is_empty() {
        return Ok(Json(VerifyResult::error("missing-input-response")));
    }
    Ok(Json(verify_token(&st, site.id, &req.response).await?))
}
