//! Network reputation: classify client IPs as datacenter / Tor / VPN using
//! published cloud ranges, the Tor exit list, an optional MaxMind ASN database
//! and a list of hosting/VPN ASNs. Most bot traffic comes from rented servers,
//! so this is one of the cheapest strong signals available.

use std::{
    collections::HashSet,
    net::IpAddr,
    sync::{Arc, RwLock},
    time::Duration,
};

use ipnet::IpNet;
use maxminddb::{geoip2, Reader};
use serde::{Deserialize, Serialize};

use crate::config::Config;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetCategory {
    Datacenter,
    Vpn,
    Tor,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NetInfo {
    pub category: Option<NetCategory>,
    /// Provider label, e.g. "aws", "gcp", "tor", or the ASN organisation.
    pub provider: Option<String>,
    pub asn: Option<u32>,
    /// IANA timezone of the IP's location (needs the City database).
    pub ip_tz: Option<String>,
    pub country: Option<String>,
}

impl NetInfo {
    /// Coarse network bucket used for reputation: /24 for IPv4, /48 for IPv6.
    pub fn net_prefix(ip: &str) -> Option<String> {
        match ip.parse::<IpAddr>().ok()? {
            IpAddr::V4(v4) => {
                let o = v4.octets();
                Some(format!("{}.{}.{}.0/24", o[0], o[1], o[2]))
            }
            IpAddr::V6(v6) => {
                let s = v6.segments();
                Some(format!("{:x}:{:x}:{:x}::/48", s[0], s[1], s[2]))
            }
        }
    }
}

/// Well-known hosting and VPN ASNs, applied when an ASN database is present.
const HOSTING_ASNS: &[(u32, &str)] = &[
    (16509, "aws"), (14618, "aws"), (15169, "google"), (396982, "gcp"), (8075, "azure"),
    (14061, "digitalocean"), (24940, "hetzner"), (16276, "ovh"), (63949, "linode"),
    (20473, "vultr"), (31898, "oracle"), (45102, "alibaba"), (132203, "tencent"),
    (12876, "scaleway"), (51167, "contabo"), (53667, "frantech"), (36352, "colocrossing"),
    (62240, "clouvider"), (202425, "ipvolume"), (29802, "hvc"), (46606, "unifiedlayer"),
    (8100, "quadranet"), (40021, "contabo-us"), (197540, "netcup"), (213230, "hetzner-cloud"),
];
const VPN_ASNS: &[(u32, &str)] = &[
    (9009, "m247"), (60068, "datacamp"), (212238, "datacamp"), (136787, "tefincom"),
    (207137, "packethub"), (147049, "packethub"), (209854, "surfshark"), (39351, "31173"),
];

#[derive(Default)]
struct RangeTable {
    v4: Vec<(u32, u32, u16)>,
    v6: Vec<(u128, u128, u16)>,
    labels: Vec<(NetCategory, String)>,
}

impl RangeTable {
    fn label_idx(&mut self, cat: NetCategory, label: &str) -> u16 {
        if let Some(i) = self.labels.iter().position(|(c, l)| *c == cat && l == label) {
            return i as u16;
        }
        self.labels.push((cat, label.to_string()));
        (self.labels.len() - 1) as u16
    }

    fn add(&mut self, net: IpNet, cat: NetCategory, label: &str) {
        let idx = self.label_idx(cat, label);
        match net {
            IpNet::V4(n) => self.v4.push((n.network().into(), n.broadcast().into(), idx)),
            IpNet::V6(n) => self.v6.push((n.network().into(), n.broadcast().into(), idx)),
        }
    }

    /// Sort and merge overlapping ranges (first label wins) so lookups can binary-search.
    fn finish(&mut self) {
        fn merge<T: Ord + Copy + num_like::Succ>(v: &mut Vec<(T, T, u16)>) {
            v.sort_by_key(|r| r.0);
            let mut out: Vec<(T, T, u16)> = Vec::with_capacity(v.len());
            for r in v.drain(..) {
                match out.last_mut() {
                    Some(last) if r.0 <= last.1.succ() => {
                        if r.1 > last.1 {
                            last.1 = r.1;
                        }
                    }
                    _ => out.push(r),
                }
            }
            *v = out;
        }
        merge(&mut self.v4);
        merge(&mut self.v6);
    }

    fn lookup(&self, ip: IpAddr) -> Option<&(NetCategory, String)> {
        fn find<T: Ord + Copy>(v: &[(T, T, u16)], x: T) -> Option<u16> {
            let i = v.partition_point(|r| r.0 <= x);
            (i > 0 && v[i - 1].1 >= x).then(|| v[i - 1].2)
        }
        let idx = match ip {
            IpAddr::V4(a) => find(&self.v4, u32::from(a)),
            IpAddr::V6(a) => match a.to_ipv4_mapped() {
                Some(v4) => find(&self.v4, u32::from(v4)),
                None => find(&self.v6, u128::from(a)),
            },
        }?;
        self.labels.get(idx as usize)
    }

    fn len(&self) -> usize {
        self.v4.len() + self.v6.len()
    }
}

mod num_like {
    pub trait Succ {
        fn succ(self) -> Self;
    }
    impl Succ for u32 {
        fn succ(self) -> Self {
            self.saturating_add(1)
        }
    }
    impl Succ for u128 {
        fn succ(self) -> Self {
            self.saturating_add(1)
        }
    }
}

#[derive(Default)]
struct Snapshot {
    ranges: RangeTable,
    tor: HashSet<IpAddr>,
}

pub struct NetRep {
    snap: RwLock<Arc<Snapshot>>,
    asn_db: Option<Reader<Vec<u8>>>,
    city_db: Option<Reader<Vec<u8>>>,
    extra_file: Option<String>,
}

impl NetRep {
    pub fn new(cfg: &Config) -> Self {
        let open = |p: &Option<String>, name: &str| {
            p.as_ref().and_then(|path| match Reader::open_readfile(path) {
                Ok(r) => {
                    tracing::info!("loaded MaxMind {name} database from {path}");
                    Some(r)
                }
                Err(e) => {
                    tracing::warn!("could not open MaxMind {name} database {path}: {e}");
                    None
                }
            })
        };
        let rep = Self {
            snap: RwLock::new(Arc::new(Snapshot::default())),
            asn_db: open(&cfg.maxmind_asn_db, "ASN"),
            city_db: open(&cfg.maxmind_city_db, "City"),
            extra_file: cfg.netrep_extra_file.clone(),
        };
        // Load local extras immediately so they apply before the first fetch.
        let mut table = RangeTable::default();
        rep.load_extra(&mut table);
        table.finish();
        *rep.snap.write().unwrap() = Arc::new(Snapshot { ranges: table, tor: HashSet::new() });
        rep
    }

    pub fn lookup(&self, ip: &str) -> NetInfo {
        let Ok(addr) = ip.parse::<IpAddr>() else { return NetInfo::default() };
        let snap = self.snap.read().unwrap().clone();
        let mut info = NetInfo::default();

        if snap.tor.contains(&addr) {
            info.category = Some(NetCategory::Tor);
            info.provider = Some("tor".into());
        } else if let Some((cat, label)) = snap.ranges.lookup(addr) {
            info.category = Some(*cat);
            info.provider = Some(label.clone());
        }

        if let Some(db) = &self.asn_db {
            if let Ok(asn) = db.lookup::<geoip2::Asn>(addr) {
                info.asn = asn.autonomous_system_number;
                if info.category.is_none() {
                    if let Some(n) = info.asn {
                        if let Some((_, l)) = VPN_ASNS.iter().find(|(a, _)| *a == n) {
                            info.category = Some(NetCategory::Vpn);
                            info.provider = Some((*l).into());
                        } else if let Some((_, l)) = HOSTING_ASNS.iter().find(|(a, _)| *a == n) {
                            info.category = Some(NetCategory::Datacenter);
                            info.provider = Some((*l).into());
                        }
                    }
                }
                if info.provider.is_none() {
                    info.provider = asn.autonomous_system_organization.map(str::to_string);
                }
            }
        }
        if let Some(db) = &self.city_db {
            if let Ok(city) = db.lookup::<geoip2::City>(addr) {
                info.ip_tz = city.location.and_then(|l| l.time_zone).map(str::to_string);
                info.country = city.country.and_then(|c| c.iso_code).map(str::to_string);
            }
        }
        info
    }

    fn load_extra(&self, table: &mut RangeTable) {
        let Some(path) = &self.extra_file else { return };
        match std::fs::read_to_string(path) {
            Ok(text) => {
                for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
                    let mut parts = line.split_whitespace();
                    let (Some(cidr), cat) = (parts.next(), parts.next().unwrap_or("datacenter")) else { continue };
                    let label = parts.next().unwrap_or("custom");
                    let cat = match cat {
                        "vpn" => NetCategory::Vpn,
                        "tor" => NetCategory::Tor,
                        _ => NetCategory::Datacenter,
                    };
                    if let Some(net) = parse_net(cidr) {
                        table.add(net, cat, label);
                    }
                }
            }
            Err(e) => tracing::warn!("could not read NETREP_EXTRA_FILE {path}: {e}"),
        }
    }

    /// Fetch every list; a failed source keeps no data from it but doesn't block the rest.
    pub async fn refresh(&self, http: &reqwest::Client) {
        let mut table = RangeTable::default();
        self.load_extra(&mut table);
        for src in SOURCES {
            match fetch_text(http, src.url).await {
                Ok(body) => {
                    let nets = (src.parse)(&body);
                    tracing::debug!("netrep: {} → {} ranges", src.label, nets.len());
                    for n in nets {
                        table.add(n, NetCategory::Datacenter, src.label);
                    }
                }
                Err(e) => tracing::warn!("netrep: fetching {} failed: {e}", src.label),
            }
        }
        let tor: HashSet<IpAddr> = match fetch_text(http, TOR_EXITS).await {
            Ok(body) => body.lines().filter_map(|l| l.trim().parse().ok()).collect(),
            Err(e) => {
                tracing::warn!("netrep: fetching Tor exits failed: {e}");
                self.snap.read().unwrap().tor.clone()
            }
        };
        table.finish();
        tracing::info!("netrep: {} merged ranges, {} Tor exits", table.len(), tor.len());
        *self.snap.write().unwrap() = Arc::new(Snapshot { ranges: table, tor });
    }

    pub fn spawn_refresh(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .user_agent("roundabout-netrep/0.1")
                .build()
                .expect("http client");
            loop {
                me.refresh(&http).await;
                tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
            }
        });
    }
}

async fn fetch_text(http: &reqwest::Client, url: &str) -> reqwest::Result<String> {
    http.get(url).send().await?.error_for_status()?.text().await
}

fn parse_net(s: &str) -> Option<IpNet> {
    let s = s.trim();
    s.parse::<IpNet>()
        .ok()
        .or_else(|| s.parse::<IpAddr>().ok().map(IpNet::from))
        .map(|n| n.trunc())
}

const TOR_EXITS: &str = "https://check.torproject.org/torbulkexitlist";

struct Source {
    label: &'static str,
    url: &'static str,
    parse: fn(&str) -> Vec<IpNet>,
}

fn json_strings(body: &str, array: &str, fields: &[&str]) -> Vec<IpNet> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else { return vec![] };
    v.get(array)
        .and_then(|a| a.as_array())
        .into_iter()
        .flatten()
        .flat_map(|item| fields.iter().filter_map(move |f| item.get(*f)?.as_str()))
        .filter_map(parse_net)
        .collect()
}

fn parse_aws(body: &str) -> Vec<IpNet> {
    let mut v = json_strings(body, "prefixes", &["ip_prefix"]);
    v.extend(json_strings(body, "ipv6_prefixes", &["ipv6_prefix"]));
    v
}

fn parse_gcp(body: &str) -> Vec<IpNet> {
    json_strings(body, "prefixes", &["ipv4Prefix", "ipv6Prefix"])
}

fn parse_oracle(body: &str) -> Vec<IpNet> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else { return vec![] };
    v["regions"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|r| r["cidrs"].as_array().into_iter().flatten())
        .filter_map(|c| parse_net(c["cidr"].as_str()?))
        .collect()
}

/// CSV / plain lists where the first field of each line is a CIDR.
fn parse_first_column(body: &str) -> Vec<IpNet> {
    body.lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| parse_net(l.split(',').next()?))
        .collect()
}

const SOURCES: &[Source] = &[
    Source { label: "aws", url: "https://ip-ranges.amazonaws.com/ip-ranges.json", parse: parse_aws },
    Source { label: "gcp", url: "https://www.gstatic.com/ipranges/cloud.json", parse: parse_gcp },
    Source { label: "oracle", url: "https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json", parse: parse_oracle },
    Source { label: "digitalocean", url: "https://digitalocean.com/geo/google.csv", parse: parse_first_column },
    Source { label: "linode", url: "https://geoip.linode.com/", parse: parse_first_column },
    Source { label: "cloudflare", url: "https://www.cloudflare.com/ips-v4", parse: parse_first_column },
    Source { label: "cloudflare", url: "https://www.cloudflare.com/ips-v6", parse: parse_first_column },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_lookup_with_overlaps() {
        let mut t = RangeTable::default();
        t.add("10.0.0.0/8".parse().unwrap(), NetCategory::Datacenter, "a");
        t.add("10.1.0.0/16".parse().unwrap(), NetCategory::Datacenter, "b");
        t.add("192.168.1.0/24".parse().unwrap(), NetCategory::Vpn, "v");
        t.add("2600:1f00::/24".parse().unwrap(), NetCategory::Datacenter, "aws");
        t.finish();
        assert_eq!(t.lookup("10.1.2.3".parse().unwrap()).unwrap().1, "a");
        assert_eq!(t.lookup("192.168.1.255".parse().unwrap()).unwrap().0, NetCategory::Vpn);
        assert!(t.lookup("192.168.2.0".parse().unwrap()).is_none());
        assert!(t.lookup("11.0.0.0".parse().unwrap()).is_none());
        assert_eq!(t.lookup("2600:1f00::1".parse().unwrap()).unwrap().1, "aws");
        assert_eq!(t.lookup("::ffff:10.0.0.1".parse().unwrap()).unwrap().1, "a");
    }

    #[test]
    fn parsers() {
        let aws = r#"{"prefixes":[{"ip_prefix":"3.0.0.0/15"}],"ipv6_prefixes":[{"ipv6_prefix":"2600:1f00::/24"}]}"#;
        assert_eq!(parse_aws(aws).len(), 2);
        assert_eq!(parse_first_column("# c\n1.2.3.0/24,US,x\n5.6.7.8\n").len(), 2);
        assert_eq!(NetInfo::net_prefix("1.2.3.4").as_deref(), Some("1.2.3.0/24"));
        assert_eq!(NetInfo::net_prefix("2001:db8:1:2::1").as_deref(), Some("2001:db8:1::/48"));
    }
}
