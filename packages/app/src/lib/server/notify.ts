import { emitNotification } from "./notificationBus";
import type { Store } from "./storage";
import type { SessionUser } from "./auth";
import type { Artifact, Comment } from "@stela/shared";
import { notificationSnippet } from "./storage/shared";

/**
 * Best-effort unread fan-out for a new comment. Recipients = the artifact owner + everyone who has
 * already commented on this version's thread, MINUS the author of this comment — never every signed-in
 * user, even on an everyone-visible artifact. Never blocks or fails the comment.
 *
 * Lives here (not in the +server.ts route) because SvelteKit only allows HTTP-handler exports from
 * route modules; this keeps it importable by both the route and its test.
 */
export async function notifyParticipants(
  store: Store,
  artifact: Artifact,
  comment: Comment,
  author: SessionUser,
): Promise<void> {
  // This runs fire-and-forget after the comment write, so the artifact may have been deleted in between.
  // Re-read it and skip the fan-out if it's gone, so we don't append unread rows pointing at a deleted
  // artifact. The /api/notifications read filter is the load-bearing guard; this just avoids the write.
  if (!(await store.getArtifact(artifact.id))) return;
  const participants = await store.listComments(artifact.id, comment.version);
  const recipients = [...new Set([artifact.ownerId, ...participants.map((p) => p.authorId)])].filter(
    (userId) => userId !== author.id,
  );
  if (recipients.length === 0) return;
  await store.appendUnread(recipients, {
    artifactId: artifact.id,
    artifactTitle: artifact.title,
    commentId: comment.id,
    version: comment.version,
    authorName: author.name,
    snippet: notificationSnippet(comment.body),
    createdAt: comment.createdAt,
  });
  emitNotification(recipients);
}
