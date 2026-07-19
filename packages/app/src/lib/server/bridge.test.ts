import { describe, it, expect } from "vitest";
import { injectBridge, BRIDGE_VERSION } from "./bridge";

describe("injectBridge", () => {
  it("injects the bridge just inside </body>", () => {
    const out = injectBridge("<html><body><h1>Hi</h1></body></html>");
    expect(out).toMatch(/<script>[\s\S]*<\/script><\/body>/);
  });

  it("falls back to </html> when there is no body", () => {
    const out = injectBridge("<html><h1>No body</h1></html>");
    expect(out).toMatch(/<script>[\s\S]*<\/script><\/html>/);
  });

  it("appends when there is neither </body> nor </html>", () => {
    const out = injectBridge("<h1>fragment</h1>");
    expect(out.startsWith("<h1>fragment</h1>")).toBe(true);
    expect(out).toContain("<script>");
  });

  it("matches the body tag case-insensitively", () => {
    expect(injectBridge("<BODY></BODY>")).toMatch(/<script>[\s\S]*<\/script><\/BODY>/i);
  });

  it("injects exactly once, before the first </body>", () => {
    const out = injectBridge("<body>a</body><body>b</body>");
    expect(out.match(/<script>/g)?.length).toBe(1);
    expect(out.indexOf("<script>")).toBeLessThan(out.indexOf("</body>"));
  });

  it("lands the real bridge verbatim (index-splice, not String.replace)", () => {
    const out = injectBridge("<body></body>");
    // Recognizable, stable slices of bridge.client.js — proves the right script was bundled and that no
    // $-pattern interpretation mangled it.
    expect(out).toContain("__stelaBridge");
    expect(out).toContain("stela-bridge");
    expect(out).toContain("MutationObserver");
  });

  it("exposes a positive-integer BRIDGE_VERSION for cache-busting", () => {
    expect(Number.isInteger(BRIDGE_VERSION)).toBe(true);
    expect(BRIDGE_VERSION).toBeGreaterThan(0);
  });
});
