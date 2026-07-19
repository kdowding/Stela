import { describe, it, expect } from "vitest";

// SvelteKit's global origin check is disabled (csrf.checkOrigin:false in svelte.config), so every
// cookie-mutating route must hand-place assertSameOrigin — one omission is a live CSRF hole. This
// meta-test source-scans the route files (via Vite's ?raw glob) and fails if a NEW mutating route ships
// without assertSameOrigin and isn't a header-credential-only endpoint (which carries no ambient cookie,
// so a malicious site can't drive it). It complements the per-route CSRF tests by catching future drift.
const serverFiles = import.meta.glob("./**/+server.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const pageServerFiles = import.meta.glob("./**/+page.server.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Mutating endpoints authenticated ONLY by a header credential (Bearer / x-api-key), never an ambient
// cookie — a cross-site request can't forge those headers without a (blocked) CORS preflight, so
// assertSameOrigin is intentionally not required. Keep this list tight; adding to it is a security call.
const HEADER_AUTH_ONLY = [
  "mcp/+server.ts", // remote MCP transport (Bearer only)
  "api/artifacts/+server.ts", // POST publish (API key/token); GET is read-only
  "oauth/register/+server.ts", // Dynamic Client Registration (no cookie)
  "cli/token/+server.ts", // CLI pairing exchange + token revoke (header cred)
];

const MUTATING_HANDLER = /export\s+(?:const|async\s+function)\s+(?:POST|PUT|PATCH|DELETE)\b/;
const HAS_ACTIONS = /export\s+const\s+actions\b/; // +page.server form actions are POSTs
const routePath = (key: string) =>
  key.replace(/\\/g, "/").replace(/^.*\/routes\//, "").replace(/^\.\//, "");

describe("CSRF guard coverage", () => {
  it("sees the route files (the ?raw glob actually matched something)", () => {
    expect(Object.keys(serverFiles).length).toBeGreaterThan(5);
  });

  it("every cookie-mutating route calls assertSameOrigin (or is a header-auth-only endpoint)", () => {
    const offenders: string[] = [];
    for (const [key, src] of Object.entries({ ...serverFiles, ...pageServerFiles })) {
      const path = routePath(key);
      if (!MUTATING_HANDLER.test(src) && !HAS_ACTIONS.test(src)) continue; // read-only route
      if (src.includes("assertSameOrigin")) continue; // guarded
      if (HEADER_AUTH_ONLY.some((p) => path.endsWith(p))) continue; // no ambient-cookie path
      offenders.push(path);
    }
    expect(offenders, `mutating route(s) missing assertSameOrigin: ${offenders.join(", ") || "none"}`).toEqual([]);
  });
});
