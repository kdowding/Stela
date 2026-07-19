import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetArtifactById, lookupArtifact, normalizePathKey, recordArtifact } from "./artifact-map";

describe("normalizePathKey", () => {
  it("folds case and separators on windows", () => {
    expect(normalizePathKey("C:/Users/Kyle/Art.html", "win32")).toBe("c:\\users\\kyle\\art.html");
    expect(normalizePathKey("C:\\Users\\KYLE\\art.HTML", "win32")).toBe("c:\\users\\kyle\\art.html");
  });

  it("keeps posix paths verbatim (case-sensitive)", () => {
    expect(normalizePathKey("/home/kyle/Art.html", "linux")).toBe("/home/kyle/Art.html");
  });
});

describe("artifact map persistence", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "stela-test-"));
    process.env.STELA_HOME = home;
  });

  afterEach(async () => {
    delete process.env.STELA_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("returns null before anything is recorded", async () => {
    expect(await lookupArtifact("https://api", "k")).toBeNull();
  });

  it("round-trips a recorded mapping, scoped per environment", async () => {
    await recordArtifact("https://api", "k", { artifactId: "id1", url: "https://api/a/id1" });
    expect(await lookupArtifact("https://api", "k")).toEqual({
      artifactId: "id1",
      url: "https://api/a/id1",
    });
    // A different API_URL is an independent namespace.
    expect(await lookupArtifact("http://localhost:5173", "k")).toBeNull();
  });

  it("overwrites the mapping on re-record (fork / rebind / refresh)", async () => {
    await recordArtifact("https://api", "k", { artifactId: "id1", url: "u1" });
    await recordArtifact("https://api", "k", { artifactId: "id2", url: "u2" });
    expect(await lookupArtifact("https://api", "k")).toEqual({ artifactId: "id2", url: "u2" });
  });

  it("persists as JSON keyed by api url then path", async () => {
    await recordArtifact("https://api", "k", { artifactId: "id1", url: "u1" });
    const raw = await readFile(join(home, "artifacts.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ "https://api": { k: { artifactId: "id1", url: "u1" } } });
  });

  it("forgetArtifactById drops every file mapping to that id, leaving others", async () => {
    await recordArtifact("https://api", "fileA", { artifactId: "id1", url: "u1" });
    await recordArtifact("https://api", "fileB", { artifactId: "id1", url: "u1b" }); // same artifact, 2 files
    await recordArtifact("https://api", "fileC", { artifactId: "id2", url: "u2" });

    await forgetArtifactById("https://api", "id1");

    expect(await lookupArtifact("https://api", "fileA")).toBeNull();
    expect(await lookupArtifact("https://api", "fileB")).toBeNull();
    expect(await lookupArtifact("https://api", "fileC")).toEqual({ artifactId: "id2", url: "u2" });
  });

  it("forgetArtifactById is a no-op when nothing matches", async () => {
    await recordArtifact("https://api", "fileC", { artifactId: "id2", url: "u2" });
    await forgetArtifactById("https://api", "missing");
    expect(await lookupArtifact("https://api", "fileC")).toEqual({ artifactId: "id2", url: "u2" });
  });

  it("concurrent records of different files don't clobber each other (mutex)", async () => {
    // Fire many interleaved read-modify-write mutations at once; without serialization a later write
    // built on a stale read would drop earlier files' mappings.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        recordArtifact("https://api", `file${i}`, { artifactId: `id${i}`, url: `u${i}` }),
      ),
    );
    for (let i = 0; i < 25; i++) {
      expect(await lookupArtifact("https://api", `file${i}`)).toEqual({
        artifactId: `id${i}`,
        url: `u${i}`,
      });
    }
  });

  it("recovers from a corrupt map file instead of erasing every mapping", async () => {
    await recordArtifact("https://api", "fileA", { artifactId: "id1", url: "u1" });
    // Simulate a torn/garbage write, then record again — the bad file is set aside, not silently {}.
    await writeFile(join(home, "artifacts.json"), "{ this is not json", "utf8");
    await recordArtifact("https://api", "fileB", { artifactId: "id2", url: "u2" });
    expect(await lookupArtifact("https://api", "fileB")).toEqual({ artifactId: "id2", url: "u2" });
  });
});
