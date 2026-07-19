import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { makeEvent, testUser } from "../../test/helpers";
import { getStore } from "$lib/server/storage";
import { POST as registerPOST } from "./register/+server";
import { handleTokenRequest } from "$lib/server/oauth/token";
import { load as authorizeLoad, actions as authorizeActions } from "./authorize/+page.server";
import { protectedResourceMetadata, authorizationServerMetadata } from "$lib/server/oauth/metadata";

const store = getStore();
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const uid = (p = "u") => `${p}-${randomBytes(8).toString("hex")}`;

/** PKCE pair: verifier = random base64url, challenge = base64url(sha256(verifier)). */
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

// Distinct clientIp per call so the per-IP rate limits (register/token) never collide across tests.
function regEvent(redirectUris: string[]) {
  return makeEvent({
    method: "POST",
    path: "/oauth/register",
    body: { redirect_uris: redirectUris, client_name: "Claude" },
    clientIp: uid("ip"),
  });
}
function formEvent(
  path: string,
  fields: Record<string, string>,
  over: { headers?: Record<string, string>; user?: ReturnType<typeof testUser> | null } = {},
) {
  return makeEvent({
    method: "POST",
    path,
    body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", ...(over.headers ?? {}) },
    locals: { user: over.user ?? null },
    clientIp: uid("ip"),
  });
}

async function registerClient(redirectUris = [REDIRECT]): Promise<string> {
  const res = await registerPOST(regEvent(redirectUris));
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.client_id).toBeTruthy();
  return body.client_id as string;
}

/** Catch a thrown SvelteKit redirect (actions throw, they don't return a value). */
async function catchRedirect(fn: () => unknown): Promise<{ status: number; location: string }> {
  let returned = false;
  let threw: unknown;
  try {
    await fn();
    returned = true;
  } catch (e) {
    threw = e;
  }
  if (returned) throw new Error("expected a redirect to be thrown");
  return threw as { status: number; location: string };
}

type ConsentData = {
  clientName: string;
  fullBleed: boolean;
  user: { name: string; email: string };
  request: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    state: string;
    resource: string;
  };
};

/** Call the authorize load and surface its consent data (the generated type is `void | data`). */
async function loadConsent(event: ReturnType<typeof makeEvent>): Promise<ConsentData> {
  return (await authorizeLoad(event)) as unknown as ConsentData;
}

/** Full front channel: register → authorize(load) → approve. Returns the issued code + verifier. */
async function authorizeAndApprove(over: { scope?: string } = {}) {
  const user = testUser({ id: uid(), name: "Connie Sent", email: "connie@example.com" });
  const scope = over.scope ?? "stela offline_access";
  const { verifier, challenge } = pkce();
  const clientId = await registerClient();
  const state = "state-" + randomBytes(6).toString("hex");
  const query: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    state,
  };
  const data = await loadConsent(makeEvent({ path: "/oauth/authorize", query, locals: { user } }));
  expect(data.clientName).toBe("Claude");
  expect(data.user.email).toBe("connie@example.com");

  const redir = await catchRedirect(() =>
    authorizeActions.approve(formEvent("/oauth/authorize", query, { user })),
  );
  expect(redir.status).toBe(303);
  const loc = new URL(redir.location);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe(state);
  const code = loc.searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code!, verifier, clientId, user, scope };
}

function tokenForm(fields: Record<string, string>) {
  return handleTokenRequest(formEvent("/oauth/token", fields));
}

describe("POST /oauth/register (DCR)", () => {
  it("registers a claude.ai client and returns a client_id (public client, auth method none)", async () => {
    const res = await registerPOST(regEvent([REDIRECT]));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBeTruthy();
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.redirect_uris).toEqual([REDIRECT]);
  });

  it("allows a loopback redirect_uri (future Claude Code)", async () => {
    const res = await registerPOST(regEvent(["http://127.0.0.1:51789/callback"]));
    expect(res.status).toBe(201);
  });

  it("rejects a non-allowlisted redirect_uri host with invalid_redirect_uri", async () => {
    const res = await registerPOST(regEvent(["https://evil.example.com/cb"]));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_redirect_uri");
  });

  it("rejects a non-https claude.ai redirect_uri", async () => {
    const res = await registerPOST(regEvent(["http://claude.ai/api/mcp/auth_callback"]));
    expect(res.status).toBe(400);
  });
});

describe("GET /oauth/authorize (load)", () => {
  async function loadWith(query: Record<string, string>, user = testUser({ id: uid() })) {
    return loadConsent(makeEvent({ path: "/oauth/authorize", query, locals: { user } }));
  }
  function baseQuery(clientId: string, challenge: string): Record<string, string> {
    return {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "stela offline_access",
      state: "stateAbc1",
    };
  }

  it("validates a well-formed request and returns consent data", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const data = await loadWith(baseQuery(clientId, challenge));
    expect(data.clientName).toBe("Claude");
    expect(data.fullBleed).toBe(true);
    expect(data.request.clientId).toBe(clientId);
  });

  it("rejects an anonymous caller with 401", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    await expect(
      authorizeLoad(
        makeEvent({ path: "/oauth/authorize", query: baseQuery(clientId, challenge), locals: { user: null } }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects an unknown client_id with 400", async () => {
    const { challenge } = pkce();
    await expect(loadWith(baseQuery(uid("nope"), challenge))).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a redirect_uri not registered to the client with 400", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    await expect(
      loadWith({ ...baseQuery(clientId, challenge), redirect_uri: "https://claude.ai/evil" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-S256 challenge method with 400", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    await expect(
      loadWith({ ...baseQuery(clientId, challenge), code_challenge_method: "plain" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a missing state with 400", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const q = baseQuery(clientId, challenge);
    delete q.state;
    await expect(loadWith(q)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an unsupported scope with 400", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    await expect(
      loadWith({ ...baseQuery(clientId, challenge), scope: "stela admin" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("approve action + POST /oauth/token", () => {
  it("issues an access + refresh token for a valid code (full happy path)", async () => {
    const { code, verifier, clientId, user } = await authorizeAndApprove();
    const res = await tokenForm({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^sat_/);
    expect(body.refresh_token).toMatch(/^srt_/);
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.scope).toContain("stela");

    // The access token resolves to the consenting user; the refresh token does NOT grant resource access.
    expect(await store.resolveAccessToken(body.access_token)).toMatchObject({ id: user.id });
    expect(await store.resolveAccessToken(body.refresh_token)).toBeNull();
  });

  it("omits a refresh token when offline_access was not requested", async () => {
    const { code, verifier, clientId } = await authorizeAndApprove({ scope: "stela" });
    const res = await tokenForm({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).refresh_token).toBeUndefined();
  });

  it("is single-use: the same code cannot be redeemed twice", async () => {
    const { code, verifier, clientId } = await authorizeAndApprove();
    const ok = await tokenForm({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    expect(ok.status).toBe(200);
    const again = await tokenForm({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("invalid_grant");
  });

  it("rejects a wrong PKCE verifier with invalid_grant", async () => {
    const { code, clientId } = await authorizeAndApprove();
    const res = await tokenForm({
      grant_type: "authorization_code",
      code,
      code_verifier: randomBytes(32).toString("base64url"),
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("rejects a redirect_uri that differs from the one bound to the code", async () => {
    const { code, verifier, clientId } = await authorizeAndApprove();
    const res = await tokenForm({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: "https://claude.ai/api/mcp/other",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a client_id that differs from the one bound to the code", async () => {
    const { code, verifier } = await authorizeAndApprove();
    const res = await tokenForm({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: uid("other"),
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unsupported grant_type", async () => {
    const res = await tokenForm({ grant_type: "password", username: "x", password: "y" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });

  it("blocks a cross-origin approve POST (same-origin guard)", async () => {
    const { code: _c, verifier: _v, clientId } = await authorizeAndApprove();
    const { challenge } = pkce();
    await expect(
      authorizeActions.approve(
        formEvent(
          "/oauth/authorize",
          {
            response_type: "code",
            client_id: clientId,
            redirect_uri: REDIRECT,
            code_challenge: challenge,
            code_challenge_method: "S256",
            scope: "stela",
            state: "x",
          },
          { user: testUser({ id: uid() }), headers: { origin: "https://evil.example.com" } },
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("refresh_token grant", () => {
  it("rotates: a new pair is issued and the old refresh token is invalidated", async () => {
    const { code, verifier, clientId } = await authorizeAndApprove();
    const first = await (
      await tokenForm({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
      })
    ).json();

    const rotated = await tokenForm({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(rotated.status).toBe(200);
    const next = await rotated.json();
    expect(next.access_token).toMatch(/^sat_/);
    expect(next.refresh_token).toMatch(/^srt_/);
    expect(next.refresh_token).not.toBe(first.refresh_token);

    // The old refresh token is now dead (single-use rotation → blunts replay).
    const reuse = await tokenForm({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(reuse.status).toBe(400);
  });

  it("rejects an access token presented at the refresh grant", async () => {
    const { code, verifier, clientId } = await authorizeAndApprove();
    const issued = await (
      await tokenForm({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
      })
    ).json();
    const res = await tokenForm({
      grant_type: "refresh_token",
      refresh_token: issued.access_token, // a sat_ access token is not a refresh token
      client_id: clientId,
    });
    expect(res.status).toBe(400);
  });
});

describe("discovery metadata", () => {
  const ORIGIN = "https://stela.example.com";

  it("protected-resource metadata points at /mcp and this AS", () => {
    const m = protectedResourceMetadata(ORIGIN);
    expect(m.resource).toBe(`${ORIGIN}/mcp`);
    expect(m.authorization_servers).toContain(ORIGIN);
    expect(m.bearer_methods_supported).toContain("header");
  });

  it("authorization-server metadata advertises S256 + our endpoints", () => {
    const m = authorizationServerMetadata(ORIGIN) as Record<string, string[] | string>;
    expect(m.issuer).toBe(ORIGIN);
    expect(m.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(m.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(m.code_challenge_methods_supported).toContain("S256");
    expect(m.grant_types_supported).toContain("refresh_token");
  });
});
