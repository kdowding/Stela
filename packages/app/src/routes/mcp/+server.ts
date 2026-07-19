import type { RequestHandler } from "./$types";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateApiKey } from "$lib/server/auth";
import { buildMcpServer } from "$lib/server/mcp/buildServer";
import { clientIp, rateLimit } from "$lib/server/ratelimit";

/**
 * Remote MCP endpoint (Streamable HTTP) — the control plane for claude.ai custom connectors and
 * any other remote MCP client.
 *
 * Auth is Bearer-only via `authenticateApiKey` (admin key or per-user token today; an OAuth access
 * token once the AS layer lands). No cookie is involved, so this is inherently CSRF-safe and mirrors
 * `POST /api/artifacts`. On a missing/invalid token we emit the RFC 9728 discovery hint
 * (`WWW-Authenticate: Bearer resource_metadata=...`) so an MCP client knows where to begin the OAuth
 * flow — the metadata document itself is served once the AS layer is built.
 *
 * Stateless + JSON responses: a fresh `McpServer` + transport per request (no server-held session),
 * which fits a tools-only server and avoids in-memory session state. `handleRequest(request)` returns
 * a Web `Response` directly — no Node req/res bridge needed (the SDK's web-standard transport).
 */
function unauthorized(origin: string): Response {
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized: present a Bearer token" },
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
      },
    },
  );
}

const handle: RequestHandler = async (event) => {
  const { request, url } = event;
  // Pre-auth IP rate limit (defense-in-depth — an edge WAF is the durable control). Every request runs
  // authenticateApiKey, which point-reads the token table for a `sat_`-prefixed bearer; without this an
  // unauthenticated token-guess loop is a billed-Table amplification vector (F4).
  rateLimit("mcp", clientIp(event), 120, 60_000);
  const user = await authenticateApiKey(request);
  if (!user) return unauthorized(url.origin);

  const server = buildMcpServer(user, url.origin);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session continuity needed for a tools server
    enableJsonResponse: true, // single JSON response instead of opening an SSE stream
  });
  await server.connect(transport);
  return transport.handleRequest(request);
};

// Streamable HTTP uses POST for JSON-RPC, GET to open a notification stream, and DELETE to end a
// session. Route all three through the transport so it can answer each correctly (e.g. 405 for an
// unsupported GET in stateless mode) rather than SvelteKit's generic method handling.
export const POST = handle;
export const GET = handle;
export const DELETE = handle;
