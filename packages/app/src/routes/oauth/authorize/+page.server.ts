import type { Actions, PageServerLoad, RequestEvent } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { getStore } from "$lib/server/storage";
import { rateLimit } from "$lib/server/ratelimit";
import { assertSameOrigin } from "$lib/server/guards";

const SUPPORTED_SCOPES = new Set(["stela", "offline_access"]);

interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state: string;
  resource: string;
}

/**
 * Validate the authorize params against a registered client. Throws 400 on anything we cannot safely
 * act on (unknown client / mismatched redirect_uri — we must NEVER redirect to an unvalidated URI).
 */
async function validate(
  p: URLSearchParams,
): Promise<{ req: AuthorizeRequest; clientName: string }> {
  if ((p.get("response_type") ?? "") !== "code") {
    throw error(400, "Unsupported response_type (only 'code')");
  }
  const clientId = p.get("client_id") ?? "";
  const client = clientId ? await getStore().getClient(clientId) : null;
  if (!client) throw error(400, "Unknown client_id");
  const redirectUri = p.get("redirect_uri") ?? "";
  if (!client.redirectUris.includes(redirectUri)) throw error(400, "redirect_uri mismatch");
  const codeChallenge = p.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    throw error(400, "Invalid code_challenge (S256, base64url, 43 chars required)");
  }
  if ((p.get("code_challenge_method") ?? "") !== "S256") {
    throw error(400, "code_challenge_method must be S256");
  }
  const scope = (p.get("scope") ?? "stela").trim() || "stela";
  if (!scope.split(/\s+/).every((s) => SUPPORTED_SCOPES.has(s))) throw error(400, "Unsupported scope");
  const state = p.get("state") ?? "";
  // Length-bound only (OAuth state is opaque) — it's reflected verbatim into the callback redirect; the
  // CLI flow bounds its equivalent, the OAuth path didn't (F26).
  if (!state || state.length > 512) throw error(400, "Invalid state");
  return {
    req: { clientId, redirectUri, codeChallenge, scope, state, resource: p.get("resource") ?? "" },
    clientName: client.clientName,
  };
}

/** Easy Auth (hooks) packs the OAuth query into a base64url `r` param across the login round-trip. */
function readParams(url: URL): URLSearchParams {
  const packed = url.searchParams.get("r");
  return packed !== null
    ? new URLSearchParams(Buffer.from(packed, "base64url").toString("utf8"))
    : url.searchParams;
}

function appendQuery(uri: string, params: Record<string, string>): string {
  return uri + (uri.includes("?") ? "&" : "?") + new URLSearchParams(params).toString();
}

export const load: PageServerLoad = async (event) => {
  const user = event.locals.user;
  if (!user) throw error(401, "Sign in first");
  rateLimit("oauth-authorize", user.id, 30, 60_000);
  const { req, clientName } = await validate(readParams(event.url));
  return {
    fullBleed: true, // render without portal chrome — a focused consent screen
    clientName,
    user: { name: user.name, email: user.email },
    request: req,
  };
};

/**
 * Re-validate the submitted params against the registered client — never trust the resubmitted
 * hidden fields blindly (a tampered redirect_uri / client_id must not slip past). Returns the request.
 */
async function reparse(event: RequestEvent): Promise<AuthorizeRequest> {
  const form = await event.request.formData();
  const p = new URLSearchParams();
  for (const k of [
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "scope",
    "state",
    "resource",
  ]) {
    p.set(k, String(form.get(k) ?? ""));
  }
  return (await validate(p)).req;
}

export const actions: Actions = {
  approve: async (event) => {
    const user = event.locals.user;
    if (!user) throw error(401, "Sign in first");
    assertSameOrigin(event);
    const req = await reparse(event);
    const code = await getStore().createAuthCode(user, {
      clientId: req.clientId,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      scope: req.scope,
      resource: req.resource,
    });
    throw redirect(303, appendQuery(req.redirectUri, { code, state: req.state }));
  },
  deny: async (event) => {
    if (!event.locals.user) throw error(401, "Sign in first");
    assertSameOrigin(event);
    const req = await reparse(event);
    throw redirect(303, appendQuery(req.redirectUri, { error: "access_denied", state: req.state }));
  },
};
