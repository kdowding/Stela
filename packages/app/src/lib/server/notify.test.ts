import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { getStore } from "$lib/server/storage";
import { notifyParticipants } from "./notify";

// the only recipient-computation / snippet-truncation / author-exclusion logic — exactly the
// regression class the loud-failure strategy targets. Integration test against the default store.
const store = getStore();
const uniqueUserId = () => `notif-${randomBytes(6).toString("hex")}`;
const anchor = { version: 1, xNorm: 0.5, yNorm: 0.5, scrollYNorm: 0, renderWidth: 800 };

async function makeArtifact(ownerId: string) {
  const { artifact } = await store.createArtifact({
    ownerId,
    ownerName: "Owner",
    title: "T",
    visibility: "everyone",
    allowedPrincipals: [],
    html: "<h1>v1</h1>",
  });
  return artifact;
}

describe("notifyParticipants", () => {
  it("notifies owner + prior participants, excludes the author, and truncates the snippet at 140", async () => {
    const ownerId = uniqueUserId();
    const participantId = uniqueUserId();
    const artifact = await makeArtifact(ownerId);

    // A participant comments first so they're on the thread.
    await store.addComment({ artifactId: artifact.id, version: 1, authorId: participantId, authorName: "P", body: "first", anchor });

    // The owner replies with a long body; fan-out should reach the participant, not the owner (author).
    const ownerComment = await store.addComment({ artifactId: artifact.id, version: 1, authorId: ownerId, authorName: "Owner", body: "x".repeat(200), anchor });
    await notifyParticipants(store, artifact, ownerComment, { id: ownerId, name: "Owner", email: "owner@x.com" });

    const forParticipant = await store.listUnread(participantId);
    const row = forParticipant.find((n) => n.artifactId === artifact.id);
    expect(row).toBeTruthy();
    expect(row!.snippet).toBe("x".repeat(140) + "…"); // truncated to 140 + ellipsis
    expect(row!.snippet.length).toBe(141);

    // The comment's own author is never notified about it.
    expect((await store.listUnread(ownerId)).some((n) => n.artifactId === artifact.id)).toBe(false);
  });

  it("dedupes repeated fan-out of the same comment to one unread row", async () => {
    const ownerId = uniqueUserId();
    const participantId = uniqueUserId();
    const artifact = await makeArtifact(ownerId);
    await store.addComment({ artifactId: artifact.id, version: 1, authorId: participantId, authorName: "P", body: "hi", anchor });
    const c = await store.addComment({ artifactId: artifact.id, version: 1, authorId: ownerId, authorName: "Owner", body: "reply", anchor });
    const author = { id: ownerId, name: "Owner", email: "owner@x.com" };

    await notifyParticipants(store, artifact, c, author);
    await notifyParticipants(store, artifact, c, author);

    expect((await store.listUnread(participantId)).filter((n) => n.artifactId === artifact.id).length).toBe(1);
  });

  it("skips the fan-out entirely when the artifact was deleted mid-flight", async () => {
    const ownerId = uniqueUserId();
    const participantId = uniqueUserId();
    const artifact = await makeArtifact(ownerId);
    await store.addComment({ artifactId: artifact.id, version: 1, authorId: participantId, authorName: "P", body: "hi", anchor });
    const c = await store.addComment({ artifactId: artifact.id, version: 1, authorId: ownerId, authorName: "Owner", body: "reply", anchor });

    await store.deleteArtifact(artifact.id); // gone before the fire-and-forget fan-out runs
    await notifyParticipants(store, { ...artifact }, c, { id: ownerId, name: "Owner", email: "o@x.com" });

    expect((await store.listUnread(participantId)).some((n) => n.artifactId === artifact.id)).toBe(false);
  });
});
