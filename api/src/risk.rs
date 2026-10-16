//! Combines every signal into one risk decision.
//!
//! Weights are deliberately small integers so the policy is easy to reason
//! about: a VPN alone (1) never forces a click, a datacenter IP (2) does in
//! managed mode, and stacking several tells gets a request rejected outright.

use crate::{
    fingerprint::Flag,
    netrep::{NetCategory, NetInfo},
    reputation::RepScores,
};

/// Managed mode asks for an interaction at or above this score.
pub const INTERACT_AT: u32 = 2;
/// Any mode rejects at or above this score.
pub const REJECT_AT: u32 = 7;
/// Score credit for a verified Private Access Token.
pub const PAT_CREDIT: u32 = 3;

const fn f(name: &'static str, weight: u32) -> Flag {
    Flag { name, weight }
}

pub fn network_flags(net: &NetInfo, rep: &RepScores) -> Vec<Flag> {
    let mut v = Vec::new();
    match net.category {
        Some(NetCategory::Tor) => v.push(f("tor", 3)),
        Some(NetCategory::Datacenter) => v.push(f("datacenter", 2)),
        Some(NetCategory::Vpn) => v.push(f("vpn", 1)),
        None => {}
    }
    if rep.ip >= 3 {
        v.push(f("ip_reported", 2));
    }
    if rep.net >= 10 {
        v.push(f("net_reported", 1));
    }
    if rep.asn >= 50 {
        v.push(f("asn_reported", 1));
    }
    v
}

pub fn device_flags(rep: &RepScores) -> Vec<Flag> {
    let mut v = Vec::new();
    if rep.device >= 2 {
        v.push(f("device_reported", 2));
    }
    if rep.device_ips > 5 {
        v.push(f("device_ip_cycling", 2));
    }
    if rep.ip_devices > 20 {
        v.push(f("ip_device_farm", 1));
    }
    v
}

pub fn score(flags: &[Flag]) -> u32 {
    flags.iter().map(|f| f.weight).sum()
}

/// Extra PoW bits for a risky network, known before any JS runs.
pub fn network_bits(flags: &[Flag]) -> u8 {
    (score(flags) * 3 / 2).min(6) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_policy() {
        let dc = NetInfo { category: Some(NetCategory::Datacenter), ..Default::default() };
        let flags = network_flags(&dc, &RepScores::default());
        assert_eq!(score(&flags), 2);
        assert_eq!(network_bits(&flags), 3);
        let vpn = NetInfo { category: Some(NetCategory::Vpn), ..Default::default() };
        assert!(score(&network_flags(&vpn, &RepScores::default())) < INTERACT_AT);
        let reported = RepScores { ip: 5, net: 12, ..Default::default() };
        assert_eq!(score(&network_flags(&NetInfo::default(), &reported)), 3);
        assert_eq!(network_bits(&[f("x", 9)]), 6);
    }
}
