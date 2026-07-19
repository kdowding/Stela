import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEvent } from "./test/helpers";

const resolve = vi.fn(async () => new Response("resolved-by-route", { status: 200 }));

type AuthSurface = "easyauth" | "generic-login" | "generic-no-login";

async function loadHandle(auth: AuthSurface = "easyauth") {
  vi.resetModules();
  vi.doMock("$app/environment", () => ({ dev: false, building: false, browser: false, version: "test" }));
  vi.doMock("$lib/server/storage", () => ({ getStore: () => ({ warmUp: () => Promise.resolve() }) }));
  vi.stubEnv("ORIGIN", "https://stela.example");
  vi.stubEnv("STORAGE_DRIVER", "azure");
  vi.stubEnv("AZURE_STORAGE_ACCOUNT", "teststorage");
  vi.stubEnv("STELA_API_KEY", "a".repeat(32));
  vi.stubEnv("BODY_SIZE_LIMIT", "12000000");
  vi.stubEnv("AUTH_MODE", "header");
  vi.stubEnv("AUTH_PRESET", auth === "easyauth" ? "easyauth" : "");
  vi.stubEnv("AUTH_HEADER_ID", auth === "easyauth" ? "" : "x-user-id");
  vi.stubEnv("AUTH_HEADER_NAME", "");
  vi.stubEnv("AUTH_HEADER_EMAIL", "");
  vi.stubEnv("AUTH_LOGIN_URL", auth === "generic-login" ? "https://login.example/start?fixed=1" : "");
  const mod = await import("./hooks.server");
  return mod.handle;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("$app/environment");
  vi.doUnmock("$lib/server/storage");
  vi.resetModules();
  vi.clearAllMocks();
  errorSpy.mockRestore();
});

const run = async (
  event: ReturnType<typeof makeEvent>,
  auth: AuthSurface = "easyauth",
) => (await loadHandle(auth))({ event, resolve } as never);

describe("handle — anonymous navigation auth surface (dev=false)", () => {
  it("Easy Auth preset 302s an anonymous HTML GET to the AAD login endpoint", async () => {
    const res = await run(makeEvent({ method: "GET", path: "/", headers: { accept: "text/html" } }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/.auth/login/aad?post_login_redirect_uri=");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("generic mode redirects to AUTH_LOGIN_URL verbatim", async () => {
    const res = await run(
      makeEvent({ method: "GET", path: "/somewhere", query: { q: "discarded" }, headers: { accept: "text/html" } }),
      "generic-login",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://login.example/start?fixed=1");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("generic mode without AUTH_LOGIN_URL returns 401 instead of redirecting or rendering a portal page", async () => {
    const res = await run(
      makeEvent({ method: "GET", path: "/", headers: { accept: "text/html" } }),
      "generic-no-login",
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe("Unauthorized");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not bounce when an Authorization header is present", async () => {
    const res = await run(
      makeEvent({ method: "GET", path: "/", headers: { accept: "text/html", authorization: "Bearer x" } }),
    );
    expect(resolve).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("does not bounce a non-HTML request", async () => {
    await run(makeEvent({ method: "GET", path: "/", headers: { accept: "application/json" } }));
    expect(resolve).toHaveBeenCalled();
  });

  it("does not bounce /api/*, /healthz, or /mcp", async () => {
    for (const path of ["/api/artifacts", "/healthz", "/mcp"]) {
      resolve.mockClear();
      await run(makeEvent({ method: "GET", path, headers: { accept: "text/html" } }));
      expect(resolve, `expected ${path} to fall through`).toHaveBeenCalled();
    }
  });

  it("treats /.auth as exempt only for the Easy Auth preset", async () => {
    const easy = await run(
      makeEvent({ method: "GET", path: "/.auth/me", headers: { accept: "text/html" } }),
    );
    expect(easy.status).toBe(200);
    expect(resolve).toHaveBeenCalled();

    resolve.mockClear();
    const generic = await run(
      makeEvent({ method: "GET", path: "/.auth/me", headers: { accept: "text/html" } }),
      "generic-login",
    );
    expect(generic.status).toBe(302);
    expect(generic.headers.get("location")).toBe("https://login.example/start?fixed=1");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("Easy Auth preset packs /cli/authorize params into a base64url r param", async () => {
    const res = await run(
      makeEvent({
        method: "GET",
        path: "/cli/authorize",
        query: { port: "5500", state: "abc", code_challenge: "xyz" },
        headers: { accept: "text/html" },
      }),
    );
    expect(res.status).toBe(302);
    const returnTo = decodeURIComponent(
      res.headers.get("location")!.split("post_login_redirect_uri=")[1]!,
    );
    expect(returnTo.startsWith("/cli/authorize?r=")).toBe(true);
    const r = new URLSearchParams(returnTo.split("?")[1]).get("r")!;
    const unpacked = new URLSearchParams(Buffer.from(r, "base64url").toString("utf8"));
    expect(unpacked.get("port")).toBe("5500");
    expect(unpacked.get("state")).toBe("abc");
    expect(unpacked.get("code_challenge")).toBe("xyz");
  });

  it("serves OAuth protected-resource discovery before anonymous navigation handling", async () => {
    const res = await run(
      makeEvent({
        method: "GET",
        path: "/.well-known/oauth-protected-resource",
        headers: { accept: "text/html" },
      }),
      "generic-no-login",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(resolve).not.toHaveBeenCalled();
  });
});
