/**
 * In-process pub/sub for "a new version of artifact X was published". The publish handler emits;
 * the SSE endpoint (routes/api/artifacts/[id]/events) subscribes and pushes to open viewers, so a
 * revision shows up live without polling.
 *
 * This is deliberately in-memory and therefore SINGLE-INSTANCE only — it works because Stela runs
 * as one Node process (publish and the SSE streams share it). If the app is ever scaled out to
 * multiple instances, a publish on one instance won't reach subscribers on another; at that point
 * move this onto a backplane (Redis pub-sub or similar) — the same roadmap step as real-time
 * comments. Until then it carries a small-team load for free.
 */
type Listener = (version: number) => void;

const channels = new Map<string, Set<Listener>>();

/** Tell every open viewer of `artifactId` that `version` is now the current version. */
export function emitVersion(artifactId: string, version: number): void {
  const listeners = channels.get(artifactId);
  if (!listeners) return;
  // Copy first so a listener unsubscribing during dispatch can't mutate the set mid-iteration.
  for (const listener of [...listeners]) {
    try {
      listener(version);
    } catch {
      /* a dead stream shouldn't break the others */
    }
  }
}

/** Subscribe to version bumps for one artifact. Returns an unsubscribe that also reaps empty channels. */
export function subscribeVersion(artifactId: string, listener: Listener): () => void {
  let set = channels.get(artifactId);
  if (!set) {
    set = new Set();
    channels.set(artifactId, set);
  }
  set.add(listener);
  return () => {
    const current = channels.get(artifactId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) channels.delete(artifactId);
  };
}
