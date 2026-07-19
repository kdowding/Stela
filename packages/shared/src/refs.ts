const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Resolve a user-supplied artifact reference to its id. Accepts a bare id or a full Stela URL
 * (…/a/{id} with any query/hash). Returns null when no valid id can be extracted. Implemented with a
 * regex (not the `URL` global) so this stays usable in the dependency-light, DOM/Node-lib-free shared
 * package.
 */
export function parseArtifactRef(input: string): string | null {
  const s = input.trim();
  if (UUID_RE.test(s)) return s;
  if (!/^https?:\/\//i.test(s)) return null;
  const candidate = s.match(/\/a\/([^/?#]+)/)?.[1];
  return candidate && UUID_RE.test(candidate) ? candidate : null;
}
