import type { RequestHandler } from "./$types";
import { error } from "@sveltejs/kit";
import { getStore } from "$lib/server/storage";
import { rateLimit } from "$lib/server/ratelimit";

/**
 * Browser-only CLI pairing start. Easy Auth (via hooks.server.ts) bounces anonymous browser
 * navigations to Entra login, so by the time we run, `locals.user` is the caller's real identity.
 * We mint a single-use code bound to that user and bounce it to the CLI's loopback listener; the
 * CLI exchanges it for a durable token at POST /cli/token. The durable token never travels in a URL.
 */
export const GET: RequestHandler = async (event) => {
  // Don't mint pairing codes for speculative prefetch/prerender navigations (defense in
  // depth; PKCE + rate limiting are the primary controls).
  const purpose = event.request.headers.get("sec-purpose") ?? "";
  if (purpose.includes("prefetch") || purpose.includes("prerender")) throw error(403, "Forbidden");

  const user = event.locals.user;
  if (!user) throw error(401, "Sign in first");
  rateLimit("cli-authorize", user.id, 30, 60_000);

  // Easy Auth's post_login_redirect_uri silently drops query params after the first '&' during the
  // login round-trip. So when hooks bounces an anonymous pairing request through Entra it packs the
  // params into a single base64url `r` value (no reserved chars → survives intact); unpack it here.
  // The already-authenticated case skips the redirect and arrives with the params directly.
  const packed = event.url.searchParams.get("r");
  const params =
    packed !== null
      ? new URLSearchParams(Buffer.from(packed, "base64url").toString("utf8"))
      : event.url.searchParams;

  const port = Number(params.get("port"));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw error(400, "Invalid loopback port");
  }
  const state = params.get("state") ?? "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(state)) throw error(400, "Invalid state");
  // PKCE: bind the code to the caller's challenge so a leaked/CSRF-minted code is useless without
  // the verifier (base64url(SHA-256(verifier)) = 43 chars).
  const challenge = params.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw error(400, "Invalid code_challenge");

  const code = await getStore().createPairingCode(user, challenge);
  const target = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  return new Response(null, { status: 302, headers: { location: target } });
};
