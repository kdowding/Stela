import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";
import { assertSameOrigin } from "$lib/server/guards";
import { getStore } from "$lib/server/storage";
import { rateLimit, clientIp } from "$lib/server/ratelimit";
import { CliTokenRequest, type CliTokenResponse } from "@stela/shared";

/**
 * Exchange a one-time pairing code (from GET /cli/authorize) for a durable per-user token.
 * The code itself is the credential, so no session/key auth is required here. CLI callers send
 * no Origin, so the same-origin guard only blocks cross-site browser abuse.
 */
export const POST: RequestHandler = async (event) => {
  assertSameOrigin(event);
  rateLimit("cli-token", clientIp(event), 30, 60_000);
  const parsed = CliTokenRequest.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) throw error(400, "Invalid request");

  const result = await getStore().redeemPairingCode(parsed.data.code, parsed.data.verifier);
  if (!result) throw error(400, "Invalid or expired code");

  const body: CliTokenResponse = {
    token: result.token,
    name: result.user.name,
    email: result.user.email,
  };
  return json(body);
};

/** Sign out: revoke whatever token the caller presents. */
export const DELETE: RequestHandler = async (event) => {
  assertSameOrigin(event);
  const provided =
    event.request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
    event.request.headers.get("x-api-key");
  if (provided) await getStore().revokeToken(provided);
  return new Response(null, { status: 204 });
};
