// Loaded by the pre-clearance gate page (/v1/gate). The widget script sets the
// rb_clearance cookie itself; this just sends the visitor back where they came from.

function safeReturn(raw: string | null): string {
  // Same-origin absolute paths only: "/x" but not "//host" or "/\host".
  if (!raw || raw[0] !== "/" || raw[1] === "/" || raw[1] === "\\" || /[\u0000-\u001f\\]/.test(raw)) return "/";
  return raw;
}

(window as unknown as Record<string, unknown>).__rbGateDone = () => {
  location.replace(safeReturn(new URLSearchParams(location.search).get("return")));
};
