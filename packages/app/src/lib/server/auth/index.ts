import { dev } from "$app/environment";
import { env } from "$env/dynamic/private";
import type { RequestEvent } from "@sveltejs/kit";
import { isValidUserId } from "@stela/shared";
import { timingSafeEqual } from "node:crypto";
import { getStore } from "$lib/server/storage";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "$lib/server/storage/types";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

/** Used locally and as the default admin-key publisher. */
const DEV_USER: SessionUser = {
  id: "dev-user-0001",
  name: "Dev User",
  email: "dev@example.com",
};

interface ClientPrincipalClaim {
  typ: string;
  val: string;
}
interface ClientPrincipal {
  auth_typ?: string;
  claims?: ClientPrincipalClaim[];
}

const CLAIM_OID = "http://schemas.microsoft.com/identity/claims/objectidentifier";
const CLAIM_EMAIL = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
const CLAIM_NAME = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name";

/**
 * Resolve the signed-in browser user through the configured trusted-header mode. Locally, fall back
 * to a dev user when no API credential is present.
 */
export function getCurrentUser(request: Request): SessionUser | null {
  const configured = getHeaderUser(request);
  if (configured) return configured;

  // Dev shim: a fake browser user so the app runs without an auth proxy. But NOT when the caller
  // presents an API credential — then they're exercising the key/token path, so let it fall through
  // to authenticateApiKey instead of being shadowed by the dev user.
  if (dev && !request.headers.get("x-api-key") && !request.headers.get("authorization")) {
    return DEV_USER;
  }
  return null;
}

function getHeaderUser(request: Request): SessionUser | null {
  if (env.AUTH_MODE !== "header") return null;
  if (env.AUTH_PRESET === "easyauth") {
    const header = request.headers.get("x-ms-client-principal");
    return header ? parseEasyAuthPrincipal(header) : null;
  }
  // Unsupported presets fail at production startup. Fail closed here too in case this runs in dev.
  if (env.AUTH_PRESET) return null;
  return parseGenericHeaders(request);
}

function parseGenericHeaders(request: Request): SessionUser | null {
  const idHeader = env.AUTH_HEADER_ID?.trim();
  if (!idHeader) return null;
  const rawId = readConfiguredHeader(request, idHeader);
  if (rawId === null || !isValidUserId(rawId)) return null;

  const id = rawId.trim();
  const email = readOptionalConfiguredHeader(request, env.AUTH_HEADER_EMAIL) ?? "";
  const name = readOptionalConfiguredHeader(request, env.AUTH_HEADER_NAME) ?? (email || id);
  return { id, name, email };
}

function readOptionalConfiguredHeader(
  request: Request,
  configuredName: string | undefined,
): string | null {
  const headerName = configuredName?.trim();
  if (!headerName) return null;
  const value = readConfiguredHeader(request, headerName)?.trim();
  return value || null;
}

function readConfiguredHeader(request: Request, headerName: string): string | null {
  try {
    return request.headers.get(headerName);
  } catch {
    // An invalid configured header name must never turn into an authenticated request.
    return null;
  }
}

/**
 * Handle an anonymous browser navigation according to the configured auth surface. Programmatic
 * endpoints and key-bearing requests fall through to their route-level 401 handling.
 */
export function loginRedirect(event: RequestEvent): Response | null {
  const { pathname, search } = event.url;
  const accept = event.request.headers.get("accept") ?? "";
  const isBrowserNav = event.request.method === "GET" && accept.includes("text/html");
  const isApi = pathname.startsWith("/api/");
  const isEasyAuthPath = env.AUTH_PRESET === "easyauth" && pathname.startsWith("/.auth");
  const isHealth = pathname === "/healthz";
  const isMcp = pathname === "/mcp";
  const hasKey =
    event.request.headers.has("x-api-key") || event.request.headers.has("authorization");
  if (!isBrowserNav || isApi || isEasyAuthPath || isHealth || isMcp || hasKey) return null;

  if (env.AUTH_MODE !== "header") return null;
  if (env.AUTH_PRESET === "easyauth") return easyAuthLoginRedirect(pathname, search);
  if (env.AUTH_PRESET) return null;
  if (env.AUTH_LOGIN_URL) {
    return new Response(null, { status: 302, headers: { location: env.AUTH_LOGIN_URL } });
  }

  // With no proxy login endpoint to send a browser to, render a plain failure instead of allowing
  // an anonymous portal shell to load without a usable session.
  return new Response("Unauthorized", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function easyAuthLoginRedirect(pathname: string, search: string): Response {
  // Easy Auth's post_login_redirect_uri silently drops query params after the first '&'. The CLI
  // pairing and OAuth consent routes carry params that must survive the login round-trip, so pack
  // them into one base64url `r` param.
  const packsParams =
    (pathname === "/cli/authorize" || pathname === "/oauth/authorize") && search;
  const returnTo = packsParams
    ? `${pathname}?r=${Buffer.from(search.slice(1), "utf8").toString("base64url")}`
    : pathname + search;
  const target = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(returnTo)}`;
  return new Response(null, { status: 302, headers: { location: target } });
}

/**
 * The API/publishing user. Two credentials resolve here, both carried in the
 * `Authorization: Bearer` or `x-api-key` header:
 *   - the configured shared admin key (`STELA_API_KEY`) → the configured identity (CI / break-glass);
 *   - a per-user token minted via SSO pairing (`stela login`) → that user, via a storage lookup.
 * Browser users never reach here — they come through `getCurrentUser()` / `locals.user`.
 */
export async function authenticateApiKey(request: Request): Promise<SessionUser | null> {
  const provided = extractCredential(request);
  if (!provided) return null;
  const admin = matchAdminKey(provided);
  if (admin) return admin;
  // OAuth access tokens (claude.ai connector) carry a distinct prefix → resolve via the OAuth store.
  // Everything else is a CLI per-user pairing token. Routing by prefix keeps this a single lookup.
  if (provided.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return getStore().resolveAccessToken(provided);
  return getStore().resolveToken(provided);
}

/** Pull the bearer/api-key credential from the request, or null. */
function extractCredential(request: Request): string | null {
  const auth = request.headers.get("authorization");
  const bearer = auth ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  return bearer || request.headers.get("x-api-key");
}

/** The configured shared key → configured identity. Fails closed in production. */
function matchAdminKey(provided: string): SessionUser | null {
  const expected = env.STELA_API_KEY ?? (dev ? "dev-publish-key" : null);
  if (!expected || !safeEqual(provided, expected)) return null;
  // Identity must be configured in prod — don't silently attribute publishes to the dev user.
  const id = env.STELA_API_USER_ID ?? (dev ? DEV_USER.id : null);
  if (!id) return null;
  return {
    id,
    name: env.STELA_API_USER_NAME ?? (dev ? DEV_USER.name : id),
    email: env.STELA_API_USER_EMAIL ?? (dev ? DEV_USER.email : ""),
  };
}

/** Constant-time string comparison (length-checked first). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Parse the Azure App Service Easy Auth client-principal contract exactly as before. */
function parseEasyAuthPrincipal(header: string): SessionUser | null {
  if (header.length > 8192) return null; // bound the work before decoding/parsing
  try {
    const decoded = Buffer.from(header, "base64").toString("utf8");
    const principal = JSON.parse(decoded) as ClientPrincipal;
    const claims = new Map((principal.claims ?? []).map((c) => [c.typ, c.val]));
    const oid = claims.get(CLAIM_OID) ?? claims.get("oid");
    // Easy Auth's Entra oid is the immutable authz key; require it to be GUID-shaped.
    if (!oid || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(oid)) return null;
    const email =
      claims.get(CLAIM_EMAIL) ?? claims.get("preferred_username") ?? claims.get("emails") ?? "";
    const name = claims.get("name") ?? claims.get(CLAIM_NAME) ?? (email || oid);
    return { id: oid, name, email };
  } catch {
    return null;
  }
}
