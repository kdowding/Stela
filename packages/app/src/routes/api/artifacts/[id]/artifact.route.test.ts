import { describe, it, expect } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GET as getArtifact, PATCH as patchArtifact, DELETE as deleteArtifact } from "./+server";
import { GET as getVersions } from "./versions/+server";
import { GET as getVersionHtml, DELETE as deleteVersion } from "./versions/[v]/+server";
import { POST } from "../+server";
import { getStore } from "$lib/server/storage";
import { makeEvent } from "../../../../test/helpers";

// Integration tests against the default SQLite store. Mint unique user ids across persisted runs.
const store = getStore();
const ADMIN = { "x-api-key": "dev-publish-key" } as const;
const html = "<h1>hello</h1>";

async function mintToken(): Promise<{ token: string; id: string }> {
  const id = randomUUID();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = await store.createPairingCode(
    { id, name: `U-${id.slice(0, 8)}`, email: `${id.slice(0, 8)}@example.com` },
    challenge,
  );
  const redeemed = await store.redeemPairingCode(code, verifier);
  if (!redeemed) throw new Error("failed to mint token");
  return { token: redeemed.token, id };
}

async function publish(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await POST(makeEvent({ method: "POST", path: "/api/artifacts", headers, body }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

describe("GET /api/artifacts/[id] — metadata", () => {
  it("the owner can read their artifact's metadata", async () => {
    const id = await publish({ ...ADMIN }, { title: "Readable", html });
    const res = await getArtifact(
      makeEvent({ path: `/api/artifacts/${id}`, params: { id }, headers: { ...ADMIN } }),
    );
    expect(res.status).toBe(200);
    const a = (await res.json()) as { id: string; title: string; ownerId: string; currentVersion: number };
    expect(a.id).toBe(id);
    expect(a.title).toBe("Readable");
    expect(a.ownerId).toBe("dev-user-0001");
    expect(a.currentVersion).toBe(1);
  });

  it("a non-owner cannot read a PRIVATE artifact → 404 (existence not leaked)", async () => {
    const id = await publish({ ...ADMIN }, { title: "Secret", html, visibility: "private" });
    const { token } = await mintToken();
    await expect(
      getArtifact(
        makeEvent({ path: `/api/artifacts/${id}`, params: { id }, headers: { "x-api-key": token } }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("any signed-in user can read an everyone-visible artifact owned by someone else", async () => {
    const { token } = await mintToken();
    const id = await publish({ "x-api-key": token }, { title: "Everyone", html, visibility: "everyone" });
    const res = await getArtifact(
      makeEvent({ path: `/api/artifacts/${id}`, params: { id }, headers: { ...ADMIN } }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(id);
  });

  it("unknown (well-formed) id → 404", async () => {
    const id = randomUUID();
    await expect(
      getArtifact(makeEvent({ path: `/api/artifacts/${id}`, params: { id }, headers: { ...ADMIN } })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("no credential → 401", async () => {
    const id = randomUUID();
    await expect(
      getArtifact(makeEvent({ path: `/api/artifacts/${id}`, params: { id } })),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("GET /api/artifacts/[id]/versions — history", () => {
  it("returns versions newest-first, with notes", async () => {
    const id = await publish({ ...ADMIN }, { title: "Versioned", html });
    await POST(
      makeEvent({
        method: "POST",
        path: "/api/artifacts",
        headers: { ...ADMIN },
        body: { artifactId: id, title: "x", html: "<h1>v2</h1>", note: "second" },
      }),
    );

    const res = await getVersions(
      makeEvent({ path: `/api/artifacts/${id}/versions`, params: { id }, headers: { ...ADMIN } }),
    );
    expect(res.status).toBe(200);
    const vs = (await res.json()) as Array<{ version: number; note?: string }>;
    expect(vs.map((v) => v.version)).toEqual([2, 1]);
    expect(vs[0]?.note).toBe("second");
  });

  it("a non-owner cannot read a private artifact's versions → 404", async () => {
    const id = await publish({ ...ADMIN }, { title: "SecretV", html, visibility: "private" });
    const { token } = await mintToken();
    await expect(
      getVersions(
        makeEvent({
          path: `/api/artifacts/${id}/versions`,
          params: { id },
          headers: { "x-api-key": token },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("DELETE /api/artifacts/[id]", () => {
  it("the owner can delete their artifact → 204 and it's gone", async () => {
    const id = await publish({ ...ADMIN }, { title: "Deletable", html });
    const res = await deleteArtifact(
      makeEvent({ method: "DELETE", path: `/api/artifacts/${id}`, params: { id }, headers: { ...ADMIN } }),
    );
    expect(res.status).toBe(204);
    expect(await store.getArtifact(id)).toBeNull();
  });

  it("a non-owner cannot delete an everyone-visible artifact → 403 (and it survives)", async () => {
    const { token } = await mintToken();
    const id = await publish({ "x-api-key": token }, { title: "EveryoneDel", html, visibility: "everyone" });
    // admin can VIEW it (server-wide) but doesn't own it → 403, not 404
    await expect(
      deleteArtifact(
        makeEvent({ method: "DELETE", path: `/api/artifacts/${id}`, params: { id }, headers: { ...ADMIN } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await store.getArtifact(id)).not.toBeNull();
  });

  it("a non-owner cannot delete a PRIVATE artifact → 404 (existence hidden)", async () => {
    const id = await publish({ ...ADMIN }, { title: "PrivDel", html, visibility: "private" });
    const { token } = await mintToken();
    await expect(
      deleteArtifact(
        makeEvent({ method: "DELETE", path: `/api/artifacts/${id}`, params: { id }, headers: { "x-api-key": token } }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("a cross-origin browser request is blocked (CSRF) → 403", async () => {
    const id = await publish({ ...ADMIN }, { title: "CsrfDel", html });
    await expect(
      deleteArtifact(
        makeEvent({
          method: "DELETE",
          path: `/api/artifacts/${id}`,
          params: { id },
          headers: { origin: "https://evil.example" },
          locals: { user: { id: "dev-user-0001", name: "Dev", email: "dev@example.com" } },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await store.getArtifact(id)).not.toBeNull();
  });
});

describe("PATCH /api/artifacts/[id] — rename", () => {
  it("the owner can rename their artifact", async () => {
    const id = await publish({ ...ADMIN }, { title: "Before", html });
    const res = await patchArtifact(
      makeEvent({ method: "PATCH", path: `/api/artifacts/${id}`, params: { id }, headers: { ...ADMIN }, body: { title: "After" } }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe("After");
    expect((await store.getArtifact(id))?.title).toBe("After");
  });

  it("rejects an empty/blank title → 400", async () => {
    const id = await publish({ ...ADMIN }, { title: "Keep", html });
    await expect(
      patchArtifact(
        makeEvent({ method: "PATCH", path: `/api/artifacts/${id}`, params: { id }, headers: { ...ADMIN }, body: { title: "   " } }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect((await store.getArtifact(id))?.title).toBe("Keep");
  });

  it("a non-owner cannot rename an everyone-visible artifact → 403", async () => {
    const { token } = await mintToken();
    const id = await publish({ "x-api-key": token }, { title: "Theirs", html, visibility: "everyone" });
    await expect(
      patchArtifact(
        makeEvent({ method: "PATCH", path: `/api/artifacts/${id}`, params: { id }, headers: { ...ADMIN }, body: { title: "Hijack" } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("a cross-origin browser rename is blocked (CSRF) → 403", async () => {
    const id = await publish({ ...ADMIN }, { title: "CsrfRename", html });
    await expect(
      patchArtifact(
        makeEvent({
          method: "PATCH",
          path: `/api/artifacts/${id}`,
          params: { id },
          headers: { origin: "https://evil.example" },
          locals: { user: { id: "dev-user-0001", name: "Dev", email: "dev@example.com" } },
          body: { title: "x" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("DELETE /api/artifacts/[id]/versions/[v]", () => {
  async function addVersion(id: string): Promise<void> {
    await POST(
      makeEvent({
        method: "POST",
        path: "/api/artifacts",
        headers: { ...ADMIN },
        body: { artifactId: id, title: "x", html: "<h1>v2</h1>" },
      }),
    );
  }

  it("the owner can delete a non-current version → 200, currentVersion unchanged", async () => {
    const id = await publish({ ...ADMIN }, { title: "VDel", html });
    await addVersion(id); // current = 2
    const res = await deleteVersion(
      makeEvent({ method: "DELETE", path: `/api/artifacts/${id}/versions/1`, params: { id, v: "1" }, headers: { ...ADMIN } }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { currentVersion: number }).currentVersion).toBe(2);
    expect(await store.getHtml(id, 1)).toBeNull();
  });

  it("refuses to delete the only version → 409 (and it survives)", async () => {
    const id = await publish({ ...ADMIN }, { title: "SoloV", html });
    await expect(
      deleteVersion(
        makeEvent({ method: "DELETE", path: `/api/artifacts/${id}/versions/1`, params: { id, v: "1" }, headers: { ...ADMIN } }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.getHtml(id, 1)).not.toBeNull();
  });

  it("a non-owner cannot delete a version of a PRIVATE artifact → 404", async () => {
    const id = await publish({ ...ADMIN }, { title: "PrivVDel", html, visibility: "private" });
    const { token } = await mintToken();
    await expect(
      deleteVersion(
        makeEvent({ method: "DELETE", path: `/api/artifacts/${id}/versions/1`, params: { id, v: "1" }, headers: { "x-api-key": token } }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("a cross-origin browser version-delete is blocked (CSRF) → 403", async () => {
    const id = await publish({ ...ADMIN }, { title: "CsrfVDel", html });
    await addVersion(id);
    await expect(
      deleteVersion(
        makeEvent({
          method: "DELETE",
          path: `/api/artifacts/${id}/versions/1`,
          params: { id, v: "1" },
          headers: { origin: "https://evil.example" },
          locals: { user: { id: "dev-user-0001", name: "Dev", email: "dev@example.com" } },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await store.getHtml(id, 1)).not.toBeNull();
  });
});

describe("GET /api/artifacts/[id]/versions/[v] — html source", () => {
  it("the owner reads a specific version and 'current'", async () => {
    const id = await publish({ ...ADMIN }, { title: "Src", html });
    await POST(
      makeEvent({
        method: "POST",
        path: "/api/artifacts",
        headers: { ...ADMIN },
        body: { artifactId: id, title: "x", html: "<h1>v2</h1>" },
      }),
    );

    const v1 = await getVersionHtml(
      makeEvent({ path: `/api/artifacts/${id}/versions/1`, params: { id, v: "1" }, headers: { ...ADMIN } }),
    );
    expect(v1.status).toBe(200);
    expect(((await v1.json()) as { html: string }).html).toBe(html);

    const cur = await getVersionHtml(
      makeEvent({ path: `/api/artifacts/${id}/versions/current`, params: { id, v: "current" }, headers: { ...ADMIN } }),
    );
    expect(((await cur.json()) as { html: string }).html).toBe("<h1>v2</h1>");
  });

  it("a non-owner cannot read a PRIVATE artifact's source → 404", async () => {
    const id = await publish({ ...ADMIN }, { title: "PrivSrc", html, visibility: "private" });
    const { token } = await mintToken();
    await expect(
      getVersionHtml(
        makeEvent({ path: `/api/artifacts/${id}/versions/1`, params: { id, v: "1" }, headers: { "x-api-key": token } }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("no credential → 401", async () => {
    const id = await publish({ ...ADMIN }, { title: "NoAuthSrc", html });
    await expect(
      getVersionHtml(makeEvent({ path: `/api/artifacts/${id}/versions/1`, params: { id, v: "1" } })),
    ).rejects.toMatchObject({ status: 401 });
  });
});
