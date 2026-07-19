import { describe, it, expect } from "vitest";
import { isAllowedRedirectUri, consentFormActionSources } from "./allowedClients";

describe("allowedClients (default config)", () => {
  it("allows allowlisted https hosts + loopback http; rejects everything else", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/cb")).toBe(true);
    expect(isAllowedRedirectUri("https://grok.com/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(isAllowedRedirectUri("https://global.consent.azure-apim.net/redirect/new-5fstela-5f6dcd34cb73e3ab03")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:51789/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:8080/cb")).toBe(true);
    expect(isAllowedRedirectUri("https://evil.example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://claude.ai/cb")).toBe(false); // https required for non-loopback
    expect(isAllowedRedirectUri("https://sub.claude.ai/cb")).toBe(false); // exact host, no subdomains
    expect(isAllowedRedirectUri("not-a-url")).toBe(false);
  });

  it("consent form-action lists the allowlisted https origins + loopback", () => {
    const fa = consentFormActionSources();
    expect(fa).toContain("'self'");
    expect(fa).toContain("https://claude.ai");
    expect(fa).toContain("https://grok.com");
    expect(fa).toContain("http://127.0.0.1:*");
  });
});
