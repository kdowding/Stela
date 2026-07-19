import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { getCurrentUser, authenticateApiKey } from "./index";
import { getStore } from "$lib/server/storage";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "$lib/server/storage/types";

// Integration tests use the default SQLite store. Every test mints unique user ids so persisted test
// state cannot collide across runs.
const store = getStore();

const uniqueUserId = () => {
  // GUID-shaped, unique per test. The Easy Auth preset requires the Entra oid claim to be a GUID.
  const h = randomBytes(16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** Encode an Easy Auth client principal the way Azure does: base64 of a JSON blob of claims. */
function encodePrincipal(opts: {
  oid?: string;
  email?: string;
  name?: string;
  auth_typ?: string;
  claims?: { typ: string; val: string }[];
}): string {
  const claims = opts.claims ?? [
    ...(opts.oid !== undefined
      ? [{ typ: "http://schemas.microsoft.com/identity/claims/objectidentifier", val: opts.oid }]
      : []),
    ...(opts.email !== undefined
      ? [{ typ: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", val: opts.email }]
      : []),
    ...(opts.name !== undefined ? [{ typ: "name", val: opts.name }] : []),
  ];
  const json = JSON.stringify({ auth_typ: opts.auth_typ ?? "aad", claims });
  return Buffer.from(json, "utf8").toString("base64");
}

const req = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/", { headers });

beforeEach(() => {
  vi.stubEnv("AUTH_MODE", "");
  vi.stubEnv("AUTH_PRESET", "");
  vi.stubEnv("AUTH_HEADER_ID", "");
  vi.stubEnv("AUTH_HEADER_NAME", "");
  vi.stubEnv("AUTH_HEADER_EMAIL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getCurrentUser — dev shim", () => {
  it("returns the DEV_USER when no credential header is present", () => {
    expect(getCurrentUser(req())).toMatchObject({
      id: "dev-user-0001",
      name: "Dev User",
      email: "dev@example.com",
    });
  });

  it("steps aside when an x-api-key header is present", () => {
    expect(getCurrentUser(req({ "x-api-key": "dev-publish-key" }))).toBeNull();
  });

  it("steps aside when an authorization header is present", () => {
    expect(getCurrentUser(req({ authorization: "Bearer some-token" }))).toBeNull();
  });
});

describe("getCurrentUser — Easy Auth preset", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_MODE", "header");
    vi.stubEnv("AUTH_PRESET", "easyauth");
  });

  it("parses a valid x-ms-client-principal into a SessionUser", () => {
    const oid = uniqueUserId();
    const header = encodePrincipal({ oid, email: "alice@example.com", name: "Alice Example" });
    expect(getCurrentUser(req({ "x-ms-client-principal": header }))).toEqual({
      id: oid,
      email: "alice@example.com",
      name: "Alice Example",
    });
  });

  it("falls back to email for name when no name claim is present", () => {
    const oid = uniqueUserId();
    const header = encodePrincipal({ oid, email: "noname@example.com" });
    expect(getCurrentUser(req({ "x-ms-client-principal": header }))).toEqual({
      id: oid,
      email: "noname@example.com",
      name: "noname@example.com",
    });
  });

  // Easy Auth sets x-ms-client-principal-id from the per-app `sub`, which differs from
  // the directory `oid`, so the principal is accepted regardless of the companion id header value.
  it("accepts a principal regardless of the x-ms-client-principal-id companion header", () => {
    const oid = uniqueUserId();
    const header = encodePrincipal({ oid, email: "match@example.com", name: "Match" });
    const user = getCurrentUser(
      req({ "x-ms-client-principal": header, "x-ms-client-principal-id": "different-sub-99" }),
    );
    expect(user?.id).toBe(oid);
  });

  it("rejects a principal whose oid is not GUID-shaped", () => {
    const header = encodePrincipal({ oid: "not-a-guid", email: "x@example.com", name: "X" });
    expect(getCurrentUser(req({ "x-ms-client-principal": header, "x-api-key": "x" }))).toBeNull();
  });

  it("rejects a principal with no oid claim", () => {
    const header = encodePrincipal({ email: "x@example.com", name: "X" });
    expect(getCurrentUser(req({ "x-ms-client-principal": header, "x-api-key": "x" }))).toBeNull();
  });

  it("rejects an over-long header before decoding (8192-byte bound)", () => {
    const oid = uniqueUserId();
    const big = encodePrincipal({ oid, email: "x@example.com", name: "x".repeat(7000) });
    expect(big.length).toBeGreaterThan(8192);
    expect(getCurrentUser(req({ "x-ms-client-principal": big, "x-api-key": "x" }))).toBeNull();

    const ok = encodePrincipal({ oid, email: "x@example.com", name: "Small" });
    expect(ok.length).toBeLessThan(8192);
    expect(getCurrentUser(req({ "x-ms-client-principal": ok }))?.id).toBe(oid);
  });

  it("returns null for malformed principal JSON", () => {
    expect(
      getCurrentUser(req({ "x-ms-client-principal": "!!!notjson!!!", "x-api-key": "x" })),
    ).toBeNull();
  });
});

describe("authenticateApiKey — admin key", () => {
  it("resolves the dev admin key to the dev identity", async () => {
    expect(await authenticateApiKey(req({ "x-api-key": "dev-publish-key" }))).toMatchObject({
      id: "dev-user-0001",
      name: "Dev User",
      email: "dev@example.com",
    });
  });

  it("resolves the dev admin key via Authorization: Bearer too", async () => {
    expect((await authenticateApiKey(req({ authorization: "Bearer dev-publish-key" })))?.id).toBe(
      "dev-user-0001",
    );
  });

  it("returns null when no credential is provided", async () => {
    expect(await authenticateApiKey(req())).toBeNull();
  });

  it("returns null for an unknown key", async () => {
    expect(await authenticateApiKey(req({ "x-api-key": "totally-bogus-key" }))).toBeNull();
  });

  it("returns null for an unknown bearer token", async () => {
    expect(
      await authenticateApiKey(req({ authorization: "Bearer totally-bogus-token" })),
    ).toBeNull();
  });
});

describe("authenticateApiKey — per-user pairing token", () => {
  it("resolves a minted per-user token via x-api-key", async () => {
    const userId = uniqueUserId();
    const { verifier, challenge } = pkce();
    const code = await store.createPairingCode(
      { id: userId, name: "Pair One", email: "pair1@example.com" },
      challenge,
    );
    const redeemed = await store.redeemPairingCode(code, verifier);
    expect(redeemed).not.toBeNull();
    expect(await authenticateApiKey(req({ "x-api-key": redeemed!.token }))).toMatchObject({
      id: userId,
      name: "Pair One",
      email: "pair1@example.com",
    });
  });

  it("resolves a minted per-user token via Authorization: Bearer", async () => {
    const userId = uniqueUserId();
    const { verifier, challenge } = pkce();
    const code = await store.createPairingCode(
      { id: userId, name: "Pair Two", email: "pair2@example.com" },
      challenge,
    );
    const redeemed = await store.redeemPairingCode(code, verifier);
    const user = await authenticateApiKey(
      req({ authorization: `Bearer ${redeemed!.token}` }),
    );
    expect(user?.id).toBe(userId);
  });

  it("returns null after a token is revoked", async () => {
    const userId = uniqueUserId();
    const { verifier, challenge } = pkce();
    const code = await store.createPairingCode(
      { id: userId, name: "Pair Three", email: "pair3@example.com" },
      challenge,
    );
    const redeemed = await store.redeemPairingCode(code, verifier);
    expect(await authenticateApiKey(req({ "x-api-key": redeemed!.token }))).toMatchObject({
      id: userId,
    });
    await store.revokeToken(redeemed!.token);
    expect(await authenticateApiKey(req({ "x-api-key": redeemed!.token }))).toBeNull();
  });
});

describe("authenticateApiKey — OAuth access-token prefix routing", () => {
  it("resolves a minted OAuth access token through the sat_ branch", async () => {
    const userId = uniqueUserId();
    const tokens = await store.issueTokens(
      { id: userId, name: "OAuth User", email: "oauth@example.com" },
      { clientId: "client-x", scope: "stela" },
    );
    expect(tokens.accessToken.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(
      await authenticateApiKey(req({ authorization: `Bearer ${tokens.accessToken}` })),
    ).toMatchObject({ id: userId, name: "OAuth User", email: "oauth@example.com" });
  });

  it("returns null for an unknown sat_-prefixed token", async () => {
    const bogus = OAUTH_ACCESS_TOKEN_PREFIX + randomBytes(16).toString("hex");
    expect(await authenticateApiKey(req({ "x-api-key": bogus }))).toBeNull();
  });
});
