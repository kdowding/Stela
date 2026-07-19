import { gunzipSync, inflateSync, inflateRawSync } from "node:zlib";
import type { ExternalRef } from "@stela/shared";

/**
 * Claude's "Save as standalone HTML" / Design Component export hides its assets — including its runtime
 * (support.js) — as base64 (usually gzipped) inside a <script type="__bundler/manifest"> block, then
 * boots them via createObjectURL. That runtime can fetch a framework from a CDN at startup (React /
 * ReactDOM / @babel/standalone from unpkg) — a RUNTIME load that findExternalRefs CANNOT see (it's
 * compressed) and the no-network CSP blocks, so the artifact errors / renders blank.
 *
 * This decompresses the manifest's code entries and scans them for those remote loads, returning them
 * as ExternalRefs so the existing publish/validate refuse-path catches them (it would otherwise publish
 * "clean" then fail at render). Best-effort + FAIL-SAFE: any change to the (undocumented, Anthropic-
 * owned) manifest format just yields [] — it never throws and never blocks a publish on its own error.
 */

const MANIFEST_RE = /<script\b[^>]*type=["']__bundler\/manifest["'][^>]*>([\s\S]*?)<\/script>/gi;
// Curated remote/CDN hosts a bundled runtime fetches code/fonts from — NOT "any https string", to keep
// false positives ~zero. Add hosts here if a new framework CDN shows up.
const REMOTE_IN_CODE_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com|esm\.(?:sh|run)|skypack\.dev|jspm\.io|googleapis\.com|gstatic\.com)\/[^"'`\s)>]*/gi;
const MAX_DECOMPRESSED = 30_000_000; // zip-bomb guard (zlib throws past this; we then fall through)

function decode(b64: string, compressed: boolean): string {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return "";
  }
  const looksGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  if (compressed || looksGzip) {
    for (const inflate of [gunzipSync, inflateSync, inflateRawSync]) {
      try {
        return inflate(buf, { maxOutputLength: MAX_DECOMPRESSED }).toString("utf8");
      } catch {
        /* wrong codec or too large — try the next */
      }
    }
  }
  try {
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

/** Remote/CDN loads hidden inside a bundled-export manifest (compressed runtime). Empty = none / not a
 *  bundled export. Pairs with findExternalRefs, which only sees plaintext refs. */
export function scanBundleForRemoteRefs(html: string): ExternalRef[] {
  if (!html.includes("__bundler/manifest")) return []; // fast path — not a bundled export
  const found: ExternalRef[] = [];
  const seen = new Set<string>();
  MANIFEST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MANIFEST_RE.exec(html)) !== null) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(m[1].trim());
    } catch {
      continue; // fail safe — not the JSON shape we know
    }
    for (const entry of Object.values(manifest)) {
      const e = entry as { mime?: string; compressed?: boolean; data?: string };
      if (!e || typeof e.data !== "string") continue;
      if (e.mime && !/javascript|ecmascript|json|text|html/i.test(e.mime)) continue; // skip binary assets
      const text = decode(e.data, e.compressed === true);
      if (!text) continue;
      REMOTE_IN_CODE_RE.lastIndex = 0;
      let u: RegExpExecArray | null;
      while ((u = REMOTE_IN_CODE_RE.exec(text)) !== null) {
        const snippet = u[0].slice(0, 80);
        if (!seen.has(snippet)) {
          seen.add(snippet);
          found.push({ kind: "remote load inside the bundled runtime", snippet, directive: "script-src" });
        }
      }
    }
  }
  return found;
}
