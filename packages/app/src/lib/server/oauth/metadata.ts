/**
 * OAuth 2.1 / MCP discovery documents: RFC 9728 Protected Resource Metadata + RFC 8414 Authorization
 * Server Metadata. Pure functions of the public origin. Served from `hooks.server.ts` (not as
 * `+server` routes) because SvelteKit doesn't reliably match a route folder beginning with '.'
 * (".well-known"), and these must work in every environment regardless of auth.
 */
export const PRM_PATH = "/.well-known/oauth-protected-resource";
export const ASM_PATH = "/.well-known/oauth-authorization-server";

/** Scopes the AS supports: `stela` = act as the user across artifact operations; `offline_access`
 *  opts the client into refresh tokens. */
export const OAUTH_SCOPES_SUPPORTED = ["stela", "offline_access"];

/** RFC 9728 — tells the client which authorization server protects the `/mcp` resource. */
export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: OAUTH_SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
  };
}

/** RFC 8414 — advertises our endpoints. Public clients + PKCE only (token auth method "none"). */
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: OAUTH_SCOPES_SUPPORTED,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}
