//! Per-challenge probe scripts.
//!
//! `frame.js` is the same for everyone (modulo build variants), so on its own
//! a bot author could reverse it once and replay requests without a browser.
//! Each challenge therefore gets a freshly generated, single-use script that:
//!
//! - computes a value from a random sequence of 32-bit operations mixed with
//!   reads of the browser environment (UA length, screen, timezone, DOM round
//!   trips, `navigator.webdriver`, its own decoder's source length);
//! - carries a random 128-bit key the frame uses to encrypt the solve payload,
//!   so signals and fingerprint never cross the wire in the clear;
//! - is heavily obfuscated, differently every time: a rotated, XOR-encoded
//!   string table behind a decoder, every property access through proxy
//!   functions, numbers as random arithmetic expressions, control flow
//!   flattened into a shuffled `switch` dispatcher driven by an encoded order
//!   string, opaque predicates, dead cases and junk functions.
//!
//! The server replays the same operations in Rust against what it knows (the
//! request's own User-Agent, the decrypted signals) and rejects a solve whose
//! probe output or payload doesn't check out. A determined attacker can still
//! run the script in a real browser — the point is that every challenge is a
//! new program, so static solvers and one-time reverse engineering don't scale.

use rand::{rngs::ThreadRng, seq::SliceRandom, Rng};
use serde::{Deserialize, Serialize};

const MIX: u32 = 0x9E37_79B1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Env {
    /// `navigator.userAgent.length`, checked against the request header.
    UaLen,
    ScreenW,
    ScreenH,
    HardwareConcurrency,
    TzOffset,
    LangCount,
    /// `navigator.webdriver ? 1 : 0`, must be 0.
    Webdriver,
    /// Length of a random string after a DOM text-node round trip.
    DomText(u8),
    /// `typeof canvas.getContext === "function"`, must be 1.
    CanvasCtx,
    /// `decoder.toString().length`: changes if the script is beautified or patched.
    SelfLen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Op {
    Add(u32),
    Xor(u32),
    Mul(u32),
    Rotl(u8),
    Mix(Env),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Probe {
    pub seed: u32,
    pub ops: Vec<Op>,
    /// Payload encryption key exported by the script.
    pub key: [u32; 4],
    /// Source length of the generated decoder (set by `render_js`).
    #[serde(default)]
    pub self_len: u32,
}

/// Environment values the server expects the probe to observe.
#[derive(Debug, Default, Clone)]
pub struct EnvValues {
    pub ua_len: u32,
    pub screen_w: u32,
    pub screen_h: u32,
    pub hardware_concurrency: u32,
    pub tz_offset: i32,
    pub lang_count: u32,
}

impl Probe {
    pub fn generate() -> Self {
        let mut rng = rand::thread_rng();
        let mut envs = vec![
            Env::UaLen,
            Env::ScreenW,
            Env::ScreenH,
            Env::HardwareConcurrency,
            Env::TzOffset,
            Env::LangCount,
            Env::Webdriver,
            Env::CanvasCtx,
            Env::SelfLen,
            Env::DomText(rng.gen_range(4..40)),
        ];
        envs.shuffle(&mut rng);
        let mut ops = Vec::new();
        for env in envs {
            for _ in 0..rng.gen_range(1..4) {
                ops.push(match rng.gen_range(0..4) {
                    0 => Op::Add(rng.gen()),
                    1 => Op::Xor(rng.gen()),
                    2 => Op::Mul(rng.gen::<u32>() | 1),
                    _ => Op::Rotl(rng.gen_range(1..32)),
                });
            }
            ops.push(Op::Mix(env));
        }
        Self { seed: rng.gen(), ops, key: rng.gen(), self_len: 0 }
    }

    pub fn key_hex(&self) -> String {
        self.key.iter().map(|k| format!("{k:08x}")).collect()
    }

    pub fn evaluate(&self, env: &EnvValues) -> u32 {
        let mut x = self.seed;
        for op in &self.ops {
            x = match *op {
                Op::Add(c) => x.wrapping_add(c),
                Op::Xor(c) => x ^ c,
                Op::Mul(c) => x.wrapping_mul(c),
                Op::Rotl(n) => x.rotate_left(u32::from(n)),
                Op::Mix(e) => {
                    let v: u32 = match e {
                        Env::UaLen => env.ua_len,
                        Env::ScreenW => env.screen_w,
                        Env::ScreenH => env.screen_h,
                        Env::HardwareConcurrency => env.hardware_concurrency,
                        Env::TzOffset => env.tz_offset as u32,
                        Env::LangCount => env.lang_count,
                        Env::Webdriver => 0,
                        Env::DomText(n) => u32::from(n),
                        Env::CanvasCtx => 1,
                        Env::SelfLen => self.self_len,
                    };
                    (x ^ v).wrapping_mul(MIX)
                }
            };
        }
        x
    }

    /// Render the obfuscated script. It stores `[result, k0, k1, k2, k3]` in
    /// `self.__rbp[<challenge id>]`. Records the decoder length for `evaluate`.
    pub fn render_js(&mut self, challenge_id: &str) -> String {
        let mut g = Gen::new();
        let js = g.render(self, challenge_id);
        self.self_len = g.decoder_len;
        js
    }
}

// ---------------------------------------------------------------------------
// Obfuscating code generator

struct Gen {
    rng: ThreadRng,
    used: std::collections::HashSet<String>,
    strings: Vec<String>,
    decoder_len: u32,
}

impl Gen {
    fn new() -> Self {
        Self { rng: rand::thread_rng(), used: Default::default(), strings: Vec::new(), decoder_len: 0 }
    }

    fn ident(&mut self) -> String {
        const FIRST: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$";
        const REST: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$";
        loop {
            let len = self.rng.gen_range(2..6);
            let mut s = String::new();
            s.push(*FIRST.choose(&mut self.rng).unwrap() as char);
            for _ in 0..len {
                s.push(*REST.choose(&mut self.rng).unwrap() as char);
            }
            // Avoid JS reserved words and collisions.
            if !matches!(s.as_str(), "do" | "if" | "in" | "for" | "let" | "new" | "try" | "var" | "case" | "else" | "enum" | "eval" | "null" | "this" | "true" | "void" | "with")
                && self.used.insert(s.clone())
            {
                return s;
            }
        }
    }

    fn sidx(&mut self, s: &str) -> usize {
        if let Some(i) = self.strings.iter().position(|x| x == s) {
            return i;
        }
        self.strings.push(s.to_string());
        self.strings.len() - 1
    }

    /// A 32-bit constant as a random expression (only the low 32 bits are meaningful).
    fn num(&mut self, c: u32) -> String {
        match self.rng.gen_range(0..4) {
            0 => {
                let a: u32 = self.rng.gen();
                format!("({:#x}^{:#x})", a, a ^ c)
            }
            1 => {
                let a: u32 = self.rng.gen();
                format!("(({:#x}+{})|0)", a, c.wrapping_sub(a))
            }
            2 => {
                let b: u32 = self.rng.gen();
                format!("(({}-{:#x})|0)", c.wrapping_add(b), b)
            }
            _ => format!("(~{:#x})", !c),
        }
    }

    fn rnum(&mut self) -> String {
        let c = self.rng.gen();
        self.num(c)
    }

    fn rsmall(&mut self, lo: u32, hi: u32) -> String {
        let n = self.rng.gen_range(lo..hi);
        self.small(n)
    }

    /// A small non-negative integer as an exact expression.
    fn small(&mut self, n: u32) -> String {
        match self.rng.gen_range(0..3) {
            0 => {
                let a = self.rng.gen_range(0..0x4000u32);
                format!("({:#x}^{:#x})", a, a ^ n)
            }
            1 => {
                let a = self.rng.gen_range(0..0x4000u32);
                format!("({}-{:#x})", n + a, a)
            }
            _ => format!("{n}"),
        }
    }

    fn render(&mut self, p: &Probe, challenge_id: &str) -> String {
        let [t, d, gf, mf, x, y, z, q, pi, cache] = std::array::from_fn(|_| self.ident());
        let k0: u32 = self.rng.gen_range(1..256);
        let k1: u32 = self.rng.gen_range(1..256);
        let k2: u32 = self.rng.gen_range(1..256);
        let off: u32 = self.rng.gen_range(0x100..0x800);

        // Pre-register strings so indices are stable.
        let names = [
            "navigator", "userAgent", "length", "screen", "width", "height", "hardwareConcurrency",
            "getTimezoneOffset", "languages", "webdriver", "document", "createElement", "canvas",
            "getContext", "function", "span", "appendChild", "createTextNode", "textContent", "__rbp",
            "Date", "Math", "imul", "split", "|", "toString",
        ];
        for n in names {
            self.sidx(n);
        }
        self.sidx(challenge_id);

        // Decoder: D(i) → original string i (after the runtime rotation).
        let decoder = format!(
            "function {d}({pi}){{{pi}={pi}-{off};var s={cache}[{pi}];if(s!==void 0)return s;var e={t}[{pi}],o='',j=0;\
             for(;j<e.length;j++)o+=String.fromCharCode(e.charCodeAt(j)^(({k0}+{pi}*{k1}+j*{k2})&255));return {cache}[{pi}]=o}}"
        );
        self.decoder_len = decoder.encode_utf16().count() as u32;

        let dref = |g: &mut Gen, s: &str| -> String {
            let i = g.sidx(s) as u32;
            format!("{d}({})", g.small(i + off))
        };

        let nav = format!("{gf}(self,{})", dref(self, "navigator"));
        let mut stmts: Vec<String> = Vec::new();
        stmts.push(format!("{x}={}", self.num(p.seed)));
        for op in &p.ops {
            let s = match *op {
                Op::Add(c) => format!("{x}=({x}+{})|0", self.num(c)),
                Op::Xor(c) => format!("{x}^={}", self.num(c)),
                Op::Mul(c) => format!(
                    "{x}={mf}({gf}(self,{}),{},[{x},{}])",
                    dref(self, "Math"),
                    dref(self, "imul"),
                    self.num(c)
                ),
                Op::Rotl(n) => {
                    let a = self.small(u32::from(n));
                    let b = self.small(32 - u32::from(n));
                    format!("{x}=({x}<<{a})|({x}>>>{b})")
                }
                Op::Mix(e) => {
                    let v = match e {
                        Env::UaLen => format!("{gf}({gf}({nav},{}),{})", dref(self, "userAgent"), dref(self, "length")),
                        Env::ScreenW => format!("{gf}({gf}(self,{}),{})", dref(self, "screen"), dref(self, "width")),
                        Env::ScreenH => format!("{gf}({gf}(self,{}),{})", dref(self, "screen"), dref(self, "height")),
                        Env::HardwareConcurrency => format!("({gf}({nav},{})||0)", dref(self, "hardwareConcurrency")),
                        Env::TzOffset => format!(
                            "{mf}(new({gf}(self,{}))(),{},[])",
                            dref(self, "Date"),
                            dref(self, "getTimezoneOffset")
                        ),
                        Env::LangCount => format!("{gf}({gf}({nav},{})||[],{})", dref(self, "languages"), dref(self, "length")),
                        Env::Webdriver => format!("({gf}({nav},{})?1:0)", dref(self, "webdriver")),
                        Env::CanvasCtx => format!(
                            "(typeof {gf}({mf}({gf}(self,{}),{},[{}]),{})==={}?1:0)",
                            dref(self, "document"),
                            dref(self, "createElement"),
                            dref(self, "canvas"),
                            dref(self, "getContext"),
                            dref(self, "function")
                        ),
                        Env::DomText(n) => {
                            let s: String = (0..n)
                                .map(|_| *b"abcdefghijklmnopqrstuvwxyz0123456789".choose(&mut self.rng).unwrap() as char)
                                .collect();
                            let el = self.ident();
                            let doc = format!("{gf}(self,{})", dref(self, "document"));
                            format!(
                                "(function(){{var {el}={mf}({doc},{},[{}]);{mf}({el},{},[{mf}({doc},{},[{}])]);return {gf}({gf}({el},{}),{})}})()",
                                dref(self, "createElement"),
                                dref(self, "span"),
                                dref(self, "appendChild"),
                                dref(self, "createTextNode"),
                                dref(self, &s),
                                dref(self, "textContent"),
                                dref(self, "length")
                            )
                        }
                        Env::SelfLen => format!("{gf}({mf}({d},{},[]),{})", dref(self, "toString"), dref(self, "length")),
                    };
                    format!(
                        "{x}={mf}({gf}(self,{}),{},[{x}^({v}|0),{}])",
                        dref(self, "Math"),
                        dref(self, "imul"),
                        self.num(MIX)
                    )
                }
            };
            stmts.push(s);
        }

        // Opaque predicates: n(n+1) is always even for the small integers in y/z.
        let (yv, zv) = (self.rng.gen_range(3..9000u32), self.rng.gen_range(3..9000u32));
        let wrap_true = |g: &mut Gen, s: String| -> String {
            let junk = format!("{x}^={}", g.rnum());
            format!("if((({z}|0)*(({z}|0)+1))%2===0){{{s}}}else{{{junk}}}")
        };
        let mut cases: Vec<(String, String)> = Vec::new();
        let mut order = Vec::new();
        for s in stmts {
            let label = format!("{:x}", self.rng.gen_range(0x10..0xfffu32));
            if order.contains(&label) {
                // Rare collision: retry with a longer label.
                let label = format!("{:x}{:x}", self.rng.gen_range(0x10..0xfffu32), self.rng.gen_range(0..16u32));
                order.push(label.clone());
                let body = if self.rng.gen_bool(0.35) { wrap_true(self, s) } else { s };
                cases.push((label, body));
                continue;
            }
            order.push(label.clone());
            let body = if self.rng.gen_bool(0.35) { wrap_true(self, s) } else { s };
            let body = if self.rng.gen_bool(0.3) {
                format!("{body};if((({y}|0)*(({y}|0)+1))%2){{{x}={mf}({gf}(self,{}),{},[{x},{}])}}", dref(self, "Math"), dref(self, "imul"), self.rnum())
            } else {
                body
            };
            cases.push((label, body));
        }
        // Dead cases that are never dispatched.
        for _ in 0..self.rng.gen_range(3..7) {
            let label = format!("{:x}", self.rng.gen_range(0x1000..0xffffu32));
            let junk = match self.rng.gen_range(0..3) {
                0 => format!("{x}=({x}+{})|0;{y}^={}", self.rnum(), self.rsmall(1, 99)),
                1 => format!("{z}={mf}({gf}(self,{}),{},[{z},{}])", dref(self, "Math"), dref(self, "imul"), self.rnum()),
                _ => format!("{x}^={gf}({nav},{})", dref(self, "userAgent")),
            };
            cases.push((label, junk));
        }
        cases.shuffle(&mut self.rng);
        let order_idx = order.join("|");
        let switch_body: String = cases
            .iter()
            .map(|(l, b)| format!("case'{l}':{b};continue;"))
            .collect();
        let dispatcher = format!(
            "var {q}={mf}({},{},[{}]),{pi}=0;while(!![]){{switch({q}[{pi}++]){{{switch_body}}}break}}",
            dref(self, &order_idx),
            dref(self, "split"),
            dref(self, "|")
        );

        // Key words exported alongside the result.
        let key_exprs: Vec<String> = p.key.iter().map(|k| format!("{}>>>0", self.num(*k))).collect();
        let out_name = dref(self, "__rbp");
        let cid = dref(self, challenge_id);

        // Junk helper functions that are never called.
        let mut junk_fns = String::new();
        for _ in 0..self.rng.gen_range(2..5) {
            let (f, a, b) = (self.ident(), self.ident(), self.ident());
            junk_fns.push_str(&format!(
                "function {f}({a},{b}){{return(({a}^{})+{b}*{})|0}}",
                self.rnum(),
                self.rsmall(1, 999)
            ));
        }

        // Encode the string table (now complete), then rotate it right so the
        // runtime's left-rotation restores the original order.
        let enc: Vec<String> = self
            .strings
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let mut out = String::from("'");
                for (j, ch) in s.bytes().enumerate() {
                    let k = (k0 + (i as u32) * k1 + (j as u32) * k2) & 255;
                    out.push_str(&format!("\\x{:02x}", u32::from(ch) ^ k));
                }
                out.push('\'');
                out
            })
            .collect();
        let n = enc.len();
        let rot = self.rng.gen_range(1..n);
        let mut stored = enc.clone();
        stored.rotate_right(rot);
        let (ta, tn) = (self.ident(), self.ident());

        format!(
            "(function(){{var {t}=[{table}],{cache}={{}};(function({ta},{tn}){{while(--{tn}>=0){ta}.push({ta}.shift())}})({t},{rot_e});\
             {decoder}function {gf}(o,k){{return o[k]}}function {mf}(o,k,a){{return o[k].apply(o,a)}}{junk_fns}\
             var {x}=0,{y}={ye},{z}={ze};try{{{dispatcher}}}catch({ta}){{{x}=0}}\
             var {tn}={gf}(self,{out_name})||(self[{out_name}]={{}});{tn}[{cid}]=[{x}>>>0,{keys}]}})();",
            table = stored.join(","),
            rot_e = self.small(rot as u32),
            ye = self.small(yv),
            ze = self.small(zv),
            keys = key_exprs.join(","),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluation_depends_on_environment() {
        let mut p = Probe::generate();
        p.render_js("abc");
        let env = EnvValues { ua_len: 120, screen_w: 1440, screen_h: 900, hardware_concurrency: 8, tz_offset: -540, lang_count: 2 };
        let a = p.evaluate(&env);
        assert_eq!(a, p.evaluate(&env));
        assert_ne!(a, p.evaluate(&EnvValues { ua_len: 121, ..env.clone() }));
        assert_ne!(a, p.evaluate(&EnvValues { tz_offset: 0, ..env }));
        assert!(p.self_len > 100);
    }

    #[test]
    fn scripts_differ_and_hide_names() {
        let mut p = Probe::generate();
        let a = p.render_js("challenge123");
        let b = p.render_js("challenge123");
        assert_ne!(a, b);
        for word in ["navigator", "userAgent", "webdriver", "challenge123", "__rbp", "imul"] {
            assert!(!a.contains(word), "{word} should be encoded");
        }
    }
}

#[cfg(test)]
mod fixtures {
    use super::*;

    /// `PROBE_FIXTURES=path cargo test probe_fixtures -- --ignored` writes
    /// random probes + expected outputs so a JS engine can cross-check them.
    #[test]
    #[ignore]
    fn probe_fixtures() {
        let path = std::env::var("PROBE_FIXTURES").expect("PROBE_FIXTURES");
        let env = EnvValues { ua_len: 111, screen_w: 1440, screen_h: 900, hardware_concurrency: 8, tz_offset: -540, lang_count: 2 };
        let out: Vec<_> = (0..300)
            .map(|i| {
                let mut p = Probe::generate();
                let id = format!("c{i}");
                let js = p.render_js(&id);
                serde_json::json!({ "id": id, "js": js, "expected": p.evaluate(&env), "key": p.key })
            })
            .collect();
        std::fs::write(path, serde_json::to_string(&out).unwrap()).unwrap();
    }
}
