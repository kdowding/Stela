import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { getStore } from "$lib/server/storage";
import { makeEvent, testUser } from "../../../test/helpers";
import { GET } from "./+server";

// Integration test against the default SQLite store. The store is shared across the suite, so each
// test mints unique user ids. These cover the G4/G6 read-boundary authorization on
// the notification inbox: a denormalized unread row (it carries the artifact title + a comment snippet)
// must stop being SERVED the moment the recipient loses access or the artifact is deleted — even though
// the row itself is still persisted in their partition.
const store = getStore();

const uniqueUserId = () =>
  `${randomBytes(4).toString("hex")}-${randomBytes(2).toString("hex")}-4${randomBytes(1)
    .toString("hex")
    .slice(0, 2)}-8${randomBytes(1).toString("hex").slice(0, 2)}-${randomBytes(6).toString("hex")}`;

async function makeArtifact(
  ownerId: string,
  over: { visibility?: "private" | "everyone" | "restricted"; allowedPrincipals?: string[] } = {},
): Promise<string> {
  const { artifact } = await store.createArtifact({
    ownerId,
    ownerName: "Owner",
    title: "Q3 Layoff Plan", // a deliberately sensitive title — the thing that must not leak post-revocation
    visibility: over.visibility ?? "private",
    allowedPrincipals: over.allowedPrincipals ?? [],
    html: "<h1>v1</h1>",
  });
  return artifact.id;
}

/** Seed one unread row directly into a recipient's partition (the shape notifyParticipants writes). */
async function seedUnread(recipientId: string, artifactId: string): Promise<void> {
  await store.appendUnread([recipientId], {
    artifactId,
    artifactTitle: "Q3 Layoff Plan",
    commentId: `c-${randomBytes(4).toString("hex")}`,
    version: 1,
    authorName: "Someone",
    snippet: "sensitive comment snippet",
    createdAt: "2026-06-21T00:00:00.000Z",
  });
}

const served = async (user: ReturnType<typeof testUser>): Promise<{ artifactId: string }[]> =>
  (await GET(makeEvent({ path: "/api/notifications", locals: { user } }))).json();

const has = (rows: { artifactId: string }[], id: string) => rows.some((n) => n.artifactId === id);

describe("GET /api/notifications — read-boundary authorization (G4/G6)", () => {
  it("stops serving a notification once the recipient is removed from a restricted allow-list (G4)", async () => {
    const ownerId = uniqueUserId();
    const viewer = testUser({ id: uniqueUserId(), email: `a-${randomBytes(3).toString("hex")}@example.com` });
    const id = await makeArtifact(ownerId, { visibility: "restricted", allowedPrincipals: [viewer.email] });
    await seedUnread(viewer.id, id);

    // While shared with them, the title + snippet are served.
    expect(has(await served(viewer), id)).toBe(true);

    // Owner revokes access. The row is still persisted in the viewer's partition...
    await store.updateSharing(id, "restricted", []);
    expect((await store.listUnread(viewer.id)).some((n) => n.artifactId === id)).toBe(true);
    // ...but the route must no longer serve it (the filter, not storage, hides it).
    expect(has(await served(viewer), id)).toBe(false);
  });

  it("stops serving notifications after a everyone→private flip for a non-owner (G4)", async () => {
    const ownerId = uniqueUserId();
    const viewer = testUser({ id: uniqueUserId() });
    const id = await makeArtifact(ownerId, { visibility: "everyone" });
    await seedUnread(viewer.id, id);
    expect(has(await served(viewer), id)).toBe(true);

    await store.updateSharing(id, "private", []);
    expect(has(await served(viewer), id)).toBe(false);
  });

  it("drops a ghost notification whose artifact was deleted after fan-out (G6)", async () => {
    const ownerId = uniqueUserId();
    const owner = testUser({ id: ownerId });
    const id = await makeArtifact(ownerId, { visibility: "private" });

    // Simulate the fire-and-forget race: the unread row lands AFTER deleteArtifact's sweep, so it
    // survives in storage but points at a now-deleted artifact.
    await store.deleteArtifact(id);
    await seedUnread(ownerId, id);
    expect((await store.listUnread(ownerId)).some((n) => n.artifactId === id)).toBe(true); // persisted...
    expect(has(await served(owner), id)).toBe(false); // ...but not served (getArtifact === null)
  });

  it("still serves notifications the caller can currently view (no over-filtering)", async () => {
    const ownerId = uniqueUserId();
    const viewer = testUser({ id: uniqueUserId() });
    const id = await makeArtifact(ownerId, { visibility: "everyone" }); // any signed-in user may view
    await seedUnread(viewer.id, id);
    expect(has(await served(viewer), id)).toBe(true);
  });
});
