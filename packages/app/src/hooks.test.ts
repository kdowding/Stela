import { describe, it, expect } from "vitest";
import { applySecurityHeaders } from "./hooks.server";
import { makeEvent } from "./test/helpers";

function headersFor(path: string): Headers {
  const res = new Response("ok");
  applySecurityHeaders(makeEvent({ path }), res);
  return res.headers;
}

describe("applySecurityHeaders (headers-ui-3)", () => {
  it("sets frame-busting + CSP + nosniff + referrer-policy on a portal page", () => {
    const h = headersFor("/");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toContain("strict-origin");
    expect(h.get("permissions-policy")).toContain("geolocation=()");
  });

  it("applies to the artifact viewer page", () => {
    expect(headersFor("/a/295d34d7-a926-40f1-9d6e-8c55b5554141").get("x-frame-options")).toBe("DENY");
  });

  it("EXCLUDES the /raw artifact endpoint (it owns its CSP and must stay framable by the viewer)", () => {
    const h = headersFor("/a/295d34d7-a926-40f1-9d6e-8c55b5554141/raw");
    expect(h.get("x-frame-options")).toBeNull();
    expect(h.get("content-security-policy")).toBeNull();
  });

  it("does not set HSTS in dev (the test double sets dev=true)", () => {
    expect(headersFor("/").get("strict-transport-security")).toBeNull();
  });
});
