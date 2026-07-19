import { describe, it, expect } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { POST, GET } from "./+server";
import { getStore } from "$lib/server/storage";
import { makeEvent } from "../../../test/helpers";

// Integration tests against the default SQLite store. The store persists across the suite, so every
// test mints unique user ids to avoid collisions.
const store = getStore();

const ADMIN = { "x-api-key": "dev-publish-key" } as const;
const html = "<h1>hello</h1>";

/** Mint a durable per-user pairing token for a freshly-minted user. */
async function mintToken(): Promise<{ token: string; id: string }> {
  const id = randomUUID();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = await store.createPairingCode(
    { id, name: `U-${id.slice(0, 8)}`, email: `${id.slice(0, 8)}@example.com` },
    challenge,
  );
  const redeemed = await store.redeemPairingCode(code, verifier);
  if (!redeemed) throw new Error("failed to mint token");
  return { token: redeemed.token, id };
}

/** Publish a brand-new artifact as the dev admin and return its server-minted id. */
async function publishNew(title = "T"): Promise<{ id: string; version: number }> {
  const res = await POST(
    makeEvent({ method: "POST", path: "/api/artifacts", headers: { ...ADMIN }, body: { title, html } }),
  );
  expect(res.status).toBe(200);
  const out = (await res.json()) as { id: string; version: number; url: string };
  return { id: out.id, version: out.version };
}

describe("POST /api/artifacts — publish new artifact", () => {
  it("creates a new artifact with the admin key → 200 {id, version, url}", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        path: "/api/artifacts",
        headers: { ...ADMIN },
        body: { title: "My Artifact", html },
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: string; version: number; url: string; title: string };
    expect(out.version).toBe(1);
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(out.url).toBe(`http://localhost:5173/a/${out.id}`);
    expect(out.title).toBe("My Artifact");

    // It is genuinely persisted and owned by the dev identity that the admin key resolves to.
    const got = await store.getArtifact(out.id);
    expect(got?.ownerId).toBe("dev-user-0001");
    expect(await store.getHtml(out.id, 1)).toContain("hello");
  });

  it("honors visibility + allowedPrincipals on create", async () => {
    const principal = `${randomUUID().slice(0, 8)}@example.com`;
    const res = await POST(
      makeEvent({
        method: "POST",
        path: "/api/artifacts",
        headers: { ...ADMIN },
        body: { title: "Shared", html, visibility: "restricted", allowedPrincipals: [principal, principal] },
      }),
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const got = await store.getArtifact(id);
    expect(got?.visibility).toBe("restricted");
    // normalizePrincipals dedupes.
    expect(got?.allowedPrincipals).toEqual([principal]);
  });

  it("stores an optional favicon emoji on create", async () => {
    const res = await POST(
      makeEvent({ method: "POST", path: "/api/artifacts", headers: { ...ADMIN }, body: { title: "Fav", html, favicon: "📊" } }),
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect((await store.getArtifact(id))?.favicon).toBe("📊");
  });

  it("rejects a favicon containing markup → 400", async () => {
    await expect(
      POST(
        makeEvent({ method: "POST", path: "/api/artifacts", headers: { ...ADMIN }, body: { title: "Bad", html, favicon: "<img>" } }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("POST /api/artifacts — add version (owner-only)", () => {
  it("a NON-owner per-user token cannot add a version → 404 (existence not leaked)", async () => {
    // dev admin owns this artifact (ownerId = dev-user-0001).
    const { id } = await publishNew("owned-by-dev");
    const { token } = await mintToken(); // a totally different user

    await expect(
      POST(
        makeEvent({
          method: "POST",
          path: "/api/artifacts",
          headers: { "x-api-key": token },
          body: { artifactId: id, title: "hijack", html: "<h1>v2-by-intruder</h1>" },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });

    // No new version was created.
    const got = await store.getArtifact(id);
    expect(got?.currentVersion).toBe(1);
  });

  it("the owner (admin key) CAN add a version of their own artifact → 200 version 2", async () => {
    const { id } = await publishNew("mine-to-revise");
    const res = await POST(
      makeEvent({
        method: "POST",
        path: "/api/artifacts",
        headers: { ...ADMIN },
        body: { artifactId: id, title: "ignored-on-version", html: "<h1>v2</h1>", note: "second" },
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: string; version: number; url: string; title: string };
    expect(out.id).toBe(id);
    expect(out.version).toBe(2);
    expect(out.url).toBe(`http://localhost:5173/a/${id}`);
    // The response echoes the EXISTING stored title, not the title sent on a version publish.
    expect(out.title).toBe("mine-to-revise");
    expect(await store.getHtml(id, 2)).toContain("v2");
  });

  it("adding a version to a non-existent (but well-formed UUID) artifact → 404", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          path: "/api/artifacts",
          headers: { ...ADMIN },
          body: { artifactId: randomUUID(), title: "ghost", html },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("POST /api/artifacts — validation", () => {
  it("a non-UUID artifactId → 400 (rejected by the schema before storage)", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          path: "/api/artifacts",
          headers: { ...ADMIN },
          body: { artifactId: "not-a-uuid", title: "T", html },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("malformed JSON body ('{') → 400", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          path: "/api/artifacts",
          headers: { ...ADMIN, "content-type": "application/json" },
          body: "{",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("missing required fields (no html) → 400", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          path: "/api/artifacts",
          headers: { ...ADMIN },
          body: { title: "no html" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("empty title → 400", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          path: "/api/artifacts",
          headers: { ...ADMIN },
          body: { title: "", html },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("POST /api/artifacts — authentication", () => {
  it("no credential → 401", async () => {
    await expect(
      POST(makeEvent({ method: "POST", path: "/api/artifacts", body: { title: "T", html } })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("an unknown/invalid api-key → 401 (dev shim does not mask a presented credential)", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          path: "/api/artifacts",
          headers: { "x-api-key": "totally-bogus-key" },
          body: { title: "T", html },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("a valid per-user token can create a NEW artifact owned by that user → 200", async () => {
    const { token, id: userId } = await mintToken();
    const res = await POST(
      makeEvent({
        method: "POST",
        path: "/api/artifacts",
        headers: { "x-api-key": token },
        body: { title: "by token user", html },
      }),
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const got = await store.getArtifact(id);
    expect(got?.ownerId).toBe(userId);
  });
});

describe("GET /api/artifacts — listing", () => {
  it("returns { mine, everyone } for an admin-key caller", async () => {
    // Create an artifact owned by the dev identity so 'mine' is non-empty for the admin caller.
    const { id } = await publishNew("listed-mine");
    const res = await GET(
      makeEvent({ method: "GET", path: "/api/artifacts", headers: { ...ADMIN } }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { mine: Array<{ id: string }>; everyone: Array<{ id: string }> };
    expect(Array.isArray(out.mine)).toBe(true);
    expect(Array.isArray(out.everyone)).toBe(true);
    expect(out.mine.some((a) => a.id === id)).toBe(true);
    // 'everyone' excludes the caller's own artifacts.
    expect(out.everyone.some((a) => a.id === id)).toBe(false);
  });

  it("a per-user token caller sees only their own in 'mine'", async () => {
    const { token, id: userId } = await mintToken();
    // One artifact owned by this token user.
    const created = await POST(
      makeEvent({ method: "POST", path: "/api/artifacts", headers: { "x-api-key": token }, body: { title: "tok-mine", html } }),
    );
    const { id } = (await created.json()) as { id: string };

    const res = await GET(
      makeEvent({ method: "GET", path: "/api/artifacts", headers: { "x-api-key": token } }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { mine: Array<{ id: string; ownerId: string }> };
    expect(out.mine.every((a) => a.ownerId === userId)).toBe(true);
    expect(out.mine.some((a) => a.id === id)).toBe(true);
  });

  it("surfaces an everyone-visible artifact from another owner in 'everyone'", async () => {
    // A different user publishes a server-wide artifact.
    const { token } = await mintToken();
    const created = await POST(
      makeEvent({
        method: "POST",
        path: "/api/artifacts",
        headers: { "x-api-key": token },
        body: { title: "server-wide", html, visibility: "everyone" },
      }),
    );
    const { id } = (await created.json()) as { id: string };

    // The admin caller (a different identity) should see it under 'everyone'.
    const res = await GET(makeEvent({ method: "GET", path: "/api/artifacts", headers: { ...ADMIN } }));
    const out = (await res.json()) as { everyone: Array<{ id: string }>; mine: Array<{ id: string }> };
    expect(out.everyone.some((a) => a.id === id)).toBe(true);
    expect(out.mine.some((a) => a.id === id)).toBe(false);
  });

  it("includes restricted artifacts shared directly with the caller in 'shared'", async () => {
    // The admin publishes a restricted artifact shared with a token user's stable id.
    const { token, id: userId } = await mintToken();
    const created = await POST(
      makeEvent({
        method: "POST",
        path: "/api/artifacts",
        headers: { ...ADMIN },
        body: { title: "shared-to-user", html, visibility: "restricted", allowedPrincipals: [userId] },
      }),
    );
    const { id } = (await created.json()) as { id: string };

    // The shared-to user sees it under 'shared' — not 'mine' (admin owns it) or 'everyone'.
    const res = await GET(makeEvent({ method: "GET", path: "/api/artifacts", headers: { "x-api-key": token } }));
    const out = (await res.json()) as {
      shared: Array<{ id: string }>;
      mine: Array<{ id: string }>;
      everyone: Array<{ id: string }>;
    };
    expect(out.shared.some((a) => a.id === id)).toBe(true);
    expect(out.mine.some((a) => a.id === id)).toBe(false);
    expect(out.everyone.some((a) => a.id === id)).toBe(false);
  });
});
