//! Browser fingerprint collected by the widget, checked for internal
//! consistency and against what the HTTP request itself reveals. Spoofing one
//! value is easy; keeping a dozen of them mutually consistent is what trips up
//! Puppeteer/Playwright stealth setups.

use chrono::{Offset, TimeZone, Utc};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Default, Deserialize, Clone)]
#[serde(default)]
pub struct UaData {
    pub brands: Vec<String>,
    pub mobile: bool,
    pub platform: String,
}

#[derive(Debug, Default, Deserialize, Clone)]
#[serde(default)]
pub struct Fingerprint {
    pub ua: String,
    pub platform: String,
    pub vendor: String,
    pub ua_data: Option<UaData>,
    pub timezone: String,
    /// `Date#getTimezoneOffset()`: minutes *behind* UTC.
    pub tz_offset: i32,
    pub canvas: String,
    pub webgl_vendor: String,
    pub webgl_renderer: String,
    pub audio: Vec<String>,
    pub video: Vec<String>,
    pub fonts_checked: bool,
    pub fonts: Vec<String>,
    pub dpr: f32,
    pub color_depth: u32,
    pub plugins: u32,
    pub chrome_obj: bool,
    pub moz: bool,
    pub eval_len: u32,
    pub notif_permission: String,
    pub notif_query: String,
    pub max_touch: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Blink,
    Gecko,
    WebKit,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Ios,
    Android,
    Linux,
    ChromeOs,
    Unknown,
}

#[derive(Debug, Clone, Copy)]
pub struct UaInfo {
    pub engine: Engine,
    pub os: Os,
    pub mobile: bool,
}

pub fn parse_ua(ua: &str) -> UaInfo {
    let os = if ua.contains("Windows") {
        Os::Windows
    } else if ua.contains("iPhone") || ua.contains("iPad") || ua.contains("iPod") {
        Os::Ios
    } else if ua.contains("Android") {
        Os::Android
    } else if ua.contains("CrOS") {
        Os::ChromeOs
    } else if ua.contains("Macintosh") || ua.contains("Mac OS X") {
        Os::Mac
    } else if ua.contains("Linux") {
        Os::Linux
    } else {
        Os::Unknown
    };
    // Every iOS browser is WebKit underneath.
    let engine = if os == Os::Ios {
        Engine::WebKit
    } else if ua.contains("Firefox/") {
        Engine::Gecko
    } else if ua.contains("Chrome/") || ua.contains("Chromium/") {
        Engine::Blink
    } else if ua.contains("Safari/") && ua.contains("Version/") {
        Engine::WebKit
    } else {
        Engine::Unknown
    };
    let mobile = matches!(os, Os::Ios | Os::Android) || ua.contains("Mobile");
    UaInfo { engine, os, mobile }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Flag {
    pub name: &'static str,
    pub weight: u32,
}

const fn flag(name: &'static str, weight: u32) -> Flag {
    Flag { name, weight }
}

fn tz_offset_minutes(tz: &str) -> Option<i32> {
    let tz: chrono_tz::Tz = tz.parse().ok()?;
    Some(tz.offset_from_utc_datetime(&Utc::now().naive_utc()).fix().local_minus_utc() / 60)
}

/// Consistency checks. `header_ua` is the request's `User-Agent`; `ip_tz` the
/// IP's timezone if a GeoIP City database is configured.
pub fn check(fp: &Fingerprint, header_ua: &str, ip_tz: Option<&str>) -> Vec<Flag> {
    let mut flags = Vec::new();
    let ua = parse_ua(header_ua);
    let renderer = fp.webgl_renderer.to_ascii_lowercase();

    if !fp.ua.is_empty() && fp.ua != header_ua {
        flags.push(flag("ua_mismatch", 3));
    }
    if ["swiftshader", "llvmpipe", "softpipe", "mesa offscreen"].iter().any(|s| renderer.contains(s)) {
        flags.push(flag("software_renderer", 2));
    } else if renderer.is_empty() && !ua.mobile {
        flags.push(flag("no_webgl", 1));
    }

    let engine_ok = match ua.engine {
        Engine::Blink => fp.chrome_obj && !fp.moz && fp.eval_len == 33 && fp.vendor.starts_with("Google"),
        Engine::Gecko => fp.moz && fp.eval_len == 37,
        Engine::WebKit => !fp.moz && fp.eval_len == 33 && fp.vendor.starts_with("Apple"),
        Engine::Unknown => true,
    };
    if !engine_ok {
        flags.push(flag("engine_mismatch", 2));
    }

    let p = fp.platform.as_str();
    let platform_ok = match ua.os {
        Os::Windows => p.starts_with("Win"),
        Os::Mac => p.starts_with("Mac"),
        Os::Ios => p.starts_with("iP") || p == "MacIntel",
        Os::Android => p.starts_with("Linux") || p.starts_with("Android"),
        Os::Linux | Os::ChromeOs => p.starts_with("Linux") || p.contains("CrOS"),
        Os::Unknown => true,
    };
    let ua_data_ok = fp.ua_data.as_ref().is_none_or(|d| {
        let dp = d.platform.as_str();
        dp.is_empty()
            || match ua.os {
                Os::Windows => dp == "Windows",
                Os::Mac => dp == "macOS",
                Os::Android => dp == "Android",
                Os::Linux => dp == "Linux",
                Os::ChromeOs => dp == "Chrome OS" || dp == "ChromeOS",
                _ => true,
            }
    });
    if !platform_ok || !ua_data_ok {
        flags.push(flag("platform_mismatch", 2));
    }
    if ua.mobile && matches!(ua.os, Os::Ios | Os::Android) && fp.max_touch == 0 {
        flags.push(flag("mobile_without_touch", 1));
    }

    // Classic headless tell: notifications denied without ever prompting.
    if fp.notif_permission == "denied" && fp.notif_query == "prompt" {
        flags.push(flag("permissions_inconsistent", 2));
    }
    if !ua.mobile && ua.engine != Engine::Unknown && fp.plugins == 0 {
        flags.push(flag("no_plugins", 1));
    }

    if fp.fonts_checked {
        let has = |names: &[&str]| names.iter().any(|n| fp.fonts.iter().any(|f| f == n));
        let fonts_ok = match ua.os {
            Os::Windows => has(&["Segoe UI", "Calibri", "Consolas"]),
            Os::Mac => has(&["Helvetica Neue", "Menlo", "Avenir"]),
            _ => true,
        };
        if !fonts_ok {
            flags.push(flag("fonts_os_mismatch", 1));
        }
    }

    if let Some(claimed) = tz_offset_minutes(&fp.timezone) {
        // getTimezoneOffset is UTC − local, so it should be the negation.
        if claimed != -fp.tz_offset {
            flags.push(flag("timezone_inconsistent", 2));
        }
        if let Some(ip) = ip_tz.and_then(tz_offset_minutes) {
            if (ip - claimed).abs() > 180 {
                flags.push(flag("timezone_vs_ip", 1));
            }
        }
    }

    if fp.canvas.is_empty() || fp.canvas == "error" {
        flags.push(flag("no_canvas", 1));
    }
    flags
}

/// Stable device hash from attributes that rarely change between visits.
pub fn device_hash(fp: &Fingerprint, screen: (u32, u32), hw: u32) -> [u8; 32] {
    let mut fonts = fp.fonts.clone();
    fonts.sort();
    let mut audio = fp.audio.clone();
    audio.sort();
    let mut video = fp.video.clone();
    video.sort();
    let parts = [
        fp.canvas.as_str(),
        &fp.webgl_vendor,
        &fp.webgl_renderer,
        &fonts.join(","),
        &audio.join(","),
        &video.join(","),
        &format!("{}x{}@{}", screen.0.max(screen.1), screen.0.min(screen.1), fp.dpr),
        &fp.color_depth.to_string(),
        &fp.timezone,
        &hw.to_string(),
        &fp.platform,
        &fp.max_touch.to_string(),
    ];
    Sha256::digest(parts.join("|").as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHROME_MAC: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

    fn real_chrome_mac() -> Fingerprint {
        Fingerprint {
            ua: CHROME_MAC.into(),
            platform: "MacIntel".into(),
            vendor: "Google Inc.".into(),
            ua_data: Some(UaData { brands: vec!["Chromium".into()], mobile: false, platform: "macOS".into() }),
            timezone: "UTC".into(),
            tz_offset: 0,
            canvas: "abc123".into(),
            webgl_vendor: "Google Inc. (Apple)".into(),
            webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)".into(),
            fonts_checked: true,
            fonts: vec!["Helvetica Neue".into(), "Menlo".into()],
            dpr: 2.0,
            color_depth: 30,
            plugins: 5,
            chrome_obj: true,
            eval_len: 33,
            notif_permission: "default".into(),
            notif_query: "prompt".into(),
            ..Default::default()
        }
    }

    #[test]
    fn genuine_browser_is_clean() {
        assert_eq!(check(&real_chrome_mac(), CHROME_MAC, None), vec![]);
    }

    #[test]
    fn headless_tells_are_flagged() {
        let mut fp = real_chrome_mac();
        fp.webgl_renderer = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))".into();
        fp.notif_permission = "denied".into();
        fp.plugins = 0;
        fp.platform = "Linux x86_64".into();
        let names: Vec<_> = check(&fp, CHROME_MAC, None).iter().map(|f| f.name).collect();
        assert!(names.contains(&"software_renderer"));
        assert!(names.contains(&"permissions_inconsistent"));
        assert!(names.contains(&"no_plugins"));
        assert!(names.contains(&"platform_mismatch"));
    }

    #[test]
    fn spoofed_ua_detected() {
        let fp = real_chrome_mac();
        let ff = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
        let names: Vec<_> = check(&fp, ff, None).iter().map(|f| f.name).collect();
        assert!(names.contains(&"ua_mismatch"));
        assert!(names.contains(&"engine_mismatch"));
        assert!(names.contains(&"fonts_os_mismatch"));
    }

    #[test]
    fn timezone_checks() {
        let mut fp = real_chrome_mac();
        fp.timezone = "Asia/Tokyo".into(); // UTC+9 → getTimezoneOffset = -540
        fp.tz_offset = -540;
        assert!(check(&fp, CHROME_MAC, Some("Asia/Tokyo")).is_empty());
        let names: Vec<_> = check(&fp, CHROME_MAC, Some("America/New_York")).iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["timezone_vs_ip"]);
        fp.tz_offset = 0;
        assert!(check(&fp, CHROME_MAC, None).iter().any(|f| f.name == "timezone_inconsistent"));
    }

    #[test]
    fn ua_parsing() {
        let i = parse_ua("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130 Mobile/15E148 Safari/604.1");
        assert_eq!((i.engine, i.os, i.mobile), (Engine::WebKit, Os::Ios, true));
        assert_eq!(parse_ua(CHROME_MAC).engine, Engine::Blink);
    }

    #[test]
    fn device_hash_is_order_insensitive() {
        let mut a = real_chrome_mac();
        let h1 = device_hash(&a, (1440, 900), 8);
        a.fonts.reverse();
        assert_eq!(h1, device_hash(&a, (900, 1440), 8));
    }
}
