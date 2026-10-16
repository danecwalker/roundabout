//! Pre-clearance HTTP endpoints: public keys, forward-auth check, online
//! verify, and the hosted gate page reverse proxies redirect to.

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    clearance::COOKIE_NAME,
    error::{ApiError, ApiResult},
    models::Site,
    state::AppState,
};

const GATE_HTML: &str = include_str!("../gate.html");

pub async fn keys(State(st): State<AppState>) -> Response {
    let mut res = Json(st.clearance.jwks()).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=300"));
    res
}

#[derive(Deserialize)]
pub struct CheckQuery {
    #[serde(default)]
    sitekey: String,
}

fn forwarded_host(headers: &HeaderMap) -> String {
    ["x-forwarded-host", "x-original-host", "host"]
        .iter()
        .find_map(|h| headers.get(*h).and_then(|v| v.to_str().ok()))
        .and_then(|v| v.split(',').next())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Forward-auth endpoint: 204 if the forwarded request carries a valid
/// clearance cookie for `sitekey`, else 401.
pub async fn check(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<CheckQuery>) -> Response {
    let jar = CookieJar::from_headers(&headers);
    let host = forwarded_host(&headers);
    let ua = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("");
    let result = match jar.get(COOKIE_NAME) {
        None => Err("missing"),
        Some(c) => st.clearance.verify(c.value(), &q.sitekey, &host, Some(ua)).map_err(|r| r.code()),
    };
    let mut res = match result {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(reason) => (StatusCode::UNAUTHORIZED, Json(json!({ "error": "clearance_required", "reason": reason }))).into_response(),
    };
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[derive(Deserialize, Default)]
pub struct VerifyReq {
    #[serde(default)]
    secret: String,
    #[serde(default)]
    clearance: String,
    hostname: Option<String>,
    user_agent: Option<String>,
}

#[derive(Serialize)]
pub struct VerifyResp {
    success: bool,
    #[serde(rename = "error-codes")]
    error_codes: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
}

fn verify_err(code: &'static str) -> Json<VerifyResp> {
    Json(VerifyResp { success: false, error_codes: vec![code], hostname: None, expires_at: None })
}

/// Online verification for backends that don't want to handle keys.
pub async fn verify(State(st): State<AppState>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<VerifyResp>> {
    let ct = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let req: Option<VerifyReq> = if ct.starts_with("application/json") {
        serde_json::from_slice(&body).ok()
    } else {
        serde_urlencoded::from_bytes(&body).ok()
    };
    let Some(req) = req else { return Ok(verify_err("bad-request")) };
    if req.secret.is_empty() {
        return Ok(verify_err("missing-input-secret"));
    }
    if req.clearance.is_empty() {
        return Ok(verify_err("missing-input-clearance"));
    }
    let Some(site) = Site::by_secret(&st.db, &req.secret).await? else {
        return Ok(verify_err("invalid-input-secret"));
    };
    // Without a hostname to compare against, accept whatever the token was bound to.
    let host = match &req.hostname {
        Some(h) => h.clone(),
        None => peek_host(&req.clearance).unwrap_or_default(),
    };
    match st.clearance.verify(&req.clearance, &site.sitekey, &host, req.user_agent.as_deref()) {
        Ok(p) => Ok(Json(VerifyResp {
            success: true,
            error_codes: vec![],
            hostname: Some(p.h),
            expires_at: chrono::DateTime::from_timestamp(p.exp, 0).map(|t| t.to_rfc3339()),
        })),
        Err(r) => Ok(verify_err(r.code())),
    }
}

fn peek_host(token: &str) -> Option<String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let body = token.split('.').nth(1)?;
    let p: crate::clearance::Payload = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
    Some(p.h)
}

#[derive(Deserialize)]
pub struct GateQuery {
    #[serde(default)]
    sitekey: String,
    #[serde(default)]
    lang: Option<String>,
}

fn html_escape(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '&' => "&amp;".to_string(),
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            '"' => "&quot;".to_string(),
            '\'' => "&#39;".to_string(),
            c => c.to_string(),
        })
        .collect()
}

/// Interstitial challenge page. Reverse proxies serve it on the customer's own
/// host (e.g. `/_roundabout/gate` → `/v1/gate`) so the clearance cookie lands
/// first-party; scripts and the widget frame still load from Roundabout.
pub async fn gate(State(st): State<AppState>, Query(q): Query<GateQuery>) -> ApiResult<Response> {
    let site = Site::by_sitekey(&st.db, &q.sitekey).await?;
    if !site.as_ref().is_some_and(|s| s.clearance_enabled) {
        return Err(ApiError::NotFound);
    }
    let base = &st.cfg.public_url;
    let lang = q.lang.filter(|l| l.len() <= 8 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).unwrap_or_else(|| "auto".into());
    let html = GATE_HTML
        .replace("{{BASE}}", &html_escape(base))
        .replace("{{SITEKEY}}", &html_escape(&q.sitekey))
        .replace("{{LANG}}", &html_escape(&lang));
    let csp = format!(
        "default-src 'none'; script-src {base}; frame-src {base}; style-src 'unsafe-inline'; \
         img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    let mut res = html.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("same-origin"));
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&csp).map_err(|e| ApiError::Internal(e.into()))?,
    );
    Ok(res)
}
