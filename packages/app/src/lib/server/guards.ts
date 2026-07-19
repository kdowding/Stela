import { error, type RequestEvent } from "@sveltejs/kit";
import type { ZodError } from "zod";
import type { Artifact, Visibility } from "@stela/shared";
import { authenticateApiKey, type SessionUser } from "./auth";
import { canManage, canView } from "./authz";
import { getStore, type Store } from "./storage";

/** Reject ids with characters disallowed in Azure Table keys (control chars + / \ # ?). Allows '-' (UUIDs). */
function hasInvalidKeyChar(id: string): boolean {
  if (id.includes("/") || id.includes("\\") || id.includes("#") || id.includes("?")) return true;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** Browser identity from the trusted auth proxy, or an API-key/token caller (MCP/CLI). */
export async function resolveUser(event: RequestEvent): Promise<SessionUser | null> {
  return event.locals.user ?? (await authenticateApiKey(event.request));
}

export async function requireUser(event: RequestEvent): Promise<SessionUser> {
  const user = await resolveUser(event);
  if (!user) throw error(401, "Sign in or provide an API key");
  return user;
}

/**
 * Block cross-site state-changing requests (cookie-auth CSRF). Browsers send `Origin`
 * on mutating requests; a non-browser API-key caller sends none and carries no ambient cookie.
 */
export function assertSameOrigin(event: RequestEvent): void {
  // API/CLI callers authenticate by header and carry no ambient cookie, so a malicious site can't
  // drive them — exempt them explicitly rather than inferring it from a missing Origin.
  if (event.request.headers.get("authorization") || event.request.headers.get("x-api-key")) return;
  const origin = event.request.headers.get("origin");
  if (origin !== null && origin !== event.url.origin) {
    throw error(403, "Cross-origin request blocked");
  }
  // Only same-origin, or a top-level navigation ('none'); reject cross-site AND same-site.
  const site = event.request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    throw error(403, "Cross-site request blocked");
  }
}

/** Validate an artifact id from the route before it reaches storage (avoids storage 400s). */
export function artifactId(raw: string | undefined): string {
  const id = (raw ?? "").trim();
  if (!id || id.length > 256 || hasInvalidKeyChar(id)) throw error(404, "Artifact not found");
  return id;
}

/** Parse a 1-based version from a query param, or fall back. */
export function parseVersion(raw: string | null, fallback: number): number {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw error(400, "Invalid version");
  return n;
}

/** Turn a Zod failure into a clean 400 (no internal schema dump). */
export function badRequest(err: ZodError): never {
  const issue = err.issues[0];
  const where = issue?.path.join(".");
  throw error(
    400,
    where ? `Invalid ${where}: ${issue?.message}` : (issue?.message ?? "Invalid request"),
  );
}

/** Trim/dedupe/drop-empty principals; only kept when visibility is restricted. */
export function normalizePrincipals(visibility: Visibility, list: string[]): string[] {
  if (visibility !== "restricted") return [];
  return [...new Set(list.map((p) => p.trim()).filter(Boolean))];
}

/** Load an artifact the caller may VIEW, or throw 401/403/404. */
export async function loadViewableArtifact(
  event: RequestEvent,
): Promise<{ user: SessionUser; artifact: Artifact; store: Store }> {
  const user = await requireUser(event);
  const store = getStore();
  const artifact = await store.getArtifact(artifactId(event.params.id));
  // Return 404 (not 403) when the caller can't view it, so private artifacts don't leak existence.
  if (!artifact || !canView(artifact, user)) throw error(404, "Artifact not found");
  return { user, artifact, store };
}

/** Load an artifact the caller OWNS (can manage), or throw 401/403/404. */
export async function loadManageableArtifact(
  event: RequestEvent,
): Promise<{ user: SessionUser; artifact: Artifact; store: Store }> {
  const user = await requireUser(event);
  const store = getStore();
  const artifact = await store.getArtifact(artifactId(event.params.id));
  if (!artifact) throw error(404, "Artifact not found");
  if (!canManage(artifact, user)) {
    // 403 only if the caller can already legitimately see it (e.g. a everyone artifact); otherwise
    // 404 so ownership/existence isn't leaked to outsiders.
    if (canView(artifact, user)) throw error(403, "Only the owner can change this");
    throw error(404, "Artifact not found");
  }
  return { user, artifact, store };
}
