import { createHash, randomBytes } from "node:crypto";
import { extractTitle } from "@stela/shared";
import type { Anchor, Artifact } from "@stela/shared";

/** CLI pairing codes are single-use and short-lived. */
export const PAIRING_TTL_MS = 2 * 60 * 1000;
/** Per-user pairing tokens get an absolute lifetime and a per-user cap. */
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_TOKENS_PER_USER = 10;
/** OAuth authorization codes are single-use and short-lived. */
export const OAUTH_CODE_TTL_MS = 2 * 60 * 1000;
/** OAuth access tokens are short-lived; refresh tokens reuse TOKEN_TTL_MS. */
export const OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000;

export function nowIso(): string {
  return new Date().toISOString();
}

/** Hash persisted secrets and immutable artifact content without driver-specific encoding choices. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256b64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function scopeIncludes(scope: string, wanted: string): boolean {
  return scope.split(/\s+/).filter(Boolean).includes(wanted);
}

/** The shared immutable-content and title-sync inputs for addVersion. */
export function inspectVersionHtml(html: string): { contentHash: string; title: string | null } {
  return { contentHash: sha256(html), title: extractTitle(html) };
}

/** Legacy rows without a current hash deliberately do not deduplicate. */
export function isIdenticalRepublish(
  currentContentHash: string,
  candidateContentHash: string,
): boolean {
  return currentContentHash.length > 0 && currentContentHash === candidateContentHash;
}

/** A titleless revision preserves the current metadata title. */
export function syncedTitle(currentTitle: string, candidateTitle: string | null): string {
  return candidateTitle ?? currentTitle;
}

/**
 * Redemption consumes a code before calling this helper. Invalid, expired, or PKCE-mismatched codes
 * therefore stay consumed in every driver.
 */
export function isFreshPkceCode(
  createdAt: string,
  ttlMs: number,
  verifier: string,
  codeChallenge: string,
  now = Date.now(),
): boolean {
  const created = Date.parse(createdAt);
  return (
    Number.isFinite(created) &&
    now - created <= ttlMs &&
    sha256b64url(verifier) === codeChallenge
  );
}

/** Missing or malformed expiries fail closed, just like elapsed expiries. */
export function isExpired(expiresAt: string, now = Date.now()): boolean {
  const expires = Date.parse(expiresAt);
  return !Number.isFinite(expires) || now > expires;
}

/** Rows are sorted oldest-first; ties retain the driver's deterministic input order. */
export function tokenHashesOverCap(
  rows: readonly { hash: string; createdAt: string }[],
): string[] {
  if (rows.length <= MAX_TOKENS_PER_USER) return [];
  return [...rows]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, rows.length - MAX_TOKENS_PER_USER)
    .map((row) => row.hash);
}

export function notificationSnippet(body: string): string {
  return body.length > 140 ? `${body.slice(0, 140)}…` : body;
}

/** Strict positive-integer read: corrupt critical fields fail loudly rather than defaulting. */
export function positiveInteger(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(
      `Corrupt entity: ${field} is not a positive integer (got ${String(value)})`,
    );
  }
  return number;
}

export function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** A single corrupt anchor degrades to the same benign pin in either driver. */
export function parseAnchor(value: unknown, fallbackVersion: number): Anchor {
  try {
    const parsed: unknown = JSON.parse(value === undefined || value === null ? "" : String(value));
    if (parsed && typeof parsed === "object") return parsed as Anchor;
  } catch {
    // Fall through to a benign default.
  }
  console.warn("Stela: corrupt comment anchor; using a default pin", { fallbackVersion });
  return { version: fallbackVersion, xNorm: 0, yNorm: 0, scrollYNorm: 0, renderWidth: 1 };
}

export function sortByUpdatedDesc(list: Artifact[]): Artifact[] {
  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
