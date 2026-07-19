import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root for Stela CLI state — the per-user token (`credentials.json`) and the path→artifact map
 * (`artifacts.json`). Honors STELA_HOME so the location can be relocated (and so tests can point
 * at a throwaway directory); defaults to ~/.stela.
 */
export function stelaDir(): string {
  const override = process.env.STELA_HOME?.trim();
  return override ? override : join(homedir(), ".stela");
}

export function credPath(): string {
  return join(stelaDir(), "credentials.json");
}

/** Local map of "which artifact does this file publish to" — the key to seamless re-versioning. */
export function artifactMapPath(): string {
  return join(stelaDir(), "artifacts.json");
}
