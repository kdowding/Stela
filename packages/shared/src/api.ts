import { z } from "zod";
import { Artifact, Favicon, Visibility } from "./artifact";
import { Anchor } from "./comment";

const PRINCIPAL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** A stable trusted-header subject: trimmed, bounded, and safe to store/match as text. */
export function isValidUserId(v: string): boolean {
  const t = v.trim();
  return t.length > 0 && t.length <= 256 && !CONTROL_CHARACTER_RE.test(t);
}

/**
 * Whether a string is an allowed principal: a syntactically valid email or a stable user id. The
 * single source of truth — the share UI imports this so its client-side validation can't drift
 * looser than the server's (which would let a bad principal through to a dead-end 400).
 */
export function isValidPrincipal(v: string): boolean {
  const t = v.trim();
  return PRINCIPAL_EMAIL_RE.test(t) || isValidUserId(t);
}
export const EMAIL_OR_USER_ID = z
  .string()
  .max(320)
  .refine(isValidPrincipal, "must be a valid email address or user id");

/** Artifact ids are server-minted UUIDs; constrain any client-supplied id to that shape. */
export const ArtifactId = z.string().uuid();
export type ArtifactId = z.infer<typeof ArtifactId>;

/** MCP/CLI → POST /api/artifacts. Omit artifactId to create new; include it to add a version. */
export const PublishRequest = z.object({
  title: z.string().min(1).max(300),
  favicon: Favicon.optional(),
  html: z.string().min(1).max(10_000_000), // 10 MB ceiling — also guard the host with BODY_SIZE_LIMIT
  visibility: Visibility.default("private"),
  allowedPrincipals: z.array(EMAIL_OR_USER_ID).max(500).default([]),
  artifactId: ArtifactId.optional(),
  note: z.string().max(2000).optional(),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

export const PublishResponse = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  url: z.string(),
  // The artifact's actual stored title. Optional so an older server (pre-title) still parses and a
  // newer MCP can fall back to its locally-derived title. On a version publish this is the EXISTING
  // title (versioning never renames), letting the client report it accurately instead of guessing.
  title: z.string().optional(),
  // True when the published HTML was byte-identical to the current version, so NO new version was
  // created (dedup). Optional so an older server still parses against a newer MCP.
  unchanged: z.boolean().optional(),
});
export type PublishResponse = z.infer<typeof PublishResponse>;

/** GET /api/artifacts → the caller's own artifacts, ones shared server-wide, and ones shared to them. */
export const ListArtifactsResponse = z.object({
  mine: z.array(Artifact),
  everyone: z.array(Artifact),
  // Default [] so an older server (pre-shared-bucket) still parses against a newer MCP.
  shared: z.array(Artifact).default([]),
});
export type ListArtifactsResponse = z.infer<typeof ListArtifactsResponse>;

/** MCP CLI pairing: exchange a one-time code (from GET /cli/authorize) for a durable per-user token. */
export const CliTokenRequest = z.object({
  code: z.string().min(1).max(512),
  /** PKCE code_verifier — proves this caller initiated the pairing (binds the loopback code). */
  verifier: z.string().min(43).max(128),
});
export type CliTokenRequest = z.infer<typeof CliTokenRequest>;

export const CliTokenResponse = z.object({
  token: z.string(),
  name: z.string(),
  email: z.string(),
});
export type CliTokenResponse = z.infer<typeof CliTokenResponse>;

/** Browser → POST /api/artifacts/{id}/comments */
export const CreateCommentRequest = z.object({
  body: z.string().min(1).max(10_000),
  version: z.number().int().positive(),
  anchor: Anchor.optional(), // omit for a general (unpinned) discussion comment
  parentId: z.string().max(256).optional(),
});
export type CreateCommentRequest = z.infer<typeof CreateCommentRequest>;

/** Browser → PATCH /api/artifacts/{id} (owner only): rename. */
export const UpdateArtifactRequest = z.object({
  title: z.string().trim().min(1).max(300),
});
export type UpdateArtifactRequest = z.infer<typeof UpdateArtifactRequest>;

/** Response of DELETE /api/artifacts/{id}/versions/{v}: the current version after removal. */
export const DeleteVersionResponse = z.object({
  currentVersion: z.number().int().positive(),
});
export type DeleteVersionResponse = z.infer<typeof DeleteVersionResponse>;

/** GET /api/artifacts/{id}/versions/{v} → that version's self-contained HTML source. Returned as
 *  JSON (not text/html) so a browser navigating here can't get artifact markup executed same-origin
 *  as the portal; the CLI MCP's get_artifact_html reads the `html` field. */
export const VersionHtmlResponse = z.object({ html: z.string() });
export type VersionHtmlResponse = z.infer<typeof VersionHtmlResponse>;

/** Browser/MCP → PUT /api/artifacts/{id}/sharing (owner only) */
export const UpdateSharingRequest = z.object({
  visibility: Visibility,
  allowedPrincipals: z.array(EMAIL_OR_USER_ID).max(500).default([]),
});
export type UpdateSharingRequest = z.infer<typeof UpdateSharingRequest>;

/** Browser → PATCH /api/artifacts/{id}/comments/{commentId} (resolve / reopen a thread) */
export const ResolveCommentRequest = z.object({
  version: z.number().int().positive(),
  resolved: z.boolean(),
});
export type ResolveCommentRequest = z.infer<typeof ResolveCommentRequest>;

/** Dynamic Client Registration (RFC 7591) → POST /oauth/register. Unknown RFC-7591 fields are
 *  ignored (zod strips them); only redirect_uris is required. */
export const ClientRegistrationRequest = z.object({
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  client_name: z.string().max(200).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(),
});
export type ClientRegistrationRequest = z.infer<typeof ClientRegistrationRequest>;

export const ClientRegistrationResponse = z.object({
  client_id: z.string(),
  client_id_issued_at: z.number().int(),
  redirect_uris: z.array(z.string()),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  token_endpoint_auth_method: z.string(),
  client_name: z.string().optional(),
});
export type ClientRegistrationResponse = z.infer<typeof ClientRegistrationResponse>;

/** OAuth 2.1 token endpoint success response (RFC 6749 §5.1). */
export const OAuthTokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  scope: z.string(),
  refresh_token: z.string().optional(),
});
export type OAuthTokenResponse = z.infer<typeof OAuthTokenResponse>;
