import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { stelaDir, artifactMapPath } from "./paths";

export type ArtifactRef = { artifactId: string; url: string };

/** apiUrl → normalized file path → the artifact that path last published to. */
type ArtifactMapFile = Record<string, Record<string, ArtifactRef>>;

/**
 * Serialize all read-modify-write mutations of artifacts.json through one in-process chain so two
 * concurrent publishes (the Claude Code harness fires tool calls in parallel) can't interleave a
 * read→mutate→write and lose one file's mapping. The map is the entire mechanism behind seamless
 * auto-versioning, so a lost entry silently forks a new artifact instead of versioning the old one.
 */
let chain: Promise<unknown> = Promise.resolve();
function withMapLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * Stable key for a local file so re-publishing the same file targets the same artifact. Windows
 * paths are case-insensitive and slash-agnostic, so fold case + separators there; POSIX paths are
 * case-sensitive and kept verbatim. Expects an already-absolute path.
 */
export function normalizePathKey(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return absPath.replace(/\//g, "\\").toLowerCase();
  return absPath;
}

/**
 * Read the map. A MISSING/unreadable file starts fresh ({}). A PRESENT-but-unparseable file is the
 * dangerous case on the write path: silently treating it as {} would let the next write erase every
 * other mapping. When `backupOnCorrupt`, move the bad file aside (.corrupt) before returning {} so a
 * single torn write can't cascade into total loss. Read-only callers don't need the backup.
 */
async function readMap(backupOnCorrupt = false): Promise<ArtifactMapFile> {
  let raw: string;
  try {
    raw = await readFile(artifactMapPath(), "utf8");
  } catch {
    return {}; // missing / unreadable — start fresh
  }
  try {
    return JSON.parse(raw) as ArtifactMapFile;
  } catch {
    if (backupOnCorrupt) {
      await rename(artifactMapPath(), `${artifactMapPath()}.corrupt`).catch(() => {});
    }
    return {};
  }
}

/** Atomic write: a process death mid-write can't leave a truncated/corrupt artifacts.json. */
async function writeMap(map: ArtifactMapFile): Promise<void> {
  await mkdir(stelaDir(), { recursive: true, mode: 0o700 });
  const tmp = `${artifactMapPath()}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
  await rename(tmp, artifactMapPath()); // atomic on the same volume
}

/** The artifact this file last published to under `apiUrl`, or null if it's never been published. */
export async function lookupArtifact(apiUrl: string, pathKey: string): Promise<ArtifactRef | null> {
  return (await readMap())[apiUrl]?.[pathKey] ?? null;
}

/** Remember (or refresh) which artifact a file publishes to, so the next publish versions it. */
export async function recordArtifact(
  apiUrl: string,
  pathKey: string,
  ref: ArtifactRef,
): Promise<void> {
  await withMapLock(async () => {
    const map = await readMap(true);
    (map[apiUrl] ??= {})[pathKey] = ref;
    await writeMap(map);
  });
}

/** Drop every file mapping that points at a deleted artifact id, so a re-publish starts fresh. */
export async function forgetArtifactById(apiUrl: string, artifactId: string): Promise<void> {
  await withMapLock(async () => {
    const map = await readMap(true);
    const env = map[apiUrl];
    if (!env) return;
    let changed = false;
    for (const key of Object.keys(env)) {
      if (env[key].artifactId === artifactId) {
        delete env[key];
        changed = true;
      }
    }
    if (changed) await writeMap(map);
  });
}
