import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { getStore } from "$lib/server/storage";
import { rateLimit, clientIp } from "$lib/server/ratelimit";
import { ClientRegistrationRequest } from "@stela/shared";
import { isAllowedRedirectUri } from "$lib/server/oauth/allowedClients";

function regError(error: string, description: string): Response {
  return json({ error, error_description: description }, { status: 400 });
}

/** Dynamic Client Registration (RFC 7591) — public, pre-auth (claude.ai calls this before login). */
export const POST: RequestHandler = async (event) => {
  rateLimit("oauth-register", clientIp(event), 20, 60_000);
  const parsed = ClientRegistrationRequest.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) return regError("invalid_client_metadata", "Malformed registration request");
  const blocked = parsed.data.redirect_uris.find((u) => !isAllowedRedirectUri(u));
  if (blocked) {
    // Log the rejected URI server-side so we can see exactly which host a new client (Grok/ChatGPT/
    // Copilot) uses, then add it to OAUTH_ALLOWED_CLIENT_HOSTS.
    console.warn(`[stela] OAuth DCR rejected — redirect_uri host not allowlisted: ${blocked}`);
    return regError("invalid_redirect_uri", "redirect_uris must use an allowlisted client host or loopback");
  }
  const client = await getStore().registerClient({
    clientName: parsed.data.client_name ?? "MCP client",
    redirectUris: parsed.data.redirect_uris,
  });
  return json(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: client.clientName,
    },
    { status: 201 },
  );
};
