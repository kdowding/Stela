import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import {
  assertSameOrigin,
  badRequest,
  loadManageableArtifact,
  normalizePrincipals,
} from "$lib/server/guards";
import { rateLimit } from "$lib/server/ratelimit";
import { UpdateSharingRequest } from "@stela/shared";

/** Change an artifact's sharing. Owner only (browser session or API key). */
export const PUT: RequestHandler = async (event) => {
  assertSameOrigin(event);
  const { user, artifact, store } = await loadManageableArtifact(event);
  rateLimit("artifact-mutate", user.id, 60, 60_000);

  const parsed = UpdateSharingRequest.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) badRequest(parsed.error);

  const principals = normalizePrincipals(parsed.data.visibility, parsed.data.allowedPrincipals);
  await store.updateSharing(artifact.id, parsed.data.visibility, principals);
  const updated = await store.getArtifact(artifact.id);
  return json(updated);
};
