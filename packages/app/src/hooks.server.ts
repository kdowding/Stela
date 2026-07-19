import type { Handle, HandleServerError, RequestEvent } from "@sveltejs/kit";
import { dev } from "$app/environment";
import { randomUUID } from "node:crypto";
import { getCurrentUser, loginRedirect } from "$lib/server/auth";
import { getStore } from "$lib/server/storage";
import { checkProdConfig } from "$lib/server/startup";
import {
  PRM_PATH,
  ASM_PATH,
  protectedResourceMetadata,
  authorizationServerMetadata,
} from "$lib/server/oauth/metadata";
import { handleTokenRequest } from "$lib/server/oauth/token";
import { consentFormActionSources } from "$lib/server/oauth/allowedClients";

// Fail-fast on critical prod misconfiguration at server start.
checkProdConfig();

// Warm storage (managed-identity token + table/container existence) at startup so the first request
// after a cold start or deploy doesn't pay that latency. Prod only; fire-and-forget — a transient
// failure must not crash boot, and the real request path retries via the store's own lazy init — but
// LOG it (don't swallow) so a cold-start storage failure is visible, not just a wall of per-request 500s.
if (!dev) {
  void getStore()
    .warmUp()
    .catch((e: unknown) => console.error("[stela] storage warm-up failed (will retry lazily):", e));
}

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = getCurrentUser(event.request);

  // OAuth 2.1 / MCP discovery — public, unauthenticated JSON. Served here (not as +server routes)
  // because SvelteKit doesn't reliably match a route folder starting with '.' (".well-known").
  if (event.url.pathname === PRM_PATH || event.url.pathname === ASM_PATH) {
    const doc =
      event.url.pathname === PRM_PATH
        ? protectedResourceMetadata(event.url.origin)
        : authorizationServerMetadata(event.url.origin);
    return new Response(JSON.stringify(doc), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
      },
    });
  }

  // OAuth token endpoint. claude.ai's token call is cross-origin + form-encoded, authenticated by the
  // auth code + PKCE verifier (or refresh token), not a cookie — so it isn't CSRF-relevant. (SvelteKit's
  // global CSRF check is disabled in svelte.config: it runs before hooks and would otherwise 403 this
  // cross-site POST.) Handled here to keep the OAuth AS endpoints together. See lib/server/oauth/token.ts.
  if (event.url.pathname === "/oauth/token" && event.request.method === "POST") {
    return handleTokenRequest(event);
  }

  // The auth proxy must allow anonymous requests through so API-key/token callers can reach Stela.
  // For anonymous browser navigations, the configured auth surface decides whether to redirect to a
  // proxy login endpoint or return a minimal 401. API/key callers fall through to route guards.
  if (!dev && !event.locals.user) {
    const authResponse = loginRedirect(event);
    if (authResponse) return authResponse;
  }

  const response = await resolve(event);
  applySecurityHeaders(event, response);
  return response;
};

/**
 * Capture unhandled server errors with a correlation id so a recurring failure (storage throttling,
 * managed-identity token expiry, a corrupt-row throw) is observable in the server logs
 * instead of an opaque 500 with nothing to correlate. The id is returned to the client (rendered by
 * SvelteKit) without leaking the underlying message — quote it in a bug report to find the log line.
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
  // 404s and expected HTTP errors aren't worth the noise; only log real failures.
  if (status !== 404) {
    const id = randomUUID();
    console.error(`[stela] error ${id} on ${event.request.method} ${event.url.pathname}:`, error);
    return { message, errorId: id };
  }
  return { message };
};

/**
 * Defense-in-depth response headers for portal pages. The artifact `/raw` endpoint sets its
 * own (deliberately different) CSP and must stay framable by the portal, so it is excluded. The CSP
 * here is intentionally a SAFE SUBSET — frame-ancestors / object-src / base-uri / form-action only —
 * so it can't break the SvelteKit bootstrap, component styles, or fonts. A stricter script-src CSP
 * (via kit.csp) + self-hosted fonts is a separate, browser-verified change.
 */
export function applySecurityHeaders(event: RequestEvent, response: Response): void {
  const p = event.url.pathname;
  if (/^\/a\/[^/]+\/raw$/.test(p)) return; // artifact /raw endpoint owns its headers
  const h = response.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  // The OAuth consent page legitimately redirects its Approve/Deny form POST to the registered
  // client's callback. Chrome & Safari enforce `form-action` against the redirect target, so a bare
  // `form-action 'self'` silently blocks that 303 and the Approve button does nothing. Allow the
  // configured client-callback hosts there — the SAME allowlist as /oauth/register, single-sourced so
  // they can't drift; keep the strict CSP everywhere else.
  const formAction =
    p === "/oauth/authorize" ? `form-action ${consentFormActionSources()}` : "form-action 'self'";
  h.set(
    "Content-Security-Policy",
    `frame-ancestors 'none'; object-src 'none'; base-uri 'none'; ${formAction}`,
  );
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), browsing-topics=()");
  if (!dev) h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
}
