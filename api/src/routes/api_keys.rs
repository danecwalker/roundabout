use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiJson, ApiResult},
    keys,
    routes::orgs::{OrgCtx, Role},
    state::AppState,
};

const MAX_KEYS: i64 = 25;

#[derive(Serialize, sqlx::FromRow)]
pub struct ApiKey {
    id: Uuid,
    name: String,
    prefix: String,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
    created_by: Option<String>,
}

const KEY_SQL: &str = "SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, u.email AS created_by \
     FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.org_id = $1";

/// Keys are managed by org admins from a dashboard session, never by another key.
fn require_manager(ctx: &OrgCtx) -> ApiResult<()> {
    if ctx.via_key {
        return Err(ApiError::Forbidden("API keys can't manage API keys; sign in to the dashboard".into()));
    }
    ctx.require(Role::Admin)
}

pub async fn list(State(st): State<AppState>, ctx: OrgCtx) -> ApiResult<Json<Vec<ApiKey>>> {
    require_manager(&ctx)?;
    let keys = sqlx::query_as(&format!("{KEY_SQL} ORDER BY k.created_at DESC"))
    .bind(ctx.org_id)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(keys))
}

#[derive(Deserialize)]
pub struct CreateKey {
    name: String,
}

#[derive(Serialize)]
pub struct CreatedKey {
    key: ApiKey,
    token: String,
}

pub async fn create(
    State(st): State<AppState>,
    ctx: OrgCtx,
    ApiJson(req): ApiJson<CreateKey>,
) -> ApiResult<(StatusCode, Json<CreatedKey>)> {
    require_manager(&ctx)?;
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::bad_request("name must be 1–100 characters"));
    }
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM api_keys WHERE org_id = $1")
        .bind(ctx.org_id)
        .fetch_one(&st.db)
        .await?;
    if count >= MAX_KEYS {
        return Err(ApiError::bad_request(format!("at most {MAX_KEYS} API keys")));
    }
    let token = format!("rbk_{}", keys::random_string(40));
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO api_keys (id, org_id, created_by, name, prefix, key_hash) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(id)
        .bind(ctx.org_id)
        .bind(ctx.user_id)
        .bind(name)
        .bind(&token[..8])
        .bind(keys::sha256_hex(&token))
        .execute(&st.db)
        .await?;
    let key: ApiKey = sqlx::query_as(&format!("{KEY_SQL} AND k.id = $2"))
        .bind(ctx.org_id)
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    Ok((StatusCode::CREATED, Json(CreatedKey { key, token })))
}

pub async fn delete(
    State(st): State<AppState>,
    ctx: OrgCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    require_manager(&ctx)?;
    let res = sqlx::query("DELETE FROM api_keys WHERE id = $1 AND org_id = $2")
        .bind(id)
        .bind(ctx.org_id)
        .execute(&st.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}
