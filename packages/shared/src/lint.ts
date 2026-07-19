export type ExternalRef = { kind: string; snippet: string; directive: string };

// Stela serves artifacts under `default-src 'none'` (script/style 'unsafe-inline' only, img/media
// data:+blob:, font data:+blob:, no connect-src). So an artifact must be fully self-contained: any
// remote resource or network call silently renders it blank. These best-effort regexes flag the
// common offenders before publish. Tuned for low false positives — they require an http(s)/protocol-
// relative URL in a *resource* context, so data:/blob:/#frag URIs and plain <a href> links are left
// alone. `directive` is the canonical CSP directive governing each ref (a hint for programmatic
// callers); under Stela's policy some — e.g. connect-src — fall back to default-src 'none'.
const REMOTE = String.raw`(?:https?:)?\/\/`; // https://, http://, or protocol-relative //

type Rule = { kind: string; directive: string; re: RegExp };

const RULES: Rule[] = [
  { kind: "external <script src>", directive: "script-src", re: new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']?\\s*${REMOTE}[^"'>\\s]*`, "gi") },
  { kind: "external resource src", directive: "img-src", re: new RegExp(`<(?:img|image|iframe|frame|source|track|video|audio|embed)\\b[^>]*\\bsrc(?:set)?\\s*=\\s*["']?\\s*${REMOTE}[^"'>\\s]*`, "gi") },
  { kind: "external <object data>", directive: "object-src", re: new RegExp(`<object\\b[^>]*\\bdata\\s*=\\s*["']?\\s*${REMOTE}[^"'>\\s]*`, "gi") },
  { kind: "external <use href>", directive: "img-src", re: new RegExp(`<use\\b[^>]*(?:xlink:)?href\\s*=\\s*["']?\\s*${REMOTE}[^"'>\\s]*`, "gi") },
  { kind: "external SVG <image href>", directive: "img-src", re: new RegExp(`<image\\b[^>]*(?:xlink:)?href\\s*=\\s*["']?\\s*${REMOTE}[^"'>\\s]*`, "gi") },
  // JS module/worker loaders that fetch a REMOTE URL. Anchored to REMOTE so data:/blob:/relative are left
  // alone — in particular `new Worker(URL.createObjectURL(blob))` (the blessed self-contained shape) and
  // `import("./local")` don't match. `(?<!@)` keeps the CSS `@import` rule from double-claiming.
  { kind: "external module import", directive: "script-src", re: new RegExp(`(?<!@)\\bimport\\b(?:[^"';]*\\bfrom\\s*)?["']\\s*${REMOTE}[^"']*`, "gi") },
  { kind: "dynamic import() to a remote URL", directive: "script-src", re: new RegExp(`\\bimport\\s*\\(\\s*["']?\\s*${REMOTE}[^"')\\s]*`, "gi") },
  { kind: "external Worker", directive: "script-src", re: new RegExp(`\\bnew\\s+(?:Shared)?Worker\\s*\\(\\s*["']\\s*${REMOTE}[^"']*`, "gi") },
  { kind: "CSS @import", directive: "style-src", re: new RegExp(`@import\\s+(?:url\\(\\s*)?["']?\\s*${REMOTE}[^"')\\s]*`, "gi") },
  { kind: "CSS url() to a remote host", directive: "style-src", re: new RegExp(`\\burl\\(\\s*["']?\\s*${REMOTE}[^"')\\s]*`, "gi") },
  { kind: "network call (fetch)", directive: "connect-src", re: /\bfetch\s*\(/gi },
  { kind: "network call (XMLHttpRequest)", directive: "connect-src", re: /\bnew\s+XMLHttpRequest\b/gi },
  { kind: "network call (WebSocket)", directive: "connect-src", re: /\bnew\s+WebSocket\s*\(/gi },
  { kind: "network call (EventSource)", directive: "connect-src", re: /\bnew\s+EventSource\s*\(/gi },
  { kind: "network call (sendBeacon)", directive: "connect-src", re: /\bnavigator\s*\.\s*sendBeacon\s*\(/gi },
  { kind: "network call (importScripts)", directive: "script-src", re: /\bimportScripts\s*\(/gi },
];

// <link> rel values that fetch nothing render-breaking under the no-network CSP: preconnect/
// dns-prefetch are pure connection warm-ups; prefetch/preload/modulepreload fetch speculatively and
// fail silently without blanking the page. The "Save as standalone HTML" export always emits a couple
// of preconnect hints, so flagging these false-refused an otherwise-fine artifact (Finding A). We only
// flag a <link> whose rel actually loads a render-affecting subresource (stylesheet/icon/...).
const INERT_LINK_REL = new Set(["preconnect", "dns-prefetch", "prefetch", "preload", "modulepreload"]);
const ICON_REL = new Set(["icon", "shortcut", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon"]);
const LINK_TAG_RE = /<link\b[^>]*>/gi;
const REMOTE_HREF = new RegExp(`^${REMOTE}`, "i"); // an href VALUE that points off-origin

// Parse a tag's attributes into name→value. We do this rather than regex-grab the first `rel=` because
// a decoy attribute (data-rel=, aria-rel=, or a "rel=" substring inside another attribute's quoted
// value) was fooling the linter into reading an inert rel and letting a genuine remote <link> through.
function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    const name = m[1].toLowerCase();
    const raw = m[2];
    const val = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
    if (!(name in attrs)) attrs[name] = val; // first occurrence wins (HTML parsing semantics)
  }
  return attrs;
}

/** The CSP directive a remote <link> would be blocked by, or null if it's self-contained / inert. */
function externalLinkDirective(tag: string): string | null {
  const attrs = parseAttrs(tag);
  if (!REMOTE_HREF.test(attrs.href ?? "")) return null; // no remote href → nothing to fetch
  const rels = (attrs.rel ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (rels.length === 0 || rels.every((r) => INERT_LINK_REL.has(r))) return null; // rel-less or all-inert
  return rels.some((r) => ICON_REL.has(r)) ? "img-src" : "style-src";
}

const snippetOf = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);

/** Find references that Stela's no-network CSP would block. Empty array = looks self-contained. */
export function findExternalRefs(html: string): ExternalRef[] {
  const found: ExternalRef[] = [];
  const seen = new Set<string>();
  const add = (kind: string, directive: string, raw: string) => {
    const snippet = snippetOf(raw);
    const key = `${kind}|${snippet}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ kind, snippet, directive });
    }
  };

  for (const { kind, directive, re } of RULES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) add(kind, directive, m[0]);
  }

  LINK_TAG_RE.lastIndex = 0;
  let lm: RegExpExecArray | null;
  while ((lm = LINK_TAG_RE.exec(html)) !== null) {
    const directive = externalLinkDirective(lm[0]);
    if (directive) add("external <link href> (stylesheet/font/icon)", directive, lm[0]);
  }

  return found;
}

/** The findings as a compact machine-readable array — `{type, snippet, directive}` — so MCP callers
 *  can react programmatically (fix the exact ref and retry) instead of parsing the prose message. */
export function externalRefsJson(refs: ExternalRef[]): string {
  return JSON.stringify(refs.map((r) => ({ type: r.kind, snippet: r.snippet, directive: r.directive })));
}

/** A human-readable refusal/validation report — bulleted list + "…and N more" tail + the
 *  machine-readable JSON — shared by both MCP surfaces so the wording and truncation can't drift. */
export function formatExternalRefs(header: string, refs: ExternalRef[], footer = ""): string {
  const shown = refs.slice(0, 12);
  const list = shown.map((r) => `  • ${r.kind}: ${r.snippet}`).join("\n");
  const more = refs.length - shown.length;
  return `${header}\n${list}${more > 0 ? `\n  • …and ${more} more` : ""}${footer}\n\nMachine-readable: ${externalRefsJson(refs)}`;
}
