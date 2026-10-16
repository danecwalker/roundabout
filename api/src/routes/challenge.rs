//! Browser-facing challenge endpoints, called from the widget frame (same origin).

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use rand::seq::SliceRandom;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    domains,
    error::{ApiError, ApiJson, ApiResult},
    fingerprint::{self, Fingerprint, Flag},
    keys::{self, test_keys::TestSite},
    models::Site,
    netrep::NetInfo,
    pat, pow,
    probe::{EnvValues, Probe},
    reputation::{self, Subject},
    risk,
    stats::{self, Stat},
    state::AppState,
};

const FRAME_HTML: &str = include_str!("../frame.html");
/// Hard per-IP, per-site ceiling on challenges per minute.
const RATE_HARD_LIMIT: u64 = 300;
/// Above this many challenges per minute, difficulty starts rising.
const RATE_SOFT_LIMIT: u64 = 20;
const MAX_DIFFICULTY: u8 = 26;
const MAX_SOLVE_ATTEMPTS: u8 = 3;

// ---------------------------------------------------------------------------
// Frame

#[derive(Deserialize)]
pub struct FrameQuery {
    #[serde(default)]
    sitekey: String,
    /// Origin of the embedding page, as reported by `api.js`. Only used to
    /// build `frame-ancestors`; the browser enforces it against the real one.
    origin: Option<String>,
}

/// Serves the widget iframe. `frame-ancestors` restricts which pages can embed
/// it, so a sitekey copied onto another domain won't render there.
pub async fn frame(State(st): State<AppState>, Query(q): Query<FrameQuery>) -> ApiResult<Response> {
    let ancestors = if keys::test_keys::sitekey(&q.sitekey).is_some() {
        "*".to_string()
    } else {
        match Site::by_sitekey(&st.db, &q.sitekey).await? {
            Some(site) => domains::frame_ancestors(q.origin.as_deref(), &site.domains, &st.cfg.trusted_embed_origins()),
            // Unknown sitekey: nothing to protect, let the frame render its error.
            None => "*".to_string(),
        }
    };
    let csp = format!(
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; \
         worker-src 'self'; img-src 'self' data:; frame-ancestors {ancestors}"
    );
    // Serve one of several differently-obfuscated builds of frame.js.
    let variant = st.frame_variants.choose(&mut rand::thread_rng()).map(String::as_str).unwrap_or("frame.js");
    let mut res = FRAME_HTML.replace("{{FRAME_JS}}", variant).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&csp).map_err(|e| ApiError::Internal(e.into()))?,
    );
    Ok(res)
}

// ---------------------------------------------------------------------------
// Issue challenge

#[derive(Deserialize)]
pub struct ChallengeReq {
    sitekey: String,
    hostname: String,
    action: Option<String>,
    cdata: Option<String>,
}

#[derive(Serialize)]
pub struct ChallengeResp {
    id: String,
    salt: String,
    puzzles: usize,
    bits: u8,
    mode: String,
    expires_in: u64,
    /// Whether the frame should attempt a Private Access Token.
    pat: bool,
}

#[derive(Serialize, Deserialize)]
struct StoredChallenge {
    site_id: Option<Uuid>,
    test: Option<TestSite>,
    mode: String,
    salt: String,
    bits: u8,
    hostname: String,
    action: Option<String>,
    cdata: Option<String>,
    ip: String,
    rate: u64,
    issued_at_ms: i64,
    attempts: u8,
    interaction_requested: bool,
    net: NetInfo,
    network_flags: Vec<String>,
    network_score: u32,
    probe: Probe,
    #[serde(default)]
    pat: bool,
    sitekey: String,
    /// Set when the site issues pre-clearance cookies.
    clearance_ttl: Option<i32>,
}

/// Turnstile-compatible limits: action ≤ 32 chars, cdata ≤ 255, `[A-Za-z0-9_-]`.
fn validate_tag(v: Option<String>, max: usize, name: &str) -> ApiResult<Option<String>> {
    match v.filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) if s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') => {
            Ok(Some(s))
        }
        Some(_) => Err(ApiError::bad_request(format!("invalid_{name}"))),
    }
}

pub fn client_ip(headers: &HeaderMap, addr: SocketAddr, trust_proxy: bool) -> String {
    if trust_proxy {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return ip.to_string();
        }
    }
    addr.ip().to_string()
}

fn user_agent(headers: &HeaderMap) -> &str {
    headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("")
}

/// Count challenges for this (site, ip) in the current minute.
async fn bump_rate(st: &AppState, site: &str, ip: &str) -> ApiResult<u64> {
    let minute = Utc::now().timestamp() / 60;
    let key = format!("rl:{site}:{ip}:{minute}");
    let mut conn = st.redis.clone();
    let (n,): (u64,) = redis::pipe()
        .atomic()
        .incr(&key, 1)
        .expire(&key, 120)
        .ignore()
        .query_async(&mut conn)
        .await?;
    Ok(n)
}

/// Add up to 6 bits of work as an IP's request rate climbs past the soft limit.
fn adaptive_bits(rate: u64) -> u8 {
    if rate <= RATE_SOFT_LIMIT {
        0
    } else {
        ((rate / RATE_SOFT_LIMIT).ilog2() as u8 + 1).min(6)
    }
}

async fn save_challenge(st: &AppState, key: &str, ch: &StoredChallenge) -> ApiResult<()> {
    let mut conn = st.redis.clone();
    let ttl: i64 = conn.ttl(key).await?;
    if ttl > 0 {
        let _: () = conn
            .set_ex(key, serde_json::to_string(ch).map_err(anyhow::Error::from)?, ttl as u64)
            .await?;
    }
    Ok(())
}

async fn load_challenge(st: &AppState, id: &str) -> ApiResult<Option<StoredChallenge>> {
    let mut conn = st.redis.clone();
    let raw: Option<String> = conn.get(format!("ch:{id}")).await?;
    raw.map(|r| serde_json::from_str(&r).map_err(|e| ApiError::Internal(e.into())))
        .transpose()
}

pub async fn create(
    State(st): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ApiJson(req): ApiJson<ChallengeReq>,
) -> ApiResult<Json<ChallengeResp>> {
    let action = validate_tag(req.action, 32, "action")?;
    let cdata = validate_tag(req.cdata, 255, "cdata")?;
    let hostname =
        domains::normalize_domain(&req.hostname).ok_or_else(|| ApiError::bad_request("invalid_hostname"))?;
    let ip = client_ip(&headers, addr, st.cfg.trust_proxy);

    let test = keys::test_keys::sitekey(&req.sitekey);
    let (site_id, mode, base_difficulty, clearance_ttl) = match test {
        Some(TestSite::Interactive) => (None, "managed".to_string(), 4, None),
        Some(_) => (None, "non_interactive".to_string(), 4, None),
        None => {
            let site = Site::by_sitekey(&st.db, &req.sitekey)
                .await?
                .ok_or_else(|| ApiError::bad_request("invalid_sitekey"))?;
            let trusted = st.cfg.trusted_embed_hosts();
            if !domains::hostname_allowed(&hostname, &site.domains) && !trusted.contains(&hostname) {
                return Err(ApiError::Forbidden("hostname_not_allowed".into()));
            }
            let clearance = site.clearance_enabled.then_some(site.clearance_ttl_secs);
            (Some(site.id), site.mode, site.difficulty as u8, clearance)
        }
    };

    let rate = bump_rate(&st, &req.sitekey, &ip).await?;
    if rate > RATE_HARD_LIMIT {
        return Err(ApiError::TooManyRequests);
    }

    // Network reputation is known before any JS runs, so risky networks pay
    // for it in proof-of-work up front.
    let net = st.netrep.lookup(&ip);
    let rep = reputation::ip_scores(&st.redis, &ip, net.asn).await?;
    let net_flags = risk::network_flags(&net, &rep);
    let extra_bits = if test.is_some() { 0 } else { adaptive_bits(rate) + risk::network_bits(&net_flags) };
    let difficulty = (base_difficulty + extra_bits).min(MAX_DIFFICULTY);

    let id = keys::random_string(32);
    let mut probe = Probe::generate();
    let probe_js = probe.render_js(&id);
    let stored = StoredChallenge {
        site_id,
        test,
        mode: mode.clone(),
        salt: keys::random_string(32),
        bits: pow::puzzle_bits(difficulty),
        hostname,
        action,
        cdata,
        ip,
        rate,
        issued_at_ms: Utc::now().timestamp_millis(),
        attempts: 0,
        interaction_requested: false,
        network_score: risk::score(&net_flags),
        network_flags: net_flags.iter().map(|f| f.name.to_string()).collect(),
        net,
        probe,
        pat: false,
        sitekey: req.sitekey.clone(),
        clearance_ttl,
    };
    let ttl = st.cfg.challenge_ttl_secs;
    let mut conn = st.redis.clone();
    let _: () = redis::pipe()
        .set_ex(format!("ch:{id}"), serde_json::to_string(&stored).map_err(anyhow::Error::from)?, ttl)
        .ignore()
        .set_ex(format!("probe:{id}"), probe_js, ttl)
        .ignore()
        .query_async(&mut conn)
        .await?;
    stats::record(&st.db, site_id, Stat::Issued);

    Ok(Json(ChallengeResp {
        id,
        salt: stored.salt,
        puzzles: pow::PUZZLES,
        bits: stored.bits,
        mode,
        expires_in: ttl,
        pat: st.pat.as_ref().is_some_and(|p| p.current_key().is_some()),
    }))
}

// ---------------------------------------------------------------------------
// Probe script

/// Single-use: the script is deleted as it's served.
pub async fn probe_js(State(st): State<AppState>, Path(file): Path<String>) -> ApiResult<Response> {
    let id = file.strip_suffix(".js").unwrap_or(&file);
    let mut conn = st.redis.clone();
    let js: Option<String> = redis::cmd("GETDEL").arg(format!("probe:{id}")).query_async(&mut conn).await?;
    let Some(js) = js else { return Err(ApiError::NotFound) };
    let mut res = js.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/javascript; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

// ---------------------------------------------------------------------------
// Private Access Token

fn pat_challenge(st: &AppState, id: &str, issuer: &str) -> Vec<u8> {
    let ctx: [u8; 32] = Sha256::digest(format!("roundabout-pat:{id}").as_bytes()).into();
    let origin = domains::normalize_domain(&st.cfg.public_url).unwrap_or_default();
    pat::build_challenge(issuer, &ctx, &origin)
}

/// 401 + `WWW-Authenticate: PrivateToken` until the browser presents a token.
pub async fn pat_redeem(State(st): State<AppState>, Path(id): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let Some(issuer) = st.pat.clone() else { return Err(ApiError::NotFound) };
    let Some(key) = issuer.current_key() else { return Err(ApiError::NotFound) };
    let Some(mut ch) = load_challenge(&st, &id).await? else { return Err(ApiError::NotFound) };
    let challenge = pat_challenge(&st, &id, &issuer.name);

    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(pat::parse_authorization);
    match token {
        Some(t) if pat::verify_token(&t, &challenge, &issuer.keys()) => {
            ch.pat = true;
            save_challenge(&st, &format!("ch:{id}"), &ch).await?;
            Ok((StatusCode::OK, Json(json!({ "pat": true }))).into_response())
        }
        Some(_) => Ok((StatusCode::FORBIDDEN, Json(json!({ "pat": false }))).into_response()),
        None => {
            let mut res = (StatusCode::UNAUTHORIZED, Json(json!({ "pat": false }))).into_response();
            let h = res.headers_mut();
            h.insert(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_str(&pat::www_authenticate(&challenge, &key)).map_err(|e| ApiError::Internal(e.into()))?,
            );
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            Ok(res)
        }
    }
}

// ---------------------------------------------------------------------------
// Solve

/// Client-reported browser signals. Everything here can be forged by a
/// determined attacker; the value is in cross-checking it against the request
/// itself, the per-challenge probe, and itself. The proof-of-work (or a PAT)
/// is the part that can't be skipped.
#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub struct Signals {
    webdriver: bool,
    headless_ua: bool,
    languages: u32,
    hardware_concurrency: u32,
    screen_w: u32,
    screen_h: u32,
    touch: bool,
    pointer_moves: u32,
    interacted: bool,
}

#[derive(Deserialize)]
pub struct SolveReq {
    id: String,
    #[serde(default)]
    nonces: Vec<u64>,
    /// Base64 of the JSON `SolvePayload`, XOR-encrypted with a keystream from
    /// the key embedded in this challenge's probe script.
    #[serde(default)]
    payload: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SolvePayload {
    signals: Signals,
    fp: Fingerprint,
    probe: Option<u32>,
}

const MAX_PAYLOAD: usize = 64 * 1024;

/// Keystream block `i` is SHA-256("{key hex}:{i}").
fn decrypt_payload(probe: &Probe, b64: &str) -> Option<SolvePayload> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if b64.len() > MAX_PAYLOAD * 4 / 3 + 4 {
        return None;
    }
    let data = STANDARD.decode(b64).ok()?;
    let khex = probe.key_hex();
    let mut plain = Vec::with_capacity(data.len());
    for (i, chunk) in data.chunks(32).enumerate() {
        let ks = Sha256::digest(format!("{khex}:{i}").as_bytes());
        plain.extend(chunk.iter().zip(ks.iter()).map(|(a, b)| a ^ b));
    }
    serde_json::from_slice(&plain).ok()
}

#[derive(Serialize)]
pub struct ClearanceOut {
    value: String,
    max_age: i32,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SolveResp {
    Ok {
        token: String,
        expires_in: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        clearance: Option<ClearanceOut>,
    },
    InteractionRequired,
    Failed { reason: &'static str },
}

#[derive(Serialize, Deserialize)]
pub struct StoredToken {
    pub site_id: Option<Uuid>,
    pub test: Option<TestSite>,
    pub hostname: String,
    pub action: Option<String>,
    pub cdata: Option<String>,
    pub challenge_ts: String,
    #[serde(default)]
    pub subject: Subject,
    #[serde(default)]
    pub ephemeral_id: Option<String>,
    #[serde(default)]
    pub risk_score: u32,
    #[serde(default)]
    pub pat: bool,
}

/// Basic environment sanity checks (independent of the fingerprint module).
fn basic_flags(ch: &StoredChallenge, s: &Signals, elapsed_ms: i64) -> Vec<Flag> {
    let mut v = Vec::new();
    let mut add = |name, weight| v.push(Flag { name, weight });
    if s.languages == 0 {
        add("no_languages", 1);
    }
    if s.hardware_concurrency == 0 {
        add("no_hardware_concurrency", 1);
    }
    if s.screen_w == 0 || s.screen_h == 0 {
        add("no_screen", 1);
    }
    // A browser can't round-trip a non-trivial puzzle this fast.
    if !ch.pat && ch.bits >= 10 && elapsed_ms < 50 {
        add("too_fast", 1);
    }
    if ch.rate > RATE_SOFT_LIMIT {
        add("high_rate", 1);
    }
    v
}

/// Terminal failure: burn the challenge so it can't be retried.
async fn fail(st: &AppState, key: &str, site_id: Option<Uuid>, reason: &'static str) -> ApiResult<Json<SolveResp>> {
    let mut conn = st.redis.clone();
    let _: () = conn.del(key).await?;
    stats::record(&st.db, site_id, Stat::Failed);
    Ok(Json(SolveResp::Failed { reason }))
}

pub async fn solve(
    State(st): State<AppState>,
    headers: HeaderMap,
    ApiJson(req): ApiJson<SolveReq>,
) -> ApiResult<Json<SolveResp>> {
    let key = format!("ch:{}", req.id);
    let Some(mut ch) = load_challenge(&st, &req.id).await? else {
        return Ok(Json(SolveResp::Failed { reason: "expired" }));
    };
    let elapsed_ms = Utc::now().timestamp_millis() - ch.issued_at_ms;
    // An undecryptable payload means the probe never ran (or was tampered with).
    let Some(payload) = decrypt_payload(&ch.probe, &req.payload) else {
        return fail(&st, &key, ch.site_id, "rejected").await;
    };
    let s = &payload.signals;
    let fp = &payload.fp;

    // A verified Private Access Token stands in for the proof-of-work.
    if !ch.pat && !pow::verify(&ch.salt, ch.bits, &req.nonces) {
        ch.attempts += 1;
        if ch.attempts >= MAX_SOLVE_ATTEMPTS {
            return fail(&st, &key, ch.site_id, "invalid_solution").await;
        }
        save_challenge(&st, &key, &ch).await?;
        return Ok(Json(SolveResp::Failed { reason: "invalid_solution" }));
    }

    // The probe must have run in an environment matching this request.
    let header_ua = user_agent(&headers);
    let expected_probe = ch.probe.evaluate(&EnvValues {
        ua_len: header_ua.encode_utf16().count() as u32,
        screen_w: s.screen_w,
        screen_h: s.screen_h,
        hardware_concurrency: s.hardware_concurrency,
        tz_offset: fp.tz_offset,
        lang_count: s.languages,
    });
    let probe_ok = payload.probe == Some(expected_probe);

    if s.webdriver || s.headless_ua || !probe_ok || ch.test == Some(TestSite::Fail) {
        if !probe_ok {
            tracing::debug!(challenge = %req.id, "probe mismatch");
        }
        return fail(&st, &key, ch.site_id, "rejected").await;
    }

    // Device tracking + reputation.
    let fp_hash = fingerprint::device_hash(fp, (s.screen_w, s.screen_h), s.hardware_concurrency);
    let subject = Subject {
        ip: ch.ip.clone(),
        asn: ch.net.asn,
        device: Some(reputation::device_id(&st.cfg.server_secret, &fp_hash)),
    };
    let rep = reputation::observe(&st.redis, &subject).await?;

    let mut flags = basic_flags(&ch, s, elapsed_ms);
    flags.extend(fingerprint::check(fp, header_ua, ch.net.ip_tz.as_deref()));
    flags.extend(risk::device_flags(&rep));
    let raw_score = risk::score(&flags) + ch.network_score;
    let score = if ch.pat { raw_score.saturating_sub(risk::PAT_CREDIT) } else { raw_score };
    if !flags.is_empty() || !ch.network_flags.is_empty() {
        tracing::debug!(
            challenge = %req.id, score, pat = ch.pat,
            flags = ?flags.iter().map(|f| f.name).chain(ch.network_flags.iter().map(String::as_str)).collect::<Vec<_>>(),
            "risk"
        );
    }

    if score >= risk::REJECT_AT {
        return fail(&st, &key, ch.site_id, "rejected").await;
    }

    let suspicious = score >= risk::INTERACT_AT || ch.test == Some(TestSite::Interactive);
    if ch.mode == "managed" && suspicious {
        if !s.interacted {
            if !ch.interaction_requested {
                ch.interaction_requested = true;
                stats::record(&st.db, ch.site_id, Stat::Interactive);
                save_challenge(&st, &key, &ch).await?;
            }
            return Ok(Json(SolveResp::InteractionRequired));
        }
        // A click we never asked for, or with no pointer/touch activity at all.
        if !ch.interaction_requested || (s.pointer_moves == 0 && !s.touch) {
            return fail(&st, &key, ch.site_id, "rejected").await;
        }
    }

    // Consume the challenge; losing the race to a concurrent solve means it's gone.
    let mut conn = st.redis.clone();
    let deleted: u32 = conn.del(&key).await?;
    if deleted == 0 {
        return Ok(Json(SolveResp::Failed { reason: "expired" }));
    }

    let clearance = ch.clearance_ttl.map(|ttl| ClearanceOut {
        value: st.clearance.issue(&ch.sitekey, &ch.hostname, header_ua, i64::from(ttl)),
        max_age: ttl,
    });
    let token = keys::new_token();
    let stored = StoredToken {
        site_id: ch.site_id,
        test: ch.test,
        hostname: ch.hostname,
        action: ch.action,
        cdata: ch.cdata,
        challenge_ts: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        subject,
        ephemeral_id: Some(reputation::ephemeral_id(&st.cfg.server_secret, ch.site_id, &fp_hash)),
        risk_score: score,
        pat: ch.pat,
    };
    let _: () = conn
        .set_ex(
            format!("tok:{token}"),
            serde_json::to_string(&stored).map_err(anyhow::Error::from)?,
            st.cfg.token_ttl_secs,
        )
        .await?;
    stats::record(&st.db, ch.site_id, Stat::Solved);
    if ch.pat {
        stats::record(&st.db, ch.site_id, Stat::Pat);
    }

    Ok(Json(SolveResp::Ok { token, expires_in: st.cfg.token_ttl_secs, clearance }))
}

#[cfg(test)]
mod tests {
    use super::adaptive_bits;

    #[test]
    fn adaptive_difficulty_ramps_and_caps() {
        assert_eq!(adaptive_bits(1), 0);
        assert_eq!(adaptive_bits(20), 0);
        assert_eq!(adaptive_bits(21), 1);
        assert_eq!(adaptive_bits(40), 2);
        assert_eq!(adaptive_bits(80), 3);
        assert_eq!(adaptive_bits(10_000), 6);
    }
}
