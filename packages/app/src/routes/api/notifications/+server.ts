import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { assertSameOrigin, requireUser } from "$lib/server/guards";
import { canView } from "$lib/server/authz";
import { getStore } from "$lib/server/storage";

/** The signed-in user's unread comment notifications, newest first. */
export const GET: RequestHandler = async (event) => {
  const user = await requireUser(event);
  const store = getStore();
  const unread = await store.listUnread(user.id);

  // Authorize at the read boundary (G4). Unread rows are denormalized — they carry the artifact title
  // and a ~140-char comment snippet captured at fan-out time. listUnread is only user-id-scoped, so without
  // a re-check a recipient who has since LOST access (removed from a restricted allow-list, or a
  // everyone→private flip) keeps seeing that title+snippet, and a notification whose artifact was DELETED
  // dangles as a dead link (G6). Re-check current access per distinct artifact (small N, hot meta
  // point-read) and drop rows the caller can no longer view or whose artifact is gone. On a transient
  // lookup error, KEEP the row — a storage blip must not blank a user's inbox; the next poll re-checks.
  const ids = [...new Set(unread.map((u) => u.artifactId))];
  const viewable = new Map<string, boolean>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const artifact = await store.getArtifact(id);
        viewable.set(id, artifact !== null && canView(artifact, user));
      } catch {
        viewable.set(id, true); // fail open on a transient error (availability, not a revoked-access leak)
      }
    }),
  );
  return json(unread.filter((u) => viewable.get(u.artifactId)));
};

/**
 * Mark notifications read for the caller: all of them, or just one artifact's when `?artifactId=` is
 * given (used when the inbox item is opened). Owner-scoped to the caller's own partition; CSRF-guarded.
 */
export const DELETE: RequestHandler = async (event) => {
  assertSameOrigin(event);
  const user = await requireUser(event);
  const artifactId = event.url.searchParams.get("artifactId") ?? undefined;
  await getStore().markRead(user.id, artifactId);
  return new Response(null, { status: 204 });
};
