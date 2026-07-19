import { describe, it, expect } from "vitest";
import { ArtifactId, PublishRequest, CliTokenRequest } from "@stela/shared";

describe("ArtifactId", () => {
  it("accepts a UUID", () =>
    expect(ArtifactId.safeParse("295d34d7-a926-40f1-9d6e-8c55b5554141").success).toBe(true));
  it("rejects a path-traversal-ish id", () =>
    expect(ArtifactId.safeParse("../etc/passwd").success).toBe(false));
});

describe("PublishRequest", () => {
  it("requires a title and html", () => expect(PublishRequest.safeParse({}).success).toBe(false));
  it("defaults visibility to private", () => {
    const r = PublishRequest.safeParse({ title: "t", html: "<h1>x</h1>" });
    expect(r.success && r.data.visibility).toBe("private");
  });
  it("rejects html over the 10MB cap", () =>
    expect(PublishRequest.safeParse({ title: "t", html: "x".repeat(10_000_001) }).success).toBe(false));
  it("rejects a user id longer than 256 characters", () =>
    expect(
      PublishRequest.safeParse({ title: "t", html: "<h1>x</h1>", visibility: "restricted", allowedPrincipals: ["x".repeat(257)] }).success,
    ).toBe(false));
  it("accepts a valid email principal", () =>
    expect(
      PublishRequest.safeParse({ title: "t", html: "<h1>x</h1>", visibility: "restricted", allowedPrincipals: ["a@b.com"] }).success,
    ).toBe(true));
  it("rejects a non-UUID artifactId", () =>
    expect(PublishRequest.safeParse({ title: "t", html: "<h1>x</h1>", artifactId: "nope" }).success).toBe(false));
});

describe("CliTokenRequest", () => {
  it("requires code + a 43–128 char verifier", () => {
    expect(CliTokenRequest.safeParse({ code: "c", verifier: "short" }).success).toBe(false);
    expect(CliTokenRequest.safeParse({ code: "c", verifier: "v".repeat(43) }).success).toBe(true);
  });
});
