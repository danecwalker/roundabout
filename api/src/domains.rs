//! Hostname allowlists. A site domain `example.com` also covers its subdomains;
//! the entry `*` allows any hostname.

pub const ANY_HOST: &str = "*";

/// Normalise user input like `https://Shop.Example.com:8443/path` to `shop.example.com`.
pub fn normalize_domain(input: &str) -> Option<String> {
    let mut s = input.trim().to_ascii_lowercase();
    for scheme in ["https://", "http://"] {
        if let Some(rest) = s.strip_prefix(scheme) {
            s = rest.to_string();
        }
    }
    let host = s.split(['/', '?', '#']).next()?;
    // Strip port (IPv6 literals are not supported as site domains).
    let host = host.rsplit_once(':').map_or(host, |(h, p)| {
        if p.chars().all(|c| c.is_ascii_digit()) {
            h
        } else {
            host
        }
    });
    let host = host.trim_end_matches('.');
    let valid = !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('.')
        && !host.starts_with('-')
        && !host.contains("..")
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    valid.then(|| host.to_string())
}

pub fn hostname_allowed(host: &str, domains: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    domains
        .iter()
        .any(|d| d == ANY_HOST || host == *d || host.strip_suffix(d.as_str()).is_some_and(|p| p.ends_with('.')))
}

/// Parse and canonicalise an origin (`scheme://host[:port]`). Rejects
/// anything else so the value is safe to put in a CSP header.
pub fn parse_origin(origin: &str) -> Option<(String, String)> {
    let (scheme, rest) = origin.split_once("://")?;
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let (host_part, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()) => (h, Some(p)),
        _ => (rest, None),
    };
    let host = normalize_domain(host_part)?;
    if host_part.to_ascii_lowercase().trim_end_matches('.') != host {
        return None; // contained a path, query or other junk
    }
    let canonical = match port {
        Some(p) => format!("{scheme}://{host}:{p}"),
        None => format!("{scheme}://{host}"),
    };
    Some((canonical, host))
}

/// CSP `frame-ancestors` for one embedding origin. The frame is told which
/// origin is embedding it; if that origin is allowed we name exactly it, and
/// the browser refuses to render if the real ancestor differs. This keeps the
/// header small for any number of site domains.
pub fn frame_ancestors(embedding_origin: Option<&str>, domains: &[String], extra_origins: &[String]) -> String {
    let mut sources = vec!["'self'".to_string()];
    if let Some((origin, host)) = embedding_origin.and_then(parse_origin) {
        if hostname_allowed(&host, domains) {
            sources.push(origin);
        }
    }
    sources.extend(extra_origins.iter().cloned());
    sources.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(normalize_domain("https://Shop.Example.com:8443/x").as_deref(), Some("shop.example.com"));
        assert_eq!(normalize_domain("localhost:5173").as_deref(), Some("localhost"));
        assert_eq!(normalize_domain("example.com.").as_deref(), Some("example.com"));
        assert_eq!(normalize_domain("").as_deref(), None);
        assert_eq!(normalize_domain("bad host").as_deref(), None);
        assert_eq!(normalize_domain("a..b").as_deref(), None);
    }

    #[test]
    fn matches_subdomains_only_on_label_boundary() {
        let d = vec!["example.com".to_string()];
        assert!(hostname_allowed("example.com", &d));
        assert!(hostname_allowed("a.b.Example.com", &d));
        assert!(!hostname_allowed("badexample.com", &d));
        assert!(!hostname_allowed("example.com.evil.io", &d));
    }

    #[test]
    fn ancestors() {
        let d = vec!["example.com".to_string()];
        let extra = vec!["http://localhost:5180".to_string()];
        assert_eq!(
            frame_ancestors(Some("https://shop.example.com"), &d, &extra),
            "'self' https://shop.example.com http://localhost:5180"
        );
        assert_eq!(frame_ancestors(Some("https://evil.io"), &d, &[]), "'self'");
        assert_eq!(frame_ancestors(None, &d, &[]), "'self'");
        // Header injection attempts are dropped.
        assert_eq!(frame_ancestors(Some("https://example.com; script-src *"), &d, &[]), "'self'");
        assert_eq!(frame_ancestors(Some("https://example.com/x"), &d, &[]), "'self'");
        assert_eq!(frame_ancestors(Some("http://localhost:3000"), &["localhost".into()], &[]), "'self' http://localhost:3000");
    }

    #[test]
    fn wildcard() {
        let any = vec![ANY_HOST.to_string()];
        assert!(hostname_allowed("anything.example", &any));
        assert_eq!(frame_ancestors(Some("https://a.b"), &any, &[]), "'self' https://a.b");
    }
}
