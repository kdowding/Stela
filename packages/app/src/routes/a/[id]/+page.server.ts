import type { PageServerLoad } from "./$types";
import { canManage } from "$lib/server/authz";
import { loadViewableArtifact } from "$lib/server/guards";

export const load: PageServerLoad = async (event) => {
  const { user, artifact, store } = await loadViewableArtifact(event);
  const versions = await store.listVersions(artifact.id);
  // Honor a ?v= deep-link (e.g. the Revisions panel's "open this revision" links, or a bookmarked
  // revision URL). Parse leniently and fall back to the current version for an absent / invalid /
  // no-longer-existing version, so a stale link shows the latest instead of erroring the viewer.
  const raw = event.url.searchParams.get("v");
  const n = raw === null || raw === "" ? artifact.currentVersion : Number(raw);
  const requestedVersion =
    Number.isInteger(n) && versions.some((v) => v.version === n) ? n : artifact.currentVersion;
  return { artifact, versions, requestedVersion, canManage: canManage(artifact, user), fullBleed: true };
};
