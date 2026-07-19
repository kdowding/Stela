import type { RequestHandler } from "./$types";
import { error } from "@sveltejs/kit";
import { ARTIFACT_CSP } from "@stela/shared";
import { loadViewableArtifact, parseVersion } from "$lib/server/guards";
import { injectBridge, BRIDGE_VERSION } from "$lib/server/bridge";

// ARTIFACT_CSP is the single source of truth in @stela/shared, imported here (the route that serves
// it), into the MCP authoring instructions, and into the validate dry-run output — so the policy we
// document can't drift from the one we serve. Pairs with the viewer's sandbox="allow-scripts" iframe.

export const GET: RequestHandler = async (event) => {
  const { artifact, store } = await loadViewableArtifact(event);

  const vParam = event.url.searchParams.get("v");
  const version = parseVersion(vParam, artifact.currentVersion);

  // The portal viewer loads the iframe with ?embed=1, which appends the page-aware comment bridge
  // (bridge.ts) at serve time. A direct/standalone hit on /raw is left pristine — the bridge is never
  // baked into the stored blob. The bridge version is folded into the ETag so a bridge change busts the
  // embed variant without touching the artifact's own immutable cache.
  const embed = event.url.searchParams.get("embed") === "1";

  // Content for (artifactId, version) is immutable until the next publish advances currentVersion, so a
  // strong validator lets a repeat load revalidate to a cheap 304 instead of re-streaming the blob (F53).
  const etag = embed ? `"${artifact.id}-${version}-e${BRIDGE_VERSION}"` : `"${artifact.id}-${version}"`;
  // The embed variant carries an injected script that evolves with BRIDGE_VERSION, so it revalidates
  // (cheap 304 via the version-stamped ETag) rather than caching immutably for a year.
  const cacheControl = embed
    ? "private, no-cache"
    : vParam !== null
      ? "private, max-age=31536000, immutable"
      : "private, no-cache";
  if (event.request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": cacheControl } });
  }

  const raw = await store.getHtml(artifact.id, version);
  if (raw === null) throw error(404, "Version not found");
  const html = embed ? injectBridge(raw) : raw;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": ARTIFACT_CSP,
      "x-content-type-options": "nosniff",
      "cache-control": cacheControl,
      etag,
    },
  });
};
