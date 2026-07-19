import { afterEach, describe, expect, it, vi } from "vitest";

// Production-mode auth: with dev=false the dev shim and dev fallbacks must not apply. Reset and
// remock the environment per test, then dynamically import the auth module.
async function loadAuth(dev = false) {
  vi.resetModules();
  vi.doMock("$app/environment", () => ({ dev, building: false, browser: false, version: "test" }));
  return import("./index");
}

const req = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/", { headers });

function configureGenericHeaders() {
  vi.stubEnv("AUTH_MODE", "header");
  vi.stubEnv("AUTH_PRESET", "");
  vi.stubEnv("AUTH_HEADER_ID", "x-user-id");
  vi.stubEnv("AUTH_HEADER_NAME", "x-user-name");
  vi.stubEnv("AUTH_HEADER_EMAIL", "x-user-email");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("$app/environment");
  vi.resetModules();
});

describe("auth in production — API credentials", () => {
  it("does not accept the well-known dev key when STELA_API_KEY is unset", async () => {
    vi.stubEnv("STELA_API_KEY", "");
    const { authenticateApiKey } = await loadAuth();
    expect(await authenticateApiKey(req({ "x-api-key": "dev-publish-key" }))).toBeNull();
  });

  it("does not attribute a matching key to DEV_USER when STELA_API_USER_ID is unset", async () => {
    const key = "a-real-long-admin-key-value-1234567890";
    vi.stubEnv("STELA_API_KEY", key);
    vi.stubEnv("STELA_API_USER_ID", "");
    const { authenticateApiKey } = await loadAuth();
    expect(await authenticateApiKey(req({ "x-api-key": key }))).toBeNull();
  });

  it("resolves the admin key to the configured identity", async () => {
    const key = "a-real-long-admin-key-value-1234567890";
    vi.stubEnv("STELA_API_KEY", key);
    vi.stubEnv("STELA_API_USER_ID", "11111111-1111-4111-8111-111111111111");
    vi.stubEnv("STELA_API_USER_NAME", "Admin");
    vi.stubEnv("STELA_API_USER_EMAIL", "admin@example.com");
    const { authenticateApiKey } = await loadAuth();
    expect(await authenticateApiKey(req({ "x-api-key": key }))).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Admin",
      email: "admin@example.com",
    });
  });
});

describe("auth in production — generic trusted headers", () => {
  it("resolves an id-only request with name/email fallbacks", async () => {
    configureGenericHeaders();
    const { getCurrentUser } = await loadAuth();
    expect(getCurrentUser(req({ "x-user-id": "  stable-subject  " }))).toEqual({
      id: "stable-subject",
      name: "stable-subject",
      email: "",
    });
  });

  it("uses email as the name fallback when no name header is present", async () => {
    configureGenericHeaders();
    const { getCurrentUser } = await loadAuth();
    expect(
      getCurrentUser(req({ "x-user-id": "subject-2", "x-user-email": "two@example.com" })),
    ).toEqual({ id: "subject-2", name: "two@example.com", email: "two@example.com" });
  });

  it("resolves configured id, name, and email headers", async () => {
    configureGenericHeaders();
    const { getCurrentUser } = await loadAuth();
    expect(
      getCurrentUser(
        req({
          "x-user-id": "subject-3",
          "x-user-name": "Ada Lovelace",
          "x-user-email": "ada@example.com",
        }),
      ),
    ).toEqual({ id: "subject-3", name: "Ada Lovelace", email: "ada@example.com" });
  });

  it("returns null when the configured id header is missing", async () => {
    configureGenericHeaders();
    const { getCurrentUser } = await loadAuth();
    expect(getCurrentUser(req({ "x-user-name": "Nobody" }))).toBeNull();
  });

  it.each([
    ["blank", "   "],
    ["embedded control character", "subject\tvalue"],
    ["more than 256 characters", "x".repeat(257)],
  ])("returns null for a %s id", async (_label, id) => {
    configureGenericHeaders();
    const { getCurrentUser } = await loadAuth();
    expect(getCurrentUser(req({ "x-user-id": id }))).toBeNull();
  });

  it("accepts the 256-character id boundary", async () => {
    configureGenericHeaders();
    const { getCurrentUser } = await loadAuth();
    const id = "x".repeat(256);
    expect(getCurrentUser(req({ "x-user-id": id }))?.id).toBe(id);
  });

  it("does not parse x-ms-client-principal outside the Easy Auth preset", async () => {
    configureGenericHeaders();
    const { getCurrentUser } = await loadAuth();
    const principal = Buffer.from(
      JSON.stringify({
        claims: [
          {
            typ: "http://schemas.microsoft.com/identity/claims/objectidentifier",
            val: "22222222-2222-4222-8222-222222222222",
          },
        ],
      }),
      "utf8",
    ).toString("base64");
    expect(getCurrentUser(req({ "x-ms-client-principal": principal }))).toBeNull();
  });
});

describe("auth in production — Easy Auth preset", () => {
  it("parses a valid Easy Auth principal when the preset is selected", async () => {
    vi.stubEnv("AUTH_MODE", "header");
    vi.stubEnv("AUTH_PRESET", "easyauth");
    const { getCurrentUser } = await loadAuth();
    const principal = Buffer.from(
      JSON.stringify({
        auth_typ: "aad",
        claims: [
          {
            typ: "http://schemas.microsoft.com/identity/claims/objectidentifier",
            val: "22222222-2222-4222-8222-222222222222",
          },
          {
            typ: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
            val: "real@example.com",
          },
        ],
      }),
      "utf8",
    ).toString("base64");
    expect(getCurrentUser(req({ "x-ms-client-principal": principal }))?.id).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("returns null for a credential-less request (no dev shim)", async () => {
    vi.stubEnv("AUTH_MODE", "header");
    vi.stubEnv("AUTH_PRESET", "easyauth");
    const { getCurrentUser } = await loadAuth();
    expect(getCurrentUser(req())).toBeNull();
  });
});
