import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOOL_DEFS, publishCommonInput, buildInstructions, STELA_SERVER_META } from "@stela/shared";
import type { SessionUser } from "$lib/server/auth";
import {
  whoami,
  designGuide,
  listArtifacts,
  publishArtifact,
  getArtifact,
  readArtifactHtml,
  setSharing,
  deleteArtifact,
  readComments,
  type ToolCtx,
} from "./tools";

// Surface-specific revision workflow; the shared intro/authoring/visibility guidance lives in
// @stela/shared so it can't drift from the CLI MCP's instructions.
const INSTRUCTIONS = buildInstructions(
  "Revisions: publishing returns a stable artifact URL. To revise an existing artifact, FIRST read " +
    "its current HTML with get_artifact_html, edit that source, then call publish_artifact with the " +
    "same url — it adds a new version at the same URL with full history. This connector acts as the " +
    "signed-in Stela user.",
);

/**
 * Build a per-request MCP server bound to the OAuth-authenticated user. Stateless: a fresh instance
 * per HTTP request. Tool *contracts* come from @stela/shared `TOOL_DEFS` (shared with the CLI MCP
 * so the two surfaces can't drift); this file only binds them to the connector's in-process handlers.
 * `publish_artifact` differs per surface (inline HTML here vs a file path in the CLI), so its schema
 * is composed locally from the shared `publishCommonInput`.
 */
export function buildMcpServer(user: SessionUser, origin: string): McpServer {
  const server = new McpServer(
    { name: "stela", version: "0.2.0-remote", ...STELA_SERVER_META },
    { instructions: INSTRUCTIONS },
  );
  const ctx: ToolCtx = { user, origin };

  server.registerTool("get_design_guide", TOOL_DEFS.get_design_guide, async () => designGuide());

  server.registerTool("whoami", TOOL_DEFS.whoami, async () => whoami(ctx));

  server.registerTool("list_artifacts", TOOL_DEFS.list_artifacts, async (args) =>
    listArtifacts(ctx, args),
  );

  server.registerTool(
    "publish_artifact",
    {
      title: "Publish or update a Stela artifact",
      description:
        "Publish a self-contained HTML artifact to Stela and get a shareable URL. Provide the HTML " +
        "inline via `html`, OR pass `fileUrl` (a short-lived public https URL) and Stela fetches the " +
        "bytes — prefer fileUrl for large or asset-heavy exports so you don't inline base64 by hand. To " +
        "revise an existing artifact, pass its `url` (works with either source). Inline all CSS/JS and " +
        "embed assets as data:/blob: URIs (no external requests, or it renders blank); pass validate: " +
        "true to dry-run the check without publishing. If you haven't already, call get_design_guide " +
        "first — it covers how to build an artifact that is self-contained AND well-designed (not templated).",
      inputSchema: {
        html: z
          .string()
          .min(1)
          .max(10_000_000)
          .optional()
          .describe(
            "The complete, self-contained artifact HTML (inline CSS/JS; data:/blob: URIs for assets). Provide html OR fileUrl.",
          ),
        fileUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "A short-lived, public https URL Stela will fetch the artifact HTML from (once, immediately). " +
              "Use instead of html for large/asset-heavy exports. Must be fetchable with no auth.",
          ),
        ...publishCommonInput,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => publishArtifact(ctx, args),
  );

  server.registerTool("get_artifact", TOOL_DEFS.get_artifact, async (args) => getArtifact(ctx, args));

  server.registerTool("get_artifact_html", TOOL_DEFS.get_artifact_html, async (args) =>
    readArtifactHtml(ctx, args),
  );

  server.registerTool("set_sharing", TOOL_DEFS.set_sharing, async (args) => setSharing(ctx, args));

  server.registerTool("read_comments", TOOL_DEFS.read_comments, async (args) =>
    readComments(ctx, args),
  );

  server.registerTool("delete_artifact", TOOL_DEFS.delete_artifact, async (args) =>
    deleteArtifact(ctx, args),
  );

  return server;
}
