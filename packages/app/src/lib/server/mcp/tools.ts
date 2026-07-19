import {
  findExternalRefs,
  formatExternalRefs,
  VALIDATE_CLEAN_NOTE,
  VALIDATE_CSP_NOTE,
  extractTitle,
  parseArtifactRef,
  isValidPrincipal,
  formatArtifactDetail,
  formatArtifactLine,
  formatComments,
  DESIGN_GUIDE,
  type Visibility,
} from "@stela/shared";
import type { SessionUser } from "$lib/server/auth";
import { getStore } from "$lib/server/storage";
import { canManage, canView } from "$lib/server/authz";
import { normalizePrincipals } from "$lib/server/guards";
import { rateLimit } from "$lib/server/ratelimit";
import { emitVersion } from "$lib/server/revisionBus";
import { fetchRemoteHtml, type FetchResult } from "$lib/server/fetchRemoteHtml";
import { scanBundleForRemoteRefs } from "$lib/server/bundleScan";

/**
 * Remote-MCP connector tools (claude.ai), acting as the OAuth-authenticated user. Unlike the
 * standalone CLI MCP (packages/mcp), these talk to the in-process `Store` directly and reuse the
 * same authz the API routes use. Handlers are exported (not inlined in buildServer) so they're unit
 * testable. There is no `~/.stela` file→artifact map here — editing is **stateless and id-based**:
 * `publish_artifact` returns the artifact URL, and a new version is published by passing that `url`.
 */
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export interface ToolCtx {
  user: SessionUser;
  origin: string;
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** SvelteKit `error()` throws an HttpError ({ status, body: { message } }); pull a clean message out. */
function httpErrorMessage(e: unknown): string | null {
  if (e && typeof e === "object" && "body" in e) {
    const body = (e as { body?: { message?: string } }).body;
    if (body && typeof body.message === "string") return body.message;
  }
  return null;
}

function artifactUrl(origin: string, id: string): string {
  return `${origin}/a/${id}`;
}

export function whoami(ctx: ToolCtx): ToolResult {
  return ok(`Connected to Stela as ${ctx.user.name} (${ctx.user.email}).`);
}

/** Static design guidance — identical to what the CLI serves; no auth or ctx needed. */
export function designGuide(): ToolResult {
  return ok(DESIGN_GUIDE);
}

export async function listArtifacts(
  ctx: ToolCtx,
  args: { scope: "mine" | "everyone" | "shared" | "all" },
): Promise<ToolResult> {
  const store = getStore();
  const [mine, everyoneAll, shared] = await Promise.all([
    store.listByOwner(ctx.user.id),
    store.listEveryone(),
    store.listSharedWith(ctx.user.id, ctx.user.email),
  ]);
  const everyone = everyoneAll.filter((a) => a.ownerId !== ctx.user.id);
  const sections: string[] = [];
  if (args.scope === "mine" || args.scope === "all") {
    sections.push(
      `# Your artifacts (${mine.length})`,
      ...(mine.length ? mine.map((a) => formatArtifactLine(a, ctx.origin)) : ["- (none)"]),
    );
  }
  if (args.scope === "everyone" || args.scope === "all") {
    sections.push(
      `# Shared with everyone (${everyone.length})`,
      ...(everyone.length ? everyone.map((a) => formatArtifactLine(a, ctx.origin)) : ["- (none)"]),
    );
  }
  if (args.scope === "shared" || args.scope === "all") {
    sections.push(
      `# Shared with you (${shared.length})`,
      ...(shared.length ? shared.map((a) => formatArtifactLine(a, ctx.origin)) : ["- (none)"]),
    );
  }
  return ok(sections.join("\n"));
}

export interface PublishArgs {
  html?: string;
  fileUrl?: string;
  title?: string;
  favicon?: string;
  visibility: Visibility;
  allowedPrincipals: string[];
  url?: string;
  note?: string;
  force: boolean;
  validate?: boolean;
}

/** Injectable so tests can drive the fileUrl path without real outbound egress. */
export interface PublishDeps {
  fetchHtml: (url: string) => Promise<FetchResult>;
}
const defaultPublishDeps: PublishDeps = { fetchHtml: (url) => fetchRemoteHtml(url) };

export async function publishArtifact(
  ctx: ToolCtx,
  args: PublishArgs,
  deps: PublishDeps = defaultPublishDeps,
): Promise<ToolResult> {
  const { user, origin } = ctx;

  // Source the HTML from EITHER an inline string or a short-lived URL Stela fetches (never both).
  const hasHtml = typeof args.html === "string" && args.html.length > 0;
  const hasUrl = typeof args.fileUrl === "string" && args.fileUrl.trim().length > 0;
  if (hasHtml && hasUrl) return fail("Pass the artifact as either `html` or `fileUrl`, not both.");
  if (!hasHtml && !hasUrl) {
    return fail("Provide the artifact as `html` (inline) or `fileUrl` (a short-lived URL Stela will fetch).");
  }

  // Rate-limit anything that does real work: a fileUrl fetch (outbound egress) or a publish. A
  // validate dry-run on INLINE html is cheap and quota-free; one that must FETCH still counts.
  if (hasUrl || !args.validate) {
    try {
      rateLimit("publish", user.id, 60, 60_000);
      rateLimit("publish-daily", user.id, 100, 86_400_000);
    } catch (e) {
      return fail(httpErrorMessage(e) ?? "Too many publishes — try again shortly.");
    }
  }

  let html: string;
  if (hasUrl) {
    const fetched = await deps.fetchHtml(args.fileUrl!.trim());
    if (!fetched.ok) return fail(`Couldn't fetch fileUrl — ${fetched.error}`);
    html = fetched.html;
  } else {
    html = args.html!;
  }
  if (html.length === 0) return fail("The artifact HTML is empty.");
  if (html.length > 10_000_000) return fail("The artifact HTML exceeds the 10 MB limit.");

  // Self-contained check (the CLI runs this client-side; the connector has no client, so it runs here).
  // External refs render blank under Stela's no-network CSP. scanBundleForRemoteRefs also looks INSIDE
  // a bundled export's compressed runtime for CDN loads (e.g. React/Babel from unpkg) that a plaintext
  // scan can't see — the failure mode that publishes "clean" then errors at render.
  const refs = [...findExternalRefs(html), ...scanBundleForRemoteRefs(html)];

  // Dry run: report what the CSP would block (machine-readable) and stop, without publishing.
  if (args.validate) {
    if (refs.length === 0) return ok(`✓ ${VALIDATE_CLEAN_NOTE}${VALIDATE_CSP_NOTE}`);
    return fail(
      formatExternalRefs("Validation found references the no-network CSP would block (it would render blank):", refs) +
        VALIDATE_CSP_NOTE,
    );
  }

  if (refs.length && !args.force) {
    return fail(
      formatExternalRefs(
        "This artifact references external resources, which Stela's no-network CSP blocks (it would render blank):",
        refs,
        "\n\nInline all CSS/JS and embed assets as data:/blob: URIs, then publish again. Pass force: true to publish as-is.",
      ),
    );
  }

  const store = getStore();

  // Publish a new VERSION of an existing artifact (stateless edit: the caller passes the URL/id).
  if (args.url && args.url.trim()) {
    const id = parseArtifactRef(args.url);
    if (!id) return fail(`'${args.url}' is not a Stela artifact URL or id.`);
    const existing = await store.getArtifact(id);
    // 404-style message whether it's missing or simply not theirs — don't leak existence/ownership.
    if (!existing || !canManage(existing, user)) {
      return fail(`No artifact ${id} you can publish to (not found, or you don't own it).`);
    }
    const { artifact, version, unchanged } = await store.addVersion(id, {
      html,
      publishedById: user.id,
      note: args.note,
    });
    if (!unchanged) emitVersion(artifact.id, version.version);
    return ok(
      unchanged
        ? `No change — "${artifact.title}" is already at v${version.version}. ${artifactUrl(origin, artifact.id)}`
        : `Published "${artifact.title}" v${version.version} → ${artifactUrl(origin, artifact.id)}`,
    );
  }

  // Create a NEW artifact.
  const title = (args.title?.trim() || extractTitle(html) || "").trim();
  if (!title) return fail("Provide a title, or include a non-empty <title> in the HTML.");
  if (args.visibility === "restricted") {
    const bad = args.allowedPrincipals.map((p) => p.trim()).filter(Boolean).find((p) => !isValidPrincipal(p));
    if (bad) return fail(`'${bad}' is not a valid email or user id.`);
  }
  const { artifact, version } = await store.createArtifact({
    ownerId: user.id,
    ownerName: user.name,
    title,
    favicon: args.favicon,
    visibility: args.visibility,
    allowedPrincipals: normalizePrincipals(args.visibility, args.allowedPrincipals),
    html,
    note: args.note,
  });
  emitVersion(artifact.id, version.version);
  const url = artifactUrl(origin, artifact.id);
  return ok(
    `Published "${artifact.title}" v${version.version} → ${url}\n` +
      `Keep this URL — to revise, call publish_artifact again with url: "${url}".`,
  );
}

export async function getArtifact(ctx: ToolCtx, args: { artifact: string }): Promise<ToolResult> {
  const id = parseArtifactRef(args.artifact);
  if (!id) return fail(`'${args.artifact}' is not a Stela artifact URL or id.`);
  const store = getStore();
  const a = await store.getArtifact(id);
  if (!a || !canView(a, ctx.user)) return fail(`Artifact ${id} not found.`);
  const versions = await store.listVersions(id);
  return ok(formatArtifactDetail(a, versions, ctx.origin));
}

export async function readArtifactHtml(
  ctx: ToolCtx,
  args: { artifact: string; version?: number },
): Promise<ToolResult> {
  const id = parseArtifactRef(args.artifact);
  if (!id) return fail(`'${args.artifact}' is not a Stela artifact URL or id.`);
  const store = getStore();
  const a = await store.getArtifact(id);
  if (!a || !canView(a, ctx.user)) return fail(`Artifact ${id} not found.`);
  const version = args.version ?? a.currentVersion;
  const html = await store.getHtml(id, version);
  if (html === null) return fail(`Version ${version} of "${a.title}" not found.`);
  // Return the raw source verbatim — nothing else — so the model can edit it and republish cleanly.
  return ok(html);
}

export async function setSharing(
  ctx: ToolCtx,
  args: { artifact: string; visibility: Visibility; allowedPrincipals: string[] },
): Promise<ToolResult> {
  const id = parseArtifactRef(args.artifact);
  if (!id) return fail(`'${args.artifact}' is not a Stela artifact URL or id.`);
  const store = getStore();
  const existing = await store.getArtifact(id);
  if (!existing || !canManage(existing, ctx.user)) {
    return fail(`No artifact ${id} you can manage (not found, or you don't own it).`);
  }
  const principals = normalizePrincipals(args.visibility, args.allowedPrincipals);
  if (args.visibility === "restricted") {
    const bad = principals.find((p) => !isValidPrincipal(p));
    if (bad) return fail(`'${bad}' is not a valid email or user id.`);
  }
  await store.updateSharing(id, args.visibility, principals);
  const who = args.visibility === "restricted" ? ` (${principals.join(", ") || "no one yet"})` : "";
  return ok(`Sharing for "${existing.title}" → ${args.visibility}${who}`);
}

export async function deleteArtifact(ctx: ToolCtx, args: { artifact: string }): Promise<ToolResult> {
  const id = parseArtifactRef(args.artifact);
  if (!id) return fail(`'${args.artifact}' is not a Stela artifact URL or id.`);
  const store = getStore();
  const existing = await store.getArtifact(id);
  if (!existing || !canManage(existing, ctx.user)) {
    return fail(`No artifact ${id} to delete (not found, or you don't own it).`);
  }
  await store.deleteArtifact(id);
  return ok(`Deleted "${existing.title}" (${id}). This cannot be undone.`);
}

export async function readComments(
  ctx: ToolCtx,
  args: { artifact: string; version?: number },
): Promise<ToolResult> {
  const id = parseArtifactRef(args.artifact);
  if (!id) return fail(`'${args.artifact}' is not a Stela artifact URL or id.`);
  const store = getStore();
  const a = await store.getArtifact(id);
  if (!a || !canView(a, ctx.user)) return fail(`Artifact ${id} not found.`);
  const version = args.version ?? a.currentVersion;
  const comments = await store.listComments(id, version);
  return ok(formatComments(comments, { title: a.title, version, apiUrl: ctx.origin, id }));
}
