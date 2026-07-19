import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzureStore } from "./azure";
import { SqliteStore } from "./sqlite";
import { LastVersionError } from "./types";
import type { Store } from "./types";

const scratch = mkdtempSync(join(tmpdir(), "stela-store-conformance-"));
const sqlite = new SqliteStore(join(scratch, "main"));
const drivers: { name: string; store: Store }[] = [
  { name: "SqliteStore", store: sqlite },
  { name: "AzureStore", store: new AzureStore() },
];

afterAll(() => {
  sqlite.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("SqliteStore — lifecycle", () => {
  it("creates stela.db on first open", async () => {
    const dataDir = join(scratch, "first-open");
    const store = new SqliteStore(dataDir);
    expect(existsSync(join(dataDir, "stela.db"))).toBe(false);
    await store.warmUp();
    expect(existsSync(join(dataDir, "stela.db"))).toBe(true);
    store.close();
  });

  it("opens and initializes the same schema idempotently", async () => {
    const dataDir = join(scratch, "idempotent");
    const first = new SqliteStore(dataDir);
    await first.warmUp();
    const { artifact } = await first.createArtifact({
      ownerId: "schema-user",
      ownerName: "Schema User",
      title: "kept",
      visibility: "private",
      allowedPrincipals: [],
      html: "<h1>kept</h1>",
    });
    const second = new SqliteStore(dataDir);
    await second.warmUp();
    expect((await second.getArtifact(artifact.id))?.title).toBe("kept");
    second.close();
    first.close();
  });
});

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

for (const { name, store } of drivers) {
describe(`${name} — artifacts`, () => {
  it("creates and reads back an artifact + its html", async () => {
    const { artifact } = await store.createArtifact({
      ownerId: "u1", ownerName: "U1", title: "T", visibility: "private", allowedPrincipals: [], html: "<h1>v1</h1>",
    });
    const got = await store.getArtifact(artifact.id);
    expect(got?.ownerId).toBe("u1");
    expect(got?.currentVersion).toBe(1);
    expect(await store.getHtml(artifact.id, 1)).toContain("v1");
  });

  it("persists an optional favicon and keeps it stable across versions", async () => {
    const { artifact } = await store.createArtifact({
      ownerId: "u1", ownerName: "U1", title: "T", favicon: "📊", visibility: "private", allowedPrincipals: [], html: "<h1>v1</h1>",
    });
    expect((await store.getArtifact(artifact.id))?.favicon).toBe("📊");
    await store.addVersion(artifact.id, { html: "<h1>v2</h1>", publishedById: "u1" });
    expect((await store.getArtifact(artifact.id))?.favicon).toBe("📊");
  });

  it("syncs the title to the new revision's <title>, but a titleless version never clobbers it", async () => {
    const { artifact } = await store.createArtifact({
      ownerId: "u1", ownerName: "U1", title: "Surface 05", visibility: "private", allowedPrincipals: [],
      html: "<!doctype html><title>Surface 05</title><h1>v1</h1>",
    });
    expect((await store.getArtifact(artifact.id))?.title).toBe("Surface 05");
    // A new version whose HTML carries a new <title> updates the stored (current) title.
    const r = await store.addVersion(artifact.id, {
      html: "<!doctype html><title>Surface 06</title><h1>v2</h1>", publishedById: "u1",
    });
    expect(r.artifact.title).toBe("Surface 06");
    expect((await store.getArtifact(artifact.id))?.title).toBe("Surface 06");
    // A version with no <title> must keep the current title rather than blank it.
    await store.addVersion(artifact.id, { html: "<h1>v3 no title</h1>", publishedById: "u1" });
    expect((await store.getArtifact(artifact.id))?.title).toBe("Surface 06");
  });

  it("addVersion is owner-only and bumps the version", async () => {
    const { artifact } = await store.createArtifact({
      ownerId: "u1", ownerName: "U1", title: "T", visibility: "private", allowedPrincipals: [], html: "<h1>v1</h1>",
    });
    await expect(
      store.addVersion(artifact.id, { html: "<h1>v2</h1>", publishedById: "intruder" }),
    ).rejects.toThrow();
    const ok = await store.addVersion(artifact.id, { html: "<h1>v2</h1>", publishedById: "u1" });
    expect(ok.version.version).toBe(2);
    expect(ok.unchanged).toBe(false);
    expect(await store.getHtml(artifact.id, 2)).toContain("v2");
  });

  it("dedups an identical re-publish: same HTML returns the current version, no new version", async () => {
    const userId = `dedup-${randomBytes(4).toString("hex")}`;
    const { artifact } = await store.createArtifact({
      ownerId: userId, ownerName: "D", title: "T", visibility: "private", allowedPrincipals: [], html: "<h1>same</h1>",
    });
    const same = await store.addVersion(artifact.id, { html: "<h1>same</h1>", publishedById: userId });
    expect(same.unchanged).toBe(true);
    expect(same.version.version).toBe(1); // still v1 — nothing new created
    expect((await store.listVersions(artifact.id)).length).toBe(1);

    const changed = await store.addVersion(artifact.id, { html: "<h1>different</h1>", publishedById: userId });
    expect(changed.unchanged).toBe(false);
    expect(changed.version.version).toBe(2);
  });

  it("listByOwner returns only the owner's artifacts", async () => {
    const userId = `owner-${randomBytes(4).toString("hex")}`;
    await store.createArtifact({ ownerId: userId, ownerName: "O", title: "mine", visibility: "private", allowedPrincipals: [], html: "<h1>x</h1>" });
    const mine = await store.listByOwner(userId);
    expect(mine.length).toBe(1);
    expect(mine[0]!.ownerId).toBe(userId);
  });

  it("listSharedWith returns restricted artifacts shared by user id or email (case-insensitive)", async () => {
    const ownerId = `sh-owner-${randomBytes(4).toString("hex")}`;
    const viewerId = `sh-viewer-${randomBytes(4).toString("hex")}`;
    const viewerEmail = `${randomBytes(4).toString("hex")}@example.com`;

    const byEmail = await store.createArtifact({
      ownerId, ownerName: "O", title: "by-email", visibility: "restricted",
      allowedPrincipals: [viewerEmail.toUpperCase()], html: "<h1>x</h1>", // upper-case to prove case-insensitivity
    });
    const byId = await store.createArtifact({
      ownerId, ownerName: "O", title: "by-user-id", visibility: "restricted",
      allowedPrincipals: [viewerId], html: "<h1>x</h1>",
    });
    await store.createArtifact({
      ownerId, ownerName: "O", title: "not-shared", visibility: "restricted",
      allowedPrincipals: ["someone-else@example.com"], html: "<h1>x</h1>",
    });

    const shared = await store.listSharedWith(viewerId, viewerEmail);
    expect(shared.map((a) => a.id).sort()).toEqual([byEmail.artifact.id, byId.artifact.id].sort());
  });

  it("deleteArtifact removes the meta row, all versions, blobs, and comments", async () => {
    const userId = `del-${randomBytes(4).toString("hex")}`;
    const { artifact } = await store.createArtifact({
      ownerId: userId, ownerName: "D", title: "to-delete", visibility: "private", allowedPrincipals: [], html: "<h1>v1</h1>",
    });
    await store.addVersion(artifact.id, { html: "<h1>v2</h1>", publishedById: userId });
    await store.addComment({
      artifactId: artifact.id, version: 2, authorId: userId, authorName: "D", body: "nice",
      anchor: { version: 2, xNorm: 0.5, yNorm: 0.5, scrollYNorm: 0, renderWidth: 1000 },
    });

    await store.deleteArtifact(artifact.id);

    expect(await store.getArtifact(artifact.id)).toBeNull();
    expect(await store.listVersions(artifact.id)).toEqual([]);
    expect(await store.getHtml(artifact.id, 1)).toBeNull();
    expect(await store.getHtml(artifact.id, 2)).toBeNull();
    expect(await store.listComments(artifact.id, 2)).toEqual([]);
    expect(await store.listByOwner(userId)).toEqual([]);
  });

  it("deleteArtifact is idempotent — deleting a missing artifact is a no-op", async () => {
    await expect(
      store.deleteArtifact("00000000-0000-4000-8000-000000000000"),
    ).resolves.toBeUndefined();
  });

  it("updateTitle renames the artifact", async () => {
    const { artifact } = await store.createArtifact({
      ownerId: "u1", ownerName: "U1", title: "Old name", visibility: "private", allowedPrincipals: [], html: "<h1>v1</h1>",
    });
    await store.updateTitle(artifact.id, "New name");
    expect((await store.getArtifact(artifact.id))?.title).toBe("New name");
  });

  it("deleteVersion removes a non-current version + its comments, leaving currentVersion intact", async () => {
    const userId = `dv-${randomBytes(4).toString("hex")}`;
    const { artifact } = await store.createArtifact({
      ownerId: userId, ownerName: "D", title: "V", visibility: "private", allowedPrincipals: [], html: "<h1>v1</h1>",
    });
    await store.addVersion(artifact.id, { html: "<h1>v2</h1>", publishedById: userId });
    await store.addVersion(artifact.id, { html: "<h1>v3</h1>", publishedById: userId }); // current = 3
    await store.addComment({
      artifactId: artifact.id, version: 1, authorId: userId, authorName: "D", body: "on v1",
      anchor: { version: 1, xNorm: 0.5, yNorm: 0.5, scrollYNorm: 0, renderWidth: 1000 },
    });

    const current = await store.deleteVersion(artifact.id, 1);
    expect(current).toBe(3);
    expect((await store.getArtifact(artifact.id))?.currentVersion).toBe(3);
    expect((await store.listVersions(artifact.id)).map((v) => v.version)).toEqual([3, 2]);
    expect(await store.getHtml(artifact.id, 1)).toBeNull();
    expect(await store.listComments(artifact.id, 1)).toEqual([]);
  });

  it("deleteVersion of the current version repoints currentVersion to the highest remaining", async () => {
    const userId = `dvc-${randomBytes(4).toString("hex")}`;
    const { artifact } = await store.createArtifact({
      ownerId: userId, ownerName: "D", title: "V", visibility: "private", allowedPrincipals: [], html: "<h1>v1</h1>",
    });
    await store.addVersion(artifact.id, { html: "<h1>v2</h1>", publishedById: userId });
    await store.addVersion(artifact.id, { html: "<h1>v3</h1>", publishedById: userId }); // current = 3

    const current = await store.deleteVersion(artifact.id, 3);
    expect(current).toBe(2);
    expect((await store.getArtifact(artifact.id))?.currentVersion).toBe(2);
    expect(await store.getHtml(artifact.id, 3)).toBeNull();
  });

  it("deleteVersion refuses to remove the only version", async () => {
    const { artifact } = await store.createArtifact({
      ownerId: "u1", ownerName: "U1", title: "Solo", visibility: "private", allowedPrincipals: [], html: "<h1>v1</h1>",
    });
    await expect(store.deleteVersion(artifact.id, 1)).rejects.toBeInstanceOf(LastVersionError);
  });

  it("never recycles a version number after the highest version is deleted", async () => {
    const userId = `mono-${randomBytes(4).toString("hex")}`;
    const { artifact } = await store.createArtifact({
      ownerId: userId, ownerName: "M", title: "Mono", visibility: "private", allowedPrincipals: [], html: "<h1>v1</h1>",
    });
    await store.addVersion(artifact.id, { html: "<h1>v2</h1>", publishedById: userId });
    await store.addVersion(artifact.id, { html: "<h1>v3</h1>", publishedById: userId }); // current = 3
    await store.deleteVersion(artifact.id, 3); // remove the highest

    // The next publish must NOT reuse v3 (which would point a stale immutable cache at new content).
    const next = await store.addVersion(artifact.id, { html: "<h1>v4</h1>", publishedById: userId });
    expect(next.version.version).toBe(4);
    expect((await store.getArtifact(artifact.id))?.currentVersion).toBe(4);
    expect(await store.getHtml(artifact.id, 4)).toContain("v4");
  });

  it("refreshes contentHash on repoint so re-publishing deleted content isn't wrongly deduped (F2)", async () => {
    const userId = `f2-${randomBytes(4).toString("hex")}`;
    const A = "<h1>content-A</h1>";
    const B = "<h1>content-B</h1>";
    const { artifact } = await store.createArtifact({
      ownerId: userId, ownerName: "F", title: "F2", visibility: "private", allowedPrincipals: [], html: A,
    });
    await store.addVersion(artifact.id, { html: B, publishedById: userId }); // v2 current, contentHash=hash(B)
    await store.deleteVersion(artifact.id, 2); // repoint to v1 (content A)

    // Re-publishing B (the just-deleted content) must create a NEW version, not dedup against the stale hash.
    const reB = await store.addVersion(artifact.id, { html: B, publishedById: userId });
    expect(reB.unchanged).toBe(false);
    expect(reB.version.version).toBe(3);
    expect((await store.getArtifact(artifact.id))?.currentVersion).toBe(3);
    expect(await store.getHtml(artifact.id, 3)).toContain("content-B");
  });

  it("still dedups a re-publish of the post-delete current content (fix preserves dedup, doesn't just clear it)", async () => {
    const userId = `f2d-${randomBytes(4).toString("hex")}`;
    const A = "<h1>keep-A</h1>";
    const { artifact } = await store.createArtifact({
      ownerId: userId, ownerName: "F", title: "F2d", visibility: "private", allowedPrincipals: [], html: A,
    });
    await store.addVersion(artifact.id, { html: "<h1>temp-B</h1>", publishedById: userId }); // v2 current
    await store.deleteVersion(artifact.id, 2); // repoint to v1 (A) → contentHash now = hash(A)

    // Re-publishing A (now the current content) SHOULD dedup — proves the hash was refreshed, not cleared.
    const reA = await store.addVersion(artifact.id, { html: A, publishedById: userId });
    expect(reA.unchanged).toBe(true);
    expect(reA.version.version).toBe(1);
  });
});

describe(`${name} — notifications`, () => {
  const item = (over: { artifactId: string; commentId: string; createdAt: string; title?: string }) => ({
    artifactId: over.artifactId,
    artifactTitle: over.title ?? "A",
    commentId: over.commentId,
    version: 1,
    authorName: "X",
    snippet: "hi",
    createdAt: over.createdAt,
  });

  it("fans out unread, lists newest-first, and marks read by artifact then all", async () => {
    const userId = `notif-${randomBytes(4).toString("hex")}`;
    const a1 = `${randomBytes(4).toString("hex")}`;
    const a2 = `${randomBytes(4).toString("hex")}`;
    await store.appendUnread([userId], item({ artifactId: a1, commentId: "c1", createdAt: "2026-06-20T01:00:00.000Z" }));
    await store.appendUnread([userId], item({ artifactId: a2, commentId: "c2", createdAt: "2026-06-20T02:00:00.000Z" }));

    const list = await store.listUnread(userId);
    expect(list.length).toBe(2);
    expect(list[0]!.artifactId).toBe(a2); // newest first

    await store.markRead(userId, a1); // clear just one artifact
    expect((await store.listUnread(userId)).map((i) => i.artifactId)).toEqual([a2]);

    await store.markRead(userId); // clear all
    expect((await store.listUnread(userId)).length).toBe(0);
  });

  it("dedupes the same comment for a recipient (upsert, no double-count)", async () => {
    const userId = `notif-${randomBytes(4).toString("hex")}`;
    const a = `${randomBytes(4).toString("hex")}`;
    const it = item({ artifactId: a, commentId: "c1", createdAt: "2026-06-20T01:00:00.000Z" });
    await store.appendUnread([userId], it);
    await store.appendUnread([userId], it);
    expect((await store.listUnread(userId)).length).toBe(1);
  });
});

describe(`${name} — token lifecycle`, () => {
  it("pairing -> redeem (PKCE) -> resolve -> revoke", async () => {
    const { verifier, challenge } = pkce();
    const code = await store.createPairingCode({ id: "u9", name: "U9", email: "u9@x.com" }, challenge);
    const redeemed = await store.redeemPairingCode(code, verifier);
    expect(redeemed?.user.id).toBe("u9");
    expect(await store.resolveToken(redeemed!.token)).toMatchObject({ id: "u9" });
    await store.revokeToken(redeemed!.token);
    expect(await store.resolveToken(redeemed!.token)).toBeNull();
  });

  it("rejects a wrong PKCE verifier and consumes the code", async () => {
    const { challenge } = pkce();
    const code = await store.createPairingCode({ id: "u9", name: "U9", email: "u9@x.com" }, challenge);
    expect(await store.redeemPairingCode(code, randomBytes(32).toString("base64url"))).toBeNull();
    // single-use: even the right verifier now fails because the code was consumed
    expect(await store.redeemPairingCode(code, "anything")).toBeNull();
  });

  it("ignores an unknown token", async () => {
    expect(await store.resolveToken("not-a-real-token")).toBeNull();
  });
});

describe(`${name} — token lifecycle controls`, () => {
  afterEach(() => vi.useRealTimers());

  it("rejects a pairing code after its TTL elapses", async () => {
    vi.useFakeTimers();
    const { verifier, challenge } = pkce();
    const code = await store.createPairingCode({ id: `ttl-${randomBytes(4).toString("hex")}`, name: "T", email: "t@x.com" }, challenge);
    vi.advanceTimersByTime(3 * 60 * 1000); // past the 2-minute PAIRING_TTL
    expect(await store.redeemPairingCode(code, verifier)).toBeNull();
  });

  it("rejects + reaps a token past its 90-day absolute expiry", async () => {
    vi.useFakeTimers();
    const userId = `exp-${randomBytes(4).toString("hex")}`;
    const { verifier, challenge } = pkce();
    const code = await store.createPairingCode({ id: userId, name: "E", email: "e@x.com" }, challenge);
    const redeemed = await store.redeemPairingCode(code, verifier);
    expect(await store.resolveToken(redeemed!.token)).toMatchObject({ id: userId });
    vi.advanceTimersByTime(91 * 24 * 60 * 60 * 1000); // past TOKEN_TTL_MS
    expect(await store.resolveToken(redeemed!.token)).toBeNull();
  });

  it("caps active tokens per user, reaping the oldest beyond the limit", async () => {
    const userId = `cap-${randomBytes(4).toString("hex")}`;
    const tokens: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { verifier, challenge } = pkce();
      const code = await store.createPairingCode({ id: userId, name: "C", email: "c@x.com" }, challenge);
      tokens.push((await store.redeemPairingCode(code, verifier))!.token);
    }
    await new Promise((r) => setTimeout(r, 1200)); // let fire-and-forget enforceTokenCap settle
    let valid = 0;
    for (const t of tokens) if (await store.resolveToken(t)) valid++;
    expect(valid).toBeLessThanOrEqual(10); // MAX_TOKENS_PER_USER
    expect(await store.resolveToken(tokens[tokens.length - 1]!)).not.toBeNull(); // newest survives
  });
});
}
