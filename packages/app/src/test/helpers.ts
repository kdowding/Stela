import type { ServerLoadEvent } from "@sveltejs/kit";
import type { SessionUser } from "$lib/server/auth";

/**
 * Build a minimal RequestEvent for unit-testing route handlers without a running server. Only the
 * fields the handlers actually use are populated; the rest are stubbed. Handlers that succeed return
 * a Response; handlers that reject throw a SvelteKit HttpError ({ status, body }) — assert with
 * `await expect(handler(event)).rejects.toMatchObject({ status })`.
 */
export function makeEvent(opts: {
  method?: string;
  path?: string;
  query?: Record<string, string>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  locals?: { user: SessionUser | null };
  clientIp?: string;
  // Returned as ServerLoadEvent<any,any,any> — a superset of RequestEvent — so one helper can be
  // passed to any route's route-specific RequestHandler AND to +page/+layout load functions.
} = {}): ServerLoadEvent<any, any, any> {
  const origin = "http://localhost:5173";
  const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
  const url = new URL((opts.path ?? "/") + qs, origin);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    if (!headers["content-type"]) headers["content-type"] = "application/json";
  }
  const request = new Request(url, init);
  return {
    request,
    url,
    params: opts.params ?? {},
    locals: opts.locals ?? { user: null },
    getClientAddress: () => opts.clientIp ?? "127.0.0.1",
    cookies: {} as never,
    fetch: globalThis.fetch,
    platform: undefined,
    route: { id: null },
    setHeaders: () => {},
    isDataRequest: false,
    isSubRequest: false,
    // load-event extras (so this also satisfies +page/+layout ServerLoadEvent)
    parent: async () => ({}),
    depends: () => {},
    untrack: <T>(fn: () => T) => fn(),
  } as unknown as ServerLoadEvent<any, any, any>;
}

/** A signed-in user for locals.user in handler tests. */
export const testUser = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test User",
  email: "test@example.com",
  ...over,
});
