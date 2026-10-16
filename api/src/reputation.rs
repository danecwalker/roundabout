//! Redis-backed reputation built from two sources:
//!
//! - **Device tracking**: a device ID (HMAC of the fingerprint hash, global and
//!   never exposed) lets us spot one device cycling through many IPs, or one
//!   IP hosting an unusual number of devices (bot farms).
//! - **Customer feedback**: sites report verified tokens as `abuse`/`legit`
//!   via `/v1/feedback`; reports count against the token's IP, /24 (or /48),
//!   ASN and device for 7 days.
//!
//! Customers get a per-site, daily-rotating `ephemeral_id` derived from the
//! same fingerprint, so they can rate-limit a device without us handing out a
//! stable cross-site identifier.

use hmac::{Hmac, Mac};
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

use crate::{error::ApiResult, netrep::NetInfo};

const REP_TTL_SECS: i64 = 7 * 24 * 3600;
const TRACK_TTL_SECS: i64 = 3600;

fn hmac_hex(secret: &[u8], parts: &[&[u8]], bytes: usize) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("hmac key");
    for p in parts {
        mac.update(p);
        mac.update(b"|");
    }
    hex::encode(&mac.finalize().into_bytes()[..bytes])
}

/// Global internal device ID.
pub fn device_id(secret: &[u8], fp_hash: &[u8; 32]) -> String {
    hmac_hex(secret, &[b"device", fp_hash], 16)
}

/// Per-site, per-day ID returned to customers in siteverify.
pub fn ephemeral_id(secret: &[u8], site_id: Option<Uuid>, fp_hash: &[u8; 32]) -> String {
    let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let site = site_id.map(|s| s.to_string()).unwrap_or_default();
    format!("eid_{}", hmac_hex(secret, &[b"eid", site.as_bytes(), day.as_bytes(), fp_hash], 12))
}

/// Who a token was issued to, kept after redemption so feedback can find it.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Subject {
    pub ip: String,
    pub asn: Option<u32>,
    pub device: Option<String>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct RepScores {
    pub ip: i64,
    pub net: i64,
    pub asn: i64,
    pub device: i64,
    /// Distinct IPs this device used in the last hour.
    pub device_ips: u64,
    /// Distinct devices seen from this IP in the last hour.
    pub ip_devices: u64,
}

fn rep_keys(s: &Subject) -> Vec<String> {
    let mut keys = vec![format!("rep:ip:{}", s.ip)];
    if let Some(net) = NetInfo::net_prefix(&s.ip) {
        keys.push(format!("rep:net:{net}"));
    }
    if let Some(asn) = s.asn {
        keys.push(format!("rep:asn:{asn}"));
    }
    if let Some(d) = &s.device {
        keys.push(format!("rep:dev:{d}"));
    }
    keys
}

/// Record that `device` was seen on `ip`, then read every reputation counter.
pub async fn observe(redis: &ConnectionManager, s: &Subject) -> ApiResult<RepScores> {
    let mut conn = redis.clone();
    let mut pipe = redis::pipe();
    if let Some(d) = &s.device {
        let dk = format!("trk:dev:{d}");
        let ik = format!("trk:ip:{}", s.ip);
        pipe.cmd("PFADD").arg(&dk).arg(&s.ip).ignore();
        pipe.expire(&dk, TRACK_TTL_SECS).ignore();
        pipe.cmd("PFADD").arg(&ik).arg(d).ignore();
        pipe.expire(&ik, TRACK_TTL_SECS).ignore();
        pipe.cmd("PFCOUNT").arg(&dk);
        pipe.cmd("PFCOUNT").arg(&ik);
    }
    let ip_key = format!("rep:ip:{}", s.ip);
    let net_key = NetInfo::net_prefix(&s.ip).map(|n| format!("rep:net:{n}")).unwrap_or_default();
    let asn_key = s.asn.map(|a| format!("rep:asn:{a}")).unwrap_or_default();
    let dev_key = s.device.as_ref().map(|d| format!("rep:dev:{d}")).unwrap_or_default();
    pipe.get(&ip_key).get(&net_key).get(&asn_key).get(&dev_key);

    let mut out = RepScores::default();
    if s.device.is_some() {
        let (device_ips, ip_devices, ip, net, asn, dev): (u64, u64, Option<i64>, Option<i64>, Option<i64>, Option<i64>) =
            pipe.query_async(&mut conn).await?;
        out = RepScores { ip: ip.unwrap_or(0), net: net.unwrap_or(0), asn: asn.unwrap_or(0), device: dev.unwrap_or(0), device_ips, ip_devices };
    } else {
        let (ip, net, asn, dev): (Option<i64>, Option<i64>, Option<i64>, Option<i64>) = pipe.query_async(&mut conn).await?;
        out.ip = ip.unwrap_or(0);
        out.net = net.unwrap_or(0);
        out.asn = asn.unwrap_or(0);
        out.device = dev.unwrap_or(0);
    }
    Ok(out)
}

/// Read-only lookup at challenge time (before we have a fingerprint).
pub async fn ip_scores(redis: &ConnectionManager, ip: &str, asn: Option<u32>) -> ApiResult<RepScores> {
    let mut conn = redis.clone();
    let net_key = NetInfo::net_prefix(ip).map(|n| format!("rep:net:{n}")).unwrap_or_default();
    let asn_key = asn.map(|a| format!("rep:asn:{a}")).unwrap_or_default();
    let (ip_s, net, asn_s): (Option<i64>, Option<i64>, Option<i64>) = redis::pipe()
        .get(format!("rep:ip:{ip}"))
        .get(net_key)
        .get(asn_key)
        .query_async(&mut conn)
        .await?;
    Ok(RepScores { ip: ip_s.unwrap_or(0), net: net.unwrap_or(0), asn: asn_s.unwrap_or(0), ..Default::default() })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Abuse,
    Legit,
}

/// Apply a customer report. Abuse adds 1 to every bucket; legit removes 1 from
/// the IP and device buckets (never below zero).
pub async fn report(redis: &ConnectionManager, s: &Subject, verdict: Verdict) -> ApiResult<()> {
    let mut conn = redis.clone();
    let keys = rep_keys(s);
    match verdict {
        Verdict::Abuse => {
            let mut pipe = redis::pipe();
            for k in &keys {
                pipe.incr(k, 1).ignore().expire(k, REP_TTL_SECS).ignore();
            }
            let _: () = pipe.query_async(&mut conn).await?;
        }
        Verdict::Legit => {
            // DECR with a floor of zero, atomically.
            let script = redis::Script::new(
                "local v = redis.call('DECR', KEYS[1]) if v < 0 then redis.call('SET', KEYS[1], 0) end return v",
            );
            for k in keys.iter().filter(|k| k.starts_with("rep:ip:") || k.starts_with("rep:dev:")) {
                let _: i64 = script.key(k).invoke_async(&mut conn).await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_scoped() {
        let fp = [3u8; 32];
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        assert_eq!(device_id(b"k", &fp), device_id(b"k", &fp));
        assert_ne!(device_id(b"k", &fp), device_id(b"other", &fp));
        assert_ne!(ephemeral_id(b"k", Some(a), &fp), ephemeral_id(b"k", Some(b), &fp));
        assert!(ephemeral_id(b"k", Some(a), &fp).starts_with("eid_"));
    }
}
