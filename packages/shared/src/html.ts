const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the handful of entities that realistically appear in a <title>; leave unknown ones intact. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const cp =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      const valid = Number.isFinite(cp) && cp >= 1 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      if (!valid) return match;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Best-effort <title> extraction. Publishing follows the artifact convention — the title
 * comes from the HTML itself, not a separate argument. Returns null when there's no non-empty <title>.
 */
export function extractTitle(html: string): string | null {
  const m = TITLE_RE.exec(html);
  if (!m) return null;
  const text = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  // Cap at the shared chokepoint so the connector's `title ?? extractTitle(html)` path can't persist an
  // oversized title past the 300-char contract (the explicit title arg and the CLI already cap at 300).
  return text.length > 0 ? text.slice(0, 300) : null;
}
