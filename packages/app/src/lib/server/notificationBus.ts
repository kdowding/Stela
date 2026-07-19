/**
 * In-process pub/sub for "a new comment-notification arrived for user X", keyed by recipient user id. The
 * comment POST handler emits; the per-user SSE endpoint (routes/api/notifications/events) subscribes
 * and pushes a nudge so the portal bell updates live.
 *
 * Deliberately a SEPARATE bus from revisionBus (rather than generalizing it) so the proven, tested
 * version-push path stays untouched. Same single-instance caveat: in-memory, so it only reaches
 * subscribers on this Node process — fine for the single B1 instance (see revisionBus for the
 * multi-instance backplane note). The payload is just a signal; the client refetches /api/notifications.
 */
type Listener = () => void;

const channels = new Map<string, Set<Listener>>();

/** Nudge every open inbox stream for these recipients that something changed. */
export function emitNotification(recipientIds: string[]): void {
  for (const userId of new Set(recipientIds)) {
    const listeners = channels.get(userId);
    if (!listeners) continue;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* a dead stream shouldn't break the others */
      }
    }
  }
}

/** Subscribe to notification nudges for one recipient. Returns an unsubscribe that reaps empty channels. */
export function subscribeNotifications(userId: string, listener: Listener): () => void {
  let set = channels.get(userId);
  if (!set) {
    set = new Set();
    channels.set(userId, set);
  }
  set.add(listener);
  return () => {
    const current = channels.get(userId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) channels.delete(userId);
  };
}
