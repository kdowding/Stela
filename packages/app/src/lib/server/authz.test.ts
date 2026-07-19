import { describe, it, expect } from "vitest";
import { canView, canManage } from "./authz";
import type { Artifact } from "@stela/shared";
import type { SessionUser } from "./auth";

const owner: SessionUser = { id: "owner-id", name: "Owner", email: "owner@example.com" };
const other: SessionUser = { id: "other-id", name: "Other", email: "other@example.com" };

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "a1",
    ownerId: "owner-id",
    ownerName: "Owner",
    title: "t",
    visibility: "private",
    allowedPrincipals: [],
    currentVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("canView", () => {
  it("owner can always view their private artifact", () => expect(canView(artifact(), owner)).toBe(true));
  it("a non-owner cannot view a private artifact", () => expect(canView(artifact(), other)).toBe(false));
  it("anyone signed in can view a everyone artifact", () =>
    expect(canView(artifact({ visibility: "everyone" }), other)).toBe(true));
  it("restricted: allowed by user id", () =>
    expect(canView(artifact({ visibility: "restricted", allowedPrincipals: ["other-id"] }), other)).toBe(true));
  it("restricted: allowed by email, case-insensitively", () =>
    expect(canView(artifact({ visibility: "restricted", allowedPrincipals: ["OTHER@example.com"] }), other)).toBe(true));
  it("restricted: rejects someone not on the list", () =>
    expect(canView(artifact({ visibility: "restricted", allowedPrincipals: ["someone@x.com"] }), other)).toBe(false));
  it("restricted: matches an allowed user id case-insensitively", () => {
    const mixed = "AABBCCDD-1111-4111-8111-AAAABBBBCCCC";
    const u: SessionUser = { id: mixed.toLowerCase(), name: "U", email: "u@example.com" };
    expect(canView(artifact({ visibility: "restricted", allowedPrincipals: [mixed] }), u)).toBe(true);
  });
});

describe("canManage", () => {
  it("only the owner can manage", () => expect(canManage(artifact(), owner)).toBe(true));
  it("a non-owner cannot manage even a everyone artifact", () =>
    expect(canManage(artifact({ visibility: "everyone" }), other)).toBe(false));
});
