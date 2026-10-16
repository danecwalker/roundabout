// Browser fingerprint for server-side consistency checks. Each value is cheap
// to collect; the server's job is cross-checking them against each other and
// against the HTTP request.

export interface Fingerprint {
  ua: string;
  platform: string;
  vendor: string;
  ua_data: { brands: string[]; mobile: boolean; platform: string } | null;
  timezone: string;
  tz_offset: number;
  canvas: string;
  webgl_vendor: string;
  webgl_renderer: string;
  audio: string[];
  video: string[];
  fonts_checked: boolean;
  fonts: string[];
  dpr: number;
  color_depth: number;
  plugins: number;
  chrome_obj: boolean;
  moz: boolean;
  eval_len: number;
  notif_permission: string;
  notif_query: string;
  max_touch: number;
}

const FONT_PROBES = [
  "Segoe UI", "Calibri", "Consolas", "Helvetica Neue", "Menlo", "Avenir",
  "Ubuntu", "DejaVu Sans", "Roboto", "Noto Color Emoji", "Arial",
];
const AUDIO = ['audio/mpeg', 'audio/ogg; codecs="vorbis"', 'audio/wav; codecs="1"', "audio/aac", "audio/flac", 'audio/webm; codecs="opus"'];
const VIDEO = ['video/mp4; codecs="avc1.42E01E"', 'video/webm; codecs="vp9"', 'video/mp4; codecs="hvc1"', 'video/mp4; codecs="av01.0.05M.08"', 'video/ogg; codecs="theora"'];

async function hashText(s: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // FNV-1a fallback for contexts without SubtleCrypto.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16);
  }
}

function canvasData(): string {
  try {
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 60;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    ctx.textBaseline = "top";
    ctx.font = '16px "Arial"';
    ctx.fillStyle = "#f60";
    ctx.fillRect(100, 1, 62, 20);
    ctx.fillStyle = "#069";
    ctx.fillText("Roundabout ✓ 🛞 ∑", 2, 15);
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
    ctx.beginPath();
    ctx.arc(50, 30, 20, 0, Math.PI * 2);
    ctx.fill();
    return c.toDataURL();
  } catch {
    return "";
  }
}

function webgl(): [string, string] {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl") || c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return ["", ""];
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) {
      return [String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)), String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))];
    }
    return [String(gl.getParameter(gl.VENDOR)), String(gl.getParameter(gl.RENDERER))];
  } catch {
    return ["", ""];
  }
}

function fonts(): string[] | null {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return null;
    const text = "mmmmmmmmmmlli1WQ@#";
    const bases = ["monospace", "serif", "sans-serif"];
    const width = (font: string) => {
      ctx.font = `48px ${font}`;
      return ctx.measureText(text).width;
    };
    const baseWidths = bases.map(width);
    return FONT_PROBES.filter((f) => bases.some((b, i) => width(`"${f}", ${b}`) !== baseWidths[i]));
  } catch {
    return null;
  }
}

function canPlay(el: HTMLMediaElement, types: string[]): string[] {
  try {
    return types.filter((t) => el.canPlayType(t) !== "");
  } catch {
    return [];
  }
}

async function notifications(): Promise<[string, string]> {
  const permission = typeof Notification !== "undefined" ? Notification.permission : "";
  let query = "";
  try {
    query = (await navigator.permissions.query({ name: "notifications" as PermissionName })).state;
  } catch {
    /* unsupported */
  }
  return [permission, query];
}

export async function collect(): Promise<Fingerprint> {
  const nav = navigator as Navigator & {
    userAgentData?: { brands: { brand: string }[]; mobile: boolean; platform: string };
  };
  const [webglVendor, webglRenderer] = webgl();
  const fontList = fonts();
  const [notifPermission, notifQuery] = await notifications();
  let timezone = "";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    /* ignore */
  }
  const canvas = canvasData();
  return {
    ua: navigator.userAgent,
    platform: navigator.platform ?? "",
    vendor: navigator.vendor ?? "",
    ua_data: nav.userAgentData
      ? { brands: nav.userAgentData.brands.map((b) => b.brand), mobile: nav.userAgentData.mobile, platform: nav.userAgentData.platform }
      : null,
    timezone,
    tz_offset: new Date().getTimezoneOffset(),
    canvas: canvas ? await hashText(canvas) : "",
    webgl_vendor: webglVendor,
    webgl_renderer: webglRenderer,
    audio: canPlay(document.createElement("audio"), AUDIO),
    video: canPlay(document.createElement("video"), VIDEO),
    fonts_checked: fontList !== null,
    fonts: fontList ?? [],
    dpr: window.devicePixelRatio || 1,
    color_depth: screen.colorDepth || 0,
    plugins: navigator.plugins?.length ?? 0,
    chrome_obj: !!(window as unknown as { chrome?: unknown }).chrome,
    moz: "mozInnerScreenX" in window,
    eval_len: eval.toString().length,
    notif_permission: notifPermission,
    notif_query: notifQuery,
    max_touch: navigator.maxTouchPoints || 0,
  };
}
