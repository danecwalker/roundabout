//! Server-to-server token verification, response-compatible with Turnstile's
//! `/siteverify` (accepts form-encoded or JSON bodies, always answers 200).

use axum::{body::Bytes, extract::State, http::HeaderMap, Json};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::ApiResult,
    keys::{self, test_keys},
    models::Site,
    reputation::{self, Subject, Verdict},
    routes::challenge::StoredToken,
    stats::{self, Stat},
    state::AppState,
};

#[derive(Deserialize, Default)]
pub struct VerifyReq {
    #[serde(default)]
    secret: String,
    #[serde(default)]
    response: String,
    #[allow(dead_code)]
    remoteip: Option<String>,
    idempotency_key: Option<String>,
}

/// Remembered for 7 days after redemption so `/v1/feedback` can find the subject.
const REDEEMED_TTL_SECS: u64 = 7 * 24 * 3600;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Metadata {
    pub ephemeral_id: Option<String>,
    pub risk_score: u32,
    pub pat: bool,
}

#[derive(Serialize, Deserialize)]
struct Redeemed {
    site_id: Uuid,
    subject: Subject,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VerifyResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub challenge_ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(rename = "error-codes")]
    pub error_codes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cdata: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,
}

impl VerifyResult {
    pub fn error(code: &str) -> Self {
        Self {
            success: false,
            challenge_ts: None,
            hostname: None,
            error_codes: vec![code.to_string()],
            action: None,
            cdata: None,
            metadata: None,
        }
    }
}

fn parse_body<T: serde::de::DeserializeOwned>(headers: &HeaderMap, body: &[u8]) -> Option<T> {
    let ct = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if ct.starts_with("application/json") {
        serde_json::from_slice(body).ok()
    } else {
        serde_urlencoded::from_bytes(body).ok()
    }
}

pub async fn siteverify(State(st): State<AppState>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<VerifyResult>> {
    let Some(req) = parse_body::<VerifyReq>(&headers, &body) else {
        return Ok(Json(VerifyResult::error("bad-request")));
    };
    if req.secret.is_empty() {
        return Ok(Json(VerifyResult::error("missing-input-secret")));
    }
    if req.response.is_empty() {
        return Ok(Json(VerifyResult::error("missing-input-response")));
    }

    match req.secret.as_str() {
        test_keys::SECRET_PASS => {
            return Ok(Json(VerifyResult {
                success: true,
                challenge_ts: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                hostname: Some("example.com".into()),
                error_codes: vec![],
                action: None,
                cdata: None,
                metadata: Some(Metadata { ephemeral_id: Some("eid_test".into()), risk_score: 0, pat: false }),
            }))
        }
        test_keys::SECRET_FAIL => return Ok(Json(VerifyResult::error("invalid-input-response"))),
        test_keys::SECRET_SPENT => return Ok(Json(VerifyResult::error("timeout-or-duplicate"))),
        _ => {}
    }

    let Some(site) = Site::by_secret(&st.db, &req.secret).await? else {
        return Ok(Json(VerifyResult::error("invalid-input-secret")));
    };

    let idem_key = req
        .idempotency_key
        .filter(|k| !k.is_empty() && k.len() <= 128)
        .map(|k| format!("idem:{}:{k}", site.id));
    let mut conn = st.redis.clone();
    if let Some(k) = &idem_key {
        let cached: Option<String> = conn.get(k).await?;
        if let Some(r) = cached.and_then(|c| serde_json::from_str(&c).ok()) {
            return Ok(Json(r));
        }
    }

    let result = verify_token(&st, site.id, &req.response).await?;
    if let Some(k) = &idem_key {
        let _: () = conn
            .set_ex(k, serde_json::to_string(&result).map_err(anyhow::Error::from)?, st.cfg.token_ttl_secs)
            .await?;
    }
    Ok(Json(result))
}

/// Redeem a widget token for `site_id`. Tokens are single-use (GETDEL).
pub async fn verify_token(st: &AppState, site_id: Uuid, response: &str) -> ApiResult<VerifyResult> {
    let result = if !response.starts_with("rt_") || response.len() > 2048 {
        VerifyResult::error("invalid-input-response")
    } else {
        let mut conn = st.redis.clone();
        let raw: Option<String> = redis::cmd("GETDEL")
            .arg(format!("tok:{response}"))
            .query_async(&mut conn)
            .await?;
        match raw.and_then(|r| serde_json::from_str::<StoredToken>(&r).ok()) {
            None => VerifyResult::error("timeout-or-duplicate"),
            Some(t) if t.site_id != Some(site_id) => VerifyResult::error("invalid-input-response"),
            Some(t) => {
                let redeemed = Redeemed { site_id, subject: t.subject };
                let _: () = conn
                    .set_ex(
                        format!("red:{}", keys::sha256_hex(response)),
                        serde_json::to_string(&redeemed).map_err(anyhow::Error::from)?,
                        REDEEMED_TTL_SECS,
                    )
                    .await?;
                VerifyResult {
                    success: true,
                    challenge_ts: Some(t.challenge_ts),
                    hostname: Some(t.hostname),
                    error_codes: vec![],
                    action: t.action,
                    cdata: t.cdata,
                    metadata: Some(Metadata { ephemeral_id: t.ephemeral_id, risk_score: t.risk_score, pat: t.pat }),
                }
            }
        }
    };
    let stat = if result.success { Stat::Verified } else { Stat::VerifyFailed };
    stats::record(&st.db, Some(site_id), stat);
    Ok(result)
}

#[derive(Deserialize, Default)]
pub struct FeedbackReq {
    #[serde(default)]
    secret: String,
    #[serde(default)]
    response: String,
    verdict: Option<String>,
}

#[derive(Serialize)]
pub struct FeedbackResult {
    success: bool,
    #[serde(rename = "error-codes")]
    error_codes: Vec<&'static str>,
}

fn feedback_err(code: &'static str) -> Json<FeedbackResult> {
    Json(FeedbackResult { success: false, error_codes: vec![code] })
}

/// Report a previously verified token as abuse (or legit). One report per token.
pub async fn feedback(State(st): State<AppState>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<FeedbackResult>> {
    let Some(req) = parse_body::<FeedbackReq>(&headers, &body) else { return Ok(feedback_err("bad-request")) };
    if req.secret.is_empty() {
        return Ok(feedback_err("missing-input-secret"));
    }
    if req.response.is_empty() {
        return Ok(feedback_err("missing-input-response"));
    }
    let verdict = match req.verdict.as_deref() {
        Some("abuse") => Verdict::Abuse,
        Some("legit") => Verdict::Legit,
        _ => return Ok(feedback_err("invalid-verdict")),
    };
    let Some(site) = Site::by_secret(&st.db, &req.secret).await? else {
        return Ok(feedback_err("invalid-input-secret"));
    };
    let mut conn = st.redis.clone();
    let raw: Option<String> = redis::cmd("GETDEL")
        .arg(format!("red:{}", keys::sha256_hex(&req.response)))
        .query_async(&mut conn)
        .await?;
    let Some(redeemed) = raw.and_then(|r| serde_json::from_str::<Redeemed>(&r).ok()) else {
        return Ok(feedback_err("unknown-or-already-reported"));
    };
    if redeemed.site_id != site.id {
        return Ok(feedback_err("invalid-input-response"));
    }
    reputation::report(&st.redis, &redeemed.subject, verdict).await?;
    if verdict == Verdict::Abuse {
        stats::record(&st.db, Some(site.id), Stat::Reported);
    }
    Ok(Json(FeedbackResult { success: true, error_codes: vec![] }))
}
