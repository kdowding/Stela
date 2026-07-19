import { z } from "zod";
import { Visibility, Favicon } from "./artifact";
import { ARTIFACT_CSP } from "./csp";
import { EMAIL_OR_USER_ID } from "./api";

/**
 * Single source of truth for the Stela MCP tool *contracts* — name, title, description, input
 * schema, annotations — shared by both server surfaces:
 *   • the standalone CLI MCP (packages/mcp), a stdio server that talks to the REST API, and
 *   • the in-process remote connector (packages/app, the /mcp route) used by claude.ai.
 * The two differ only in their *handlers* (HTTP delegation vs direct store access) and their
 * transport/auth — the contracts must not drift, so they live here and both register from them.
 *
 * `publish_artifact` is the one tool whose input legitimately differs per surface (a local file
 * path vs inline HTML), so it isn't in TOOL_DEFS; its common fields live in `publishCommonInput`
 * and each surface composes the rest. A parity test on each side asserts that the tools it actually
 * registers match CROSS_IMPL_TOOL_NAMES (the CLI adds login/logout on top).
 */

const artifactRef = z.string().describe("A Stela artifact URL (…/a/{id}) or its id");
const versionOpt = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Which version to read. Defaults to the artifact's current version.");

export const TOOL_DEFS = {
  whoami: {
    title: "Show Stela identity",
    description: "Show which Stela identity you're acting as.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  get_design_guide: {
    title: "Get the Stela design guide",
    description:
      "Read this BEFORE authoring or publishing an artifact. Covers what Stela requires (its no-network " +
      "CSP and fully self-contained HTML) AND how to make an artifact that is both compliant and genuinely " +
      "well-designed — recipes for fonts/icons/charts with no network, taste principles, and the generic " +
      "look to avoid. Takes no arguments; call it first whenever you're asked to create or publish a " +
      "Stela artifact.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  list_artifacts: {
    title: "List Stela artifacts",
    description:
      "List Stela artifacts you've published, ones shared server-wide, and ones shared directly with you.",
    inputSchema: {
      scope: z
        .enum(["mine", "everyone", "shared", "all"])
        .default("mine")
        .describe("Which set to list: your own (mine), server-wide, shared directly with you, or all"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  get_artifact: {
    title: "Get a Stela artifact",
    description:
      "Look up a Stela artifact's metadata and version history by URL or id — e.g. to find the id / " +
      "current version of one you published earlier, or that someone shared with you. Read-only.",
    inputSchema: { artifact: artifactRef },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  get_artifact_html: {
    title: "Read an artifact's HTML source",
    description:
      "Return the full, self-contained HTML source of an artifact (the current version by default, or a " +
      "specific one). Use this to EDIT an existing artifact: read the source, modify it, then publish a " +
      "new version of the same artifact.",
    inputSchema: { artifact: artifactRef, version: versionOpt },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  set_sharing: {
    title: "Change artifact sharing",
    description: "Change who can view an artifact you own (private / everyone / specific people).",
    inputSchema: {
      artifact: artifactRef,
      visibility: Visibility.describe(
        "private (you), everyone (anyone signed in to the server), or restricted (specific people)",
      ),
      allowedPrincipals: z
        .array(EMAIL_OR_USER_ID)
        .max(500)
        .default([])
        .describe("Emails/user ids allowed to view when visibility is 'restricted'"),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  read_comments: {
    title: "Read Stela artifact comments",
    description:
      "Read the pinned review comments on a Stela artifact (by URL or id) so you can address the " +
      "feedback and re-publish — closing the review loop. Read-only. Defaults to the current version; " +
      "pass version to read an older revision's comments.",
    inputSchema: { artifact: artifactRef, version: versionOpt },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  delete_artifact: {
    title: "Delete a Stela artifact",
    description:
      "Permanently delete an artifact you own — all versions, comments, and history. This cannot be " +
      "undone. Accepts a URL or id.",
    inputSchema: { artifact: artifactRef },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
};

/**
 * publish_artifact input fields common to both surfaces. Each surface adds its own source field
 * (CLI: `file`; connector: `html`) and the CLI also adds `newArtifact`.
 */
export const publishCommonInput = {
  title: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe("Title for the artifact. Defaults to the HTML <title>, then the file name."),
  favicon: Favicon.optional().describe(
    "Emoji for the artifact's browser-tab / gallery icon, e.g. 📊. Optional; set on create, stable across versions.",
  ),
  visibility: Visibility.default("private").describe(
    "private (you), everyone (anyone signed in to the server), or restricted (specific people). Applies when " +
      "CREATING a new artifact; ignored when versioning an existing one — use set_sharing to change it.",
  ),
  allowedPrincipals: z
    .array(EMAIL_OR_USER_ID)
    .max(500)
    .default([])
    .describe("When visibility is 'restricted', the emails/user ids allowed to view"),
  url: z
    .string()
    .optional()
    .describe("A Stela artifact URL or id to add this as a new version of. Omit to create a new artifact."),
  note: z.string().max(2000).optional().describe("Optional changelog note for this version"),
  force: z
    .boolean()
    .default(false)
    .describe(
      "Publish even if the HTML references external resources or makes network calls — Stela's CSP " +
        "blocks those, so the artifact may render blank. Only set this if you're sure.",
    ),
  validate: z
    .boolean()
    .default(false)
    .describe(
      "Dry run — check the HTML against Stela's no-network CSP and return any blocking references " +
        "(machine-readable) WITHOUT publishing. Use it to self-check before shipping.",
    ),
};

/**
 * Every tool both surfaces must expose: the 7 in TOOL_DEFS plus publish_artifact. The CLI MCP also
 * registers login/logout (it does its own SSO pairing; the connector authenticates via OAuth).
 */
export const CROSS_IMPL_TOOL_NAMES: string[] = [...Object.keys(TOOL_DEFS), "publish_artifact"];

/**
 * Server-level display metadata spread into both surfaces' MCP `serverInfo` (initialize result).
 * `icons` follows the MCP 2025-11-25 icons spec, deliberately using a data: URI rather than an https
 * URL — Stela's /favicon.svg sits behind the auth proxy, so an unauthenticated host icon-fetch may
 * receive a login/401 response. Mirrors packages/app/static/favicon.svg. Rendering is
 * CLIENT-DEPENDENT (hosts that read serverInfo.icons show it; most still show a generic icon for
 * custom servers), so this is
 * best-effort: it costs nothing and lights up wherever support lands.
 */
export const STELA_SERVER_META = {
  title: "Stela",
  icons: [
    {
      src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiIgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIj4KICA8cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHJ4PSI3IiBmaWxsPSIjMGMxNjJmIiAvPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJzIiB4MT0iNSIgeTE9IjI2IiB4Mj0iMjciIHkyPSI2IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzM2NTJjZCIgLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMzliMzRhIiAvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICA8L2RlZnM+CiAgPHBhdGggZD0iTTUgMjUgTDEzIDEyIEwxOC41IDIxIEwyMS41IDE2IEwyNyAyNSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ1cmwoI3MpIiBzdHJva2Utd2lkdGg9IjIuNiIKICAgIHN0cm9rZS1saW5lam9pbj0icm91bmQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgLz4KICA8Y2lyY2xlIGN4PSIxMyIgY3k9IjkuMiIgcj0iMi43IiBmaWxsPSIjMzliMzRhIiAvPgo8L3N2Zz4K",
      mimeType: "image/svg+xml",
      sizes: ["any"],
    },
  ],
};

// --- Server `instructions` (lands in the host's system prompt) ---

const INSTRUCTIONS_INTRO =
  "Stela hosts self-contained HTML artifacts — single-file HTML pages an agent produces (dashboards, " +
  "prototypes, reports) — and shares them with people outside the chat: privately, server-wide, or " +
  "with named people.";
const INSTRUCTIONS_AUTHORING =
  "Authoring: BEFORE creating an artifact, call get_design_guide — it covers Stela's constraints AND how " +
  "to make the result genuinely well-designed (not templated). In short: write fully self-contained HTML — " +
  "inline ALL CSS/JS and embed assets as data: (or blob:) " +
  'URIs. Stela serves artifacts under exactly this CSP: "' +
  ARTIFACT_CSP +
  '". So inline <script>/<style> run and data:/blob: fonts, images and media load — but there is NO ' +
  "network: external <script src>, <link rel=stylesheet>, remote url(), and fetch/XHR/WebSocket all " +
  "fail and render the artifact blank. This includes RUNTIME loads: a component that pulls its " +
  "framework (React/Vue) or any library from a CDN while booting renders blank too, even though the " +
  "static HTML looks clean — bundle ALL runtime dependencies inline. (Inert <link " +
  "rel=preconnect|dns-prefetch|preload> hints are ignored — leave them in or not.) publish_artifact " +
  "refuses external refs unless force: true; pass validate: true to dry-run that check without " +
  "publishing. Give it a <title>.";
const INSTRUCTIONS_VISIBILITY =
  "Default visibility is private. Confirm with the user before publishing 'everyone' (the whole server) " +
  "or 'restricted' (named people).";

/**
 * Compose the server instructions, injecting the surface-specific revision-workflow paragraph (the
 * CLI versions an artifact by re-publishing the same file; the connector by passing the artifact url).
 */
export function buildInstructions(revisionWorkflow: string): string {
  return [
    INSTRUCTIONS_INTRO,
    "",
    INSTRUCTIONS_AUTHORING,
    "",
    revisionWorkflow,
    "",
    INSTRUCTIONS_VISIBILITY,
  ].join("\n");
}

/**
 * Message for a CLEAN `validate` dry-run. Deliberately does NOT say "safe to publish": the check is a
 * static scan and can't see a framework/library that a bundled runtime CDN-loads at boot (which still
 * renders blank). Shared so both MCP surfaces report the same caveat and can't drift.
 */
export const VALIDATE_CLEAN_NOTE =
  "No external references in the static HTML — it looks self-contained. Caveat: this is a static scan " +
  "and can't see scripts a bundled runtime loads at boot (e.g. a framework CDN-loaded at runtime), which " +
  "would still render blank — make sure any framework/library is inlined, not CDN-loaded.";

/**
 * Appended to EVERY validate result (clean OR flagged): the verbatim sandbox CSP. A static scan can't
 * see runtime-injected CDN loads, so the reliable self-check is to render a local copy under this exact
 * policy (a <meta http-equiv> reproduces the resource directives) and look for the blank/violation.
 */
export const VALIDATE_CSP_NOTE = `\n\nSandbox CSP (render a local copy under this to self-check): ${ARTIFACT_CSP}`;

/**
 * The Stela design guide — returned verbatim by the get_design_guide tool on BOTH surfaces. Written
 * to be ENVIRONMENT-AGNOSTIC: it assumes no filesystem, no repo, and no design-system file, because
 * most callers are remote connectors (Grok / ChatGPT / Copilot / claude.ai) that have only the
 * conversation and these tools. It fuses Stela's hard constraints with general design taste so any
 * connecting model can produce an artifact that is both compliant AND well-designed. The CSP is
 * interpolated from the single source so it can't drift. No backticks in the body (template literal).
 */
export const DESIGN_GUIDE = `# Stela Design Guide

Read this before authoring an artifact for Stela. It has two jobs: make sure your artifact actually WORKS under Stela's constraints, and make sure it is genuinely well-designed instead of templated. A beautiful artifact that renders blank is useless; a working artifact that looks generic wastes the medium.

## 1. What Stela requires (non-negotiable)

Stela serves every artifact as a single HTML document in a locked-down sandbox under exactly this Content-Security-Policy:

${ARTIFACT_CSP}

In plain terms: inline everything, fetch nothing.
- Inline <style> and <script> run. data: and blob: URLs work for fonts, images, and media.
- There is NO network. An external <script src>, <link rel="stylesheet">, @import url(https://...), web-font link, fetch / XHR / WebSocket, or any remote URL fails silently and the artifact renders blank.
- This includes RUNTIME loads — the most common failure. A component that boots a framework (React, Vue, etc.) or a library from a CDN while it starts up looks clean in the static HTML but renders blank, because the framework never arrives. If you are using a "standalone HTML export" from a component tool, check whether its runtime pulls anything from a CDN; if it does, it will not work here. Bundle every dependency inline, or write it framework-free.
- Inert <link rel="preconnect|dns-prefetch|preload"> hints are ignored (not errors) — leave them or remove them.
- NO durable storage, either. The sandbox runs your HTML at an OPAQUE origin, so localStorage, sessionStorage, and cookies all THROW a SecurityError on access — and reading one un-guarded at startup crashes the whole script (a common way a "Save" button silently kills every handler wired below it). Keep state in memory for the session, wrap any storage access in try/catch, and never imply persistence that survives a reload.

Always dry-run before publishing: call publish_artifact with validate: true. It returns any blocking references without publishing. A clean result means the static HTML has no external refs; if your environment can render HTML, also open a local copy under the CSP above (a <meta http-equiv="Content-Security-Policy"> tag reproduces the resource rules) and confirm it actually paints.

## 2. How to be self-contained (recipes)

You can build almost anything inside the cage — you just reach for different tools:
- Fonts: you cannot link Google Fonts. Either design with a strong system-font stack (fast, zero bytes), or, if a specific face is essential, embed ONE subsetted weight as a data: URI inside an @font-face src. Do not embed many weights; it bloats the file.
- Icons: inline <svg> directly. No icon-font CDNs, no icon libraries over the network.
- Images / illustration: small raster as data: URIs; prefer CSS gradients, shapes, and inline SVG for decoration — they cost almost nothing and never fail to load.
- Charts / data viz: draw with <canvas> or hand-written inline SVG. Do NOT load a charting library from a CDN.
- Interactivity: vanilla JS in an inline <script>. You do not need a framework for tabs, reveals, accordions, filtering, or small state. If you genuinely want one, its full source must be inlined in the document.
- Honest controls: every button must do something real. With no backend and no durable storage, do not add Save / Sync controls that imply persistence — keep edits in memory for the session, or make the control genuinely client-side: print via window.print(), "download" by building a data: URI or Blob behind an <a download>. If a control can't truly work here, leave it out.

## 3. Make it good, not templated

Working is the floor; design is the point. Give each artifact a specific identity — not a layout you would hand to any other subject.
- Ground it in the subject. The best source of distinctive choices is what the thing actually IS — its domain, vocabulary, and mood. Build with the real content you are given, never lorem ipsum or invented filler. If the person gave you colors, type, or a brand in the conversation, honor those exactly; otherwise design for the subject.
- Commit a small system first, then build. Before writing markup, decide: a 4-6 color palette (named hex values), two type roles (a display face with personality + a readable body face), and a one-line layout idea. Derive every later color and type choice from that system so the page is coherent.
- Avoid the default AI look. Generic AI design clusters into a few tells: cream background + high-contrast serif + terracotta accent; near-black + one acid-bright accent; or hairline-ruled "broadsheet" columns. Each is fine IF the subject calls for it — but if you would produce the same look for any topic, it is a default, not a choice.
- The hero is a thesis. Open with the most characteristic thing about the subject — a statement, a number, a visual, a live demo — chosen deliberately. A big stat with a small label over a gradient is the template answer; use it only if it is genuinely best here.
- Type carries the personality. Set a real scale with intentional contrast in weight, size, and spacing. This is where you have the most expressive room despite the no-font-loading rule (see section 4).
- Structure should mean something. Numbered steps (01 / 02 / 03) only when the content is truly a sequence. Eyebrows, dividers, and labels should encode real structure, not decorate.
- One motion moment, not many. A single orchestrated animation lands; scattered effects read as machine-generated. Respect prefers-reduced-motion.
- Spend boldness once. Pick the one memorable thing and let everything around it stay quiet. Cap intensity — at most two of {vivid color, dense atmosphere, motion} at full strength. Loud everywhere is as much a tell as bland everywhere.

## 4. Personality without loadable fonts

Because you cannot pull web fonts, typography takes more craft, not less:
- Build a deliberate system-font stack and lean on what you CAN control: weight contrast (e.g. an 800 display against 400 body), size jumps, letter-spacing, line-height, and font-feature-settings. A tight type scale in plain system fonts can look sharp and intentional.
- Get atmosphere from CSS, not assets: layered gradients, radial-gradient glows, subtle noise, backdrop-filter, shadows, hairline borders. All self-contained, all expressive.
- If one specific typeface truly makes the design, embed a single subsetted weight as a data: @font-face — a deliberate exception, not a habit.

## 5. Copy is design material

Words are part of the design; generic copy makes a page feel as templated as a generic layout.
- Write from the reader's side of the screen. Name things by what people recognize and do, not by how the system works.
- Active voice, sentence case, plain verbs, no filler. A control says what it does, and an action keeps its name through the whole flow.
- Specific beats clever.
- NEVER fabricate data. Numbers, stats, logos, and quotes must be real, or CLEARLY illustrative (labeled as a sample / mockup). Inventing "47 published this month" or a competitor comparison as if it were fact undermines the artifact and the person sharing it. When you do not have a real figure, leave it out or mark it illustrative.

## 6. Multi-page artifacts (so review comments land on the right page)

If your artifact has multiple screens — a sidebar that swaps views, a tabbed prototype, a wizard — Stela scopes each review comment to the PAGE it was placed on, so feedback stays with the right screen instead of floating over the wrong one. This is automatic; you do not have to do anything. A few habits just make the detection sharper and the page names friendlier, and all are optional:
- Keep every page in the DOM and show/hide them (toggle a class / display) instead of tearing down one screen to build the next. This matters most: a page that exists only while it is active cannot be told apart. The one-of-N-visible pattern (one section shown, the rest display:none) is exactly right.
- Name each page. Stela reads data-stela-view="rate-card" on the page's container first, then a stable id, a distinguishing data- attribute shared across the pages, or the page's heading; a data-stela-view-label="Rate card" (or a clear heading) becomes the page's name in the comment list.
- Drive navigation from a real control (a nav item, a tab) or the URL hash — not an ephemeral in-memory jump.

Do none of it and comments still work; they just fall back to spanning the whole artifact when pages can't be distinguished.

## 7. Before you publish
- Run validate: true first — every time.
- Default visibility is private; confirm before publishing server-wide or to specific people.
- Re-publishing the same artifact (pass its url) creates a new version at the same link — iterate freely.

Working and self-contained is the contract. Distinctive and honest is the bar.`;
