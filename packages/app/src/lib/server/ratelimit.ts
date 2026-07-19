import { error, type RequestEvent } from "@sveltejs/kit";

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();

/**
 * Best-effort in-memory fixed-window rate limiter. Adequate for the single-instance B1
 * plan; a multi-instance deployment would move this to a shared store / edge WAF. Throws 429 when
 * the caller exceeds `limit` within `windowMs`.
 */
export function rateLimit(name: string, id: string, limit: number, windowMs: number): void {
  const key = `${name}:${id}`;
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + windowMs };
    windows.set(key, w);
  }
  if (++w.count > limit) {
    throw error(429, `Too many requests. Try again in ${Math.ceil((w.resetAt - now) / 1000)}s.`);
  }
  // Bound memory: opportunistically drop expired windows.
  if (windows.size > 10_000) {
    for (const [k, v] of windows) if (now >= v.resetAt) windows.delete(k);
  }
}

/**
 * Client IP for IP-keyed limits. Behind a trusted reverse proxy the real client is the LAST
 * X-Forwarded-For hop (the proxy appends it; see the implementation note below). Falls back to the socket address.
 * Best-effort (XFF is client-influenced) — reserve IP keying for endpoints with no authenticated
 * principal yet (the pairing-code exchange); prefer user-id keying everywhere else.
 * NOTE: take the LAST hop, never the first — the leftmost hops are client-supplied and spoofable, so
 * "fixing" this to read the first hop would reopen the rate-limit-bypass it deliberately avoids.
 */
export function clientIp(event: RequestEvent): string {
  // A trusted reverse proxy appends the real client IP as the LAST X-Forwarded-For hop; leftmost hops are
  // client-supplied and spoofable, so take the last non-empty hop (cicd-config-1). Falls back to the
  // socket address.
  const xff = event.request.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1]!;
  }
  try {
    return event.getClientAddress();
  } catch {
    return "unknown";
  }
}
