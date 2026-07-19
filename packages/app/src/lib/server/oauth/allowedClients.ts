import { env } from "$env/dynamic/private";

/**
 * Which client hosts may register an OAuth client (DCR) and receive the consent-form redirect. This is
 * the key control on the otherwise-public registration endpoint — it limits *which* AI hosts can
 * connect, so the AS can't be abused as an open redirector / token-phisher by an attacker-registered
 * client. Configurable via OAUTH_ALLOWED_CLIENT_HOSTS (comma-separated hostnames) so adding a host
 * (ChatGPT/OpenAI, M365 Copilot, …) is a config (env) change, not a deploy.
 *
 * SINGLE SOURCE OF TRUTH for BOTH the DCR redirect_uri check (routes/oauth/register) and the
 * /oauth/authorize consent-page form-action CSP (hooks.server.ts), so the two can't drift. Loopback
 * (Claude Code + local dev) is always allowed.
 */
// global.consent.azure-apim.net is the Power Platform connector OAuth broker — Copilot Studio (its MCP
// "Dynamic discovery" / DCR path) routes its redirect_uri through it, e.g.
// https://global.consent.azure-apim.net/redirect/new-5fstela-<id>. Host-level allowlist; the
// per-connector path varies. Tenant-lock (Entra) + the consent gate + PKCE remain the real controls.
const DEFAULT_CLIENT_HOSTS = ["claude.ai", "claude.com", "grok.com", "chatgpt.com", "global.consent.azure-apim.net"];

export function allowedClientHosts(): string[] {
  const raw = env.OAUTH_ALLOWED_CLIENT_HOSTS?.trim();
  if (!raw) return DEFAULT_CLIENT_HOSTS;
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** True if a redirect_uri is an allowlisted-host HTTPS callback, or loopback http (Claude Code / dev). */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "https:" && allowedClientHosts().includes(u.hostname.toLowerCase())) return true;
  if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.protocol === "http:") return true;
  return false;
}

/** CSP `form-action` sources for the consent page: the allowlisted https origins + loopback wildcards,
 *  so the browser permits the Approve button's 303 to the client's registered callback. */
export function consentFormActionSources(): string {
  const origins = allowedClientHosts().map((h) => `https://${h}`);
  return ["'self'", ...origins, "http://127.0.0.1:*", "http://localhost:*"].join(" ");
}
