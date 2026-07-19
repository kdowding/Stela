import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { getStore } from "$lib/server/storage";

/**
 * Liveness + storage-readiness probe for container/host health checks. A point-read that round-trips to
 * Table storage proves the managed-identity credential + table existence are healthy — turning the
 * documented "green boot but storage RBAC not yet propagated" gotcha into a failed health check
 * instead of per-request 500s. A missing artifact (null) is success; only a network/auth failure 503s.
 * Unauthenticated by design (no identity, no data returned) and excluded from the login bounce in hooks.
 */
export const GET: RequestHandler = async () => {
  try {
    await getStore().getArtifact("__healthz__"); // expected null; we only care that the call succeeds
    return json({ status: "ok" });
  } catch (e) {
    console.error("[stela] /healthz storage check failed:", e);
    return json({ status: "degraded" }, { status: 503 });
  }
};
