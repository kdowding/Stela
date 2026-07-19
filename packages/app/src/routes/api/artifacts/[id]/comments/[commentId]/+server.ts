import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";
import { canManage } from "$lib/server/authz";
import { assertSameOrigin, badRequest, loadViewableArtifact } from "$lib/server/guards";
import { rateLimit } from "$lib/server/ratelimit";
import { ResolveCommentRequest } from "@stela/shared";

/** Resolve / reopen a comment thread. Anyone with view access can toggle it. */
export const PATCH: RequestHandler = async (event) => {
  assertSameOrigin(event);
  const { user, artifact, store } = await loadViewableArtifact(event);
  rateLimit("comment-mutate", user.id, 60, 60_000);

  const parsed = ResolveCommentRequest.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) badRequest(parsed.error);
  const { version, resolved } = parsed.data;
  if (version > artifact.currentVersion) throw error(400, "Invalid version");

  // Read-before-write: confirm the comment exists in this artifact+version partition.
  const existing = await store.getComment(artifact.id, version, event.params.commentId);
  if (!existing) throw error(404, "Comment not found");

  await store.setResolved(artifact.id, version, event.params.commentId, resolved, user.id);
  return json({ ok: true });
};

/** Delete a comment (a pin + its replies). Only the comment's author or the artifact owner may. */
export const DELETE: RequestHandler = async (event) => {
  assertSameOrigin(event);
  const { user, artifact, store } = await loadViewableArtifact(event);
  rateLimit("comment-mutate", user.id, 60, 60_000);

  // Comments are version-scoped; the version rides on ?v= (DELETE carries no body).
  const version = Number(event.url.searchParams.get("v"));
  if (!Number.isInteger(version) || version < 1 || version > artifact.currentVersion) {
    throw error(400, "Invalid version");
  }

  const existing = await store.getComment(artifact.id, version, event.params.commentId);
  if (!existing) throw error(404, "Comment not found");
  // Author-or-owner only. 403 (not 404) is fine here — view access already confirms the artifact exists.
  if (existing.authorId !== user.id && !canManage(artifact, user)) {
    throw error(403, "You can't delete this comment");
  }

  await store.deleteComment(artifact.id, version, event.params.commentId);
  return new Response(null, { status: 204 });
};
