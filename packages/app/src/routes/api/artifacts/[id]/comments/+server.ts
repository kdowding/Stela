import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";
import {
  assertSameOrigin,
  badRequest,
  loadViewableArtifact,
  parseVersion,
} from "$lib/server/guards";
import { rateLimit } from "$lib/server/ratelimit";
import { notifyParticipants } from "$lib/server/notify";
import { CreateCommentRequest } from "@stela/shared";

export const GET: RequestHandler = async (event) => {
  const { artifact, store } = await loadViewableArtifact(event);
  const version = parseVersion(event.url.searchParams.get("v"), artifact.currentVersion);
  return json(await store.listComments(artifact.id, version));
};

export const POST: RequestHandler = async (event) => {
  assertSameOrigin(event);
  const { user, artifact, store } = await loadViewableArtifact(event);
  rateLimit("comment", user.id, 120, 60_000);

  const parsed = CreateCommentRequest.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) badRequest(parsed.error);
  const c = parsed.data;

  // Comment must attach to an existing, immutable version (1..currentVersion) and its pin's anchor
  // must be on that same version.
  if (c.version > artifact.currentVersion) throw error(400, "Invalid version");
  // A pinned comment's anchor must be on the same version; a general comment has no anchor to check.
  if (c.anchor && c.anchor.version !== c.version) throw error(400, "Anchor version mismatch");
  // The version must still EXIST: deleting a middle version leaves a gap below currentVersion, and a
  // comment on a deleted version would orphan rows in a partition nothing renders (single-partition query).
  const versions = await store.listVersions(artifact.id);
  if (!versions.some((v) => v.version === c.version)) throw error(404, "Version not found");

  // A reply must point at an existing top-level comment in the same artifact+version.
  if (c.parentId) {
    const parent = await store.getComment(artifact.id, c.version, c.parentId);
    if (!parent || parent.parentId) throw error(400, "Reply target not found");
  }

  const comment = await store.addComment({
    artifactId: artifact.id,
    version: c.version,
    authorId: user.id,
    authorName: user.name,
    body: c.body,
    anchor: c.anchor,
    parentId: c.parentId,
  });

  // Notify the owner + thread participants (best-effort; never blocks or fails the comment).
  void notifyParticipants(store, artifact, comment, user).catch((e: unknown) =>
    console.error("Stela: comment notification fan-out failed:", e),
  );

  return json(comment);
};
