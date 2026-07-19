import { parseArtifactRef } from "@stela/shared";

export type PublishTarget =
  | { kind: "create" }
  | { kind: "version"; artifactId: string; source: "url" | "map" }
  | { kind: "error"; message: string };

/**
 * Decide whether a publish creates a new artifact or versions an existing one.
 * Precedence: explicit fork (newArtifact) > explicit url/id > remembered path mapping > create new.
 */
export function resolveTarget(opts: {
  newArtifact?: boolean;
  url?: string | undefined;
  mappedId?: string | null;
}): PublishTarget {
  if (opts.newArtifact) return { kind: "create" };
  if (opts.url !== undefined && opts.url.trim() !== "") {
    const id = parseArtifactRef(opts.url);
    if (!id) return { kind: "error", message: `'${opts.url}' is not a Stela artifact URL or id.` };
    return { kind: "version", artifactId: id, source: "url" };
  }
  if (opts.mappedId) return { kind: "version", artifactId: opts.mappedId, source: "map" };
  return { kind: "create" };
}
