import type { RequestHandler } from "./$types";
import { requireUser } from "$lib/server/guards";
import { rateLimit } from "$lib/server/ratelimit";
import { subscribeNotifications } from "$lib/server/notificationBus";

export const GET: RequestHandler = async (event) => {
  const user = await requireUser(event);
  // Admission control: a per-user-id connection-rate limit only. It's a self-expiring time window, so it
  // can't get "stuck". We deliberately do NOT also cap concurrent streams — that counter decremented
  // only on abort/cancel, which fire LATE behind a reverse proxy on reload, so it leaked slots and
  // 429'd legitimate clients into an EventSource reconnect loop.
  rateLimit("notif-events", user.id, 60, 60_000);

  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        // Backpressure: drop the nudge if the client isn't draining. Safe — the bell re-fetches the
        // authoritative list on connect/visibilitychange, and EventSource auto-reconnects.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* controller already closed (client gone) */
        }
      };

      send(": connected\n\n"); // open the stream; the client fetches the list on connect
      unsubscribe = subscribeNotifications(user.id, () => send("event: notify\ndata: 1\n\n"));
      heartbeat = setInterval(() => send(": ping\n\n"), 30_000);
      // Cap total connection lifetime so an idle-open tab can't pin resources indefinitely; the client
      // transparently reconnects.
      lifetime = setTimeout(() => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }, 3_600_000);

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
      "x-accel-buffering": "no",
    },
  });
};
