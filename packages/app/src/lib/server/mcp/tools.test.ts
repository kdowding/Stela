import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { testUser } from "../../../test/helpers";
import { getStore } from "$lib/server/storage";
import { ARTIFACT_CSP } from "@stela/shared";
import {
  whoami,
  listArtifacts,
  publishArtifact,
  getArtifact,
  readArtifactHtml,
  setSharing,
  deleteArtifact,
  readComments,
  type ToolCtx,
  type ToolResult,
} from "./tools";

const store = getStore();
const ORIGIN = "http://localhost:5173";
const uid = (p = "u") => `${p}-${randomBytes(8).toString("hex")}`;
const ctxFor = (over = {}): ToolCtx => ({ user: testUser({ id: uid(), ...over }), origin: ORIGIN });

const SELF_CONTAINED = "<!doctype html><html><head><title>My Art</title></head><body>hi</body></html>";

function text(r: ToolResult): string {
  return r.content.map((c) => c.text).join("\n");
}
/** Pull the artifact URL out of a publish result. */
function urlOf(r: ToolResult): string {
  const m = text(r).match(/https?:\/\/\S+\/a\/[0-9a-f-]+/i);
  if (!m) throw new Error(`no artifact url in result: ${text(r)}`);
  return m[0];
}

describe("publish_artifact", () => {
  it("creates a new artifact and returns its URL + version", async () => {
    const ctx = ctxFor();
    const r = await publishArtifact(ctx, {
      html: SELF_CONTAINED,
      visibility: "private",
      allowedPrincipals: [],
      force: false,
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/v1/);
    const url = urlOf(r);
    // It really landed in the store, owned by the caller, titled from <title>.
    const mine = await store.listByOwner(ctx.user.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("My Art");
    expect(url).toContain(mine[0].id);
  });

  it("refuses an artifact with external references (no-network CSP), unless forced", async () => {
    const ctx = ctxFor();
    const withCdn =
      '<!doctype html><html><head><title>X</title><script src="https://cdn.example.com/x.js"></script></head><body>hi</body></html>';
    const refused = await publishArtifact(ctx, {
      html: withCdn,
      visibility: "private",
      allowedPrincipals: [],
      force: false,
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/external/i);
    expect(await store.listByOwner(ctx.user.id)).toHaveLength(0);

    const forced = await publishArtifact(ctx, {
      html: withCdn,
      visibility: "private",
      allowedPrincipals: [],
      force: true,
    });
    expect(forced.isError).toBeFalsy();
    expect(await store.listByOwner(ctx.user.id)).toHaveLength(1);
  });

  it("requires a title when the HTML has no <title>", async () => {
    const ctx = ctxFor();
    const r = await publishArtifact(ctx, {
      html: "<!doctype html><html><body>no title here</body></html>",
      visibility: "private",
      allowedPrincipals: [],
      force: false,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/title/i);
  });

  it("versions an existing artifact when given its url, and dedups identical content", async () => {
    const ctx = ctxFor();
    const created = await publishArtifact(ctx, {
      html: SELF_CONTAINED,
      visibility: "private",
      allowedPrincipals: [],
      force: false,
    });
    const url = urlOf(created);

    const same = await publishArtifact(ctx, {
      html: SELF_CONTAINED,
      url,
      visibility: "private",
      allowedPrincipals: [],
      force: false,
    });
    expect(same.isError).toBeFalsy();
    expect(text(same)).toMatch(/No change/i);

    const changed = await publishArtifact(ctx, {
      html: SELF_CONTAINED.replace("hi", "hello again"),
      url,
      visibility: "private",
      allowedPrincipals: [],
      force: false,
    });
    expect(text(changed)).toMatch(/v2/);
  });

  it("won't version an artifact the caller doesn't own", async () => {
    const owner = ctxFor();
    const created = await publishArtifact(owner, {
      html: SELF_CONTAINED,
      visibility: "private",
      allowedPrincipals: [],
      force: false,
    });
    const url = urlOf(created);

    const stranger = ctxFor();
    const r = await publishArtifact(stranger, {
      html: SELF_CONTAINED.replace("hi", "sneaky"),
      url,
      visibility: "private",
      allowedPrincipals: [],
      force: false,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not found, or you don't own it/i);
  });

  it("rejects a control character in a user id on a restricted create", async () => {
    const ctx = ctxFor();
    const r = await publishArtifact(ctx, {
      html: SELF_CONTAINED,
      visibility: "restricted",
      allowedPrincipals: ["user\tvalue"],
      force: false,
    });
    expect(r.isError).toBe(true);
  });

  it("validate: true dry-runs without publishing (clean and dirty)", async () => {
    const ctx = ctxFor();
    const clean = await publishArtifact(ctx, {
      html: SELF_CONTAINED,
      visibility: "private",
      allowedPrincipals: [],
      force: false,
      validate: true,
    });
    expect(clean.isError).toBeFalsy();
    expect(text(clean)).toMatch(/self-contained/i);
    expect(text(clean)).toContain(ARTIFACT_CSP); // validate hands back the exact policy for a local render check
    expect(await store.listByOwner(ctx.user.id)).toHaveLength(0); // nothing was published

    const dirty = await publishArtifact(ctx, {
      html: '<!doctype html><title>X</title><script src="https://cdn.example.com/x.js"></script>',
      visibility: "private",
      allowedPrincipals: [],
      force: false,
      validate: true,
    });
    expect(dirty.isError).toBe(true);
    expect(text(dirty)).toMatch(/Machine-readable:/);
    expect(text(dirty)).toContain(ARTIFACT_CSP); // the verbatim CSP is returned on the dirty path too
    expect(text(dirty)).toMatch(/script-src/); // the structured directive is present
    expect(await store.listByOwner(ctx.user.id)).toHaveLength(0);
  });

  it("publishes from a fileUrl by fetching the bytes (injected fetcher)", async () => {
    const ctx = ctxFor();
    const r = await publishArtifact(
      ctx,
      { fileUrl: "https://assets.example/a.html", visibility: "private", allowedPrincipals: [], force: false },
      { fetchHtml: async () => ({ ok: true, html: SELF_CONTAINED }) },
    );
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/v1/);
    const mine = await store.listByOwner(ctx.user.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("My Art");
  });

  it("surfaces a fileUrl fetch failure as an error (and publishes nothing)", async () => {
    const ctx = ctxFor();
    const r = await publishArtifact(
      ctx,
      { fileUrl: "https://assets.example/a.html", visibility: "private", allowedPrincipals: [], force: false },
      { fetchHtml: async () => ({ ok: false, error: "resolves to a non-public address (10.0.0.1)" }) },
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/non-public/i);
    expect(await store.listByOwner(ctx.user.id)).toHaveLength(0);
  });

  it("rejects html and fileUrl together, and rejects neither", async () => {
    const ctx = ctxFor();
    const both = await publishArtifact(ctx, {
      html: SELF_CONTAINED,
      fileUrl: "https://x.example/a.html",
      visibility: "private",
      allowedPrincipals: [],
      force: false,
    });
    expect(both.isError).toBe(true);
    const neither = await publishArtifact(ctx, {
      visibility: "private",
      allowedPrincipals: [],
      force: false,
    });
    expect(neither.isError).toBe(true);
  });

  it("validate: true with a fileUrl still fetches, reports, and publishes nothing", async () => {
    const ctx = ctxFor();
    let fetched = false;
    const r = await publishArtifact(
      ctx,
      {
        fileUrl: "https://assets.example/a.html",
        visibility: "private",
        allowedPrincipals: [],
        force: false,
        validate: true,
      },
      {
        fetchHtml: async () => {
          fetched = true;
          return { ok: true, html: SELF_CONTAINED };
        },
      },
    );
    expect(fetched).toBe(true); // the hasUrl half of the rate-limit/fetch gate runs even on a dry run
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/self-contained/i);
    expect(await store.listByOwner(ctx.user.id)).toHaveLength(0);
  });
});

describe("set_sharing / delete_artifact / get_artifact", () => {
  async function makeOwned(ctx: ToolCtx): Promise<string> {
    return urlOf(
      await publishArtifact(ctx, {
        html: SELF_CONTAINED,
        visibility: "private",
        allowedPrincipals: [],
        force: false,
      }),
    );
  }

  it("set_sharing updates visibility for the owner and blocks non-owners", async () => {
    const owner = ctxFor();
    const url = await makeOwned(owner);
    const ok = await setSharing(owner, { artifact: url, visibility: "everyone", allowedPrincipals: [] });
    expect(ok.isError).toBeFalsy();
    expect(text(ok)).toMatch(/everyone/);

    const stranger = ctxFor();
    const blocked = await setSharing(stranger, {
      artifact: url,
      visibility: "everyone",
      allowedPrincipals: [],
    });
    expect(blocked.isError).toBe(true);
  });

  it("delete_artifact removes it for the owner and blocks non-owners", async () => {
    const owner = ctxFor();
    const url = await makeOwned(owner);

    const stranger = ctxFor();
    expect((await deleteArtifact(stranger, { artifact: url })).isError).toBe(true);

    const ok = await deleteArtifact(owner, { artifact: url });
    expect(ok.isError).toBeFalsy();
    expect(await store.listByOwner(owner.user.id)).toHaveLength(0);
  });

  it("get_artifact returns metadata to a viewer and 404s a non-viewer", async () => {
    const owner = ctxFor();
    const url = await makeOwned(owner);
    const got = await getArtifact(owner, { artifact: url });
    expect(got.isError).toBeFalsy();
    expect(text(got)).toMatch(/Versions \(1\)/);

    const stranger = ctxFor();
    const denied = await getArtifact(stranger, { artifact: url });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/not found/i);
  });

  it("rejects a bad artifact reference", async () => {
    const ctx = ctxFor();
    expect((await getArtifact(ctx, { artifact: "garbage" })).isError).toBe(true);
  });
});

describe("read-only tools", () => {
  it("whoami echoes the connected identity", () => {
    const ctx = ctxFor({ name: "Ada L", email: "ada@example.com" });
    expect(text(whoami(ctx))).toContain("ada@example.com");
  });

  it("list_artifacts surfaces the caller's own artifacts under 'mine'", async () => {
    const ctx = ctxFor();
    await publishArtifact(ctx, {
      html: SELF_CONTAINED,
      visibility: "private",
      allowedPrincipals: [],
      force: false,
    });
    const r = await listArtifacts(ctx, { scope: "mine" });
    expect(text(r)).toMatch(/Your artifacts \(1\)/);
    expect(text(r)).toContain("My Art");
  });

  it("read_comments reports an empty thread for a fresh artifact", async () => {
    const ctx = ctxFor();
    const url = urlOf(
      await publishArtifact(ctx, {
        html: SELF_CONTAINED,
        visibility: "private",
        allowedPrincipals: [],
        force: false,
      }),
    );
    expect(text(await readComments(ctx, { artifact: url }))).toMatch(/No comments/i);
  });
});

describe("get_artifact_html", () => {
  it("returns the current source to a viewer, and a specific version on request", async () => {
    const ctx = ctxFor();
    const v1 = "<!doctype html><html><head><title>Doc</title></head><body>one</body></html>";
    const url = urlOf(
      await publishArtifact(ctx, { html: v1, visibility: "private", allowedPrincipals: [], force: false }),
    );
    const v2 = v1.replace("one", "two");
    await publishArtifact(ctx, { html: v2, url, visibility: "private", allowedPrincipals: [], force: false });

    const cur = await readArtifactHtml(ctx, { artifact: url });
    expect(cur.isError).toBeFalsy();
    expect(text(cur)).toBe(v2);

    const old = await readArtifactHtml(ctx, { artifact: url, version: 1 });
    expect(text(old)).toBe(v1);
  });

  it("404s a non-viewer of a private artifact", async () => {
    const owner = ctxFor();
    const url = urlOf(
      await publishArtifact(owner, {
        html: SELF_CONTAINED,
        visibility: "private",
        allowedPrincipals: [],
        force: false,
      }),
    );
    const r = await readArtifactHtml(ctxFor(), { artifact: url });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not found/i);
  });

  it("rejects a bad reference", async () => {
    expect((await readArtifactHtml(ctxFor(), { artifact: "nope" })).isError).toBe(true);
  });
});
