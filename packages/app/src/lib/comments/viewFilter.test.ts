import { describe, it, expect } from "vitest";
import { partitionPins, groupOffPage } from "./viewFilter";
import type { Comment } from "@stela/shared";

function pin(id: string, viewKey?: string, viewLabel?: string): Comment {
  return {
    id,
    artifactId: "a1",
    version: 1,
    authorId: "o",
    authorName: "A",
    body: "b",
    resolved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    anchor: { version: 1, xNorm: 0.5, yNorm: 0.5, scrollYNorm: 0, renderWidth: 1000, viewKey, viewLabel },
  };
}

describe("partitionPins", () => {
  it("returns everything on-page when there is no current view (single-page / undetected)", () => {
    const roots = [pin("1", "a"), pin("2"), pin("3", "b")];
    const { onPage, offPage } = partitionPins(roots, null);
    expect(onPage.map((c) => c.id)).toEqual(["1", "2", "3"]);
    expect(offPage).toEqual([]);
  });

  it("keeps pins on the matching page and pushes the rest off-page", () => {
    const roots = [pin("1", "admin-run"), pin("2", "partner-statements"), pin("3", "admin-run")];
    const { onPage, offPage } = partitionPins(roots, { key: "admin-run", label: "Run" });
    expect(onPage.map((c) => c.id)).toEqual(["1", "3"]);
    expect(offPage.map((c) => c.id)).toEqual(["2"]);
  });

  it("treats a viewKey-less pin as page-global (always on-page)", () => {
    const roots = [pin("legacy"), pin("scoped", "other")];
    const { onPage, offPage } = partitionPins(roots, { key: "current", label: "" });
    expect(onPage.map((c) => c.id)).toEqual(["legacy"]);
    expect(offPage.map((c) => c.id)).toEqual(["scoped"]);
  });

  it("excludes general (unpinned) comments from both buckets", () => {
    const general = { ...pin("g"), anchor: undefined } as Comment;
    const { onPage, offPage } = partitionPins([general, pin("p", "x")], { key: "x", label: "X" });
    expect(onPage.map((c) => c.id)).toEqual(["p"]);
    expect(offPage).toEqual([]);
  });
});

describe("groupOffPage", () => {
  it("groups by page and sorts most-commented first", () => {
    const offPage = [pin("1", "a", "Alpha"), pin("2", "b", "Bravo"), pin("3", "a", "Alpha"), pin("4", "a", "Alpha")];
    expect(groupOffPage(offPage)).toEqual([
      { key: "a", label: "Alpha", count: 3 },
      { key: "b", label: "Bravo", count: 1 },
    ]);
  });

  it("falls back to the key, then a generic label, when no viewLabel is stored", () => {
    expect(groupOffPage([pin("1", "lonely-key")])[0]).toEqual({ key: "lonely-key", label: "lonely-key", count: 1 });
  });
});
