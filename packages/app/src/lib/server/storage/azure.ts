import { TableClient, odata, type TableEntity } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import type { Artifact, Comment, Version, Visibility } from "@stela/shared";
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

const CONTAINER = "artifacts";
const T_ARTIFACTS = "artifacts";
const T_VERSIONS = "versions";
const T_COMMENTS = "comments";
const T_TOKENS = "tokens";
const T_TOKENS_BY_OWNER = "tokensByOwner";
const T_PAIRINGS = "pairings";
const T_UNREAD = "unread";
const T_OAUTH_CLIENTS = "oauthClients";
const T_OAUTH_CODES = "oauthCodes";
const T_OAUTH_TOKENS = "oauthTokens";

// Production: a storage account NAME + managed identity (no secret). Local: the Azurite emulator.
// NOTE: data-tables + Azurite authenticate only via the "UseDevelopmentStorage=true" shorthand —
// the explicit connection string / named-key forms hit AuthorizationFailure (path-style signing).
const STORAGE_ACCOUNT = env.AZURE_STORAGE_ACCOUNT;
const STORAGE_CONN = env.AZURE_STORAGE_CONNECTION_STRING;
const LOCAL_CONN = STORAGE_CONN ?? "UseDevelopmentStorage=true";
const useManagedIdentity = !!STORAGE_ACCOUNT && !STORAGE_CONN;

let sharedCredential: DefaultAzureCredential | undefined;
function credential(): DefaultAzureCredential {
  return (sharedCredential ??= new DefaultAzureCredential());
}

function makeTableClient(table: string): TableClient {
  if (STORAGE_ACCOUNT && useManagedIdentity) {
    return new TableClient(`https://${STORAGE_ACCOUNT}.table.core.windows.net`, table, credential());
  }
  return TableClient.fromConnectionString(LOCAL_CONN, table, { allowInsecureConnection: true });
}

function makeBlobService(): BlobServiceClient {
  if (STORAGE_ACCOUNT && useManagedIdentity) {
    return new BlobServiceClient(`https://${STORAGE_ACCOUNT}.blob.core.windows.net`, credential());
  }
  return BlobServiceClient.fromConnectionString(LOCAL_CONN);
}

/**
 * Azure Blob (immutable artifact HTML) + Table (metadata, versions, comments).
 * Everything goes through this class so the rest of the app never touches the SDK —
 * swapping to Cosmos later is a contained change (see CLAUDE.md).
 */
export class AzureStore implements Store {
  private readonly artifacts = makeTableClient(T_ARTIFACTS);
  private readonly versions = makeTableClient(T_VERSIONS);
  private readonly comments = makeTableClient(T_COMMENTS);
  private readonly tokens = makeTableClient(T_TOKENS);
  private readonly tokensByOwner = makeTableClient(T_TOKENS_BY_OWNER);
  private readonly pairings = makeTableClient(T_PAIRINGS);
  private readonly unread = makeTableClient(T_UNREAD);
  private readonly oauthClients = makeTableClient(T_OAUTH_CLIENTS);
  private readonly oauthCodes = makeTableClient(T_OAUTH_CODES);
  private readonly oauthTokens = makeTableClient(T_OAUTH_TOKENS);
  private readonly blobs = makeBlobService();
  private ready: Promise<void> | null = null;

  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.artifacts.createTable().catch(ignoreExists);
        await this.versions.createTable().catch(ignoreExists);
        await this.comments.createTable().catch(ignoreExists);
        await this.tokens.createTable().catch(ignoreExists);
        await this.tokensByOwner.createTable().catch(ignoreExists);
        await this.pairings.createTable().catch(ignoreExists);
        await this.unread.createTable().catch(ignoreExists);
        await this.oauthClients.createTable().catch(ignoreExists);
        await this.oauthCodes.createTable().catch(ignoreExists);
        await this.oauthTokens.createTable().catch(ignoreExists);
        await this.blobs.getContainerClient(CONTAINER).createIfNotExists();
      })().catch((e: unknown) => {
        this.ready = null; // don't latch a failure — let the next call retry
        throw e;
      });
    }
    return this.ready;
  }

  /** Warm the managed-identity credential + table/container existence so the first real request after
   *  a cold start doesn't pay that latency. Idempotent — ensure() caches its result. */
  async warmUp(): Promise<void> {
    await this.ensure();
  }

  private async uploadHtml(blobPath: string, html: string): Promise<void> {
    const block = this.blobs.getContainerClient(CONTAINER).getBlockBlobClient(blobPath);
    const buf = Buffer.from(html, "utf8");
    await block.uploadData(buf, {
      blobHTTPHeaders: { blobContentType: "text/html; charset=utf-8" },
    });
  }

  /** Best-effort rollback of a partially-written version (blob + version row). */
  private async cleanupVersion(artifactId: string, version: number, blobPath: string): Promise<void> {
    await this.blobs
      .getContainerClient(CONTAINER)
      .getBlockBlobClient(blobPath)
      .deleteIfExists()
      .catch(() => {});
    await this.versions.deleteEntity(artifactId, pad(version)).catch(() => {});
  }

  async createArtifact(input: NewArtifactInput): Promise<{ artifact: Artifact; version: Version }> {
    await this.ensure();
    const id = randomUUID();
    const version = 1;
    const at = nowIso();
    const blobPath = `${id}/v${version}.html`;

    const artifact: Artifact = {
      id,
      ownerId: input.ownerId,
      ownerName: input.ownerName,
      title: input.title,
      favicon: input.favicon,
      visibility: input.visibility,
      allowedPrincipals: input.allowedPrincipals,
      currentVersion: version,
      createdAt: at,
      updatedAt: at,
    };
    const ver: Version = {
      artifactId: id,
      version,
      blobPath,
      publishedById: input.ownerId,
      publishedAt: at,
      note: input.note,
    };

    await this.uploadHtml(blobPath, input.html);
    try {
      // Version row before the meta row: if either fails, no artifact is left exposed.
      await this.versions.createEntity(toVersionEntity(ver));
      // maxVersionEver seeds the monotonic high-water mark; contentHash seeds the identical-republish
      // dedup — both read back by addVersion (see there).
      await this.artifacts.createEntity({
        ...toArtifactEntity(artifact),
        maxVersionEver: version,
        contentHash: sha256(input.html),
      });
    } catch (e) {
      await this.cleanupVersion(id, version, blobPath); // best-effort: don't leave an orphan blob
      throw e;
    }
    return { artifact, version: ver };
  }

  async addVersion(
    artifactId: string,
    input: AddVersionInput,
  ): Promise<{ artifact: Artifact; version: Version; unchanged: boolean }> {
    await this.ensure();
    // Allocate from the version rows (source of truth) and claim the slot atomically
    // (createEntity → 409 if someone raced us). Avoids blob clobber and lost versions.
    for (let attempt = 0; attempt < 8; attempt++) {
      // Read the raw meta row (not getArtifact) so we can also see the maxVersionEver high-water mark.
      let metaEntity: Record<string, unknown>;
      try {
        metaEntity = await this.artifacts.getEntity(artifactId, "meta");
      } catch (e) {
        if (isNotFound(e)) throw new Error(`Artifact ${artifactId} not found`);
        throw e;
      }
      const existing = fromArtifactEntity(metaEntity);
      // Defense in depth: only the owner may publish a new version. Routes enforce this,
      // but asserting here guarantees the invariant for every caller of the storage layer.
      if (existing.ownerId !== input.publishedById) {
        throw new Error(`addVersion: caller ${input.publishedById} is not the owner of ${artifactId}`);
      }
      const all = await this.listVersions(artifactId); // sorted desc

      // Identical re-publish: if the new HTML byte-matches the CURRENT version, don't create another
      // version — return the current one as a no-op (no storage churn, no duplicate history entry).
      // This is the main defense against a runaway publish loop, whose output is usually unchanged.
      // The hash lives on the meta row; it's absent on pre-dedup artifacts, in which case we publish.
      const { contentHash: newHash, title: newTitle } = inspectVersionHtml(input.html);
      const currentHash = str(metaEntity["contentHash"]);
      if (isIdenticalRepublish(currentHash, newHash)) {
        const current = all.find((v) => v.version === existing.currentVersion);
        if (current) return { artifact: existing, version: current, unchanged: true };
      }

      const maxRow = all.length > 0 ? all[0]!.version : existing.currentVersion;
      // Allocate monotonically from a never-decremented high-water mark so version numbers NEVER
      // recycle — even after deleteVersion removes the highest version. That keeps every
      // (artifactId, version) pair pinned to the same immutable HTML forever, which the /raw
      // `immutable` cache header and any ?v= deep-link rely on (a reused number would otherwise serve
      // stale, deleted content). deleteVersion deliberately never touches maxVersionEver.
      const storedHW = Number(metaEntity["maxVersionEver"]);
      const highWater = Number.isInteger(storedHW) && storedHW > 0 ? storedHW : maxRow;
      const version = Math.max(maxRow, highWater) + 1;
      const at = nowIso();
      const blobPath = `${artifactId}/v${version}.html`;
      const ver: Version = {
        artifactId,
        version,
        blobPath,
        publishedById: input.publishedById,
        publishedAt: at,
        note: input.note,
      };

      try {
        await this.versions.createEntity(toVersionEntity(ver)); // claim the version number
      } catch (e) {
        if (isStatus(e, 409)) continue; // lost the race for this number — recompute and retry
        throw e;
      }

      try {
        await this.uploadHtml(blobPath, input.html); // unique path now; no clobber
        // Merge ONLY the fields this path owns so a concurrent sharing change isn't reverted.
        // maxVersionEver advances with currentVersion (monotonic mark); contentHash tracks the new
        // current version for the next dedup check.
        await this.artifacts.updateEntity(
          {
            partitionKey: artifactId,
            rowKey: "meta",
            currentVersion: version,
            maxVersionEver: version,
            contentHash: newHash,
            updatedAt: at,
            // Sync the meta title to the new revision's <title> so get_artifact and the gallery show the
            // current title, not the one frozen at create. Only when the new HTML has one — never clobber.
            ...(newTitle ? { title: newTitle } : {}),
          },
          "Merge",
        );
      } catch (e) {
        // Don't leave a claimed-but-empty version row or orphan blob behind.
        await this.cleanupVersion(artifactId, version, blobPath);
        throw e;
      }
      const updated: Artifact = {
        ...existing,
        title: syncedTitle(existing.title, newTitle),
        currentVersion: version,
        updatedAt: at,
      };
      return { artifact: updated, version: ver, unchanged: false };
    }
    throw new Error(`Could not allocate a new version for ${artifactId} (too much contention)`);
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    await this.ensure();
    try {
      const entity = await this.artifacts.getEntity(id, "meta");
      return fromArtifactEntity(entity);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listByOwner(ownerId: string): Promise<Artifact[]> {
    await this.ensure();
    const out: Artifact[] = [];
    for await (const e of this.artifacts.listEntities({
      queryOptions: { filter: odata`ownerId eq ${ownerId}` },
    })) {
      out.push(fromArtifactEntity(e));
    }
    return sortByUpdatedDesc(out);
  }

  async listEveryone(): Promise<Artifact[]> {
    await this.ensure();
    const out: Artifact[] = [];
    for await (const e of this.artifacts.listEntities({
      queryOptions: { filter: odata`visibility eq ${"everyone"}` },
    })) {
      out.push(fromArtifactEntity(e));
    }
    return sortByUpdatedDesc(out);
  }

  async listSharedWith(userId: string, email: string): Promise<Artifact[]> {
    await this.ensure();
    // Scan restricted artifacts and filter by principal — same shape as listEveryone. The principal
    // match mirrors canView (user id/email, case-insensitive). At server scale a scan is fine; a
    // `sharedWithUser` (PK=user id) index is the documented upgrade if the restricted set grows.
    const normalizedId = userId.toLowerCase();
    const e = email.toLowerCase();
    const out: Artifact[] = [];
    for await (const ent of this.artifacts.listEntities({
      queryOptions: { filter: odata`visibility eq ${"restricted"}` },
    })) {
      const a = fromArtifactEntity(ent);
      if (a.ownerId === userId) continue; // owners already see their own under "mine"
      if (a.allowedPrincipals.some((p) => p.toLowerCase() === normalizedId || p.toLowerCase() === e)) out.push(a);
    }
    return sortByUpdatedDesc(out);
  }

  async getHtml(artifactId: string, version: number): Promise<string | null> {
    await this.ensure();
    const block = this.blobs
      .getContainerClient(CONTAINER)
      .getBlockBlobClient(`${artifactId}/v${version}.html`);
    try {
      const buf = await block.downloadToBuffer();
      return buf.toString("utf8");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listVersions(artifactId: string): Promise<Version[]> {
    await this.ensure();
    const out: Version[] = [];
    for await (const e of this.versions.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${artifactId}` },
    })) {
      out.push(fromVersionEntity(e));
    }
    return out.sort((a, b) => b.version - a.version);
  }

  async updateSharing(
    id: string,
    visibility: Visibility,
    allowedPrincipals: string[],
  ): Promise<void> {
    await this.ensure();
    // Merge ONLY the sharing fields so a concurrent publish (merging currentVersion) is safe.
    await this.artifacts.updateEntity(
      {
        partitionKey: id,
        rowKey: "meta",
        visibility,
        allowedPrincipals: JSON.stringify(allowedPrincipals),
        updatedAt: nowIso(),
      },
      "Merge",
    );
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await this.ensure();
    // Merge ONLY the title so a concurrent publish (currentVersion) or sharing change isn't reverted.
    await this.artifacts.updateEntity(
      { partitionKey: id, rowKey: "meta", title, updatedAt: nowIso() },
      "Merge",
    );
  }

  async deleteVersion(id: string, version: number): Promise<number> {
    await this.ensure();
    const all = await this.listVersions(id); // sorted desc
    if (all.length <= 1) throw new LastVersionError();
    const existing = await this.getArtifact(id);
    if (!all.some((v) => v.version === version)) {
      // Already gone (idempotent) — report the unchanged pointer.
      return existing?.currentVersion ?? all[0]!.version;
    }

    // Remove the blob, the version row, and the comments scoped to this exact version.
    await this.blobs
      .getContainerClient(CONTAINER)
      .getBlockBlobClient(`${id}/v${version}.html`)
      .deleteIfExists()
      .catch(() => {});
    await this.versions.deleteEntity(id, pad(version)).catch((e: unknown) => {
      if (!isNotFound(e)) throw e;
    });
    for await (const e of this.comments.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${commentPartition(id, version)}` },
    })) {
      await this.comments.deleteEntity(str(e["partitionKey"]), str(e["rowKey"])).catch(() => {});
    }

    // Repoint currentVersion only if we removed the one in use. Concurrency-safe (F11): a publish racing
    // this delete can advance currentVersion to a higher version AFTER our initial reads, so don't repoint
    // from the stale snapshot. Re-read the meta row (value + ETag), recompute from a FRESH version list,
    // and repoint under If-Match — retrying on a 412. Only act while currentVersion still equals the
    // version we deleted; otherwise a concurrent publish/delete already moved the pointer and it must not
    // be reverted to a stale value.
    for (let attempt = 0; attempt < 5; attempt++) {
      let meta: Record<string, unknown>;
      try {
        meta = await this.artifacts.getEntity(id, "meta");
      } catch (e) {
        if (isNotFound(e)) return version; // artifact deleted out from under us; nothing to repoint
        throw e;
      }
      const liveCurrent = positiveInteger(meta["currentVersion"], "currentVersion");
      if (liveCurrent !== version) return liveCurrent; // non-current delete, or pointer already advanced
      const remaining = await this.listVersions(id); // fresh, taken AFTER the row delete above
      if (remaining.length === 0) return version; // unreachable (last-version delete refused), guard anyway
      const newCurrent = remaining[0]!.version; // highest remaining (list is desc)
      // F2: refresh contentHash to the new current's content, else a later identical re-publish dedups
      // against the deleted version and is silently dropped. Empty-string fallback (never undefined — a
      // Merge ignores undefined and would keep the stale value) safely disables dedup if the blob is gone.
      const newCurrentHtml = await this.getHtml(id, newCurrent);
      try {
        await this.artifacts.updateEntity(
          {
            partitionKey: id,
            rowKey: "meta",
            currentVersion: newCurrent,
            contentHash: newCurrentHtml !== null ? sha256(newCurrentHtml) : "",
            updatedAt: nowIso(),
          },
          "Merge",
          { etag: str(meta["etag"]) || "*" },
        );
        return newCurrent;
      } catch (e) {
        if (isStatus(e, 412)) continue; // meta changed under us — re-read and re-evaluate
        throw e;
      }
    }
    // Sustained contention: fall back to whatever the live pointer is now.
    return (await this.getArtifact(id))?.currentVersion ?? version;
  }

  async deleteArtifact(id: string): Promise<void> {
    await this.ensure();
    // Remove the meta row FIRST — that's what gates viewing (getArtifact), so the artifact becomes
    // immediately inaccessible even if the rest of the cleanup is interrupted (no reachable orphan).
    // 404 means it's already gone; sweep the rest anyway to clean up a prior partial delete.
    try {
      await this.artifacts.deleteEntity(id, "meta");
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    // Version rows (PK = id). Best-effort from here — the artifact is already gone to readers.
    for (const v of await this.listVersions(id)) {
      await this.versions.deleteEntity(id, pad(v.version)).catch(() => {});
    }
    // Version blobs ({id}/v*.html) — list by prefix so any orphaned blob is swept too.
    const container = this.blobs.getContainerClient(CONTAINER);
    for await (const b of container.listBlobsFlat({ prefix: `${id}/` })) {
      await container.getBlockBlobClient(b.name).deleteIfExists().catch(() => {});
    }
    // Comments across every version (PK = `{id}:{version}`) via a prefix range scan ([`{id}:`,`{id};`)).
    for await (const e of this.comments.listEntities({
      queryOptions: { filter: odata`PartitionKey ge ${`${id}:`} and PartitionKey lt ${`${id};`}` },
    })) {
      await this.comments.deleteEntity(str(e["partitionKey"]), str(e["rowKey"])).catch(() => {});
    }
    // Unread notifications pointing at this artifact (RK = `{id}:{commentId}`, across all recipient
    // partitions). A table scan, but deleteArtifact is rare and the table is internal-scale.
    for await (const e of this.unread.listEntities({
      queryOptions: { filter: odata`RowKey ge ${`${id}:`} and RowKey lt ${`${id};`}` },
    })) {
      await this.unread.deleteEntity(str(e["partitionKey"]), str(e["rowKey"])).catch(() => {});
    }
  }

  async listComments(artifactId: string, version: number): Promise<Comment[]> {
    await this.ensure();
    const out: Comment[] = [];
    for await (const e of this.comments.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${commentPartition(artifactId, version)}` },
    })) {
      out.push(fromCommentEntity(e));
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getComment(
    artifactId: string,
    version: number,
    commentId: string,
  ): Promise<Comment | null> {
    await this.ensure();
    try {
      const e = await this.comments.getEntity(commentPartition(artifactId, version), commentId);
      return fromCommentEntity(e);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async addComment(input: AddCommentInput): Promise<Comment> {
    await this.ensure();
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
    await this.comments.createEntity(toCommentEntity(comment));
    return comment;
  }

  async setResolved(
    artifactId: string,
    version: number,
    commentId: string,
    resolved: boolean,
    actorId: string,
  ): Promise<void> {
    await this.ensure();
    await this.comments.updateEntity(
      {
        partitionKey: commentPartition(artifactId, version),
        rowKey: commentId,
        resolved,
        resolvedById: actorId,
        resolvedAt: nowIso(),
      },
      "Merge",
    );
  }

  async deleteComment(artifactId: string, version: number, commentId: string): Promise<void> {
    await this.ensure();
    const pk = commentPartition(artifactId, version);
    // Remove any replies pointing at this comment (one level deep — replies always parent the root),
    // then the comment itself. catch() makes it idempotent against a concurrent/duplicate delete.
    for await (const e of this.comments.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${pk} and parentId eq ${commentId}` },
    })) {
      await this.comments.deleteEntity(pk, str(e["rowKey"])).catch(() => {});
    }
    await this.comments.deleteEntity(pk, commentId).catch(() => {});
  }

  // --- comment notifications (per-recipient unread inbox) ---

  async appendUnread(recipientIds: string[], item: NotificationItem): Promise<void> {
    await this.ensure();
    // Fan out one row per recipient. Upsert so a retry can't 409, and so the same comment never
    // double-counts for a recipient. RK = `{artifactId}:{commentId}` enables per-artifact markRead.
    await Promise.all(
      [...new Set(recipientIds)].map((userId) =>
        this.unread
          .upsertEntity(
            {
              partitionKey: userId,
              rowKey: `${item.artifactId}:${item.commentId}`,
              artifactId: item.artifactId,
              artifactTitle: item.artifactTitle,
              commentId: item.commentId,
              version: item.version,
              authorName: item.authorName,
              snippet: item.snippet,
              createdAt: item.createdAt,
            },
            "Replace",
          )
          .catch((e: unknown) => console.error("Stela: unread fan-out write failed:", e)),
      ),
    );
  }

  async listUnread(userId: string): Promise<NotificationItem[]> {
    await this.ensure();
    const out: NotificationItem[] = [];
    for await (const e of this.unread.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${userId}` },
    })) {
      out.push({
        artifactId: str(e["artifactId"]),
        artifactTitle: str(e["artifactTitle"]),
        commentId: str(e["commentId"]),
        version: positiveInteger(e["version"], "version"),
        authorName: str(e["authorName"]),
        snippet: str(e["snippet"]),
        createdAt: str(e["createdAt"]),
      });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
  }

  async markRead(userId: string, artifactId?: string): Promise<void> {
    await this.ensure();
    // All unread for the user, or just one artifact's (RK range `{id}:`..`{id};`, same trick as deleteArtifact).
    const filter =
      artifactId === undefined
        ? odata`PartitionKey eq ${userId}`
        : odata`PartitionKey eq ${userId} and RowKey ge ${`${artifactId}:`} and RowKey lt ${`${artifactId};`}`;
    for await (const e of this.unread.listEntities({ queryOptions: { filter } })) {
      await this.unread.deleteEntity(str(e["partitionKey"]), str(e["rowKey"])).catch(() => {});
    }
  }

  // --- CLI pairing + per-user tokens (secrets stored only as SHA-256 hashes) ---

  async createPairingCode(user: TokenIdentity, codeChallenge: string): Promise<string> {
    await this.ensure();
    void this.reapExpiredPairings(); // best-effort GC; never blocks the flow
    const code = randomToken();
    await this.pairings.createEntity({
      partitionKey: sha256(code),
      rowKey: "pairing",
      userId: user.id,
      name: user.name,
      email: user.email,
      codeChallenge,
      createdAt: nowIso(),
    });
    return code;
  }

  async redeemPairingCode(
    code: string,
    verifier: string,
  ): Promise<{ token: string; user: TokenIdentity } | null> {
    await this.ensure();
    const codeHash = sha256(code);
    let entity: Record<string, unknown>;
    try {
      entity = await this.pairings.getEntity(codeHash, "pairing");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    // Single-use, atomically: only the caller who wins the conditional delete proceeds; a concurrent
    // redeem of the same code gets 412/404 and is rejected.
    try {
      await this.pairings.deleteEntity(codeHash, "pairing", { etag: str(entity["etag"]) || "*" });
    } catch (err) {
      if (isStatus(err, 412) || isNotFound(err)) return null;
      throw err;
    }
    if (
      !isFreshPkceCode(
        str(entity["createdAt"]),
        PAIRING_TTL_MS,
        verifier,
        str(entity["codeChallenge"]),
      )
    ) {
      return null;
    }

    const user: TokenIdentity = {
      id: str(entity["userId"]),
      name: str(entity["name"]),
      email: str(entity["email"]),
    };
    const token = randomToken();
    const tokenHash = sha256(token);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + TOKEN_TTL_MS).toISOString();
    // Primary token row (hot point-read on auth) + an owner-index row (enables the cap and
    // future revoke-all). Both carry the absolute expiry.
    await this.tokens.createEntity({
      partitionKey: tokenHash,
      rowKey: "token",
      userId: user.id,
      name: user.name,
      email: user.email,
      createdAt,
      expiresAt,
    });
    await this.tokensByOwner
      .createEntity({ partitionKey: user.id, rowKey: tokenHash, createdAt, expiresAt })
      .catch((e: unknown) =>
        console.error("Stela: tokensByOwner index write failed (token cap may drift):", e),
      );
    void this.enforceTokenCap(user.id); // best-effort; never blocks login
    return { token, user };
  }

  async resolveToken(token: string): Promise<TokenIdentity | null> {
    await this.ensure();
    const hash = sha256(token);
    let entity: Record<string, unknown>;
    try {
      entity = await this.tokens.getEntity(hash, "token");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    // Absolute expiry: a lapsed token is rejected and reaped from both tables.
    // Fail closed: a missing/unparseable expiresAt (e.g. a legacy pre-expiry token) is rejected and
    // reaped rather than treated as never-expiring.
    if (isExpired(str(entity["expiresAt"]))) {
      await this.deleteToken(hash, str(entity["userId"]));
      return null;
    }
    return { id: str(entity["userId"]), name: str(entity["name"]), email: str(entity["email"]) };
  }

  async revokeToken(token: string): Promise<void> {
    await this.ensure();
    const hash = sha256(token);
    let userId = "";
    try {
      userId = str((await this.tokens.getEntity(hash, "token"))["userId"]);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    await this.deleteToken(hash, userId);
  }

  /** Delete a token from both the primary table and the owner index. */
  private async deleteToken(tokenHash: string, userId: string): Promise<void> {
    await this.tokens.deleteEntity(tokenHash, "token").catch(() => {});
    if (userId) await this.tokensByOwner.deleteEntity(userId, tokenHash).catch(() => {});
  }

  /** Keep at most MAX_TOKENS_PER_USER active tokens per user; reap the oldest beyond the cap. */
  private async enforceTokenCap(userId: string): Promise<void> {
    try {
      const rows: { hash: string; createdAt: string }[] = [];
      for await (const e of this.tokensByOwner.listEntities({
        queryOptions: { filter: odata`PartitionKey eq ${userId}` },
      })) {
        rows.push({ hash: str(e["rowKey"]), createdAt: str(e["createdAt"]) });
      }
      for (const hash of tokenHashesOverCap(rows)) {
        await this.deleteToken(hash, userId);
      }
    } catch {
      /* best-effort */
    }
  }

  /** Best-effort GC of abandoned (never-redeemed) pairing codes. */
  private async reapExpiredPairings(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - PAIRING_TTL_MS).toISOString();
      let n = 0;
      for await (const e of this.pairings.listEntities({
        queryOptions: { filter: odata`createdAt lt ${cutoff}` },
      })) {
        if (n++ >= 100) break;
        await this.pairings.deleteEntity(str(e["partitionKey"]), str(e["rowKey"])).catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  }

  /**
   * Best-effort GC of expired OAuth codes (past OAUTH_CODE_TTL_MS) and tokens (past expiresAt), mirroring
   * reapExpiredPairings — the code/token tables otherwise only shrink via redeem/rotate/lazy-reject, so
   * abandoned codes and lapsed tokens would accumulate. Fire-and-forget; never blocks.
   */
  private async reapExpiredOAuth(): Promise<void> {
    try {
      const nowMs = Date.now();
      const codeCutoff = new Date(nowMs - OAUTH_CODE_TTL_MS).toISOString();
      let codes = 0;
      for await (const e of this.oauthCodes.listEntities({
        queryOptions: { filter: odata`createdAt lt ${codeCutoff}` },
      })) {
        if (codes++ >= 100) break;
        await this.oauthCodes.deleteEntity(str(e["partitionKey"]), str(e["rowKey"])).catch(() => {});
      }
      const nowStr = new Date(nowMs).toISOString();
      let toks = 0;
      for await (const e of this.oauthTokens.listEntities({
        queryOptions: { filter: odata`expiresAt lt ${nowStr}` },
      })) {
        if (toks++ >= 100) break;
        await this.oauthTokens.deleteEntity(str(e["partitionKey"]), str(e["rowKey"])).catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  }

  // --- OAuth 2.1 authorization server (claude.ai connector). Mirrors the CLI pairing/token patterns
  //     above: secrets stored only as SHA-256 hashes, single-use codes via conditional ETag delete,
  //     PKCE S256. Separate tables + token prefixes keep OAuth off the CLI per-user token cap. ---

  async registerClient(input: { clientName: string; redirectUris: string[] }): Promise<OAuthClient> {
    await this.ensure();
    const clientId = randomUUID();
    const createdAt = nowIso();
    await this.oauthClients.createEntity({
      partitionKey: clientId,
      rowKey: "client",
      clientName: input.clientName,
      redirectUris: JSON.stringify(input.redirectUris),
      createdAt,
    });
    return { clientId, clientName: input.clientName, redirectUris: input.redirectUris, createdAt };
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    await this.ensure();
    try {
      const e = await this.oauthClients.getEntity(clientId, "client");
      return {
        clientId,
        clientName: str(e["clientName"]),
        redirectUris: parseStringArray(e["redirectUris"]),
        createdAt: str(e["createdAt"]),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
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
    await this.ensure();
    void this.reapExpiredOAuth(); // best-effort GC; never blocks the flow
    const code = randomToken();
    await this.oauthCodes.createEntity({
      partitionKey: sha256(code),
      rowKey: "code",
      userId: user.id,
      name: user.name,
      email: user.email,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scope: params.scope,
      resource: params.resource ?? "",
      createdAt: nowIso(),
    });
    return code;
  }

  async redeemAuthCode(
    code: string,
    params: { verifier: string; clientId: string; redirectUri: string },
  ): Promise<{ user: TokenIdentity; scope: string } | null> {
    await this.ensure();
    const codeHash = sha256(code);
    let entity: Record<string, unknown>;
    try {
      entity = await this.oauthCodes.getEntity(codeHash, "code");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    // Single-use, atomically (mirror redeemPairingCode): the winner of the conditional delete proceeds.
    try {
      await this.oauthCodes.deleteEntity(codeHash, "code", { etag: str(entity["etag"]) || "*" });
    } catch (err) {
      if (isStatus(err, 412) || isNotFound(err)) return null;
      throw err;
    }
    if (
      !isFreshPkceCode(
        str(entity["createdAt"]),
        OAUTH_CODE_TTL_MS,
        params.verifier,
        str(entity["codeChallenge"]),
      )
    ) {
      return null;
    }
    // The code is bound to the client + redirect_uri it was issued for (RFC 6749 §4.1.3).
    if (str(entity["clientId"]) !== params.clientId) return null;
    if (str(entity["redirectUri"]) !== params.redirectUri) return null;
    return {
      user: { id: str(entity["userId"]), name: str(entity["name"]), email: str(entity["email"]) },
      scope: str(entity["scope"]),
    };
  }

  async issueTokens(
    user: TokenIdentity,
    params: { clientId: string; scope: string },
  ): Promise<OAuthTokens> {
    await this.ensure();
    void this.reapExpiredOAuth(); // best-effort GC; never blocks
    const now = Date.now();
    const accessToken = OAUTH_ACCESS_TOKEN_PREFIX + randomToken();
    await this.writeOAuthToken(
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
      await this.writeOAuthToken(
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

  private async writeOAuthToken(
    kind: "access" | "refresh",
    token: string,
    user: TokenIdentity,
    clientId: string,
    scope: string,
    expiresAtMs: number,
  ): Promise<void> {
    await this.oauthTokens.createEntity({
      partitionKey: sha256(token),
      rowKey: kind,
      userId: user.id,
      name: user.name,
      email: user.email,
      clientId,
      scope,
      createdAt: nowIso(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  async resolveAccessToken(token: string): Promise<TokenIdentity | null> {
    await this.ensure();
    const hash = sha256(token);
    let entity: Record<string, unknown>;
    try {
      entity = await this.oauthTokens.getEntity(hash, "access");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    // Fail closed: a lapsed/unparseable expiry is rejected and reaped (mirror resolveToken).
    if (isExpired(str(entity["expiresAt"]))) {
      await this.oauthTokens.deleteEntity(hash, "access").catch(() => {});
      return null;
    }
    return { id: str(entity["userId"]), name: str(entity["name"]), email: str(entity["email"]) };
  }

  async rotateRefreshToken(
    refreshToken: string,
    params: { clientId: string },
  ): Promise<OAuthTokens | null> {
    await this.ensure();
    const hash = sha256(refreshToken);
    let entity: Record<string, unknown>;
    try {
      entity = await this.oauthTokens.getEntity(hash, "refresh");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    // Refresh tokens are single-use: invalidate the presented one atomically before minting a new
    // pair. A concurrent reuse loses the conditional delete → null (blunts refresh-token replay).
    try {
      await this.oauthTokens.deleteEntity(hash, "refresh", { etag: str(entity["etag"]) || "*" });
    } catch (err) {
      if (isStatus(err, 412) || isNotFound(err)) return null;
      throw err;
    }
    if (isExpired(str(entity["expiresAt"]))) return null;
    if (str(entity["clientId"]) !== params.clientId) return null;
    const user: TokenIdentity = {
      id: str(entity["userId"]),
      name: str(entity["name"]),
      email: str(entity["email"]),
    };
    return this.issueTokens(user, { clientId: params.clientId, scope: str(entity["scope"]) });
  }
}

// --- Azure table keys ---

function pad(n: number): string {
  return String(n).padStart(6, "0");
}
function commentPartition(artifactId: string, version: number): string {
  return `${artifactId}:${version}`;
}

// --- entity mapping (Table entities are flat; arrays/objects are JSON strings) ---

function toArtifactEntity(a: Artifact): TableEntity<Record<string, unknown>> {
  return {
    partitionKey: a.id,
    rowKey: "meta",
    ownerId: a.ownerId,
    ownerName: a.ownerName,
    title: a.title,
    ...(a.favicon ? { favicon: a.favicon } : {}),
    visibility: a.visibility,
    allowedPrincipals: JSON.stringify(a.allowedPrincipals),
    currentVersion: a.currentVersion,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function fromArtifactEntity(e: Record<string, unknown>): Artifact {
  return {
    id: str(e["partitionKey"]),
    ownerId: str(e["ownerId"]),
    ownerName: str(e["ownerName"]),
    title: str(e["title"]),
    favicon: e["favicon"] ? str(e["favicon"]) : undefined,
    visibility: str(e["visibility"]) as Visibility,
    allowedPrincipals: parseStringArray(e["allowedPrincipals"]),
    currentVersion: positiveInteger(e["currentVersion"], "currentVersion"),
    createdAt: str(e["createdAt"]),
    updatedAt: str(e["updatedAt"]),
  };
}

function toVersionEntity(v: Version): TableEntity<Record<string, unknown>> {
  return {
    partitionKey: v.artifactId,
    rowKey: pad(v.version),
    version: v.version,
    blobPath: v.blobPath,
    publishedById: v.publishedById,
    publishedAt: v.publishedAt,
    ...(v.note !== undefined ? { note: v.note } : {}),
  };
}

function fromVersionEntity(e: Record<string, unknown>): Version {
  return {
    artifactId: str(e["partitionKey"]),
    version: positiveInteger(e["version"], "version"),
    blobPath: str(e["blobPath"]),
    publishedById: str(e["publishedById"]),
    publishedAt: str(e["publishedAt"]),
    note: e["note"] === undefined ? undefined : str(e["note"]),
  };
}

function toCommentEntity(c: Comment): TableEntity<Record<string, unknown>> {
  return {
    partitionKey: commentPartition(c.artifactId, c.version),
    rowKey: c.id,
    version: c.version,
    authorId: c.authorId,
    authorName: c.authorName,
    body: c.body,
    // Omit the column entirely for a general (unpinned) comment, so it reads back as undefined rather
    // than a phantom default pin. parentId is handled the same way below.
    ...(c.anchor !== undefined ? { anchor: JSON.stringify(c.anchor) } : {}),
    resolved: c.resolved,
    ...(c.parentId !== undefined ? { parentId: c.parentId } : {}),
    createdAt: c.createdAt,
  };
}

function fromCommentEntity(e: Record<string, unknown>): Comment {
  const partition = str(e["partitionKey"]);
  const sep = partition.lastIndexOf(":");
  const version = positiveInteger(e["version"], "version");
  return {
    id: str(e["rowKey"]),
    artifactId: sep >= 0 ? partition.slice(0, sep) : partition,
    version,
    authorId: str(e["authorId"]),
    authorName: str(e["authorName"]),
    body: str(e["body"]),
    // Absent column ⇒ a general comment (no pin). Present-but-corrupt still degrades to a default pin.
    anchor: e["anchor"] === undefined ? undefined : parseAnchor(e["anchor"], version),
    resolved: Boolean(e["resolved"]),
    resolvedById: e["resolvedById"] === undefined ? undefined : str(e["resolvedById"]),
    resolvedAt: e["resolvedAt"] === undefined ? undefined : str(e["resolvedAt"]),
    parentId: e["parentId"] === undefined ? undefined : str(e["parentId"]),
    createdAt: str(e["createdAt"]),
  };
}

// --- helpers ---

function ignoreExists(err: unknown): void {
  if (isStatus(err, 409)) return;
  throw err;
}
function isNotFound(err: unknown): boolean {
  return isStatus(err, 404);
}
function isStatus(err: unknown, code: number): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode?: number }).statusCode === code
  );
}
function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}
