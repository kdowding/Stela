import { describe, it, expect } from "vitest";
import {
  Anchor,
  Comment,
  CreateCommentRequest,
  ResolveCommentRequest,
  UpdateSharingRequest,
  CliTokenResponse,
  ListArtifactsResponse,
  PublishResponse,
  type Artifact,
} from "@stela/shared";

// ---------------------------------------------------------------------------
// Reusable fixtures
// ---------------------------------------------------------------------------

function validAnchor(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    xNorm: 0.5,
    yNorm: 0.25,
    renderWidth: 1024,
    ...over,
  };
}

function validArtifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "a1",
    ownerId: "owner-id",
    ownerName: "Owner",
    title: "Title",
    visibility: "private",
    allowedPrincipals: [],
    currentVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Anchor
// ---------------------------------------------------------------------------

describe("Anchor", () => {
  it("accepts a minimal valid anchor", () => {
    const parsed = Anchor.parse(validAnchor());
    expect(parsed.xNorm).toBe(0.5);
    expect(parsed.yNorm).toBe(0.25);
    expect(parsed.renderWidth).toBe(1024);
  });

  it("defaults scrollYNorm to 0 when omitted", () => {
    expect(Anchor.parse(validAnchor()).scrollYNorm).toBe(0);
  });

  it("preserves an explicit scrollYNorm", () => {
    expect(Anchor.parse(validAnchor({ scrollYNorm: 0.75 })).scrollYNorm).toBe(0.75);
  });

  it("accepts the boundary values 0 and 1 for normalized fields", () => {
    expect(Anchor.parse(validAnchor({ xNorm: 0, yNorm: 1, scrollYNorm: 1 })).xNorm).toBe(0);
    expect(Anchor.parse(validAnchor({ xNorm: 1, yNorm: 0 })).xNorm).toBe(1);
  });

  it("rejects xNorm > 1", () => {
    expect(Anchor.safeParse(validAnchor({ xNorm: 1.0001 })).success).toBe(false);
  });

  it("rejects xNorm < 0", () => {
    expect(Anchor.safeParse(validAnchor({ xNorm: -0.0001 })).success).toBe(false);
  });

  it("rejects yNorm > 1", () => {
    expect(Anchor.safeParse(validAnchor({ yNorm: 1.5 })).success).toBe(false);
  });

  it("rejects yNorm < 0", () => {
    expect(Anchor.safeParse(validAnchor({ yNorm: -1 })).success).toBe(false);
  });

  it("rejects scrollYNorm out of [0,1]", () => {
    expect(Anchor.safeParse(validAnchor({ scrollYNorm: 2 })).success).toBe(false);
    expect(Anchor.safeParse(validAnchor({ scrollYNorm: -0.5 })).success).toBe(false);
  });

  it("requires renderWidth to be strictly positive", () => {
    expect(Anchor.safeParse(validAnchor({ renderWidth: 0 })).success).toBe(false);
    expect(Anchor.safeParse(validAnchor({ renderWidth: -10 })).success).toBe(false);
  });

  it("requires version to be a positive integer", () => {
    expect(Anchor.safeParse(validAnchor({ version: 0 })).success).toBe(false);
    expect(Anchor.safeParse(validAnchor({ version: -1 })).success).toBe(false);
    expect(Anchor.safeParse(validAnchor({ version: 1.5 })).success).toBe(false);
  });

  it("accepts optional selector and textSnippet strings", () => {
    const parsed = Anchor.parse(validAnchor({ selector: "#root > div", textSnippet: "Hello" }));
    expect(parsed.selector).toBe("#root > div");
    expect(parsed.textSnippet).toBe("Hello");
  });

  it("rejects a non-string selector", () => {
    expect(Anchor.safeParse(validAnchor({ selector: 123 })).success).toBe(false);
  });

  it("accepts optional viewKey and viewLabel (multi-page scoping)", () => {
    const parsed = Anchor.parse(validAnchor({ viewKey: "admin-run", viewLabel: "May 2026 Run In Review" }));
    expect(parsed.viewKey).toBe("admin-run");
    expect(parsed.viewLabel).toBe("May 2026 Run In Review");
  });

  it("leaves viewKey/viewLabel undefined when omitted (page-global pin)", () => {
    const parsed = Anchor.parse(validAnchor());
    expect(parsed.viewKey).toBeUndefined();
    expect(parsed.viewLabel).toBeUndefined();
  });

  it("caps viewKey at 512 chars and viewLabel at 200", () => {
    expect(Anchor.safeParse(validAnchor({ viewKey: "x".repeat(512) })).success).toBe(true);
    expect(Anchor.safeParse(validAnchor({ viewKey: "x".repeat(513) })).success).toBe(false);
    expect(Anchor.safeParse(validAnchor({ viewLabel: "x".repeat(200) })).success).toBe(true);
    expect(Anchor.safeParse(validAnchor({ viewLabel: "x".repeat(201) })).success).toBe(false);
  });

  it("rejects a non-string viewKey", () => {
    expect(Anchor.safeParse(validAnchor({ viewKey: 42 })).success).toBe(false);
  });

  it("accepts an optional dom anchor with a text quote + offset", () => {
    const parsed = Anchor.parse(
      validAnchor({ dom: { selector: "#x", text: { exact: "Hello", prefix: "a", suffix: "b" }, offsetX: 0.5, offsetY: 0.25, tag: "p" } }),
    );
    expect(parsed.dom?.selector).toBe("#x");
    expect(parsed.dom?.text?.exact).toBe("Hello");
    expect(parsed.dom?.offsetY).toBe(0.25);
  });

  it("rejects a dom anchor whose offset is out of [0,1]", () => {
    expect(Anchor.safeParse(validAnchor({ dom: { offsetX: 1.5, offsetY: 0 } })).success).toBe(false);
  });

  it("leaves dom undefined when omitted (coordinate-only pin)", () => {
    expect(Anchor.parse(validAnchor()).dom).toBeUndefined();
  });

  it("rejects a missing required field (renderWidth)", () => {
    const { renderWidth: _omit, ...rest } = validAnchor();
    expect(Anchor.safeParse(rest).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Comment
// ---------------------------------------------------------------------------

describe("Comment", () => {
  function validComment(over: Record<string, unknown> = {}) {
    return {
      id: "c1",
      artifactId: "a1",
      version: 1,
      authorId: "author-id",
      authorName: "Author",
      body: "Looks good",
      anchor: validAnchor(),
      createdAt: "2026-01-01T00:00:00.000Z",
      ...over,
    };
  }

  it("accepts a valid comment and defaults resolved to false", () => {
    const parsed = Comment.parse(validComment());
    expect(parsed.resolved).toBe(false);
    expect(parsed.body).toBe("Looks good");
  });

  it("rejects an empty body", () => {
    expect(Comment.safeParse(validComment({ body: "" })).success).toBe(false);
  });

  it("rejects a non-positive version", () => {
    expect(Comment.safeParse(validComment({ version: 0 })).success).toBe(false);
  });

  it("requires a valid nested anchor", () => {
    expect(Comment.safeParse(validComment({ anchor: validAnchor({ xNorm: 2 }) })).success).toBe(false);
  });

  it("accepts optional resolve-audit and parent fields", () => {
    const parsed = Comment.parse(
      validComment({
        resolved: true,
        resolvedById: "resolver-id",
        resolvedAt: "2026-02-01T00:00:00.000Z",
        parentId: "c0",
      }),
    );
    expect(parsed.resolved).toBe(true);
    expect(parsed.resolvedById).toBe("resolver-id");
    expect(parsed.parentId).toBe("c0");
  });

  it("rejects a missing required field (createdAt)", () => {
    const { createdAt: _omit, ...rest } = validComment();
    expect(Comment.safeParse(rest).success).toBe(false);
  });

  it("accepts a general (unpinned) comment with no anchor", () => {
    const { anchor: _omit, ...rest } = validComment();
    const parsed = Comment.parse(rest);
    expect(parsed.anchor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CreateCommentRequest
// ---------------------------------------------------------------------------

describe("CreateCommentRequest", () => {
  function valid(over: Record<string, unknown> = {}) {
    return { body: "A comment", version: 1, anchor: validAnchor(), ...over };
  }

  it("accepts a valid request", () => {
    const parsed = CreateCommentRequest.parse(valid());
    expect(parsed.body).toBe("A comment");
    expect(parsed.version).toBe(1);
  });

  it("accepts an optional parentId", () => {
    expect(CreateCommentRequest.parse(valid({ parentId: "c0" })).parentId).toBe("c0");
  });

  it("accepts a request with no anchor (general comment)", () => {
    const { anchor: _omit, ...rest } = valid();
    expect(CreateCommentRequest.safeParse(rest).success).toBe(true);
  });

  it("rejects an empty body (min 1)", () => {
    expect(CreateCommentRequest.safeParse(valid({ body: "" })).success).toBe(false);
  });

  it("accepts a body at the 10000 boundary", () => {
    expect(CreateCommentRequest.safeParse(valid({ body: "x".repeat(10_000) })).success).toBe(true);
  });

  it("rejects a body over 10000 chars", () => {
    expect(CreateCommentRequest.safeParse(valid({ body: "x".repeat(10_001) })).success).toBe(false);
  });

  it("rejects a non-positive version", () => {
    expect(CreateCommentRequest.safeParse(valid({ version: 0 })).success).toBe(false);
  });

  it("rejects a non-integer version", () => {
    expect(CreateCommentRequest.safeParse(valid({ version: 1.5 })).success).toBe(false);
  });

  it("rejects an invalid nested anchor", () => {
    expect(CreateCommentRequest.safeParse(valid({ anchor: validAnchor({ renderWidth: 0 }) })).success).toBe(false);
  });

  it("rejects a parentId longer than 256 chars", () => {
    expect(CreateCommentRequest.safeParse(valid({ parentId: "x".repeat(257) })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ResolveCommentRequest
// ---------------------------------------------------------------------------

describe("ResolveCommentRequest", () => {
  it("accepts resolve and reopen", () => {
    expect(ResolveCommentRequest.parse({ version: 1, resolved: true }).resolved).toBe(true);
    expect(ResolveCommentRequest.parse({ version: 2, resolved: false }).resolved).toBe(false);
  });

  it("rejects a non-positive version", () => {
    expect(ResolveCommentRequest.safeParse({ version: 0, resolved: true }).success).toBe(false);
  });

  it("rejects a non-integer version", () => {
    expect(ResolveCommentRequest.safeParse({ version: 1.2, resolved: true }).success).toBe(false);
  });

  it("requires resolved to be a boolean", () => {
    expect(ResolveCommentRequest.safeParse({ version: 1, resolved: "yes" }).success).toBe(false);
  });

  it("rejects a missing version", () => {
    expect(ResolveCommentRequest.safeParse({ resolved: true }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UpdateSharingRequest — principal email-or-stable-user-id validation, max 500
// ---------------------------------------------------------------------------

describe("UpdateSharingRequest", () => {
  it("accepts a request and defaults allowedPrincipals to []", () => {
    const parsed = UpdateSharingRequest.parse({ visibility: "everyone" });
    expect(parsed.allowedPrincipals).toEqual([]);
  });

  it("accepts a valid email principal", () => {
    const parsed = UpdateSharingRequest.parse({
      visibility: "restricted",
      allowedPrincipals: ["jane.doe@example.com"],
    });
    expect(parsed.allowedPrincipals).toEqual(["jane.doe@example.com"]);
  });

  it("accepts a non-GUID stable user id principal", () => {
    expect(
      UpdateSharingRequest.safeParse({
        visibility: "restricted",
        allowedPrincipals: ["proxy-subject/alice"],
      }).success,
    ).toBe(true);
  });

  it("accepts a mix of email and user id principals", () => {
    expect(
      UpdateSharingRequest.safeParse({
        visibility: "restricted",
        allowedPrincipals: ["a@b.co", "stable-user-123"],
      }).success,
    ).toBe(true);
  });

  it("rejects a blank user id", () => {
    expect(
      UpdateSharingRequest.safeParse({ visibility: "restricted", allowedPrincipals: ["   "] }).success,
    ).toBe(false);
  });

  it("rejects a user id containing a control character", () => {
    expect(
      UpdateSharingRequest.safeParse({
        visibility: "restricted",
        allowedPrincipals: ["user\tvalue"],
      }).success,
    ).toBe(false);
  });

  it("rejects a user id longer than 256 characters", () => {
    expect(
      UpdateSharingRequest.safeParse({
        visibility: "restricted",
        allowedPrincipals: ["x".repeat(257)],
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid visibility", () => {
    expect(UpdateSharingRequest.safeParse({ visibility: "public", allowedPrincipals: [] }).success).toBe(false);
  });

  it("accepts exactly 500 principals", () => {
    const arr = Array.from({ length: 500 }, (_, i) => `user${i}@example.com`);
    expect(UpdateSharingRequest.safeParse({ visibility: "restricted", allowedPrincipals: arr }).success).toBe(true);
  });

  it("rejects more than 500 principals", () => {
    const arr = Array.from({ length: 501 }, (_, i) => `user${i}@example.com`);
    expect(UpdateSharingRequest.safeParse({ visibility: "restricted", allowedPrincipals: arr }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CliTokenResponse
// ---------------------------------------------------------------------------

describe("CliTokenResponse", () => {
  it("accepts a valid response", () => {
    const parsed = CliTokenResponse.parse({ token: "tok_abc", name: "Jane", email: "jane@example.com" });
    expect(parsed.token).toBe("tok_abc");
    expect(parsed.email).toBe("jane@example.com");
  });

  it("rejects a missing field", () => {
    expect(CliTokenResponse.safeParse({ token: "tok_abc", name: "Jane" }).success).toBe(false);
  });

  it("rejects a non-string token", () => {
    expect(CliTokenResponse.safeParse({ token: 123, name: "Jane", email: "j@x.co" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ListArtifactsResponse
// ---------------------------------------------------------------------------

describe("ListArtifactsResponse", () => {
  it("accepts empty mine/everyone arrays", () => {
    const parsed = ListArtifactsResponse.parse({ mine: [], everyone: [] });
    expect(parsed.mine).toEqual([]);
    expect(parsed.everyone).toEqual([]);
  });

  it("accepts populated arrays of artifacts", () => {
    const parsed = ListArtifactsResponse.parse({
      mine: [validArtifact({ id: "m1" })],
      everyone: [validArtifact({ id: "c1", visibility: "everyone" })],
    });
    expect(parsed.mine[0].id).toBe("m1");
    expect(parsed.everyone[0].visibility).toBe("everyone");
  });

  it("rejects a missing key", () => {
    expect(ListArtifactsResponse.safeParse({ mine: [] }).success).toBe(false);
  });

  it("rejects an array containing an invalid artifact", () => {
    expect(ListArtifactsResponse.safeParse({ mine: [{ id: "bad" }], everyone: [] }).success).toBe(false);
  });

  it("rejects an artifact with a non-positive currentVersion", () => {
    expect(
      ListArtifactsResponse.safeParse({ mine: [validArtifact({ currentVersion: 0 })], everyone: [] }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PublishResponse
// ---------------------------------------------------------------------------

describe("PublishResponse", () => {
  it("accepts a valid response", () => {
    const parsed = PublishResponse.parse({ id: "abc", version: 1, url: "https://stela.example.com/a/abc" });
    expect(parsed.id).toBe("abc");
    expect(parsed.version).toBe(1);
  });

  it("rejects a non-positive version", () => {
    expect(PublishResponse.safeParse({ id: "abc", version: 0, url: "https://x" }).success).toBe(false);
  });

  it("rejects a non-integer version", () => {
    expect(PublishResponse.safeParse({ id: "abc", version: 1.5, url: "https://x" }).success).toBe(false);
  });

  it("rejects a missing url", () => {
    expect(PublishResponse.safeParse({ id: "abc", version: 1 }).success).toBe(false);
  });
});
