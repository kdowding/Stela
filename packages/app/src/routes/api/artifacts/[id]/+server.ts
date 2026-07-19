import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import {
  assertSameOrigin,
  badRequest,
  loadManageableArtifact,
  loadViewableArtifact,
} from "$lib/server/guards";
import { rateLimit } from "$lib/server/ratelimit";
import { UpdateArtifactRequest } from "@stela/shared";

/** Read one artifact's metadata. Any viewer (MCP/CLI token or signed-in browser user); 404 if not. */
export const GET: RequestHandler = async (event) => {
  const { artifact } = await loadViewableArtifact(event);
  return json(artifact);
};

/** Rename an artifact (title only). Owner only; CSRF-guarded for browser callers. */
export const PATCH: RequestHandler = async (event) => {
  assertSameOrigin(event);
  const { user, artifact, store } = await loadManageableArtifact(event);
  rateLimit("artifact-mutate", user.id, 60, 60_000);

  const parsed = UpdateArtifactRequest.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) badRequest(parsed.error);

  await store.updateTitle(artifact.id, parsed.data.title);
  const updated = await store.getArtifact(artifact.id);
  return json(updated ?? { ...artifact, title: parsed.data.title });
};

/** Permanently delete an artifact and all its versions, blobs, and comments. Owner only. */
export const DELETE: RequestHandler = async (event) => {
  assertSameOrigin(event);
  const { user, artifact, store } = await loadManageableArtifact(event);
  // Deletion fans out into a version scan + blob prefix-list + per-blob deletes + a comment range
  // scan — the heaviest storage path in the app. A modest user-id cap matches other mutation routes.
  rateLimit("artifact-mutate", user.id, 60, 60_000);
  await store.deleteArtifact(artifact.id);
  return new Response(null, { status: 204 });
};
