import { z } from "zod";

/** Who can view an artifact. */
export const Visibility = z.enum(["private", "everyone", "restricted"]);
export type Visibility = z.infer<typeof Visibility>;

/**
 * A short emoji used as the artifact's browser-tab / gallery icon (parity with the built-in
 * artifact favicon). It's rendered into an SVG data: URI and gallery text; output is neutralized by
 * encodeURIComponent + Svelte auto-escaping, and this refine rejects the HTML/SVG-dangerous
 * characters so only safe (emoji-shaped) input is ever stored.
 */
export const Favicon = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .refine((v) => !/[<>&"']/.test(v), "favicon must be a short emoji (no markup characters)");
export type Favicon = z.infer<typeof Favicon>;

/** An artifact = a self-contained HTML doc + metadata. The current version is served at /a/{id}. */
export const Artifact = z.object({
  id: z.string(),
  ownerId: z.string(),
  ownerName: z.string(),
  title: z.string(),
  /** Optional emoji icon for the tab/gallery — set on create, stable across versions. */
  favicon: z.string().max(16).optional(),
  visibility: Visibility,
  /** Emails / user ids allowed to view when visibility === "restricted". */
  allowedPrincipals: z.array(z.string()).default([]),
  currentVersion: z.number().int().positive(),
  createdAt: z.string(), // ISO 8601
  updatedAt: z.string(), // ISO 8601
});
export type Artifact = z.infer<typeof Artifact>;

/** One immutable published version of an artifact's HTML. */
export const Version = z.object({
  artifactId: z.string(),
  version: z.number().int().positive(),
  blobPath: z.string(),
  publishedById: z.string(),
  publishedAt: z.string(), // ISO 8601
  note: z.string().optional(),
});
export type Version = z.infer<typeof Version>;
