import { describe, it, expect } from "vitest";
import type { Artifact, Comment, Version } from "@stela/shared";
import { formatArtifactDetail, formatComments } from "@stela/shared";

const ID = "3f8a1c2d-1111-4abc-8def-0123456789ab";
const base: Artifact = {
  id: ID,
  ownerId: "o",
  ownerName: "Dev User",
  title: "Quarterly Numbers",
  visibility: "everyone",
  allowedPrincipals: [],
  currentVersion: 2,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
};
const versions: Version[] = [
  { artifactId: ID, version: 1, blobPath: "x", publishedById: "o", publishedAt: "2026-06-20T00:00:00.000Z" },
  { artifactId: ID, version: 2, blobPath: "x", publishedById: "o", publishedAt: "2026-06-20T01:00:00.000Z", note: "tweaks" },
];

describe("formatArtifactDetail", () => {
  it("includes title, visibility, current version, owner, URL and id", () => {
    const out = formatArtifactDetail(base, versions, "https://host");
    expect(out).toContain("Quarterly Numbers — everyone · v2 · owner Dev User");
    expect(out).toContain(`URL: https://host/a/${ID}`);
    expect(out).toContain(`id:  ${ID}`);
  });

  it("lists versions newest-first with notes", () => {
    const out = formatArtifactDetail(base, versions, "https://host");
    expect(out).toContain("v2 · 2026-06-20T01:00:00.000Z — tweaks");
    expect(out.indexOf("v1 ·")).toBeGreaterThan(out.indexOf("v2 ·")); // v2 printed before v1
  });

  it("shows restricted principals", () => {
    const out = formatArtifactDetail(
      { ...base, visibility: "restricted", allowedPrincipals: ["a@x.com"] },
      [],
      "https://host",
    );
    expect(out).toContain("restricted [a@x.com]");
  });

  it("omits the Versions section when none are returned", () => {
    expect(formatArtifactDetail(base, [], "https://host")).not.toContain("Versions");
  });

  it("prefixes the favicon emoji when the artifact has one", () => {
    const out = formatArtifactDetail({ ...base, favicon: "📊" }, [], "https://host");
    expect(out.startsWith("📊 Quarterly Numbers —")).toBe(true);
  });
});

const comment = (over: Partial<Comment>): Comment => ({
  id: "c1",
  artifactId: ID,
  version: 2,
  authorId: "o",
  authorName: "Alice",
  body: "looks off",
  anchor: { version: 2, xNorm: 0.5, yNorm: 0.33, scrollYNorm: 0, renderWidth: 800 },
  resolved: false,
  createdAt: "2026-06-20T14:30:00.000Z",
  ...over,
});

describe("formatComments", () => {
  const opts = { title: "Quarterly Numbers", version: 2, apiUrl: "https://host", id: ID };

  it("summarizes open/resolved counts and links the versioned URL", () => {
    const out = formatComments(
      [comment({ id: "a", resolved: false }), comment({ id: "b", resolved: true })],
      opts,
    );
    expect(out).toContain('Comments on "Quarterly Numbers" v2 — 1 open, 1 resolved (2 threads)');
    expect(out).toContain(`URL: https://host/a/${ID}?v=2`);
  });

  it("renders pin position, state, and nests replies under their parent", () => {
    const out = formatComments(
      [
        comment({ id: "root", body: "this chart misleads", authorName: "Alice" }),
        comment({ id: "r1", parentId: "root", authorName: "Bob", body: "fixing", createdAt: "2026-06-20T14:45:00.000Z" }),
      ],
      opts,
    );
    expect(out).toContain("[open] Alice · 2026-06-20T14:30:00.000Z · pin ~(50%, 33%)");
    expect(out).toContain("  this chart misleads");
    expect(out).toContain("  └ Bob · 2026-06-20T14:45:00.000Z: fixing");
  });

  it("reports an empty version cleanly", () => {
    expect(formatComments([], opts)).toContain("(no comments on this version)");
  });
});
