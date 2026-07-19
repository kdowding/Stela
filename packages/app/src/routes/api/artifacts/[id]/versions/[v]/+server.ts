import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";
import {
  assertSameOrigin,
  loadManageableArtifact,
  loadViewableArtifact,
  parseVersion,
} from "$lib/server/guards";
import { rateLimit } from "$lib/server/ratelimit";
import { LastVersionError } from "$lib/server/storage";
import type { DeleteVersionResponse, VersionHtmlResponse } from "@stela/shared";

/**
 * Read one published version's self-contained HTML source. Viewer-gated (404 hides existence).
 * Returned as JSON (not text/html) so a session-authenticated browser navigating here can't get
 * arbitrary artifact markup executed same-origin as the portal — the CLI MCP's get_artifact_html
 * reads the `html` field. `v` may be a version number or the literal "current".
 */
export const GET: RequestHandler = async (event) => {
  const { artifact, store } = await loadViewableArtifact(event);
  const version =
    event.params.v === "current"
      ? artifact.currentVersion
      : parseVersion(event.params.v ?? null, artifact.currentVersion);
  const html = await store.getHtml(artifact.id, version);
  if (html === null) throw error(404, "Version not found");
  const body: VersionHtmlResponse = { html };
  return json(body);
};

/**
 * Delete a single published version of an artifact (its blob, version row, and that version's
 * comments). Owner only; CSRF-guarded. Repoints currentVersion if the deleted one was current.
 * Returns the resulting currentVersion. 409 if it's the artifact's only version.
 */
export const DELETE: RequestHandler = async (event) => {
  assertSameOrigin(event);
  const { user, artifact, store } = await loadManageableArtifact(event);
  rateLimit("artifact-mutate", user.id, 60, 60_000);
  const version = parseVersion(event.params.v ?? null, artifact.currentVersion);
  try {
    const currentVersion = await store.deleteVersion(artifact.id, version);
    const body: DeleteVersionResponse = { currentVersion };
    return json(body);
  } catch (e) {
    if (e instanceof LastVersionError) throw error(409, "Cannot delete the only version");
    throw e;
  }
};
