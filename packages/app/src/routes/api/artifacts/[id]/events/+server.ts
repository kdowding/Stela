import type { RequestHandler } from "./$types";
import { loadViewableArtifact } from "$lib/server/guards";
import { rateLimit } from "$lib/server/ratelimit";
import { subscribeVersion } from "$lib/server/revisionBus";

/**
 * Server-Sent Events stream of version bumps for one artifact, so an open viewer updates live when a
 * new revision is published. Viewer-gated (same authz as reading the artifact); 404 if not allowed.
 *
 * The sandboxed artifact iframe has no network egress, so the PORTAL page holds this stream. Pushes
 * come from the in-process revisionBus (the publish handler emits) — no polling, ~0 cost at our scale.
 * A 30s heartbeat keeps it alive through proxy idle-connection cuts (e.g. ~230s on some hosts).
 */
export const GET: RequestHandler = async (event) => {
  const { user, artifact } = await loadViewableArtifact(event);

  // Admission control: a per-user-id connection-rate limit only (self-expiring time window, can't get
  // "stuck"). No concurrent-stream cap — that counter only decremented on abort/cancel, which fire
  // LATE behind a reverse proxy on reload, so it leaked slots and 429'd legit clients.
  rateLimit("events", user.id, 60, 60_000);

  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        // Backpressure: drop the nudge if the client isn't draining (a half-open connection must not
        // accumulate unbounded chunks). Safe — the client re-syncs authoritative state on reconnect.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* controller already closed (client gone) */
        }
      };

      // Initial sync: a freshly-(re)connected client learns the current version immediately. It equals
      // what they're already showing on first connect, so the client treats it as a no-op.
      send(`event: version\ndata: ${artifact.currentVersion}\n\n`);

      unsubscribe = subscribeVersion(artifact.id, (v) => send(`event: version\ndata: ${v}\n\n`));
      heartbeat = setInterval(() => send(": ping\n\n"), 30_000);
      // Cap total connection lifetime so an idle-open tab can't pin a socket + timer + bus listener
      // indefinitely; EventSource transparently reconnects + reconciles on focus.
      lifetime = setTimeout(() => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }, 3_600_000);

      // Tear down when the client disconnects so listeners/timers don't leak.
      event.request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      // Hint to disable proxy buffering so events flush immediately through proxy front ends.
      "x-accel-buffering": "no",
    },
  });
};
