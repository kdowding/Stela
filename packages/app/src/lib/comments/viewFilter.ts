import type { Comment } from "@stela/shared";

/** The page the artifact currently shows (from the embed bridge), or null if single-page / undetected. */
export type CurrentView = { key: string; label: string } | null;

/**
 * Split root pins into those shown on the current page vs. those belonging to other pages of a
 * multi-page artifact. With no current view (single-page / nothing detected) everything is on-page —
 * pre-page-aware behavior. A pin with no viewKey (legacy, or placed while no view was detected) is
 * page-global and always on-page, so we never hide a pin we can't place.
 */
export function partitionPins(
  roots: Comment[],
  view: CurrentView,
): { onPage: Comment[]; offPage: Comment[] } {
  const onPage: Comment[] = [];
  const offPage: Comment[] = [];
  for (const c of roots) {
    if (!c.anchor) continue; // general (unpinned) comments aren't pins
    if (!view || !c.anchor.viewKey || c.anchor.viewKey === view.key) onPage.push(c);
    else offPage.push(c);
  }
  return { onPage, offPage };
}

export type OffPageGroup = { key: string; label: string; count: number };

/** Group off-page pins by their page (most-commented first) for the "N on other pages" indicator. */
export function groupOffPage(offPage: Comment[]): OffPageGroup[] {
  const m = new Map<string, OffPageGroup>();
  for (const c of offPage) {
    if (!c.anchor) continue;
    const k = c.anchor.viewKey ?? "";
    const g = m.get(k) ?? { key: k, label: c.anchor.viewLabel || c.anchor.viewKey || "Another page", count: 0 };
    g.count++;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}
