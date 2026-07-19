// The Content-Security-Policy every artifact is served under: the /raw route sets this header and the
// viewer iframes the artifact with sandbox="allow-scripts". SINGLE SOURCE OF TRUTH — imported by that
// route, by the MCP authoring instructions, and by the validate dry-run output, so the policy we
// *document* (and hand a model for a local render check) is provably the policy we *serve*.
//
// Self-contained artifacts only: inline script/style + data:/blob: assets, and NO network egress
// (there is deliberately no connect-src, so fetch/XHR/WebSocket fall back to default-src 'none').
const DIRECTIVES = [
  "default-src 'none'",
  // blob: lets the standard "Save as standalone HTML" export boot — its runtime and fonts load via
  // createObjectURL. Safe: blob: is a local scheme, so it changes neither egress (default-src 'none')
  // nor the opaque-origin sandbox. Browser-verified to render; without it the export goes blank.
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  // Opaque-origin sandbox even if the doc is opened directly, not just inside the viewer iframe.
  "sandbox allow-scripts",
];

export const ARTIFACT_CSP = DIRECTIVES.join("; ");
