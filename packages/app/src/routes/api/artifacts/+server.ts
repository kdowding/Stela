import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";
import { authenticateApiKey } from "$lib/server/auth";
import { canManage } from "$lib/server/authz";
import { getStore } from "$lib/server/storage";
import { artifactId, badRequest, normalizePrincipals, requireUser } from "$lib/server/guards";
import { clientIp, rateLimit } from "$lib/server/ratelimit";
import { emitVersion } from "$lib/server/revisionBus";
import { PublishRequest, type Artifact, type PublishResponse, type Version } from "@stela/shared";

/** Publish (MCP/CLI). API-key/token authenticated via header → inherently CSRF-safe. */
export const POST: RequestHandler = async (event) => {
  const { request, url } = event;
  // Pre-auth IP rate limit before authenticateApiKey point-reads the token table — caps an
  // unauthenticated token-guess loop (the user-id-keyed limits below only fire post-auth) (F4).
  rateLimit("publish-ip", clientIp(event), 120, 60_000);
  const publisher = await authenticateApiKey(request);
  if (!publisher) throw error(401, "Invalid or missing API key");
  rateLimit("publish", publisher.id, 60, 60_000);
  // Daily anti-loop tripwire. B1 is a flat compute cost, so the only spend that scales with abuse is
  // Blob/Table storage. The PRIMARY defense is identical-content dedup in the store (a runaway loop's
  // output is usually unchanged → no new blob); this 100/day/user backstop only bites a loop that
  // changes content every iteration. Far above real iterative re-publishing. Soft (in-memory, resets
  // on restart) — the Azure budget alert is the durable backstop.
  rateLimit("publish-daily", publisher.id, 100, 86_400_000);

  const parsed = PublishRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) badRequest(parsed.error);
  const input = parsed.data;

  const store = getStore();
  let result: { artifact: Artifact; version: Version; unchanged?: boolean };
  if (input.artifactId) {
    // Publishing a NEW VERSION of an existing artifact is owner-only. Return 404 rather
    // than 403 so a non-owner can't probe which artifact ids exist.
    const id = artifactId(input.artifactId);
    const existing = await store.getArtifact(id);
    if (!existing || !canManage(existing, publisher)) throw error(404, "Artifact not found");
    result = await store.addVersion(id, {
      html: input.html,
      publishedById: publisher.id,
      note: input.note,
    });
  } else {
    result = await store.createArtifact({
      ownerId: publisher.id,
      ownerName: publisher.name,
      title: input.title,
      favicon: input.favicon,
      visibility: input.visibility,
      allowedPrincipals: normalizePrincipals(input.visibility, input.allowedPrincipals),
      html: input.html,
      note: input.note,
    });
  }

  // Push the new version to any open viewers (in-process SSE bus → live update, no polling). Skip on
  // an identical-content no-op — nothing changed, so there's nothing for viewers to advance to.
  if (!result.unchanged) emitVersion(result.artifact.id, result.version.version);

  const body: PublishResponse = {
    id: result.artifact.id,
    version: result.version.version,
    url: `${url.origin}/a/${result.artifact.id}`,
    // Echo the stored title so the client reports the real one — on a version publish this is the
    // existing title, not whatever <title> the just-published file happened to carry.
    title: result.artifact.title,
    // true when the HTML matched the current version, so no new version was created (dedup).
    unchanged: result.unchanged ?? false,
  };
  return json(body);
};

/** List artifacts for the caller — MCP/CLI via token/key, or a signed-in browser user. */
export const GET: RequestHandler = async (event) => {
  const user = await requireUser(event);
  const store = getStore();
  const [mine, everyoneAll, shared] = await Promise.all([
    store.listByOwner(user.id),
    store.listEveryone(),
    store.listSharedWith(user.id, user.email),
  ]);
  const everyone = everyoneAll.filter((a) => a.ownerId !== user.id);
  return json({ mine, everyone, shared });
};
