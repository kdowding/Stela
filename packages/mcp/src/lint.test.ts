import { describe, it, expect } from "vitest";
import { findExternalRefs } from "@stela/shared";

const kinds = (html: string) => findExternalRefs(html).map((r) => r.kind);

describe("findExternalRefs — flags things the no-network CSP blocks", () => {
  it("external <script src>", () => {
    expect(kinds(`<script src="https://cdn.tailwindcss.com"></script>`)).toContain("external <script src>");
  });

  it("external stylesheet <link href> (incl. protocol-relative)", () => {
    expect(kinds(`<link rel="stylesheet" href="//fonts.googleapis.com/css?x">`)).toContain(
      "external <link href> (stylesheet/font/icon)",
    );
  });

  it("external <img src> and srcset", () => {
    expect(kinds(`<img src="https://example.com/logo.png">`)).toContain("external resource src");
    expect(kinds(`<img srcset="https://example.com/a.png 1x">`)).toContain("external resource src");
  });

  it("CSS url() and @import to a remote host", () => {
    expect(kinds(`<style>@import url(https://x.com/a.css); .a{background:url('https://x/y.png')}</style>`)).toEqual(
      expect.arrayContaining(["CSS @import", "CSS url() to a remote host"]),
    );
  });

  it("network calls", () => {
    expect(kinds(`<script>fetch('/api/x'); new WebSocket('wss://x'); new EventSource('/s')</script>`)).toEqual(
      expect.arrayContaining([
        "network call (fetch)",
        "network call (WebSocket)",
        "network call (EventSource)",
      ]),
    );
  });
});

describe("findExternalRefs — leaves self-contained content alone", () => {
  it("no findings for inline + data: + blob: + anchor links", () => {
    const html = [
      "<!doctype html><title>OK</title>",
      "<style>body{background:url(data:image/png;base64,AAAA)}</style>",
      `<img src="data:image/svg+xml,<svg/>">`,
      `<a href="https://example.com">a normal link is fine</a>`,
      "<script>const x = 1; document.title = x;</script>",
    ].join("");
    expect(findExternalRefs(html)).toEqual([]);
  });

  it("does not trip on the word 'prefetch' or bare 'fetch' without a call", () => {
    expect(findExternalRefs(`<link rel="prefetch"> the word fetch in prose`)).toEqual([]);
  });

  it("dedupes repeated identical references", () => {
    const one = `<script src="https://cdn/x.js"></script>`;
    expect(findExternalRefs(one + one)).toHaveLength(1);
  });
});

describe("findExternalRefs — rel-aware <link> handling (Finding A)", () => {
  it("does NOT flag inert hint links, even with a remote href", () => {
    expect(findExternalRefs(`<link rel="preconnect" href="https://fonts.gstatic.com">`)).toEqual([]);
    expect(findExternalRefs(`<link rel="dns-prefetch" href="//fonts.googleapis.com">`)).toEqual([]);
    expect(findExternalRefs(`<link rel="preload" as="font" href="https://x.com/f.woff2">`)).toEqual([]);
    expect(findExternalRefs(`<link rel="modulepreload" href="https://x.com/m.js">`)).toEqual([]);
  });

  it("still flags a remote stylesheet / icon link", () => {
    expect(kinds(`<link rel="stylesheet" href="https://x.com/a.css">`)).toContain(
      "external <link href> (stylesheet/font/icon)",
    );
    expect(kinds(`<link rel="icon" href="https://x.com/favicon.ico">`)).toContain(
      "external <link href> (stylesheet/font/icon)",
    );
  });

  it("flags a link if any real-subresource rel sits alongside an inert hint", () => {
    expect(kinds(`<link rel="preload stylesheet" href="https://x.com/a.css">`)).toContain(
      "external <link href> (stylesheet/font/icon)",
    );
  });

  it("is not fooled by a decoy rel= elsewhere in the tag (data-rel, quoted value)", () => {
    // a genuine remote stylesheet must still be flagged despite an inert-looking decoy rel
    for (const tag of [
      `<link data-rel="preload" rel="stylesheet" href="//x/a.css">`,
      `<link aria-rel="preconnect" rel="stylesheet" href="//x/a.css">`,
      `<link title="rel = preload" rel="stylesheet" href="//x/a.css">`,
      `<link href="//x/a.css" data-x="rel=preconnect" rel="stylesheet">`,
    ]) {
      expect(kinds(tag), tag).toContain("external <link href> (stylesheet/font/icon)");
    }
  });

  it("tags a remote icon link img-src and a remote stylesheet style-src", () => {
    expect(findExternalRefs(`<link rel="icon" href="https://x.com/favicon.ico">`)[0]?.directive).toBe("img-src");
    expect(findExternalRefs(`<link rel="stylesheet" href="https://x.com/a.css">`)[0]?.directive).toBe("style-src");
  });
});

describe("findExternalRefs — directive hints", () => {
  it("tags each finding with the CSP directive that blocks it", () => {
    const byKind = Object.fromEntries(
      findExternalRefs(
        `<script src="https://x/x.js"></script><style>@import url(https://x/a.css)</style><script>fetch('/x')</script>`,
      ).map((r) => [r.kind, r.directive]),
    );
    expect(byKind["external <script src>"]).toBe("script-src");
    expect(byKind["CSS @import"]).toBe("style-src");
    expect(byKind["network call (fetch)"]).toBe("connect-src");
  });
});

describe("findExternalRefs — remote JS/SVG loaders (F15)", () => {
  it("flags remote SVG <image href>, module import, dynamic import, and Worker", () => {
    expect(kinds(`<svg><image href="https://x/a.png"/></svg>`)).toContain("external SVG <image href>");
    expect(kinds(`<script type="module">import x from "https://x/m.js"</script>`)).toContain(
      "external module import",
    );
    expect(kinds(`<script>import("https://x/m.js")</script>`)).toContain("dynamic import() to a remote URL");
    expect(kinds(`<script>new Worker("https://x/w.js")</script>`)).toContain("external Worker");
  });

  it("leaves the self-contained data:/blob:/local equivalents alone", () => {
    expect(findExternalRefs(`<svg><image href="data:image/png;base64,AAAA"/></svg>`)).toEqual([]);
    expect(findExternalRefs(`<script>const w = new Worker(URL.createObjectURL(b));</script>`)).toEqual([]);
    expect(findExternalRefs(`<script>import("./local.js"); import y from "./z.js";</script>`)).toEqual([]);
  });
});
