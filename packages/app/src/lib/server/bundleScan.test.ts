import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { scanBundleForRemoteRefs } from "./bundleScan";

/** Build a minimal "__bundler/manifest" HTML with one code entry (gzipped by default, like the real export). */
function bundle(js: string, opts: { compressed?: boolean; mime?: string } = {}): string {
  const compressed = opts.compressed !== false;
  const data = (compressed ? gzipSync(Buffer.from(js, "utf8")) : Buffer.from(js, "utf8")).toString("base64");
  const manifest = { "1b192538-x": { mime: opts.mime ?? "text/javascript", compressed, data } };
  return `<!doctype html><html><head><script type="__bundler/manifest">${JSON.stringify(manifest)}</script></head><body></body></html>`;
}

describe("scanBundleForRemoteRefs", () => {
  it("finds the CDN framework loads hidden in a gzipped runtime entry", async () => {
    const js =
      'var s=document.createElement("script");s.src="https://unpkg.com/react@18.3.1/umd/react.production.min.js";' +
      'document.head.appendChild(s);loadScript("https://unpkg.com/@babel/standalone@7.26.4/babel.min.js");';
    const refs = scanBundleForRemoteRefs(bundle(js));
    expect(refs.some((r) => r.snippet.includes("unpkg.com/react"))).toBe(true);
    expect(refs.some((r) => r.snippet.includes("@babel/standalone"))).toBe(true);
    expect(refs[0].directive).toBe("script-src");
  });

  it("returns [] for a self-contained bundle (no remote loads)", () => {
    expect(scanBundleForRemoteRefs(bundle('function App(){return "hi"}App();'))).toEqual([]);
  });

  it("returns [] for HTML with no bundler manifest (fast path)", () => {
    expect(scanBundleForRemoteRefs("<!doctype html><body>plain self-contained</body>")).toEqual([]);
  });

  it("also scans an uncompressed (raw base64) code entry", () => {
    const refs = scanBundleForRemoteRefs(bundle('import x from "https://esm.sh/lodash";', { compressed: false }));
    expect(refs.some((r) => r.snippet.includes("esm.sh/lodash"))).toBe(true);
  });

  it("is fail-safe on a malformed manifest (no throw, empty result)", () => {
    expect(scanBundleForRemoteRefs('<script type="__bundler/manifest">not json</script>')).toEqual([]);
  });
});
