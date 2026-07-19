import type { Artifact, Version } from "./artifact";
import type { Comment } from "./comment";

/** One-line summary of an artifact for the list_artifacts tool. */
export function formatArtifactLine(a: Artifact, baseUrl: string): string {
  const who =
    a.visibility === "restricted" ? ` [${a.allowedPrincipals.join(", ") || "no one yet"}]` : "";
  return `- ${a.title} — ${a.visibility}${who} · v${a.currentVersion} · ${baseUrl}/a/${a.id}`;
}

/** Human-readable metadata + version history for the get_artifact tool. */
export function formatArtifactDetail(
  artifact: Artifact,
  versions: Version[],
  apiUrl: string,
): string {
  const who =
    artifact.visibility === "restricted"
      ? ` [${artifact.allowedPrincipals.join(", ") || "no one yet"}]`
      : "";
  const lines = [
    `${artifact.favicon ? `${artifact.favicon} ` : ""}${artifact.title} — ${artifact.visibility}${who} · v${artifact.currentVersion} · owner ${artifact.ownerName}`,
    `URL: ${apiUrl}/a/${artifact.id}`,
    `id:  ${artifact.id}`,
  ];
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  if (sorted.length > 0) {
    lines.push(`Versions (${sorted.length}):`);
    for (const v of sorted) {
      lines.push(`  v${v.version} · ${v.publishedAt}${v.note ? ` — ${v.note}` : ""}`);
    }
  }
  lines.push("", "Tip: call get_artifact_html to read the HTML source before editing.");
  return lines.join("\n");
}

/** Cap on threads rendered by read_comments so a busy artifact doesn't flood the tool output. */
const MAX_THREADS = 50;

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * Human-readable comment threads for the read_comments tool: top-level pins with their replies, the
 * resolved/open state, author, time, and the pin's normalized position (so the agent can correlate
 * feedback to a region of the artifact it can't see).
 */
export function formatComments(
  comments: Comment[],
  opts: { title: string; version: number; apiUrl: string; id: string },
): string {
  const roots = comments
    .filter((c) => !c.parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const repliesByParent = new Map<string, Comment[]>();
  for (const c of comments) {
    if (!c.parentId) continue;
    const list = repliesByParent.get(c.parentId) ?? [];
    list.push(c);
    repliesByParent.set(c.parentId, list);
  }
  for (const list of repliesByParent.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  const open = roots.filter((c) => !c.resolved).length;
  const resolved = roots.length - open;
  const head = [
    `Comments on "${opts.title}" v${opts.version} — ${open} open, ${resolved} resolved (${roots.length} thread${roots.length === 1 ? "" : "s"})`,
    `URL: ${opts.apiUrl}/a/${opts.id}?v=${opts.version}`,
  ];
  if (roots.length === 0) return `${head[0]}\n${head[1]}\n\n(no comments on this version)`;

  const lines = [...head, ""];
  for (const c of roots.slice(0, MAX_THREADS)) {
    // A pinned comment shows its spot (and page, for multi-page artifacts); a general one is unanchored.
    const where = c.anchor
      ? `pin ~(${pct(c.anchor.xNorm)}, ${pct(c.anchor.yNorm)})${c.anchor.viewLabel ? ` on ${c.anchor.viewLabel}` : ""}`
      : "general";
    lines.push(`[${c.resolved ? "resolved" : "open"}] ${c.authorName} · ${c.createdAt} · ${where}`);
    lines.push(`  ${c.body.replace(/\n/g, "\n  ")}`);
    for (const r of repliesByParent.get(c.id) ?? []) {
      lines.push(`  └ ${r.authorName} · ${r.createdAt}: ${r.body.replace(/\n/g, "\n    ")}`);
    }
    lines.push("");
  }
  if (roots.length > MAX_THREADS) {
    lines.push(`…and ${roots.length - MAX_THREADS} more thread(s) — open the URL to see them all.`);
  }
  return lines.join("\n").trimEnd();
}
