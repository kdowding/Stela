import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzureStore } from "./azure";
import { SqliteStore } from "./sqlite";
import type { Store } from "./types";

// Audit follow-up coverage.
const scratch = mkdtempSync(join(tmpdir(), "stela-store-audit-conformance-"));
const sqlite = new SqliteStore(scratch);
const drivers: { name: string; store: Store }[] = [
  { name: "SqliteStore", store: sqlite },
  { name: "AzureStore", store: new AzureStore() },
];

afterAll(() => {
  sqlite.close();
  rmSync(scratch, { recursive: true, force: true });
});

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const oauthUser = () => ({ id: `oauth-${randomBytes(4).toString("hex")}`, name: "O", email: "o@x.com" });

for (const { name, store } of drivers) {
describe(`${name} — OAuth token lifecycle`, () => {
  afterEach(() => vi.useRealTimers());

  it("issues + resolves an access token, then reaps it past its 1h expiry", async () => {
    vi.useFakeTimers();
    const user = oauthUser();
    const { accessToken } = await store.issueTokens(user, { clientId: "c1", scope: "stela" });
    expect(await store.resolveAccessToken(accessToken)).toMatchObject({ id: user.id });
    vi.advanceTimersByTime(61 * 60 * 1000); // past OAUTH_ACCESS_TTL_MS (1h)
    expect(await store.resolveAccessToken(accessToken)).toBeNull();
  });

  it("single-uses a refresh token and BURNS it on a client_id mismatch", async () => {
    const user = oauthUser();
    const { refreshToken } = await store.issueTokens(user, { clientId: "c1", scope: "stela offline_access" });
    expect(refreshToken).toBeTruthy();
    // Wrong client_id: rotation fails — and the delete runs before the client check, so the token is burned.
    expect(await store.rotateRefreshToken(refreshToken!, { clientId: "wrong" })).toBeNull();
    // Even the correct client_id now fails, proving the burn-on-mismatch ordering.
    expect(await store.rotateRefreshToken(refreshToken!, { clientId: "c1" })).toBeNull();
  });

  it("rotates a refresh token and rejects the presented one on reuse (single-use replay)", async () => {
    const user = oauthUser();
    const { refreshToken } = await store.issueTokens(user, { clientId: "c1", scope: "stela offline_access" });
    const rotated = await store.rotateRefreshToken(refreshToken!, { clientId: "c1" });
    expect(rotated?.refreshToken).toBeTruthy();
    expect(await store.rotateRefreshToken(refreshToken!, { clientId: "c1" })).toBeNull(); // old one dead
  });

  it("rejects a refresh token past its 90-day absolute TTL", async () => {
    vi.useFakeTimers();
    const user = oauthUser();
    const { refreshToken } = await store.issueTokens(user, { clientId: "c1", scope: "stela offline_access" });
    vi.advanceTimersByTime(91 * 24 * 60 * 60 * 1000); // past TOKEN_TTL_MS (90d)
    expect(await store.rotateRefreshToken(refreshToken!, { clientId: "c1" })).toBeNull();
  });

  it("expires an OAuth auth code past its 2-minute TTL", async () => {
    vi.useFakeTimers();
    const user = oauthUser();
    const { verifier, challenge } = pkce();
    const code = await store.createAuthCode(user, { clientId: "c1", redirectUri: "https://c/cb", codeChallenge: challenge, scope: "stela" });
    vi.advanceTimersByTime(3 * 60 * 1000); // past OAUTH_CODE_TTL_MS (2m)
    expect(await store.redeemAuthCode(code, { verifier, clientId: "c1", redirectUri: "https://c/cb" })).toBeNull();
  });
});

describe(`${name} — deleteVersion repoint (F11)`, () => {
  async function threeVersions(): Promise<string> {
    const { artifact } = await store.createArtifact({
      ownerId: "u1", ownerName: "U1", title: "T", visibility: "private", allowedPrincipals: [], html: "<h1>v1</h1>",
    });
    await store.addVersion(artifact.id, { html: "<h1>v2</h1>", publishedById: "u1" });
    await store.addVersion(artifact.id, { html: "<h1>v3</h1>", publishedById: "u1" });
    return artifact.id; // current = 3
  }

  it("leaves currentVersion unchanged when a non-current version is deleted", async () => {
    const id = await threeVersions();
    expect(await store.deleteVersion(id, 1)).toBe(3); // delete the oldest, non-current
    expect((await store.getArtifact(id))?.currentVersion).toBe(3);
  });

  it("repoints to the highest remaining when the current version is deleted", async () => {
    const id = await threeVersions();
    expect(await store.deleteVersion(id, 3)).toBe(2);
    expect((await store.getArtifact(id))?.currentVersion).toBe(2);
  });
});
}
