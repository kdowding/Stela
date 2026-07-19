import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { getStore } from "$lib/server/storage";
import { makeEvent, testUser } from "../../../test/helpers";
import { POST, GET } from "./[id]/comments/+server";
import { notifyParticipants } from "$lib/server/notify";
import { PATCH, DELETE } from "./[id]/comments/[commentId]/+server";
import { PUT } from "./[id]/sharing/+server";

// Integration tests against the default SQLite store. The store is shared across the whole suite, so
// every test mints unique user ids to avoid colliding with other tests.
const store = getStore();

const uniqueUserId = () =>
  `${randomBytes(4).toString("hex")}-${randomBytes(2).toString("hex")}-4${randomBytes(1)
    .toString("hex")
    .slice(0, 2)}-8${randomBytes(1).toString("hex").slice(0, 2)}-${randomBytes(6).toString("hex")}`;

const anchor = (version = 1) => ({
  version,
  xNorm: 0.5,
  yNorm: 0.5,
  scrollYNorm: 0,
  renderWidth: 800,
});

/** Create a fresh artifact owned by `ownerId`, returning its id. */
async function makeArtifact(
  ownerId: string,
  over: { visibility?: "private" | "everyone" | "restricted"; allowedPrincipals?: string[] } = {},
): Promise<string> {
  const { artifact } = await store.createArtifact({
    ownerId,
    ownerName: "Owner",
    title: "T",
    visibility: over.visibility ?? "private",
    allowedPrincipals: over.allowedPrincipals ?? [],
    html: "<h1>v1</h1>",
  });
  return artifact.id;
}

describe("POST /api/artifacts/[id]/comments", () => {
  let ownerId: string;
  let id: string;

  beforeEach(async () => {
    ownerId = uniqueUserId();
    id = await makeArtifact(ownerId);
  });

  it("creates a comment for the owner and returns it (200)", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        params: { id },
        locals: { user: testUser({ id: ownerId }) },
        body: { body: "first comment", version: 1, anchor: anchor(1) },
      }),
    );
    expect(res.status).toBe(200);
    const comment = await res.json();
    expect(comment.id).toBeTruthy();
    expect(comment.artifactId).toBe(id);
    expect(comment.version).toBe(1);
    expect(comment.body).toBe("first comment");
    expect(comment.authorId).toBe(ownerId);
    expect(comment.resolved).toBe(false);
    expect(comment.anchor.xNorm).toBe(0.5);
  });

  it("rejects a version greater than currentVersion (400)", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          params: { id },
          locals: { user: testUser({ id: ownerId }) },
          body: { body: "future", version: 2, anchor: anchor(2) },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an anchor.version that differs from the comment version (400)", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          params: { id },
          locals: { user: testUser({ id: ownerId }) },
          body: { body: "mismatch", version: 1, anchor: anchor(2) },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an invalid body via schema validation (400)", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          params: { id },
          locals: { user: testUser({ id: ownerId }) },
          body: { body: "", version: 1, anchor: anchor(1) },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("blocks a cross-origin browser POST (CSRF, 403)", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          params: { id },
          headers: { origin: "https://evil.example" },
          locals: { user: testUser({ id: ownerId }) },
          body: { body: "csrf", version: 1, anchor: anchor(1) },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns 404 to a non-owner of a private artifact (existence not leaked)", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          params: { id },
          locals: { user: testUser({ id: uniqueUserId() }) },
          body: { body: "sneaky", version: 1, anchor: anchor(1) },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns 404 for an unknown artifact id", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          params: { id: randomUUID() },
          locals: { user: testUser({ id: ownerId }) },
          body: { body: "x", version: 1, anchor: anchor(1) },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a reply whose parent does not exist (400)", async () => {
    await expect(
      POST(
        makeEvent({
          method: "POST",
          params: { id },
          locals: { user: testUser({ id: ownerId }) },
          body: { body: "reply", version: 1, anchor: anchor(1), parentId: randomUUID() },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a comment on a deleted (gap) version below currentVersion (404)", async () => {
    // v1, v2, v3 then delete the middle v2 → a gap below currentVersion (3). A crafted POST to v2
    // passes the upper-bound check but the version no longer exists, so it must 404 (no orphan rows).
    await store.addVersion(id, { html: "<h1>v2</h1>", publishedById: ownerId });
    await store.addVersion(id, { html: "<h1>v3</h1>", publishedById: ownerId });
    await store.deleteVersion(id, 2);
    await expect(
      POST(
        makeEvent({
          method: "POST",
          params: { id },
          locals: { user: testUser({ id: ownerId }) },
          body: { body: "orphan", version: 2, anchor: anchor(2) },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("comment notification fan-out", () => {
  it("notifies the owner + thread participants but never the comment's own author", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId, { visibility: "everyone" });
    // A different everyone viewer comments on the owner's artifact.
    const commenter = testUser({ id: uniqueUserId(), name: "Commenter" });
    const created = await (
      await POST(
        makeEvent({
          method: "POST",
          params: { id },
          locals: { user: commenter },
          body: { body: "nice work", version: 1, anchor: anchor(1) },
        }),
      )
    ).json();

    // Drive the fan-out deterministically (the route fires it best-effort/async).
    const artifact = await store.getArtifact(id);
    await notifyParticipants(store, artifact!, created, commenter);

    // The owner is notified; the author of the comment is not.
    expect((await store.listUnread(ownerId)).some((n) => n.artifactId === id)).toBe(true);
    expect((await store.listUnread(commenter.id)).length).toBe(0);
  });

  it("does not notify anyone when the owner comments on their own artifact alone", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    const owner = testUser({ id: ownerId });
    const created = await (
      await POST(
        makeEvent({
          method: "POST",
          params: { id },
          locals: { user: owner },
          body: { body: "note to self", version: 1, anchor: anchor(1) },
        }),
      )
    ).json();
    const artifact = await store.getArtifact(id);
    await notifyParticipants(store, artifact!, created, owner);
    expect((await store.listUnread(ownerId)).length).toBe(0);
  });
});

describe("GET /api/artifacts/[id]/comments", () => {
  it("lists comments for the requested version", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    await POST(
      makeEvent({
        method: "POST",
        params: { id },
        locals: { user: testUser({ id: ownerId }) },
        body: { body: "hello", version: 1, anchor: anchor(1) },
      }),
    );
    const res = await GET(
      makeEvent({ params: { id }, query: { v: "1" }, locals: { user: testUser({ id: ownerId }) } }),
    );
    expect(res.status).toBe(200);
    const comments = await res.json();
    expect(Array.isArray(comments)).toBe(true);
    expect(comments.length).toBe(1);
    expect(comments[0].body).toBe("hello");
  });

  it("returns 404 to a non-owner of a private artifact", async () => {
    const id = await makeArtifact(uniqueUserId());
    await expect(
      GET(makeEvent({ params: { id }, locals: { user: testUser({ id: uniqueUserId() }) } })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("PATCH /api/artifacts/[id]/comments/[commentId]", () => {
  it("resolves a comment and records the actor + timestamp", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);

    const created = await (
      await POST(
        makeEvent({
          method: "POST",
          params: { id },
          locals: { user: testUser({ id: ownerId }) },
          body: { body: "resolve me", version: 1, anchor: anchor(1) },
        }),
      )
    ).json();

    const res = await PATCH(
      makeEvent({
        method: "PATCH",
        params: { id, commentId: created.id },
        locals: { user: testUser({ id: ownerId }) },
        body: { version: 1, resolved: true },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    // The audit trail must surface through a subsequent listing.
    const comments = await (
      await GET(
        makeEvent({
          params: { id },
          query: { v: "1" },
          locals: { user: testUser({ id: ownerId }) },
        }),
      )
    ).json();
    const updated = comments.find((c: { id: string }) => c.id === created.id);
    expect(updated.resolved).toBe(true);
    expect(updated.resolvedById).toBe(ownerId);
    expect(typeof updated.resolvedAt).toBe("string");
    expect(updated.resolvedAt.length).toBeGreaterThan(0);
  });

  it("records the resolving actor (not the author) on reopen/resolve", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId, { visibility: "everyone" });
    const created = await (
      await POST(
        makeEvent({
          method: "POST",
          params: { id },
          locals: { user: testUser({ id: ownerId }) },
          body: { body: "everyone comment", version: 1, anchor: anchor(1) },
        }),
      )
    ).json();

    // A different signed-in (everyone) viewer resolves it — anyone with view access may toggle.
    const actorId = uniqueUserId();
    await PATCH(
      makeEvent({
        method: "PATCH",
        params: { id, commentId: created.id },
        locals: { user: testUser({ id: actorId }) },
        body: { version: 1, resolved: true },
      }),
    );

    const comments = await (
      await GET(
        makeEvent({
          params: { id },
          query: { v: "1" },
          locals: { user: testUser({ id: ownerId }) },
        }),
      )
    ).json();
    const updated = comments.find((c: { id: string }) => c.id === created.id);
    expect(updated.resolvedById).toBe(actorId);
  });

  it("returns 404 when the comment does not exist", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    await expect(
      PATCH(
        makeEvent({
          method: "PATCH",
          params: { id, commentId: randomUUID() },
          locals: { user: testUser({ id: ownerId }) },
          body: { version: 1, resolved: true },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a version greater than currentVersion (400)", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    await expect(
      PATCH(
        makeEvent({
          method: "PATCH",
          params: { id, commentId: randomUUID() },
          locals: { user: testUser({ id: ownerId }) },
          body: { version: 5, resolved: true },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("blocks a cross-origin PATCH (CSRF, 403)", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    await expect(
      PATCH(
        makeEvent({
          method: "PATCH",
          params: { id, commentId: randomUUID() },
          headers: { origin: "https://evil.example" },
          locals: { user: testUser({ id: ownerId }) },
          body: { version: 1, resolved: true },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("DELETE /api/artifacts/[id]/comments/[commentId]", () => {
  /** POST a comment as `user`, returning the created comment. */
  async function addComment(id: string, user: ReturnType<typeof testUser>, parentId?: string) {
    return (
      await POST(
        makeEvent({
          method: "POST",
          params: { id },
          locals: { user },
          body: { body: "to delete", version: 1, anchor: anchor(1), ...(parentId ? { parentId } : {}) },
        }),
      )
    ).json();
  }

  const del = (id: string, commentId: string, user: ReturnType<typeof testUser>, v = "1") =>
    DELETE(makeEvent({ method: "DELETE", params: { id, commentId }, query: { v }, locals: { user } }));

  it("lets the comment's author delete it, and cascades to its replies (204)", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId, { visibility: "everyone" });
    const author = testUser({ id: uniqueUserId() });
    const root = await addComment(id, author);
    await addComment(id, testUser({ id: uniqueUserId() }), root.id); // a reply from someone else

    const res = await del(id, root.id, author);
    expect(res.status).toBe(204);

    // Both the pin and its reply are gone.
    const comments = await (
      await GET(makeEvent({ params: { id }, query: { v: "1" }, locals: { user: testUser({ id: ownerId }) } }))
    ).json();
    expect(comments.length).toBe(0);
  });

  it("lets the artifact owner delete another user's comment (204)", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId, { visibility: "everyone" });
    const root = await addComment(id, testUser({ id: uniqueUserId() }));

    const res = await del(id, root.id, testUser({ id: ownerId }));
    expect(res.status).toBe(204);
  });

  it("forbids a non-author, non-owner viewer from deleting (403)", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId, { visibility: "everyone" });
    const root = await addComment(id, testUser({ id: uniqueUserId() }));

    // A third everyone user (can view, but neither author nor owner) must not delete.
    await expect(del(id, root.id, testUser({ id: uniqueUserId() }))).rejects.toMatchObject({ status: 403 });
  });

  it("returns 404 when the comment does not exist", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    await expect(del(id, randomUUID(), testUser({ id: ownerId }))).rejects.toMatchObject({ status: 404 });
  });

  it("blocks a cross-origin DELETE (CSRF, 403)", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    await expect(
      DELETE(
        makeEvent({
          method: "DELETE",
          params: { id, commentId: randomUUID() },
          query: { v: "1" },
          headers: { origin: "https://evil.example" },
          locals: { user: testUser({ id: ownerId }) },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("PUT /api/artifacts/[id]/sharing", () => {
  it("lets the owner change visibility to everyone (200)", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    const res = await PUT(
      makeEvent({
        method: "PUT",
        params: { id },
        locals: { user: testUser({ id: ownerId }) },
        body: { visibility: "everyone", allowedPrincipals: [] },
      }),
    );
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.visibility).toBe("everyone");

    // Confirm it actually persisted.
    const got = await store.getArtifact(id);
    expect(got?.visibility).toBe("everyone");
  });

  it("drops allowedPrincipals when visibility is not restricted", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    const res = await PUT(
      makeEvent({
        method: "PUT",
        params: { id },
        locals: { user: testUser({ id: ownerId }) },
        body: { visibility: "everyone", allowedPrincipals: ["someone@example.com"] },
      }),
    );
    const updated = await res.json();
    expect(updated.visibility).toBe("everyone");
    expect(updated.allowedPrincipals).toEqual([]);
  });

  it("keeps normalized principals when visibility is restricted", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    const res = await PUT(
      makeEvent({
        method: "PUT",
        params: { id },
        locals: { user: testUser({ id: ownerId }) },
        body: {
          visibility: "restricted",
          allowedPrincipals: ["dup@example.com", "dup@example.com", "keep@example.com"],
        },
      }),
    );
    const updated = await res.json();
    expect(updated.visibility).toBe("restricted");
    expect(updated.allowedPrincipals).toEqual(["dup@example.com", "keep@example.com"]);
  });

  it("returns 404 to a non-owner of a private artifact (existence hidden)", async () => {
    const id = await makeArtifact(uniqueUserId());
    await expect(
      PUT(
        makeEvent({
          method: "PUT",
          params: { id },
          locals: { user: testUser({ id: uniqueUserId() }) },
          body: { visibility: "everyone", allowedPrincipals: [] },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns 403 to a non-owner who can already view a everyone artifact", async () => {
    const id = await makeArtifact(uniqueUserId(), { visibility: "everyone" });
    await expect(
      PUT(
        makeEvent({
          method: "PUT",
          params: { id },
          locals: { user: testUser({ id: uniqueUserId() }) },
          body: { visibility: "private", allowedPrincipals: [] },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an invalid visibility via schema validation (400)", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    await expect(
      PUT(
        makeEvent({
          method: "PUT",
          params: { id },
          locals: { user: testUser({ id: ownerId }) },
          body: { visibility: "public", allowedPrincipals: [] },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("blocks a cross-origin PUT (CSRF, 403)", async () => {
    const ownerId = uniqueUserId();
    const id = await makeArtifact(ownerId);
    await expect(
      PUT(
        makeEvent({
          method: "PUT",
          params: { id },
          headers: { origin: "https://evil.example" },
          locals: { user: testUser({ id: ownerId }) },
          body: { visibility: "everyone", allowedPrincipals: [] },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
