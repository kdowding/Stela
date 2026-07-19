import { z } from "zod";

/**
 * DOM-anchor descriptor: resolves a pin to an element + offset so it survives the
 * artifact scrolling and reflowing, instead of sticking to a viewport coordinate. Resolved INSIDE the
 * iframe by the embed bridge, best-signal-first (selector, then a text quote), and it falls back to the
 * Anchor's xNorm/yNorm whenever it can't resolve — so a dom-anchored pin is never worse than a plain one.
 * Because a Stela version is byte-frozen, these signals resolve identically for every viewer forever.
 */
export const DomAnchor = z.object({
  /** A CSS path to the element (secondary signal). */
  selector: z.string().max(2000).optional(),
  /** A text quote of the element's content (primary signal) — robust to structural change. */
  text: z
    .object({
      exact: z.string().max(400),
      prefix: z.string().max(160).optional(),
      suffix: z.string().max(160).optional(),
    })
    .optional(),
  /** Where in the resolved element's box the pin sits (0..1), so it lands where you clicked. */
  offsetX: z.number().min(0).max(1),
  offsetY: z.number().min(0).max(1),
  /** The element's tag, as a resolution tiebreaker. */
  tag: z.string().max(40).optional(),
});
export type DomAnchor = z.infer<typeof DomAnchor>;

/**
 * Where a comment is pinned. The coordinate fields (xNorm/yNorm + the width the commenter saw) are the
 * always-present fallback; `dom`, when set, anchors the pin to an element so it tracks the content.
 * Anchors are version-scoped — they belong to the artifact version they were made on.
 */
export const Anchor = z.object({
  version: z.number().int().positive(),
  xNorm: z.number().min(0).max(1),
  yNorm: z.number().min(0).max(1),
  scrollYNorm: z.number().min(0).max(1).default(0),
  renderWidth: z.number().positive(),
  // Capped — the whole Anchor is JSON-stringified into one 64 KB Table column; reserved for the DOM-anchor upgrade.
  selector: z.string().max(2000).optional(),
  textSnippet: z.string().max(2000).optional(),
  // Page-scope within a version: which "view" of a multi-page artifact the pin sits on (e.g. a mockup
  // that swaps screens in place). `viewKey` is an opaque match key the embed bridge reports for the
  // active view (best-signal-first: the artifact's own data-stela-view / shared data-attr / id /
  // heading); `viewLabel` is its human name for the comment list. Both absent ⇒ the pin isn't
  // page-scoped (legacy pins, single-page artifacts, or a view the detector couldn't resolve) and it
  // shows on every page — failing safe to pre-page-aware behavior. Distinct from selector/textSnippet
  //, which anchor *within* a page; these select the page itself.
  viewKey: z.string().max(512).optional(),
  viewLabel: z.string().max(200).optional(),
  // The DOM-anchor. When present and resolvable, the bridge streams the pin's live position from
  // the element; when absent or unresolvable, the pin falls back to xNorm/yNorm. Hybrid: never worse.
  dom: DomAnchor.optional(),
});
export type Anchor = z.infer<typeof Anchor>;

export const Comment = z.object({
  id: z.string(),
  artifactId: z.string(),
  version: z.number().int().positive(),
  authorId: z.string(),
  authorName: z.string(),
  body: z.string().min(1),
  // Optional: a comment WITH an anchor is a pin (placed on a spot); WITHOUT one it's a general comment
  // in the artifact's discussion. Both thread and resolve identically — a pin is just an anchored comment.
  anchor: Anchor.optional(),
  resolved: z.boolean().default(false),
  /** Audit trail for the most recent resolve/reopen toggle. */
  resolvedById: z.string().optional(),
  resolvedAt: z.string().optional(),
  /** Set for replies; top-level comments have no parent. */
  parentId: z.string().optional(),
  createdAt: z.string(), // ISO 8601
});
export type Comment = z.infer<typeof Comment>;
