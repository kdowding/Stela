import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { getStore } from "$lib/server/storage";
import { makeEvent, testUser } from "../test/helpers";
import { load as galleryLoad } from "./+page.server";
import { load as layoutLoad } from "./+layout.server";
import { load as viewerLoad } from "./a/[id]/+page.server";

const store = getStore();
const uid = (p: string) => `${p}-${randomBytes(4).toString("hex")}`;

describe("gallery +page.server load", () => {
  it("returns empty (no error) for an anonymous user", async () => {
    expect(await galleryLoad(makeEvent({ locals: { user: null } }))).toMatchObject({
      mine: [],
      everyone: [],
      storageError: false,
    });
  });

  it("lists the signed-in user's own artifacts", async () => {
    const userId = uid("gallery");
    const user = testUser({ id: userId });
    await store.createArtifact({ ownerId: userId, ownerName: user.name, title: "G", visibility: "private", allowedPrincipals: [], html: "<h1>g</h1>" });
    const data: any = await galleryLoad(makeEvent({ locals: { user } }));
    expect(data.storageError).toBe(false);
    expect(data.mine.some((a: { ownerId: string }) => a.ownerId === userId)).toBe(true);
  });

  it("excludes the user's own artifacts from the everyone list", async () => {
    const userId = uid("gallery2");
    const user = testUser({ id: userId });
    await store.createArtifact({ ownerId: userId, ownerName: user.name, title: "E", visibility: "everyone", allowedPrincipals: [], html: "<h1>e</h1>" });
    const data: any = await galleryLoad(makeEvent({ locals: { user } }));
    expect(data.everyone.every((a: { ownerId: string }) => a.ownerId !== userId)).toBe(true);
  });
});

describe("+layout.server load", () => {
  it("passes the user through to the layout", async () => {
    const user = testUser();
    expect(await layoutLoad(makeEvent({ locals: { user } }))).toEqual({ user });
  });
  it("passes null through for an anonymous user", async () => {
    expect(await layoutLoad(makeEvent({ locals: { user: null } }))).toEqual({ user: null });
  });
});

describe("viewer a/[id]/+page.server load", () => {
  it("returns artifact + versions + canManage + fullBleed for the owner", async () => {
    const userId = uid("viewer");
    const { artifact } = await store.createArtifact({ ownerId: userId, ownerName: "V", title: "V", visibility: "private", allowedPrincipals: [], html: "<h1>v</h1>" });
    const data: any = await viewerLoad(makeEvent({ params: { id: artifact.id }, locals: { user: testUser({ id: userId }) } }));
    expect(data.artifact.id).toBe(artifact.id);
    expect(data.canManage).toBe(true);
    expect(data.fullBleed).toBe(true);
    expect(data.versions.length).toBeGreaterThanOrEqual(1);
  });

  it("404s for a non-viewer of a private artifact", async () => {
    const { artifact } = await store.createArtifact({ ownerId: uid("owner"), ownerName: "O", title: "P", visibility: "private", allowedPrincipals: [], html: "<h1>p</h1>" });
    await expect(
      viewerLoad(makeEvent({ params: { id: artifact.id }, locals: { user: testUser({ id: uid("intruder") }) } })),
    ).rejects.toMatchObject({ status: 404 });
  });
});
