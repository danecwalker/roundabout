//! Organizations (teams): role-based membership and invite links. Invites are
//! shareable URLs rather than emails, so a self-hosted instance needs no mail
//! setup.

use axum::{
    extract::{FromRequestParts, Path, State},
    http::{request::Parts, StatusCode},
    Json,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiJson, ApiResult},
    keys,
    routes::auth::{api_key_org, session_user, AuthUser},
    state::AppState,
};

const INVITE_TTL_DAYS: i64 = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Member,
    Admin,
    Owner,
}

impl Role {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "viewer" => Some(Self::Viewer),
            "member" => Some(Self::Member),
            "admin" => Some(Self::Admin),
            "owner" => Some(Self::Owner),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Member => "member",
            Self::Admin => "admin",
            Self::Owner => "owner",
        }
    }
}

/// The organization a request acts on, and the caller's role in it.
///
/// API keys act on the org they were created in with admin rights. Sessions
/// pick the org from `X-Org-Id`, defaulting to the user's oldest membership.
pub struct OrgCtx {
    pub org_id: Uuid,
    pub user_id: Option<Uuid>,
    pub role: Role,
    /// Authenticated with an API key rather than a session.
    pub via_key: bool,
}

impl OrgCtx {
    pub fn require(&self, min: Role) -> ApiResult<()> {
        if self.role >= min {
            Ok(())
        } else {
            Err(ApiError::Forbidden(format!("requires the {} role", min.as_str())))
        }
    }
}

impl FromRequestParts<AppState> for OrgCtx {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        if let Some((org_id, user_id)) = api_key_org(st, parts).await? {
            return Ok(OrgCtx { org_id, user_id, role: Role::Admin, via_key: true });
        }
        let user_id = session_user(st, parts).await?;
        let requested = parts
            .headers
            .get("x-org-id")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.parse::<Uuid>().map_err(|_| ApiError::bad_request("invalid X-Org-Id")))
            .transpose()?;
        let row: Option<(Uuid, String)> = match requested {
            Some(org) => {
                sqlx::query_as("SELECT org_id, role FROM org_members WHERE org_id = $1 AND user_id = $2")
                    .bind(org)
                    .bind(user_id)
                    .fetch_optional(&st.db)
                    .await?
            }
            None => {
                sqlx::query_as(
                    "SELECT org_id, role FROM org_members WHERE user_id = $1 ORDER BY created_at, org_id LIMIT 1",
                )
                .bind(user_id)
                .fetch_optional(&st.db)
                .await?
            }
        };
        let (org_id, role) = row.ok_or_else(|| ApiError::Forbidden("not a member of this organization".into()))?;
        Ok(OrgCtx { org_id, user_id: Some(user_id), role: Role::parse(&role).unwrap_or(Role::Viewer), via_key: false })
    }
}

async fn role_in(st: &AppState, org: Uuid, user: Uuid) -> ApiResult<Role> {
    let row: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(org)
        .bind(user)
        .fetch_optional(&st.db)
        .await?;
    // Non-members get 404 rather than 403 so org IDs aren't probeable.
    row.and_then(|(r,)| Role::parse(&r)).ok_or(ApiError::NotFound)
}

async fn require_role(st: &AppState, org: Uuid, user: Uuid, min: Role) -> ApiResult<Role> {
    let role = role_in(st, org, user).await?;
    if role < min {
        return Err(ApiError::Forbidden(format!("requires the {} role", min.as_str())));
    }
    Ok(role)
}

fn validate_name(name: &str) -> ApiResult<String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 100 {
        return Err(ApiError::bad_request("name must be 1–100 characters"));
    }
    Ok(n.to_string())
}

#[derive(Serialize, sqlx::FromRow)]
pub struct OrgSummary {
    id: Uuid,
    name: String,
    role: String,
    created_at: DateTime<Utc>,
    member_count: i64,
}

const ORG_SUMMARY_SQL: &str = "SELECT o.id, o.name, m.role, o.created_at, \
     (SELECT count(*) FROM org_members x WHERE x.org_id = o.id) AS member_count \
     FROM orgs o JOIN org_members m ON m.org_id = o.id AND m.user_id = $1";

async fn org_summary(st: &AppState, user: Uuid, org: Uuid) -> ApiResult<OrgSummary> {
    sqlx::query_as(&format!("{ORG_SUMMARY_SQL} WHERE o.id = $2"))
        .bind(user)
        .bind(org)
        .fetch_optional(&st.db)
        .await?
        .ok_or(ApiError::NotFound)
}

pub async fn list(State(st): State<AppState>, AuthUser(uid): AuthUser) -> ApiResult<Json<Vec<OrgSummary>>> {
    let orgs = sqlx::query_as(&format!("{ORG_SUMMARY_SQL} ORDER BY m.created_at, o.id"))
        .bind(uid)
        .fetch_all(&st.db)
        .await?;
    Ok(Json(orgs))
}

#[derive(Deserialize)]
pub struct NameReq {
    name: String,
}

/// Create an org with `user` as owner, inside an existing transaction.
pub async fn create_org_tx(tx: &mut sqlx::PgConnection, name: &str, user: Uuid) -> sqlx::Result<Uuid> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, $2)").bind(id).bind(name).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(id)
        .bind(user)
        .execute(&mut *tx)
        .await?;
    Ok(id)
}

pub async fn create(
    State(st): State<AppState>,
    AuthUser(uid): AuthUser,
    ApiJson(req): ApiJson<NameReq>,
) -> ApiResult<(StatusCode, Json<OrgSummary>)> {
    let name = validate_name(&req.name)?;
    let mut tx = st.db.begin().await?;
    let id = create_org_tx(&mut tx, &name, uid).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(org_summary(&st, uid, id).await?)))
}

pub async fn rename(
    State(st): State<AppState>,
    AuthUser(uid): AuthUser,
    Path(org): Path<Uuid>,
    ApiJson(req): ApiJson<NameReq>,
) -> ApiResult<Json<OrgSummary>> {
    require_role(&st, org, uid, Role::Admin).await?;
    let name = validate_name(&req.name)?;
    sqlx::query("UPDATE orgs SET name = $2 WHERE id = $1").bind(org).bind(name).execute(&st.db).await?;
    Ok(Json(org_summary(&st, uid, org).await?))
}

pub async fn delete(State(st): State<AppState>, AuthUser(uid): AuthUser, Path(org): Path<Uuid>) -> ApiResult<StatusCode> {
    require_role(&st, org, uid, Role::Owner).await?;
    sqlx::query("DELETE FROM orgs WHERE id = $1").bind(org).execute(&st.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Members

#[derive(Serialize, sqlx::FromRow)]
pub struct Member {
    user_id: Uuid,
    email: String,
    role: String,
    joined_at: DateTime<Utc>,
}

const MEMBER_SQL: &str = "SELECT m.user_id, u.email, m.role, m.created_at AS joined_at \
     FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1";

pub async fn members(State(st): State<AppState>, AuthUser(uid): AuthUser, Path(org): Path<Uuid>) -> ApiResult<Json<Vec<Member>>> {
    require_role(&st, org, uid, Role::Viewer).await?;
    let rows = sqlx::query_as(&format!("{MEMBER_SQL} ORDER BY m.created_at"))
        .bind(org)
        .fetch_all(&st.db)
        .await?;
    Ok(Json(rows))
}

async fn owner_count(tx: &mut sqlx::PgConnection, org: Uuid) -> sqlx::Result<i64> {
    // Lock the org's owner rows so concurrent demotions can't both succeed.
    let rows: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM org_members WHERE org_id = $1 AND role = 'owner' FOR UPDATE")
        .bind(org)
        .fetch_all(&mut *tx)
        .await?;
    Ok(rows.len() as i64)
}

#[derive(Deserialize)]
pub struct RoleReq {
    role: String,
}

pub async fn update_member(
    State(st): State<AppState>,
    AuthUser(uid): AuthUser,
    Path((org, target)): Path<(Uuid, Uuid)>,
    ApiJson(req): ApiJson<RoleReq>,
) -> ApiResult<Json<Member>> {
    let me = require_role(&st, org, uid, Role::Admin).await?;
    let new_role = Role::parse(&req.role).ok_or_else(|| ApiError::bad_request("invalid role"))?;
    let current = role_in(&st, org, target).await?;
    if (current == Role::Owner || new_role == Role::Owner) && me != Role::Owner {
        return Err(ApiError::Forbidden("only owners can grant or change the owner role".into()));
    }
    let mut tx = st.db.begin().await?;
    if current == Role::Owner && new_role != Role::Owner && owner_count(&mut tx, org).await? <= 1 {
        return Err(ApiError::bad_request("an organization needs at least one owner"));
    }
    sqlx::query("UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2")
        .bind(org)
        .bind(target)
        .bind(new_role.as_str())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let m = sqlx::query_as(&format!("{MEMBER_SQL} AND m.user_id = $2"))
        .bind(org)
        .bind(target)
        .fetch_one(&st.db)
        .await?;
    Ok(Json(m))
}

pub async fn remove_member(
    State(st): State<AppState>,
    AuthUser(uid): AuthUser,
    Path((org, target)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    let me = role_in(&st, org, uid).await?;
    let current = role_in(&st, org, target).await?;
    let leaving = target == uid;
    if !leaving {
        if me < Role::Admin {
            return Err(ApiError::Forbidden("requires the admin role".into()));
        }
        if current == Role::Owner && me != Role::Owner {
            return Err(ApiError::Forbidden("only owners can remove owners".into()));
        }
    }
    let mut tx = st.db.begin().await?;
    if current == Role::Owner && owner_count(&mut tx, org).await? <= 1 {
        return Err(ApiError::bad_request(
            "the last owner can't leave; transfer ownership or delete the organization",
        ));
    }
    sqlx::query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(org)
        .bind(target)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Invites

#[derive(Serialize, sqlx::FromRow)]
pub struct Invite {
    id: Uuid,
    role: String,
    email: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    invited_by: Option<String>,
}

const INVITE_SQL: &str = "SELECT i.id, i.role, i.email, i.created_at, i.expires_at, u.email AS invited_by \
     FROM org_invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.org_id = $1";

pub async fn invites(State(st): State<AppState>, AuthUser(uid): AuthUser, Path(org): Path<Uuid>) -> ApiResult<Json<Vec<Invite>>> {
    require_role(&st, org, uid, Role::Admin).await?;
    let rows = sqlx::query_as(&format!("{INVITE_SQL} AND i.expires_at > now() ORDER BY i.created_at DESC"))
        .bind(org)
        .fetch_all(&st.db)
        .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateInvite {
    role: String,
    email: Option<String>,
}

#[derive(Serialize)]
pub struct CreatedInvite {
    invite: Invite,
    url: String,
}

pub async fn create_invite(
    State(st): State<AppState>,
    AuthUser(uid): AuthUser,
    Path(org): Path<Uuid>,
    ApiJson(req): ApiJson<CreateInvite>,
) -> ApiResult<(StatusCode, Json<CreatedInvite>)> {
    let me = require_role(&st, org, uid, Role::Admin).await?;
    let role = Role::parse(&req.role).ok_or_else(|| ApiError::bad_request("invalid role"))?;
    if role == Role::Owner && me != Role::Owner {
        return Err(ApiError::Forbidden("only owners can invite owners".into()));
    }
    let email = req.email.map(|e| e.trim().to_string()).filter(|e| !e.is_empty());
    if email.as_ref().is_some_and(|e| e.len() > 254) {
        return Err(ApiError::bad_request("email too long"));
    }
    let token = format!("rbi_{}", keys::random_string(40));
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO org_invites (id, org_id, role, email, token_hash, created_by, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(id)
    .bind(org)
    .bind(role.as_str())
    .bind(&email)
    .bind(keys::sha256_hex(&token))
    .bind(uid)
    .bind(Utc::now() + Duration::days(INVITE_TTL_DAYS))
    .execute(&st.db)
    .await?;
    let invite = sqlx::query_as(&format!("{INVITE_SQL} AND i.id = $2"))
        .bind(org)
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    let url = format!("{}/invite/{token}", st.cfg.public_url);
    Ok((StatusCode::CREATED, Json(CreatedInvite { invite, url })))
}

pub async fn revoke_invite(
    State(st): State<AppState>,
    AuthUser(uid): AuthUser,
    Path((org, invite)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    require_role(&st, org, uid, Role::Admin).await?;
    let res = sqlx::query("DELETE FROM org_invites WHERE id = $1 AND org_id = $2")
        .bind(invite)
        .bind(org)
        .execute(&st.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct InvitePreview {
    org_name: String,
    role: String,
    invited_by: Option<String>,
    expires_at: DateTime<Utc>,
}

pub async fn find_invite(db: &sqlx::PgPool, token: &str) -> ApiResult<Option<InvitePreview>> {
    Ok(sqlx::query_as(
        "SELECT o.name AS org_name, i.role, u.email AS invited_by, i.expires_at \
         FROM org_invites i JOIN orgs o ON o.id = i.org_id LEFT JOIN users u ON u.id = i.created_by \
         WHERE i.token_hash = $1 AND i.expires_at > now()",
    )
    .bind(keys::sha256_hex(token))
    .fetch_optional(db)
    .await?)
}

pub async fn preview_invite(State(st): State<AppState>, Path(token): Path<String>) -> ApiResult<Json<InvitePreview>> {
    find_invite(&st.db, &token).await?.map(Json).ok_or(ApiError::NotFound)
}

/// Consume an invite for `user` (inside a transaction). Returns the org joined.
pub async fn redeem_invite_tx(tx: &mut sqlx::PgConnection, token: &str, user: Uuid) -> ApiResult<Uuid> {
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "DELETE FROM org_invites WHERE token_hash = $1 AND expires_at > now() RETURNING org_id, role",
    )
    .bind(keys::sha256_hex(token))
    .fetch_optional(&mut *tx)
    .await?;
    let (org, role) = row.ok_or(ApiError::NotFound)?;
    // Already a member: keep the higher of the two roles.
    sqlx::query(
        "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) \
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = CASE \
           WHEN array_position(ARRAY['viewer','member','admin','owner'], EXCLUDED.role) \
              > array_position(ARRAY['viewer','member','admin','owner'], org_members.role) \
           THEN EXCLUDED.role ELSE org_members.role END",
    )
    .bind(org)
    .bind(user)
    .bind(role)
    .execute(&mut *tx)
    .await?;
    Ok(org)
}

pub async fn accept_invite(
    State(st): State<AppState>,
    AuthUser(uid): AuthUser,
    Path(token): Path<String>,
) -> ApiResult<Json<OrgSummary>> {
    let mut tx = st.db.begin().await?;
    let org = redeem_invite_tx(&mut tx, &token, uid).await?;
    tx.commit().await?;
    Ok(Json(org_summary(&st, uid, org).await?))
}
