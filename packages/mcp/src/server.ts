import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  Artifact,
  Version,
  Comment,
  CliTokenResponse,
  PublishResponse,
  ListArtifactsResponse,
  VersionHtmlResponse,
  TOOL_DEFS,
  publishCommonInput,
  buildInstructions,
  formatArtifactDetail,
  formatArtifactLine,
  formatComments,
  extractTitle,
  findExternalRefs,
  formatExternalRefs,
  VALIDATE_CLEAN_NOTE,
  VALIDATE_CSP_NOTE,
  DESIGN_GUIDE,
  STELA_SERVER_META,
  parseArtifactRef,
} from "@stela/shared";
import { stelaDir, credPath } from "./paths";
import { resolveTarget } from "./refs";
import { forgetArtifactById, lookupArtifact, normalizePathKey, recordArtifact } from "./artifact-map";

const API_URL = (process.env.STELA_API_URL ?? "http://localhost:5173").replace(/\/+$/, "");
// Bound every API call so a wedged/slow server can't hang a tool call indefinitely (F55).
const API_TIMEOUT_MS = Number(process.env.STELA_TIMEOUT_MS) || 30_000;

// Never send a credential over plaintext to a remote host. Loopback http is fine for dev.
function isLoopbackUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

/**
 * Refuse to send the per-user token to a non-HTTPS remote host. Called from the entrypoint (index.ts)
 * rather than at module load, so importing this module for tests can't terminate the process.
 */
export function assertSafeApiUrl(): void {
  if (!API_URL.startsWith("https://") && !isLoopbackUrl(API_URL)) {
    process.stderr.write(
      `\nStela: refusing a non-HTTPS remote API URL (${API_URL}). Set STELA_API_URL to https://.\n`,
    );
    process.exit(1);
  }
}

type CredEntry = { token: string; name: string; email: string };
type CredFile = Record<string, CredEntry>; // keyed by API_URL — one login per environment

async function readCreds(): Promise<CredFile> {
  try {
    return JSON.parse(await readFile(credPath(), "utf8")) as CredFile;
  } catch {
    return {};
  }
}

async function writeCreds(all: CredFile): Promise<void> {
  await mkdir(stelaDir(), { recursive: true, mode: 0o700 });
  // Atomic write (tmp + rename) so a process death mid-write can't truncate credentials.json.
  const tmp = `${credPath()}.tmp`;
  await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  await rename(tmp, credPath());
}

/** The credential to send: the configured admin key wins, else the cached per-user token. */
async function currentToken(): Promise<string | null> {
  if (process.env.STELA_API_KEY) return process.env.STELA_API_KEY;
  return (await readCreds())[API_URL]?.token ?? null;
}

type ApiResult = { ok: true; res: Response } | { ok: false; error: string };

/**
 * fetch wrapper that attaches the caller's credential and turns network failures into a clean
 * result. Pass `token: null` to send no credential (used for the pairing-code exchange).
 */
async function api(path: string, init: RequestInit = {}, token?: string | null): Promise<ApiResult> {
  const cred = token === undefined ? await currentToken() : token;
  // Abort if the request doesn't complete in time — undici's global fetch has no overall deadline, so a
  // slow/wedged server or half-open socket would otherwise hang the tool call forever (F55). Bounds
  // connect + headers; the caller reads the body right after, so the residual mid-body stall is small.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { ...(cred ? { "x-api-key": cred } : {}), ...(init.headers ?? {}) },
    });
    return { ok: true, res };
  } catch (e) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? `Stela request timed out after ${API_TIMEOUT_MS / 1000}s (${API_URL}).`
        : `Could not reach Stela at ${API_URL}: ${String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function notSignedIn() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Not signed in to Stela (${API_URL}). Run the \`login\` tool first.`,
      },
    ],
    isError: true,
  };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Validate a server response with its Zod schema instead of an unchecked cast. */
async function parseResponse<T>(
  res: Response,
  schema: { parse: (v: unknown) => T },
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: schema.parse(await res.json()) };
  } catch (e) {
    return { ok: false, error: `Unexpected response from Stela: ${(e as Error).message}` };
  }
}

// --- SSO pairing (one-time browser login) ---

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // cmd.exe treats & | < > as command separators, so an unquoted URL with a query string is
      // truncated at the first '&' — the browser opens '…?port=NNNN' and drops state/code_challenge,
      // and the server rejects it with 400 "Invalid state". Pass the args verbatim with the URL
      // double-quoted so cmd sees one token (the empty "" is start's window-title arg). The pairing
      // URL is base64url params only, so it never contains a `"` that could break out of the quotes.
      spawn("cmd", ["/d", "/s", "/c", `start "" "${url}"`], {
        stdio: "ignore",
        detached: true,
        windowsVerbatimArguments: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    /* the URL is also printed on stderr as a fallback */
  }
}

function donePage(title: string, msg: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:Inter,system-ui,sans-serif;background:#121316;color:#ece6d8;display:grid;place-items:center;height:100vh;margin:0">` +
    `<div style="text-align:center;max-width:420px;padding:32px">` +
    `<div style="font-family:ui-monospace,monospace;font-weight:700;color:#d08a4a;letter-spacing:.22em;text-transform:lowercase;font-size:13px;margin-bottom:10px">stela</div>` +
    `<h1 style="font-size:22px;margin:0 0 8px">${title}</h1>` +
    `<p style="color:#8b867a;font-size:15px;margin:0">${msg}</p></div></body>`
  );
}

/** Open the browser to /cli/authorize and wait for the loopback callback to hand back the code. */
function loopbackAuthorize(state: string, challenge: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const gotState = url.searchParams.get("state") ?? "";
      if (!code || gotState !== state) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(donePage("Sign-in failed", "Please return to your terminal and try again."));
        finish(new Error("state mismatch or missing code"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        donePage("You're signed in to Stela", "Return to your terminal — you can close this tab."),
      );
      finish(null, code);
    });

    const timer = setTimeout(
      () => finish(new Error("timed out waiting for browser sign-in (3 min)")),
      180_000,
    );
    function finish(err: Error | null, code?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(code as string);
    }

    server.on("error", (e) => finish(e as Error));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (!port) {
        finish(new Error("could not bind a loopback port"));
        return;
      }
      const authUrl = `${API_URL}/cli/authorize?port=${port}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}`;
      process.stderr.write(`\nStela sign-in — opening your browser:\n${authUrl}\n\n`);
      openBrowser(authUrl);
    });
  });
}

// Surface-specific revision workflow; the shared intro/authoring/visibility guidance lives in
// @stela/shared so it can't drift from the remote connector's instructions.
const INSTRUCTIONS = buildInstructions(
  "Revisions are automatic: publishing the SAME file again creates a new version at the SAME stable " +
    "URL with full revision history — you never need to track artifact ids. To start a separate " +
    "artifact from a file you've published before, pass newArtifact: true. To publish a new version " +
    "of an artifact someone shared with you, pass its url (read its current source first with " +
    "get_artifact_html).",
);

/**
 * Build the stdio MCP server. Tool *contracts* come from @stela/shared `TOOL_DEFS` (shared with the
 * remote connector so the two surfaces can't drift); the handlers here are this CLI's own HTTP-client
 * implementations against the REST API. Pure (no transport) so it can be unit-tested — index.ts
 * connects the stdio transport. `publish_artifact` takes a file path (vs inline HTML in the connector),
 * so its input is composed locally from the shared `publishCommonInput`.
 */
export function buildLocalServer(): McpServer {
  const server = new McpServer(
    { name: "stela", version: "0.2.0", ...STELA_SERVER_META },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "login",
    {
      title: "Sign in to Stela",
      description:
        "Sign in to Stela as yourself (one-time browser SSO). Caches a per-user token used for publishing.",
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async () => {
      if (process.env.STELA_API_KEY) {
        return {
          content: [
            { type: "text", text: `A configured admin key is already set for ${API_URL}; no login needed.` },
          ],
        };
      }
      try {
        const state = randomBytes(16).toString("base64url");
        // PKCE: keep the verifier in-process; only its hash (challenge) goes in the browser URL.
        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const code = await loopbackAuthorize(state, challenge);
        const r = await api(
          "/cli/token",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code, verifier }),
          },
          null,
        );
        if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
        if (!r.res.ok) {
          return {
            content: [{ type: "text", text: `Sign-in failed (${r.res.status}): ${await r.res.text()}` }],
            isError: true,
          };
        }
        const p = await parseResponse(r.res, CliTokenResponse);
        if (!p.ok) return errorResult(p.error);
        const all = await readCreds();
        all[API_URL] = { token: p.data.token, name: p.data.name, email: p.data.email };
        await writeCreds(all);
        return {
          content: [{ type: "text", text: `Signed in to Stela as ${p.data.name} (${p.data.email}).` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Login failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "logout",
    {
      title: "Sign out of Stela",
      description: "Sign out of Stela on this machine (revokes the cached per-user token).",
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const all = await readCreds();
      const token = all[API_URL]?.token;
      if (!token) {
        return { content: [{ type: "text", text: `No Stela credentials stored for ${API_URL}.` }] };
      }
      // Revoke server-side first, then ALWAYS clear local creds so logout can't be stranded by an
      // unreachable server or an already-dead token; 401/404 means it's already gone.
      const r = await api("/cli/token", { method: "DELETE" }, token);
      delete all[API_URL];
      await writeCreds(all).catch(() => {});
      if (r.ok && (r.res.ok || r.res.status === 401 || r.res.status === 404)) {
        return { content: [{ type: "text", text: `Signed out of Stela (${API_URL}).` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `Cleared local Stela credentials, but couldn't confirm server-side revocation (${r.ok ? `HTTP ${r.res.status}` : r.error}); the token expires on its own.`,
          },
        ],
      };
    },
  );

  server.registerTool("get_design_guide", TOOL_DEFS.get_design_guide, async () => ({
    content: [{ type: "text" as const, text: DESIGN_GUIDE }],
  }));

  server.registerTool("whoami", TOOL_DEFS.whoami, async () => {
    if (process.env.STELA_API_KEY) {
      return {
        content: [{ type: "text", text: `Using the configured Stela admin key for ${API_URL}.` }],
      };
    }
    const creds = (await readCreds())[API_URL];
    if (!creds) return notSignedIn();
    return {
      content: [
        { type: "text", text: `Signed in to Stela (${API_URL}) as ${creds.name} (${creds.email}).` },
      ],
    };
  });

  server.registerTool(
    "publish_artifact",
    {
      title: "Publish artifact to Stela",
      description:
        "Publish a self-contained HTML file to Stela and get a shareable URL. Publishing the SAME file " +
        "again automatically creates a new version at the same stable URL (revision history) — you don't " +
        "need to track artifact ids. Pass `url` to publish a new version of an existing artifact (e.g. one " +
        "shared with you), or `newArtifact: true` to force a brand-new artifact from a file you've published " +
        "before. The HTML must be fully self-contained — Stela serves it under a no-network CSP, so any " +
        "external request makes it render blank. Pass validate: true to dry-run the self-contained check " +
        "without publishing. If you haven't already, call get_design_guide first — it covers how to build " +
        "an artifact that is self-contained AND well-designed (not templated).",
      inputSchema: {
        file: z.string().describe("Absolute path to the self-contained .html file to publish"),
        ...publishCommonInput,
        newArtifact: z
          .boolean()
          .default(false)
          .describe("Force-create a brand-new artifact even if this file was published before."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ file, title, favicon, visibility, allowedPrincipals, url, newArtifact, force, note, validate }) => {
      if (!(await currentToken())) return notSignedIn();

      let html: string;
      try {
        const info = await stat(file);
        if (info.size > 10_000_000) {
          return errorResult(`File is ${(info.size / 1e6).toFixed(1)}MB; the artifact limit is 10MB.`);
        }
        html = await readFile(file, "utf8");
      } catch (e) {
        return errorResult(`Could not read file '${file}': ${String(e)}`);
      }

      // Stela serves under a no-network CSP, so a non-self-contained artifact renders blank. Catch it
      // before publishing rather than after sharing a broken link (force: true to publish anyway).
      const externalRefs = findExternalRefs(html);

      // Dry run: report what the CSP would block (machine-readable) and stop, without publishing.
      if (validate) {
        if (externalRefs.length === 0) {
          return {
            content: [{ type: "text", text: `✓ "${basename(file)}" — ${VALIDATE_CLEAN_NOTE}${VALIDATE_CSP_NOTE}` }],
          };
        }
        return errorResult(
          formatExternalRefs(
            `Validation found ${externalRefs.length} reference(s) Stela's no-network CSP would block (it would render blank):`,
            externalRefs,
          ) + VALIDATE_CSP_NOTE,
        );
      }

      if (externalRefs.length > 0 && !force) {
        return errorResult(
          formatExternalRefs(
            `"${file}" isn't self-contained — Stela serves artifacts under a no-network CSP (default-src 'none'), so these would render blank or fail:`,
            externalRefs,
            `\n\nInline them (embed assets as data:/blob: URIs, drop network calls), or pass force: true to publish anyway.`,
          ),
        );
      }

      const absPath = resolve(file);
      const pathKey = normalizePathKey(absPath);
      const mapped = await lookupArtifact(API_URL, pathKey);
      const target = resolveTarget({ newArtifact, url, mappedId: mapped?.artifactId ?? null });
      if (target.kind === "error") return errorResult(target.message);

      // Title only matters when creating; on a new version the server keeps the existing title stable.
      const resolvedTitle = (
        title?.trim() ||
        extractTitle(html) ||
        basename(absPath).replace(/\.html?$/i, "") ||
        "Untitled artifact"
      ).slice(0, 300);

      const send = (artifactId: string | undefined) =>
        api("/api/artifacts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // A version publish (artifactId set) ignores everything but html/note server-side, yet the whole
          // body is still PublishRequest-validated — so omit favicon/visibility/allowedPrincipals, whose
          // strict schemas (Favicon/EMAIL_OR_USER_ID) could 400 a versioning publish on ignored fields. Keep
          // `title`: PublishRequest requires it (the server ignores it when versioning) (F57).
          body: JSON.stringify(
            artifactId === undefined
              ? { title: resolvedTitle, favicon, html, visibility, allowedPrincipals, note }
              : { title: resolvedTitle, html, artifactId, note },
          ),
        });

      let r = await send(target.kind === "version" ? target.artifactId : undefined);
      if (!r.ok) return errorResult(r.error);

      // A remembered mapping can go stale (artifact deleted, or no longer yours → 404). Transparently
      // fall back to a fresh artifact — but only for auto-mapped ids; an explicit url/id is a deliberate
      // target, so surface its 404 rather than silently forking a copy.
      let staleRecovered = false;
      if (!r.res.ok && r.res.status === 404 && target.kind === "version" && target.source === "map") {
        r = await send(undefined);
        if (!r.ok) return errorResult(r.error);
        staleRecovered = true;
      }

      if (!r.res.ok) {
        const body = await r.res.text();
        const hint =
          r.res.status === 404 && target.kind === "version"
            ? ` — no artifact you can publish to at that reference. Omit \`url\` to publish a new artifact.`
            : "";
        return errorResult(`Publish failed (${r.res.status}): ${body}${hint}`);
      }

      const p = await parseResponse(r.res, PublishResponse);
      if (!p.ok) return errorResult(p.error);

      // Remember (or refresh) where this file publishes so the next publish versions it automatically.
      await recordArtifact(API_URL, pathKey, { artifactId: p.data.id, url: p.data.url }).catch(() => {});

      const versioned = target.kind === "version" && !staleRecovered;
      // Prefer the server's actual stored title — correct even when versioning an artifact whose title
      // differs from this file's <title> (a fork, or a url= target). Fall back for an older server.
      const shownTitle = p.data.title ?? resolvedTitle;
      // Identical-content dedup: the server made no new version because the HTML matched the current
      // one. Report it as a no-op (not a failure) so a re-run / loop doesn't think it published.
      if (p.data.unchanged) {
        return {
          content: [
            {
              type: "text",
              text: `No change — "${shownTitle}" is already v${p.data.version} with identical content, so nothing new was published → ${p.data.url}`,
            },
          ],
        };
      }
      const lead = versioned
        ? `Published v${p.data.version} of "${shownTitle}"`
        : `Published "${shownTitle}"`;
      // A fork re-points this file's auto-version target to the new artifact; say so, so a later plain
      // re-publish of the same file isn't a surprise (pass url= to aim at a different artifact).
      const forked = newArtifact && target.kind === "create";
      // A url= target ALSO re-points this file's remembered target when it differs from the prior
      // mapping — same surprise, so announce it too (the fork guard previously left this path silent).
      const rebound =
        target.kind === "version" &&
        target.source === "url" &&
        (mapped?.artifactId ?? null) !== p.data.id;
      const tail = staleRecovered
        ? " (the previous artifact was gone, so this started a new one)"
        : forked
          ? " — re-publishing this file will now version this new artifact (pass url= to target another)"
          : rebound
            ? " — re-publishing this file will now version this artifact (pass url= to target another)"
            : "";
      const warn =
        externalRefs.length > 0
          ? `\n⚠ Published with ${externalRefs.length} external reference(s) — blocked by Stela's CSP, so it may render blank.`
          : "";
      return { content: [{ type: "text", text: `${lead}${tail} → ${p.data.url}${warn}` }] };
    },
  );

  server.registerTool("list_artifacts", TOOL_DEFS.list_artifacts, async ({ scope }) => {
    if (!(await currentToken())) return notSignedIn();
    const r = await api("/api/artifacts");
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
    if (!r.res.ok) {
      return {
        content: [{ type: "text", text: `List failed (${r.res.status}): ${await r.res.text()}` }],
        isError: true,
      };
    }

    const p = await parseResponse(r.res, ListArtifactsResponse);
    if (!p.ok) return errorResult(p.error);
    const data = p.data;
    const sections: string[] = [];
    if (scope === "mine" || scope === "all") {
      sections.push(
        `# Your artifacts (${data.mine.length})`,
        ...(data.mine.length ? data.mine.map((a) => formatArtifactLine(a, API_URL)) : ["- (none)"]),
      );
    }
    if (scope === "everyone" || scope === "all") {
      sections.push(
        `# Shared with everyone (${data.everyone.length})`,
        ...(data.everyone.length ? data.everyone.map((a) => formatArtifactLine(a, API_URL)) : ["- (none)"]),
      );
    }
    if (scope === "shared" || scope === "all") {
      sections.push(
        `# Shared with you (${data.shared.length})`,
        ...(data.shared.length ? data.shared.map((a) => formatArtifactLine(a, API_URL)) : ["- (none)"]),
      );
    }
    return { content: [{ type: "text", text: sections.join("\n") }] };
  });

  server.registerTool("get_artifact", TOOL_DEFS.get_artifact, async ({ artifact }) => {
    if (!(await currentToken())) return notSignedIn();
    const id = parseArtifactRef(artifact);
    if (!id) return errorResult(`'${artifact}' is not a Stela artifact URL or id.`);

    const [metaRes, versRes] = await Promise.all([
      api(`/api/artifacts/${id}`),
      api(`/api/artifacts/${id}/versions`),
    ]);
    if (!metaRes.ok) return errorResult(metaRes.error);
    if (!metaRes.res.ok) {
      const hint = metaRes.res.status === 404 ? " (not found, or you don't have access)" : "";
      return errorResult(`Lookup failed (${metaRes.res.status})${hint}: ${await metaRes.res.text()}`);
    }
    const meta = await parseResponse(metaRes.res, Artifact);
    if (!meta.ok) return errorResult(meta.error);

    let versions: Version[] = [];
    if (versRes.ok && versRes.res.ok) {
      const parsed = await parseResponse(versRes.res, z.array(Version));
      if (parsed.ok) versions = parsed.data;
    }
    return { content: [{ type: "text", text: formatArtifactDetail(meta.data, versions, API_URL) }] };
  });

  server.registerTool("get_artifact_html", TOOL_DEFS.get_artifact_html, async ({ artifact, version }) => {
    if (!(await currentToken())) return notSignedIn();
    const id = parseArtifactRef(artifact);
    if (!id) return errorResult(`'${artifact}' is not a Stela artifact URL or id.`);
    // The raw render route is session-gated, so a token-bearing fetch can't read it; this api-key
    // route returns the source as JSON. "current" resolves server-side to the latest version.
    const r = await api(`/api/artifacts/${id}/versions/${version ?? "current"}`);
    if (!r.ok) return errorResult(r.error);
    if (!r.res.ok) {
      const hint = r.res.status === 404 ? " (not found, or you don't have access)" : "";
      return errorResult(`Reading source failed (${r.res.status})${hint}: ${await r.res.text()}`);
    }
    const p = await parseResponse(r.res, VersionHtmlResponse);
    if (!p.ok) return errorResult(p.error);
    // Return the raw source verbatim — nothing else — so the model can edit it and republish cleanly.
    return { content: [{ type: "text", text: p.data.html }] };
  });

  server.registerTool("read_comments", TOOL_DEFS.read_comments, async ({ artifact, version }) => {
    if (!(await currentToken())) return notSignedIn();
    const id = parseArtifactRef(artifact);
    if (!id) return errorResult(`'${artifact}' is not a Stela artifact URL or id.`);

    // Resolve the artifact first — for its title and (when version is omitted) its current version.
    const metaRes = await api(`/api/artifacts/${id}`);
    if (!metaRes.ok) return errorResult(metaRes.error);
    if (!metaRes.res.ok) {
      const hint = metaRes.res.status === 404 ? " (not found, or you don't have access)" : "";
      return errorResult(`Lookup failed (${metaRes.res.status})${hint}: ${await metaRes.res.text()}`);
    }
    const meta = await parseResponse(metaRes.res, Artifact);
    if (!meta.ok) return errorResult(meta.error);
    const v = version ?? meta.data.currentVersion;

    const commentsRes = await api(`/api/artifacts/${id}/comments?v=${v}`);
    if (!commentsRes.ok) return errorResult(commentsRes.error);
    if (!commentsRes.res.ok) {
      return errorResult(`Reading comments failed (${commentsRes.res.status}): ${await commentsRes.res.text()}`);
    }
    const parsed = await parseResponse(commentsRes.res, z.array(Comment));
    if (!parsed.ok) return errorResult(parsed.error);

    return {
      content: [
        {
          type: "text",
          text: formatComments(parsed.data, { title: meta.data.title, version: v, apiUrl: API_URL, id }),
        },
      ],
    };
  });

  server.registerTool(
    "set_sharing",
    TOOL_DEFS.set_sharing,
    async ({ artifact, visibility, allowedPrincipals }) => {
      if (!(await currentToken())) return notSignedIn();
      const id = parseArtifactRef(artifact);
      if (!id) return errorResult(`'${artifact}' is not a Stela artifact URL or id.`);
      const r = await api(`/api/artifacts/${id}/sharing`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility, allowedPrincipals }),
      });
      if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
      if (!r.res.ok) {
        return {
          content: [{ type: "text", text: `Set sharing failed (${r.res.status}): ${await r.res.text()}` }],
          isError: true,
        };
      }

      const p = await parseResponse(r.res, Artifact);
      if (!p.ok) return errorResult(p.error);
      const a = p.data;
      const who =
        a.visibility === "restricted" ? ` (${a.allowedPrincipals.join(", ") || "no one yet"})` : "";
      return { content: [{ type: "text", text: `Sharing for "${a.title}" → ${a.visibility}${who}` }] };
    },
  );

  server.registerTool("delete_artifact", TOOL_DEFS.delete_artifact, async ({ artifact }) => {
    if (!(await currentToken())) return notSignedIn();
    const id = parseArtifactRef(artifact);
    if (!id) return errorResult(`'${artifact}' is not a Stela artifact URL or id.`);
    const r = await api(`/api/artifacts/${id}`, { method: "DELETE" });
    if (!r.ok) return errorResult(r.error);
    if (r.res.status === 404) {
      // Already gone (or never yours) — heal the local mapping so a re-publish won't chase it.
      await forgetArtifactById(API_URL, id).catch(() => {});
      return errorResult(`No artifact ${id} to delete (not found, or you don't own it).`);
    }
    if (!r.res.ok) {
      return errorResult(`Delete failed (${r.res.status}): ${await r.res.text()}`);
    }
    await forgetArtifactById(API_URL, id).catch(() => {});
    return { content: [{ type: "text", text: `Deleted artifact ${id}.` }] };
  });

  return server;
}
