import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "$env/dynamic/private";
import type { Artifact, Comment, Version, Visibility } from "@stela/shared";
import {
  isExpired,
  isFreshPkceCode,
  isIdenticalRepublish,
  inspectVersionHtml,
  nowIso,
  OAUTH_ACCESS_TTL_MS,
  OAUTH_CODE_TTL_MS,
  PAIRING_TTL_MS,
  parseAnchor,
  parseStringArray,
  positiveInteger,
  randomToken,
  scopeIncludes,
  sha256,
  sortByUpdatedDesc,
  syncedTitle,
  TOKEN_TTL_MS,
  tokenHashesOverCap,
} from "./shared";
import type {
  AddCommentInput,
  AddVersionInput,
  NewArtifactInput,
  NotificationItem,
  OAuthClient,
  OAuthTokens,
  Store,
  TokenIdentity,
} from "./types";
import { LastVersionError, OAUTH_ACCESS_TOKEN_PREFIX, OAUTH_REFRESH_TOKEN_PREFIX } from "./types";

const DATABASE_FILENAME = "stela.db";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    title TEXT NOT NULL,
    favicon TEXT,
    visibility TEXT NOT NULL CHECK (visibility IN ('private', 'everyone', 'restricted')),
    allowed_principals TEXT NOT NULL,
    current_version INTEGER NOT NULL CHECK (current_version > 0),
    max_version_ever INTEGER NOT NULL CHECK (max_version_ever > 0),
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS artifacts_owner_updated
    ON artifacts (owner_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS artifacts_visibility_updated
    ON artifacts (visibility, updated_at DESC);

  CREATE TABLE IF NOT EXISTS versions (
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    blob_path TEXT NOT NULL,
    published_by_id TEXT NOT NULL,
    published_at TEXT NOT NULL,
    note TEXT,
    PRIMARY KEY (artifact_id, version),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS versions_artifact_desc
    ON versions (artifact_id, version DESC);

  CREATE TABLE IF NOT EXISTS artifact_html (
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    html TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version),
    FOREIGN KEY (artifact_id, version)
      REFERENCES versions(artifact_id, version) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS comments (
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    anchor TEXT,
    resolved INTEGER NOT NULL CHECK (resolved IN (0, 1)),
    resolved_by_id TEXT,
    resolved_at TEXT,
    parent_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version, id),
    FOREIGN KEY (artifact_id, version)
      REFERENCES versions(artifact_id, version) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS comments_thread_created
    ON comments (artifact_id, version, created_at, id);
  CREATE INDEX IF NOT EXISTS comments_parent
    ON comments (artifact_id, version, parent_id);

  CREATE TABLE IF NOT EXISTS cli_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS cli_tokens_user_created
    ON cli_tokens (user_id, created_at, token_hash);

  CREATE TABLE IF NOT EXISTS pairing_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS pairing_codes_created ON pairing_codes (created_at);

  CREATE TABLE IF NOT EXISTS unread_notifications (
    recipient_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    artifact_title TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    author_name TEXT NOT NULL,
    snippet TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (recipient_id, artifact_id, comment_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS unread_recipient_created
    ON unread_notifications (recipient_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS unread_artifact
    ON unread_notifications (artifact_id);

  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS oauth_codes_created ON oauth_codes (created_at);

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (token_hash, kind)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS oauth_tokens_expires ON oauth_tokens (expires_at);
`;

type Row = Record<string, unknown>;

/**
 * Self-host storage: one SQLite database owns metadata, immutable HTML, comments, and auth state.
 * DatabaseSync is intentionally wrapped in the existing async Store contract.
 */
export class SqliteStore implements Store {
  readonly databasePath: string;
  private handle: DatabaseSync | null = null;

  constructor(dataDir = env.DATA_DIR?.trim() || resolve(process.cwd(), ".data")) {
    this.databasePath = resolve(dataDir, DATABASE_FILENAME);
  }

  private database(): DatabaseSync {
    if (this.handle) return this.handle;
    mkdirSync(dirname(this.databasePath), { recursive: true });
    const database = new DatabaseSync(this.databasePath);
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA foreign_keys = ON");
      const version = Number(database.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
      if (version > 1) {
        throw new Error(`Unsupported Stela SQLite schema version ${version}`);
      }
      database.exec(SCHEMA);
      if (version === 0) database.exec("PRAGMA user_version = 1");
      this.handle = database;
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.database();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the operation's original error.
      }
      throw error;
    }
  }

  /** Test/process lifecycle helper; deliberately not added to the frozen Store interface. */
  close(): void {
    this.handle?.close();
    this.handle = null;
  }

  async warmUp(): Promise<void> {
    this.database().prepare("SELECT 1 AS ok").get();
  }

  async createArtifact(input: NewArtifactInput): Promise<{ artifact: Artifact; version: Version }> {
    const id = randomUUID();
    const versionNumber = 1;
    const at = nowIso();
    const blobPath = `${id}/v${versionNumber}.html`;
    const artifact: Artifact = {
      id,
      ownerId: input.ownerId,
      ownerName: input.ownerName,
      title: input.title,
      favicon: input.favicon,
      visibility: input.visibility,
      allowedPrincipals: input.allowedPrincipals,
      currentVersion: versionNumber,
      createdAt: at,
      updatedAt: at,
    };
    const version: Version = {
      artifactId: id,
      version: versionNumber,
      blobPath,
      publishedById: input.ownerId,
      publishedAt: at,
      note: input.note,
    };

    this.transaction((database) => {
      database
        .prepare(
          `INSERT INTO artifacts
            (id, owner_id, owner_name, title, favicon, visibility, allowed_principals,
             current_version, max_version_ever, content_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.ownerId,
          input.ownerName,
          input.title,
          input.favicon ?? null,
          input.visibility,
          JSON.stringify(input.allowedPrincipals),
          versionNumber,
          versionNumber,
          sha256(input.html),
          at,
          at,
        );
      insertVersion(database, version, input.html);
    });
    return { artifact, version };
  }

  async addVersion(
    artifactId: string,
    input: AddVersionInput,
  ): Promise<{ artifact: Artifact; version: Version; unchanged: boolean }> {
    const inspected = inspectVersionHtml(input.html);
    return this.transaction((database) => {
      const meta = database.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as
        | Row
        | undefined;
      if (!meta) throw new Error(`Artifact ${artifactId} not found`);
      const existing = artifactFromRow(meta);
      if (existing.ownerId !== input.publishedById) {
        throw new Error(`addVersion: caller ${input.publishedById} is not the owner of ${artifactId}`);
      }

      if (
        isIdenticalRepublish(rowText(meta, "content_hash"), inspected.contentHash)
      ) {
        const currentRow = database
          .prepare("SELECT * FROM versions WHERE artifact_id = ? AND version = ?")
          .get(artifactId, existing.currentVersion) as Row | undefined;
        if (currentRow) {
          return { artifact: existing, version: versionFromRow(currentRow), unchanged: true };
        }
      }

      const maxRow = database
        .prepare("SELECT MAX(version) AS max_version FROM versions WHERE artifact_id = ?")
        .get(artifactId) as Row | undefined;
      const rowMaximum = Number(maxRow?.["max_version"] ?? existing.currentVersion);
      const highWater = positiveInteger(meta["max_version_ever"], "maxVersionEver");
      const versionNumber = Math.max(rowMaximum, highWater) + 1;
      const at = nowIso();
      const version: Version = {
        artifactId,
        version: versionNumber,
        blobPath: `${artifactId}/v${versionNumber}.html`,
        publishedById: input.publishedById,
        publishedAt: at,
        note: input.note,
      };
      insertVersion(database, version, input.html);
      database
        .prepare(
          `UPDATE artifacts
             SET current_version = ?, max_version_ever = ?, content_hash = ?, updated_at = ?,
                 title = COALESCE(?, title)
           WHERE id = ?`,
        )
        .run(
          versionNumber,
          versionNumber,
          inspected.contentHash,
          at,
          inspected.title,
          artifactId,
        );
      return {
        artifact: {
          ...existing,
          title: syncedTitle(existing.title, inspected.title),
          currentVersion: versionNumber,
          updatedAt: at,
        },
        version,
        unchanged: false,
      };
    });
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    const row = this.database().prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? artifactFromRow(row) : null;
  }

  async listByOwner(ownerId: string): Promise<Artifact[]> {
    const rows = this.database().prepare("SELECT * FROM artifacts WHERE owner_id = ?").all(ownerId);
    return sortByUpdatedDesc(rows.map((row) => artifactFromRow(row)));
  }

  async listEveryone(): Promise<Artifact[]> {
    const rows = this.database()
      .prepare("SELECT * FROM artifacts WHERE visibility = 'everyone'")
      .all();
    return sortByUpdatedDesc(rows.map((row) => artifactFromRow(row)));
  }

  async listSharedWith(userId: string, email: string): Promise<Artifact[]> {
    const normalizedId = userId.toLowerCase();
    const normalizedEmail = email.toLowerCase();
    const rows = this.database()
      .prepare("SELECT * FROM artifacts WHERE visibility = 'restricted'")
      .all();
    const artifacts = rows
      .map((row) => artifactFromRow(row))
      .filter(
        (artifact) =>
          artifact.ownerId !== userId &&
          artifact.allowedPrincipals.some((principal) => {
            const normalized = principal.toLowerCase();
            return normalized === normalizedId || normalized === normalizedEmail;
          }),
      );
    return sortByUpdatedDesc(artifacts);
  }

  async getHtml(artifactId: string, version: number): Promise<string | null> {
    const row = this.database()
      .prepare("SELECT html FROM artifact_html WHERE artifact_id = ? AND version = ?")
      .get(artifactId, version) as Row | undefined;
    return row ? rowText(row, "html") : null;
  }

  async listVersions(artifactId: string): Promise<Version[]> {
    return this.database()
      .prepare("SELECT * FROM versions WHERE artifact_id = ? ORDER BY version DESC")
      .all(artifactId)
      .map((row) => versionFromRow(row));
  }

  async updateSharing(
    id: string,
    visibility: Visibility,
    allowedPrincipals: string[],
  ): Promise<void> {
    const result = this.database()
      .prepare(
        `UPDATE artifacts
            SET visibility = ?, allowed_principals = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(visibility, JSON.stringify(allowedPrincipals), nowIso(), id);
    if (Number(result.changes) === 0) throw new Error(`Artifact ${id} not found`);
  }

  async updateTitle(id: string, title: string): Promise<void> {
    const result = this.database()
      .prepare("UPDATE artifacts SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, nowIso(), id);
    if (Number(result.changes) === 0) throw new Error(`Artifact ${id} not found`);
  }

  async deleteVersion(id: string, version: number): Promise<number> {
    return this.transaction((database) => {
      const rows = database
        .prepare("SELECT * FROM versions WHERE artifact_id = ? ORDER BY version DESC")
        .all(id);
      if (rows.length <= 1) throw new LastVersionError();
      const meta = database.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
        | Row
        | undefined;
      const versions = rows.map((row) => versionFromRow(row));
      if (!versions.some((candidate) => candidate.version === version)) {
        return meta ? positiveInteger(meta["current_version"], "currentVersion") : versions[0]!.version;
      }

      database
        .prepare("DELETE FROM versions WHERE artifact_id = ? AND version = ?")
        .run(id, version);
      if (!meta) return version;
      const liveCurrent = positiveInteger(meta["current_version"], "currentVersion");
      if (liveCurrent !== version) return liveCurrent;
      const remaining = database
        .prepare("SELECT version FROM versions WHERE artifact_id = ? ORDER BY version DESC LIMIT 1")
        .get(id) as Row | undefined;
      if (!remaining) return version;
      const newCurrent = positiveInteger(remaining["version"], "version");
      const html = database
        .prepare("SELECT html FROM artifact_html WHERE artifact_id = ? AND version = ?")
        .get(id, newCurrent) as Row | undefined;
      database
        .prepare(
          `UPDATE artifacts
              SET current_version = ?, content_hash = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(newCurrent, html ? sha256(rowText(html, "html")) : "", nowIso(), id);
      return newCurrent;
    });
  }

  async deleteArtifact(id: string): Promise<void> {
    this.transaction((database) => {
      database.prepare("DELETE FROM unread_notifications WHERE artifact_id = ?").run(id);
      database.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
    });
  }

  async listComments(artifactId: string, version: number): Promise<Comment[]> {
    return this.database()
      .prepare(
        `SELECT * FROM comments
          WHERE artifact_id = ? AND version = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(artifactId, version)
      .map((row) => commentFromRow(row));
  }

  async getComment(
    artifactId: string,
    version: number,
    commentId: string,
  ): Promise<Comment | null> {
    const row = this.database()
      .prepare("SELECT * FROM comments WHERE artifact_id = ? AND version = ? AND id = ?")
      .get(artifactId, version, commentId) as Row | undefined;
    return row ? commentFromRow(row) : null;
  }

  async addComment(input: AddCommentInput): Promise<Comment> {
    const comment: Comment = {
      id: randomUUID(),
      artifactId: input.artifactId,
      version: input.version,
      authorId: input.authorId,
      authorName: input.authorName,
      body: input.body,
      anchor: input.anchor,
      resolved: false,
      parentId: input.parentId,
      createdAt: nowIso(),
    };
    this.database()
      .prepare(
        `INSERT INTO comments
          (artifact_id, version, id, author_id, author_name, body, anchor, resolved,
           resolved_by_id, resolved_at, parent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
      )
      .run(
        comment.artifactId,
        comment.version,
        comment.id,
        comment.authorId,
        comment.authorName,
        comment.body,
        comment.anchor === undefined ? null : JSON.stringify(comment.anchor),
        comment.parentId ?? null,
        comment.createdAt,
      );
    return comment;
  }

  async setResolved(
    artifactId: string,
    version: number,
    commentId: string,
    resolved: boolean,
    actorId: string,
  ): Promise<void> {
    const result = this.database()
      .prepare(
        `UPDATE comments
            SET resolved = ?, resolved_by_id = ?, resolved_at = ?
          WHERE artifact_id = ? AND version = ? AND id = ?`,
      )
      .run(resolved ? 1 : 0, actorId, nowIso(), artifactId, version, commentId);
    if (Number(result.changes) === 0) throw new Error(`Comment ${commentId} not found`);
  }

  async deleteComment(artifactId: string, version: number, commentId: string): Promise<void> {
    this.transaction((database) => {
      database
        .prepare(
          `DELETE FROM comments
            WHERE artifact_id = ? AND version = ? AND (id = ? OR parent_id = ?)`,
        )
        .run(artifactId, version, commentId, commentId);
    });
  }

  async appendUnread(recipientIds: string[], item: NotificationItem): Promise<void> {
    const statement = this.database().prepare(
      `INSERT INTO unread_notifications
        (recipient_id, artifact_id, comment_id, artifact_title, version, author_name, snippet, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (recipient_id, artifact_id, comment_id) DO UPDATE SET
         artifact_title = excluded.artifact_title,
         version = excluded.version,
         author_name = excluded.author_name,
         snippet = excluded.snippet,
         created_at = excluded.created_at`,
    );
    for (const userId of new Set(recipientIds)) {
      try {
        statement.run(
          userId,
          item.artifactId,
          item.commentId,
          item.artifactTitle,
          item.version,
          item.authorName,
          item.snippet,
          item.createdAt,
        );
      } catch (error) {
        console.error("Stela: unread fan-out write failed:", error);
      }
    }
  }

  async listUnread(userId: string): Promise<NotificationItem[]> {
    return this.database()
      .prepare(
        `SELECT * FROM unread_notifications
          WHERE recipient_id = ?
          ORDER BY created_at DESC`,
      )
      .all(userId)
      .map((row) => notificationFromRow(row));
  }

  async markRead(userId: string, artifactId?: string): Promise<void> {
    if (artifactId === undefined) {
      this.database().prepare("DELETE FROM unread_notifications WHERE recipient_id = ?").run(userId);
      return;
    }
    this.database()
      .prepare("DELETE FROM unread_notifications WHERE recipient_id = ? AND artifact_id = ?")
      .run(userId, artifactId);
  }

  async createPairingCode(user: TokenIdentity, codeChallenge: string): Promise<string> {
    this.reapExpiredPairings();
    const code = randomToken();
    this.database()
      .prepare(
        `INSERT INTO pairing_codes
          (code_hash, user_id, name, email, code_challenge, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256(code), user.id, user.name, user.email, codeChallenge, nowIso());
    return code;
  }

  async redeemPairingCode(
    code: string,
    verifier: string,
  ): Promise<{ token: string; user: TokenIdentity } | null> {
    const codeHash = sha256(code);
    const consumed = this.transaction((database) => {
      const row = database.prepare("SELECT * FROM pairing_codes WHERE code_hash = ?").get(codeHash) as
        | Row
        | undefined;
      if (!row) return null;
      database.prepare("DELETE FROM pairing_codes WHERE code_hash = ?").run(codeHash);
      return row;
    });
    if (!consumed) return null;
    if (
      !isFreshPkceCode(
        rowText(consumed, "created_at"),
        PAIRING_TTL_MS,
        verifier,
        rowText(consumed, "code_challenge"),
      )
    ) {
      return null;
    }

    const user = identityFromRow(consumed);
    const token = randomToken();
    const now = Date.now();
    this.database()
      .prepare(
        `INSERT INTO cli_tokens
          (token_hash, user_id, name, email, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(token),
        user.id,
        user.name,
        user.email,
        new Date(now).toISOString(),
        new Date(now + TOKEN_TTL_MS).toISOString(),
      );
    this.enforceTokenCap(user.id);
    return { token, user };
  }

  async resolveToken(token: string): Promise<TokenIdentity | null> {
    const hash = sha256(token);
    const row = this.database().prepare("SELECT * FROM cli_tokens WHERE token_hash = ?").get(hash) as
      | Row
      | undefined;
    if (!row) return null;
    if (isExpired(rowText(row, "expires_at"))) {
      this.deleteToken(hash);
      return null;
    }
    return identityFromRow(row);
  }

  async revokeToken(token: string): Promise<void> {
    this.deleteToken(sha256(token));
  }

  private deleteToken(tokenHash: string): void {
    this.database().prepare("DELETE FROM cli_tokens WHERE token_hash = ?").run(tokenHash);
  }

  private enforceTokenCap(userId: string): void {
    try {
      this.transaction((database) => {
        const rows = database
          .prepare(
            `SELECT token_hash, created_at FROM cli_tokens
              WHERE user_id = ?
              ORDER BY created_at ASC, rowid ASC`,
          )
          .all(userId)
          .map((row) => ({
            hash: rowText(row, "token_hash"),
            createdAt: rowText(row, "created_at"),
          }));
        const remove = tokenHashesOverCap(rows);
        const statement = database.prepare("DELETE FROM cli_tokens WHERE token_hash = ?");
        for (const hash of remove) statement.run(hash);
      });
    } catch {
      // Best-effort: token issuance must not fail because cap maintenance did.
    }
  }

  private reapExpiredPairings(): void {
    try {
      const cutoff = new Date(Date.now() - PAIRING_TTL_MS).toISOString();
      this.database()
        .prepare(
          `DELETE FROM pairing_codes
            WHERE code_hash IN (
              SELECT code_hash FROM pairing_codes WHERE created_at < ? LIMIT 100
            )`,
        )
        .run(cutoff);
    } catch {
      // Best-effort garbage collection.
    }
  }

  private reapExpiredOAuth(): void {
    try {
      const now = Date.now();
      const codeCutoff = new Date(now - OAUTH_CODE_TTL_MS).toISOString();
      const database = this.database();
      database
        .prepare(
          `DELETE FROM oauth_codes
            WHERE code_hash IN (
              SELECT code_hash FROM oauth_codes WHERE created_at < ? LIMIT 100
            )`,
        )
        .run(codeCutoff);
      database
        .prepare(
          `DELETE FROM oauth_tokens
            WHERE (token_hash, kind) IN (
              SELECT token_hash, kind FROM oauth_tokens WHERE expires_at < ? LIMIT 100
            )`,
        )
        .run(new Date(now).toISOString());
    } catch {
      // Best-effort garbage collection.
    }
  }

  async registerClient(input: { clientName: string; redirectUris: string[] }): Promise<OAuthClient> {
    const clientId = randomUUID();
    const createdAt = nowIso();
    this.database()
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(clientId, input.clientName, JSON.stringify(input.redirectUris), createdAt);
    return { clientId, clientName: input.clientName, redirectUris: input.redirectUris, createdAt };
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const row = this.database().prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as
      | Row
      | undefined;
    return row
      ? {
          clientId,
          clientName: rowText(row, "client_name"),
          redirectUris: parseStringArray(row["redirect_uris"]),
          createdAt: rowText(row, "created_at"),
        }
      : null;
  }

  async createAuthCode(
    user: TokenIdentity,
    params: {
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      scope: string;
      resource?: string;
    },
  ): Promise<string> {
    this.reapExpiredOAuth();
    const code = randomToken();
    this.database()
      .prepare(
        `INSERT INTO oauth_codes
          (code_hash, user_id, name, email, client_id, redirect_uri, code_challenge,
           scope, resource, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(code),
        user.id,
        user.name,
        user.email,
        params.clientId,
        params.redirectUri,
        params.codeChallenge,
        params.scope,
        params.resource ?? "",
        nowIso(),
      );
    return code;
  }

  async redeemAuthCode(
    code: string,
    params: { verifier: string; clientId: string; redirectUri: string },
  ): Promise<{ user: TokenIdentity; scope: string } | null> {
    const codeHash = sha256(code);
    const consumed = this.transaction((database) => {
      const row = database.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(codeHash) as
        | Row
        | undefined;
      if (!row) return null;
      database.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(codeHash);
      return row;
    });
    if (!consumed) return null;
    if (
      !isFreshPkceCode(
        rowText(consumed, "created_at"),
        OAUTH_CODE_TTL_MS,
        params.verifier,
        rowText(consumed, "code_challenge"),
      ) ||
      rowText(consumed, "client_id") !== params.clientId ||
      rowText(consumed, "redirect_uri") !== params.redirectUri
    ) {
      return null;
    }
    return { user: identityFromRow(consumed), scope: rowText(consumed, "scope") };
  }

  async issueTokens(
    user: TokenIdentity,
    params: { clientId: string; scope: string },
  ): Promise<OAuthTokens> {
    this.reapExpiredOAuth();
    return this.transaction((database) => this.issueTokensInTransaction(database, user, params));
  }

  private issueTokensInTransaction(
    database: DatabaseSync,
    user: TokenIdentity,
    params: { clientId: string; scope: string },
  ): OAuthTokens {
    const now = Date.now();
    const accessToken = OAUTH_ACCESS_TOKEN_PREFIX + randomToken();
    insertOAuthToken(
      database,
      "access",
      accessToken,
      user,
      params.clientId,
      params.scope,
      now + OAUTH_ACCESS_TTL_MS,
    );
    let refreshToken: string | undefined;
    if (scopeIncludes(params.scope, "offline_access")) {
      refreshToken = OAUTH_REFRESH_TOKEN_PREFIX + randomToken();
      insertOAuthToken(
        database,
        "refresh",
        refreshToken,
        user,
        params.clientId,
        params.scope,
        now + TOKEN_TTL_MS,
      );
    }
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(OAUTH_ACCESS_TTL_MS / 1000),
      scope: params.scope,
    };
  }

  async resolveAccessToken(token: string): Promise<TokenIdentity | null> {
    const hash = sha256(token);
    const row = this.database()
      .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
      .get(hash) as Row | undefined;
    if (!row) return null;
    if (isExpired(rowText(row, "expires_at"))) {
      this.database()
        .prepare("DELETE FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
        .run(hash);
      return null;
    }
    return identityFromRow(row);
  }

  async rotateRefreshToken(
    refreshToken: string,
    params: { clientId: string },
  ): Promise<OAuthTokens | null> {
    const hash = sha256(refreshToken);
    return this.transaction((database) => {
      const row = database
        .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
        .get(hash) as Row | undefined;
      if (!row) return null;
      database
        .prepare("DELETE FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
        .run(hash);
      if (
        isExpired(rowText(row, "expires_at")) ||
        rowText(row, "client_id") !== params.clientId
      ) {
        return null;
      }
      return this.issueTokensInTransaction(database, identityFromRow(row), {
        clientId: params.clientId,
        scope: rowText(row, "scope"),
      });
    });
  }
}

function insertVersion(database: DatabaseSync, version: Version, html: string): void {
  database
    .prepare(
      `INSERT INTO versions
        (artifact_id, version, blob_path, published_by_id, published_at, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      version.artifactId,
      version.version,
      version.blobPath,
      version.publishedById,
      version.publishedAt,
      version.note ?? null,
    );
  database
    .prepare("INSERT INTO artifact_html (artifact_id, version, html) VALUES (?, ?, ?)")
    .run(version.artifactId, version.version, html);
}

function insertOAuthToken(
  database: DatabaseSync,
  kind: "access" | "refresh",
  token: string,
  user: TokenIdentity,
  clientId: string,
  scope: string,
  expiresAtMs: number,
): void {
  database
    .prepare(
      `INSERT INTO oauth_tokens
        (token_hash, kind, user_id, name, email, client_id, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sha256(token),
      kind,
      user.id,
      user.name,
      user.email,
      clientId,
      scope,
      nowIso(),
      new Date(expiresAtMs).toISOString(),
    );
}

function artifactFromRow(row: Row): Artifact {
  return {
    id: rowText(row, "id"),
    ownerId: rowText(row, "owner_id"),
    ownerName: rowText(row, "owner_name"),
    title: rowText(row, "title"),
    favicon: rowOptionalText(row, "favicon"),
    visibility: rowText(row, "visibility") as Visibility,
    allowedPrincipals: parseStringArray(row["allowed_principals"]),
    currentVersion: positiveInteger(row["current_version"], "currentVersion"),
    createdAt: rowText(row, "created_at"),
    updatedAt: rowText(row, "updated_at"),
  };
}

function versionFromRow(row: Row): Version {
  return {
    artifactId: rowText(row, "artifact_id"),
    version: positiveInteger(row["version"], "version"),
    blobPath: rowText(row, "blob_path"),
    publishedById: rowText(row, "published_by_id"),
    publishedAt: rowText(row, "published_at"),
    note: rowOptionalText(row, "note"),
  };
}

function commentFromRow(row: Row): Comment {
  const version = positiveInteger(row["version"], "version");
  return {
    id: rowText(row, "id"),
    artifactId: rowText(row, "artifact_id"),
    version,
    authorId: rowText(row, "author_id"),
    authorName: rowText(row, "author_name"),
    body: rowText(row, "body"),
    anchor: row["anchor"] === null ? undefined : parseAnchor(row["anchor"], version),
    resolved: Boolean(row["resolved"]),
    resolvedById: rowOptionalText(row, "resolved_by_id"),
    resolvedAt: rowOptionalText(row, "resolved_at"),
    parentId: rowOptionalText(row, "parent_id"),
    createdAt: rowText(row, "created_at"),
  };
}

function notificationFromRow(row: Row): NotificationItem {
  return {
    artifactId: rowText(row, "artifact_id"),
    artifactTitle: rowText(row, "artifact_title"),
    commentId: rowText(row, "comment_id"),
    version: positiveInteger(row["version"], "version"),
    authorName: rowText(row, "author_name"),
    snippet: rowText(row, "snippet"),
    createdAt: rowText(row, "created_at"),
  };
}

function identityFromRow(row: Row): TokenIdentity {
  return {
    id: rowText(row, "user_id"),
    name: rowText(row, "name"),
    email: rowText(row, "email"),
  };
}

function rowText(row: Row, column: string): string {
  const value = row[column];
  return value === undefined || value === null ? "" : String(value);
}

function rowOptionalText(row: Row, column: string): string | undefined {
  const value = row[column];
  return value === undefined || value === null ? undefined : String(value);
}
