import { describe, it, expect } from "vitest";
import { parseArtifactRef } from "@stela/shared";
import { resolveTarget } from "./refs";

const ID = "3f8a1c2d-1111-4abc-8def-0123456789ab";

describe("parseArtifactRef", () => {
  it("accepts a bare uuid (trimmed)", () => {
    expect(parseArtifactRef(ID)).toBe(ID);
    expect(parseArtifactRef(`  ${ID}  `)).toBe(ID);
  });

  it("extracts the id from a full viewer URL, ignoring query/hash", () => {
    expect(parseArtifactRef(`https://stela.example.com/a/${ID}`)).toBe(ID);
    expect(parseArtifactRef(`https://host/a/${ID}?v=2#pin`)).toBe(ID);
  });

  it("rejects non-artifact URLs and junk", () => {
    expect(parseArtifactRef("https://host/other/path")).toBeNull();
    expect(parseArtifactRef("not a url")).toBeNull();
    expect(parseArtifactRef("https://host/a/not-a-uuid")).toBeNull();
    expect(parseArtifactRef("")).toBeNull();
  });
});

describe("resolveTarget", () => {
  it("creates when nothing is known", () => {
    expect(resolveTarget({})).toEqual({ kind: "create" });
  });

  it("versions a remembered mapping", () => {
    expect(resolveTarget({ mappedId: ID })).toEqual({ kind: "version", artifactId: ID, source: "map" });
  });

  it("lets an explicit url override the remembered mapping", () => {
    expect(resolveTarget({ url: `https://h/a/${ID}`, mappedId: "stale-id" })).toEqual({
      kind: "version",
      artifactId: ID,
      source: "url",
    });
  });

  it("lets newArtifact force a create over both url and mapping", () => {
    expect(resolveTarget({ newArtifact: true, url: `https://h/a/${ID}`, mappedId: ID })).toEqual({
      kind: "create",
    });
  });

  it("errors on an unparseable url", () => {
    expect(resolveTarget({ url: "garbage" }).kind).toBe("error");
  });

  it("treats a blank url as absent", () => {
    expect(resolveTarget({ url: "   ", mappedId: ID })).toEqual({
      kind: "version",
      artifactId: ID,
      source: "map",
    });
  });
});
