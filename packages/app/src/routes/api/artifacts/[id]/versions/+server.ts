import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { loadViewableArtifact } from "$lib/server/guards";

/** List an artifact's published versions (newest-first), so a caller can resume editing. Viewer-gated. */
export const GET: RequestHandler = async (event) => {
  const { artifact, store } = await loadViewableArtifact(event);
  const versions = await store.listVersions(artifact.id);
  return json(versions);
};
