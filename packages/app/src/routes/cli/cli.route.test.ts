import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { makeEvent, testUser } from "../../test/helpers";
import { getStore } from "$lib/server/storage";
import { ARTIFACT_CSP } from "@stela/shared";
import { GET as authorizeGET } from "./authorize/+server";
import { POST as tokenPOST, DELETE as tokenDELETE } from "./token/+server";
import { GET as rawGET } from "../a/[id]/raw/+server";

const store = getStore();

/** Unique user id per test so persisted SQLite state never collides. */
const uid = (p = "u") => `${p}-${randomBytes(8).toString("hex")}`;

/** PKCE pair: verifier = random base64url, challenge = base64url(sha256(verifier)). */
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

/** Drive authorize GET and pull the pairing code out of the 302 Location. */
async function authorize(over: {
  user?: ReturnType<typeof testUser>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
} = {}) {
  const { challenge } = pkce();
  const user = over.user ?? testUser({ id: uid() });
  const query = { port: "51789", state: "abc12345", code_challenge: challenge, ...(over.query ?? {}) };
  return authorizeGET(
    makeEvent({ path: "/cli/authorize", query, headers: over.headers, locals: { user } }),
  );
}

function codeFromLocation(res: Response): { code: string; state: string; port: string } {
  expect(res.status).toBe(302);
  const loc = res.headers.get("location");
  expect(loc).toBeTruthy();
  const u = new URL(loc!);
  expect(u.protocol).toBe("http:");
  expect(u.hostname).toBe("127.0.0.1");
  expect(u.pathname).toBe("/callback");
  const code = u.searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code!, state: u.searchParams.get("state") ?? "", port: u.port };
}

describe("GET /cli/authorize", () => {
  it("mints a pairing code and 302s to the loopback callback with code + state", async () => {
    const user = testUser({ id: uid() });
    const { challenge } = pkce();
    const res = await authorizeGET(
      makeEvent({
        path: "/cli/authorize",
        query: { port: "55123", state: "myState_01", code_challenge: challenge },
        locals: { user },
      }),
    );
    const { code, state, port } = codeFromLocation(res);
    expect(state).toBe("myState_01");
    expect(port).toBe("55123");
    expect(code.length).toBeGreaterThan(0);
  });

  it("accepts pairing params packed into a single base64url `r` param (Easy Auth round-trip)", async () => {
    // Easy Auth drops query params after the first '&', so hooks packs port+state+code_challenge
    // into one base64url `r` value for the login redirect; the route must unpack it identically.
    const user = testUser({ id: uid() });
    const { challenge } = pkce();
    const packed = Buffer.from(
      `port=53777&state=packedState1&code_challenge=${challenge}`,
      "utf8",
    ).toString("base64url");
    const res = await authorizeGET(
      makeEvent({ path: "/cli/authorize", query: { r: packed }, locals: { user } }),
    );
    const { state, port } = codeFromLocation(res);
    expect(state).toBe("packedState1");
    expect(port).toBe("53777");
  });

  it("rejects a prefetch navigation with 403", async () => {
    await expect(authorize({ headers: { "sec-purpose": "prefetch;prerender" } })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects a prerender navigation with 403", async () => {
    await expect(authorize({ headers: { "sec-purpose": "prerender" } })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects an anonymous caller with 401", async () => {
    const { challenge } = pkce();
    await expect(
      authorizeGET(
        makeEvent({
          path: "/cli/authorize",
          query: { port: "51000", state: "abc12345", code_challenge: challenge },
          locals: { user: null },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a missing code_challenge with 400", async () => {
    const user = testUser({ id: uid() });
    await expect(
      authorizeGET(
        makeEvent({
          path: "/cli/authorize",
          query: { port: "51000", state: "abc12345" },
          locals: { user },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a too-short code_challenge with 400", async () => {
    await expect(authorize({ query: { code_challenge: "tooshort" } })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects a malformed state with 400", async () => {
    await expect(authorize({ query: { state: "bad!" } })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a too-short state with 400", async () => {
    await expect(authorize({ query: { state: "short" } })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a privileged port (< 1024) with 400", async () => {
    await expect(authorize({ query: { port: "80" } })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-numeric port with 400", async () => {
    await expect(authorize({ query: { port: "notaport" } })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an out-of-range port (> 65535) with 400", async () => {
    await expect(authorize({ query: { port: "70000" } })).rejects.toMatchObject({ status: 400 });
  });
});

describe("POST /cli/token", () => {
  it("exchanges a valid code + matching verifier for a token (200) and echoes identity", async () => {
    const { verifier, challenge } = pkce();
    const user = testUser({ id: uid(), name: "Cli User", email: "cli@example.com" });
    const authRes = await authorizeGET(
      makeEvent({
        path: "/cli/authorize",
        query: { port: "52001", state: "validstate1", code_challenge: challenge },
        locals: { user },
      }),
    );
    const { code } = codeFromLocation(authRes);

    const res = await tokenPOST(
      makeEvent({ method: "POST", path: "/cli/token", body: { code, verifier } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.name).toBe("Cli User");
    expect(body.email).toBe("cli@example.com");

    // The minted token resolves to the same user via the store.
    expect(await store.resolveToken(body.token)).toMatchObject({ id: user.id });
  });

  it("rejects a wrong verifier with 400 (PKCE mismatch)", async () => {
    const { challenge } = pkce();
    const authRes = await authorize({ query: { code_challenge: challenge } });
    const { code } = codeFromLocation(authRes);
    const wrong = randomBytes(32).toString("base64url");
    await expect(
      tokenPOST(makeEvent({ method: "POST", path: "/cli/token", body: { code, verifier: wrong } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a missing verifier field with 400 (schema validation)", async () => {
    const authRes = await authorize();
    const { code } = codeFromLocation(authRes);
    await expect(
      tokenPOST(makeEvent({ method: "POST", path: "/cli/token", body: { code } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an empty/invalid JSON body with 400", async () => {
    await expect(
      tokenPOST(makeEvent({ method: "POST", path: "/cli/token", body: "not json" })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an unknown code with 400", async () => {
    const { verifier } = pkce();
    await expect(
      tokenPOST(
        makeEvent({
          method: "POST",
          path: "/cli/token",
          body: { code: `nope-${randomBytes(8).toString("hex")}`, verifier },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("is single-use: a code cannot be redeemed twice", async () => {
    const { verifier, challenge } = pkce();
    const authRes = await authorize({ query: { code_challenge: challenge } });
    const { code } = codeFromLocation(authRes);

    const first = await tokenPOST(
      makeEvent({ method: "POST", path: "/cli/token", body: { code, verifier } }),
    );
    expect(first.status).toBe(200);

    await expect(
      tokenPOST(makeEvent({ method: "POST", path: "/cli/token", body: { code, verifier } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("blocks a cross-origin browser POST (same-origin guard)", async () => {
    const { verifier } = pkce();
    await expect(
      tokenPOST(
        makeEvent({
          method: "POST",
          path: "/cli/token",
          headers: { origin: "https://evil.example.com" },
          body: { code: "x".repeat(10), verifier },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("DELETE /cli/token", () => {
  it("revokes the presented token and returns 204", async () => {
    // Mint a real token through the full pairing flow.
    const { verifier, challenge } = pkce();
    const authRes = await authorize({ query: { code_challenge: challenge } });
    const { code } = codeFromLocation(authRes);
    const tokRes = await tokenPOST(
      makeEvent({ method: "POST", path: "/cli/token", body: { code, verifier } }),
    );
    const { token } = await tokRes.json();
    expect(await store.resolveToken(token)).not.toBeNull();

    const res = await tokenDELETE(
      makeEvent({ method: "DELETE", path: "/cli/token", headers: { "x-api-key": token } }),
    );
    expect(res.status).toBe(204);
    expect(await store.resolveToken(token)).toBeNull();
  });

  it("accepts a Bearer authorization header and revokes it", async () => {
    const { verifier, challenge } = pkce();
    const authRes = await authorize({ query: { code_challenge: challenge } });
    const { code } = codeFromLocation(authRes);
    const tokRes = await tokenPOST(
      makeEvent({ method: "POST", path: "/cli/token", body: { code, verifier } }),
    );
    const { token } = await tokRes.json();

    const res = await tokenDELETE(
      makeEvent({
        method: "DELETE",
        path: "/cli/token",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(204);
    expect(await store.resolveToken(token)).toBeNull();
  });

  it("returns 204 even when no credential is presented (idempotent sign-out)", async () => {
    const res = await tokenDELETE(makeEvent({ method: "DELETE", path: "/cli/token" }));
    expect(res.status).toBe(204);
  });

  it("blocks a cross-origin browser DELETE without a credential (same-origin guard)", async () => {
    await expect(
      tokenDELETE(
        makeEvent({
          method: "DELETE",
          path: "/cli/token",
          headers: { origin: "https://evil.example.com" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("GET /a/[id]/raw", () => {
  async function makeArtifact(ownerId: string, html = "<h1>hello</h1>") {
    const { artifact } = await store.createArtifact({
      ownerId,
      ownerName: "Owner",
      title: "Raw T",
      visibility: "private",
      allowedPrincipals: [],
      html,
    });
    return artifact;
  }

  it("serves the html to the owner with the sandbox CSP", async () => {
    const owner = testUser({ id: uid("owner") });
    const artifact = await makeArtifact(owner.id, "<h1>raw-body</h1>");

    const res = await rawGET(
      makeEvent({ path: `/a/${artifact.id}/raw`, params: { id: artifact.id }, locals: { user: owner } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(ARTIFACT_CSP); // the route serves exactly the single-source constant — no drift
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox allow-scripts");
    // blob: on script-src/font-src lets the standard blob-bundle export render (verified in-sandbox);
    // egress + opaque-origin isolation are unchanged.
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval' blob:");
    expect(csp).toContain("font-src data: blob:");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("raw-body");
  });

  it("returns 404 to a non-viewer (private artifact existence not leaked)", async () => {
    const owner = testUser({ id: uid("owner") });
    const stranger = testUser({ id: uid("stranger") });
    const artifact = await makeArtifact(owner.id);

    await expect(
      rawGET(
        makeEvent({
          path: `/a/${artifact.id}/raw`,
          params: { id: artifact.id },
          locals: { user: stranger },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns 404 for an unknown artifact id", async () => {
    const owner = testUser({ id: uid("owner") });
    await expect(
      rawGET(
        makeEvent({
          path: `/a/missing-${randomBytes(6).toString("hex")}/raw`,
          params: { id: `missing-${randomBytes(6).toString("hex")}` },
          locals: { user: owner },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns 400 for an invalid version query param", async () => {
    const owner = testUser({ id: uid("owner") });
    const artifact = await makeArtifact(owner.id);
    await expect(
      rawGET(
        makeEvent({
          path: `/a/${artifact.id}/raw`,
          query: { v: "0" },
          params: { id: artifact.id },
          locals: { user: owner },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns 404 for a version that does not exist", async () => {
    const owner = testUser({ id: uid("owner") });
    const artifact = await makeArtifact(owner.id);
    await expect(
      rawGET(
        makeEvent({
          path: `/a/${artifact.id}/raw`,
          query: { v: "99" },
          params: { id: artifact.id },
          locals: { user: owner },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("sets an immutable cache header when a specific version is requested", async () => {
    const owner = testUser({ id: uid("owner") });
    const artifact = await makeArtifact(owner.id);
    const res = await rawGET(
      makeEvent({
        path: `/a/${artifact.id}/raw`,
        query: { v: "1" },
        params: { id: artifact.id },
        locals: { user: owner },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });
});
