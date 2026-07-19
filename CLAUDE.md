# Stela

Self-hosted platform to host and share **agent-built artifacts** (self-contained HTML — the shape Claude's artifacts popularized). Any MCP-capable agent can publish; share privately, server-wide, or with named people; every artifact gets a stable URL, immutable **revision history**, and **pinned visual comments**. *Stela: an inscribed stone slab erected for public display.*

## Stack

pnpm workspaces, TypeScript strict end-to-end, SvelteKit + Svelte 5 (runes, `adapter-node`).

- `packages/shared` — Zod schemas/types (Artifact, Version, Comment, Anchor, sharing DTOs) imported by UI, API, **and** MCP.
- `packages/app` — the deployable: UI + API + the remote MCP endpoint (`/mcp`, Streamable HTTP) + Stela's own OAuth 2.1 AS (PKCE, DCR) for MCP clients.
- `packages/mcp` — stdio MCP server for CLI agents (`stela-mcp`): publish by file path, auto-versioning via `~/.stela/artifacts.json`.

## Identity & storage (the two pluggable seams)

- **Auth = trusted headers.** An identity-aware proxy in front of the app injects identity; Stela has NO account system — first sight of a new id is enrollment. `AUTH_MODE=header` + `AUTH_HEADER_ID/NAME/EMAIL` (generic), or `AUTH_PRESET=easyauth` (Azure Easy Auth contract). Dev builds use a dev-shim user. Prod **fails loud at boot** if auth is unconfigured. Optional `AUTH_LOGIN_URL` redirects anonymous browser navs.
- **Storage = `Store` interface** (`lib/server/storage/types.ts`) with two drivers: `sqlite` (default — `node:sqlite`, one `DATA_DIR/stela.db`, WAL, STRICT tables) and `azure` (Tables + Blobs, ETag concurrency). `STORAGE_DRIVER` selects; prod requires it explicitly, sqlite requires a writable `DATA_DIR`. Driver-agnostic semantics (title sync, republish dedup, hashing, PKCE, TTLs, token cap) live in `storage/shared.ts`.

## Hard rules

- **Never** touch a storage SDK (`node:sqlite`, `@azure/*`) outside `packages/app/src/lib/server/storage/` — depend on `getStore()` / the `Store` interface.
- **Never** read identity headers outside `packages/app/src/lib/server/auth/` — use `getCurrentUser()` / `authenticateApiKey()` / `locals.user`.
- Route handlers go through `lib/server/guards.ts` (auth/authz/validation, same-origin CSRF for browser mutations).
- Artifacts are **immutable per version**; republish appends (identical bytes dedup); the share URL stays stable. Comments are scoped to the version they were made on.
- Artifacts render in an opaque-origin sandboxed iframe under `default-src 'none'` CSP — no network egress. `fetchRemoteHtml.ts` is the app's only outbound request path and is SSRF-hardened; keep it that way.
- `svelte-check` + `tsc --strict` must pass with 0 errors; tests via `npx pnpm -r --if-present test` (vitest).

## Development

- pnpm may not be installed globally — `npx pnpm …` always works.
- `npx pnpm dev` → app on :5173, dev identity, sqlite in `packages/app/.data/` (gitignored). Route tests write to `.data-test/` (pinned in `vitest.config.ts`) — never to the dev gallery.
- The storage conformance suites (`storage/*.conformance.test.ts`) run every contract test against BOTH drivers. The sqlite leg needs nothing; **the azure leg needs Azurite listening** (`npx pnpm dev:storage`) — without it those tests burn 5s timeouts each and the run looks hung.
- Deploy story: `Dockerfile` + `compose.yaml` (auth proxy in front; `--profile demo` bundles a static-identity Caddy). `BODY_SIZE_LIMIT` ~12 MB; publish schema caps HTML at 10 MB; `ORIGIN` must match the public URL or publish URLs + CSRF break.

## Design

The interface is its own design system — **"stela — the slab: cut basalt · ochre pigment · lapis seal"** — fully documented in `DESIGN.md`. Tokens live in `packages/app/src/app.css`; never hardcode palette values in components. The mark (boustrophedon glyph) lives in `lib/components/Logo.svelte` + `static/favicon.svg` — keep them in sync.
