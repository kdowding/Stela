import { json, type RequestEvent } from "@sveltejs/kit";
import { getStore } from "$lib/server/storage";
import { rateLimit, clientIp } from "$lib/server/ratelimit";
import type { OAuthTokens } from "$lib/server/storage/types";

/** OAuth error response (RFC 6749 §5.2). */
function oauthError(error: string, status = 400, description?: string): Response {
  return json(
    { error, ...(description ? { error_description: description } : {}) },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function tokenResponse(t: OAuthTokens): Response {
  return json(
    {
      access_token: t.accessToken,
      token_type: "Bearer",
      expires_in: t.expiresIn,
      scope: t.scope,
      ...(t.refreshToken ? { refresh_token: t.refreshToken } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * OAuth 2.1 token endpoint. Invoked from `hooks.server.ts` (NOT a `+server` route) so it bypasses
 * SvelteKit's built-in form-POST CSRF origin check: claude.ai's token call is cross-origin and
 * `application/x-www-form-urlencoded`, and is authenticated by the authorization code + PKCE verifier
 * (or the refresh token) — never a cookie — so it isn't CSRF-relevant and the origin check would
 * wrongly 403 it. Public + form-encoded per RFC 6749.
 */
export async function handleTokenRequest(event: RequestEvent): Promise<Response> {
  rateLimit("oauth-token", clientIp(event), 60, 60_000);
  let form: FormData;
  try {
    form = await event.request.formData();
  } catch {
    return oauthError("invalid_request", 400, "Expected an application/x-www-form-urlencoded body");
  }
  const grantType = String(form.get("grant_type") ?? "");
  const store = getStore();

  if (grantType === "authorization_code") {
    const code = String(form.get("code") ?? "");
    const verifier = String(form.get("code_verifier") ?? "");
    const clientId = String(form.get("client_id") ?? "");
    const redirectUri = String(form.get("redirect_uri") ?? "");
    if (!code || !verifier || !clientId || !redirectUri) return oauthError("invalid_request");
    const redeemed = await store.redeemAuthCode(code, { verifier, clientId, redirectUri });
    if (!redeemed) return oauthError("invalid_grant", 400, "Invalid or expired authorization code");
    return tokenResponse(await store.issueTokens(redeemed.user, { clientId, scope: redeemed.scope }));
  }

  if (grantType === "refresh_token") {
    const refreshToken = String(form.get("refresh_token") ?? "");
    const clientId = String(form.get("client_id") ?? "");
    if (!refreshToken || !clientId) return oauthError("invalid_request");
    const rotated = await store.rotateRefreshToken(refreshToken, { clientId });
    if (!rotated) return oauthError("invalid_grant", 400, "Invalid or expired refresh token");
    return tokenResponse(rotated);
  }

  return oauthError("unsupported_grant_type");
}
