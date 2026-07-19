import type { Anchor, Artifact, Comment, Version, Visibility } from "@stela/shared";

/** Thrown by deleteVersion when asked to remove an artifact's only remaining version. Routes map this to 409. */
export class LastVersionError extends Error {
  constructor(message = "Cannot delete the only version of an artifact") {
    super(message);
    this.name = "LastVersionError";
  }
}

export interface NewArtifactInput {
  ownerId: string;
  ownerName: string;
  title: string;
  favicon?: string;
  visibility: Visibility;
  allowedPrincipals: string[];
  html: string;
  note?: string;
}

export interface AddVersionInput {
  html: string;
  publishedById: string;
  note?: string;
}

export interface AddCommentInput {
  artifactId: string;
  version: number;
  authorId: string;
  authorName: string;
  body: string;
  anchor?: Anchor; // omitted for a general (unpinned) discussion comment
  parentId?: string;
}

export interface ArtifactStore {
  createArtifact(input: NewArtifactInput): Promise<{ artifact: Artifact; version: Version }>;
  /**
   * Add a new version. If the HTML is byte-identical to the current version, NO new version is
   * created — the current one is returned with `unchanged: true` (identical-republish dedup).
   */
  addVersion(
    artifactId: string,
    input: AddVersionInput,
  ): Promise<{ artifact: Artifact; version: Version; unchanged: boolean }>;
  getArtifact(id: string): Promise<Artifact | null>;
  listByOwner(ownerId: string): Promise<Artifact[]>;
  listEveryone(): Promise<Artifact[]>;
  /** Restricted artifacts shared TO this user (matched by user id or email), excluding ones they own. */
  listSharedWith(userId: string, email: string): Promise<Artifact[]>;
  getHtml(artifactId: string, version: number): Promise<string | null>;
  listVersions(artifactId: string): Promise<Version[]>;
  updateSharing(id: string, visibility: Visibility, allowedPrincipals: string[]): Promise<void>;
  /** Rename an artifact (owner-gated upstream). Merges title + updatedAt onto the meta row. */
  updateTitle(id: string, title: string): Promise<void>;
  /**
   * Permanently delete a single version: its blob, version row, and the comments scoped to it. If it
   * was the current version, currentVersion is repointed to the highest remaining one. Returns the
   * resulting currentVersion. Throws {@link LastVersionError} if it's the artifact's only version.
   */
  deleteVersion(id: string, version: number): Promise<number>;
  /** Permanently delete an artifact and all its versions, blobs, and comments. Idempotent. */
  deleteArtifact(id: string): Promise<void>;
}

export interface CommentStore {
  listComments(artifactId: string, version: number): Promise<Comment[]>;
  getComment(artifactId: string, version: number, commentId: string): Promise<Comment | null>;
  addComment(input: AddCommentInput): Promise<Comment>;
  setResolved(
    artifactId: string,
    version: number,
    commentId: string,
    resolved: boolean,
    actorId: string,
  ): Promise<void>;
  /** Delete a comment; if it's a root (pin), its replies go too. Idempotent (authorize upstream). */
  deleteComment(artifactId: string, version: number, commentId: string): Promise<void>;
}

/** One unread comment-notification for a recipient (denormalized so the inbox needs no extra reads). */
export interface NotificationItem {
  artifactId: string;
  artifactTitle: string;
  commentId: string;
  version: number;
  authorName: string;
  snippet: string;
  createdAt: string; // ISO 8601
}

export interface NotificationStore {
  /** Fan out one comment-notification to several recipients (best-effort; never blocks the comment). */
  appendUnread(recipientIds: string[], item: NotificationItem): Promise<void>;
  /** A recipient's unread notifications, newest first. */
  listUnread(userId: string): Promise<NotificationItem[]>;
  /** Mark read: clear one artifact's unread for the recipient, or ALL when artifactId is omitted. */
  markRead(userId: string, artifactId?: string): Promise<void>;
}

/** Identity carried by a per-user API token (and the configured admin key). Structurally a SessionUser. */
export interface TokenIdentity {
  id: string;
  name: string;
  email: string;
}

export interface TokenStore {
  /** Mint a short-lived, single-use pairing code bound to a signed-in user + a PKCE challenge. Returns the plaintext code. */
  createPairingCode(user: TokenIdentity, codeChallenge: string): Promise<string>;
  /**
   * Redeem a pairing code (single-use, time-limited) for a durable per-user token. The PKCE
   * `verifier` must hash to the challenge bound at authorize time. Returns the plaintext token +
   * identity once, or null if the code is invalid/expired/mismatched.
   */
  redeemPairingCode(
    code: string,
    verifier: string,
  ): Promise<{ token: string; user: TokenIdentity } | null>;
  /** Resolve a per-user token to its identity (hot auth path), or null if unknown/revoked. */
  resolveToken(token: string): Promise<TokenIdentity | null>;
  /** Revoke a per-user token (sign-out). No-op if the token is unknown. */
  revokeToken(token: string): Promise<void>;
}

/** OAuth access tokens carry this prefix so `authenticateApiKey` routes them with a single lookup;
 *  refresh tokens carry the other. Anything unprefixed is a CLI per-user pairing token. */
export const OAUTH_ACCESS_TOKEN_PREFIX = "sat_";
export const OAUTH_REFRESH_TOKEN_PREFIX = "srt_";

/** A DCR-registered OAuth client (public client — PKCE, no secret in v1). */
export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

/** Tokens minted by the OAuth token endpoint. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Access-token lifetime in seconds (for the `expires_in` response field). */
  expiresIn: number;
  scope: string;
}

/**
 * Stela as its own OAuth 2.1 Authorization Server (for the claude.ai connector). Mirrors the CLI
 * pairing/token patterns: secrets stored only as SHA-256 hashes, single-use codes (conditional
 * ETag delete), PKCE S256.
 */
export interface OAuthStore {
  /** Register a client (Dynamic Client Registration, RFC 7591). Returns the minted client_id + metadata. */
  registerClient(input: { clientName: string; redirectUris: string[] }): Promise<OAuthClient>;
  /** Look up a registered client by id, or null. */
  getClient(clientId: string): Promise<OAuthClient | null>;
  /** Mint a single-use, PKCE-bound authorization code for a consented user — bound to client + redirect + scope. */
  createAuthCode(
    user: TokenIdentity,
    params: {
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      scope: string;
      resource?: string;
    },
  ): Promise<string>;
  /**
   * Redeem an authorization code (single-use, time-limited). Validates PKCE
   * (sha256b64url(verifier) === challenge) and that clientId + redirectUri match what was bound at
   * authorize time. Returns the user + granted scope once, or null.
   */
  redeemAuthCode(
    code: string,
    params: { verifier: string; clientId: string; redirectUri: string },
  ): Promise<{ user: TokenIdentity; scope: string } | null>;
  /** Issue an access token (+ a rotating refresh token when scope includes `offline_access`). */
  issueTokens(user: TokenIdentity, params: { clientId: string; scope: string }): Promise<OAuthTokens>;
  /** Resolve an OAuth access token to its identity (hot path), or null if unknown/expired. */
  resolveAccessToken(token: string): Promise<TokenIdentity | null>;
  /** Rotate a refresh token: validate + invalidate the presented one, mint a fresh access+refresh pair. */
  rotateRefreshToken(refreshToken: string, params: { clientId: string }): Promise<OAuthTokens | null>;
}

export interface Store
  extends ArtifactStore,
    CommentStore,
    TokenStore,
    OAuthStore,
    NotificationStore {
  /** Eagerly initialize storage (managed-identity token + table/container existence) so the first
   *  real request after a cold start or deploy doesn't pay that latency. Safe to call repeatedly. */
  warmUp(): Promise<void>;
}
