# Contributing

Thanks for looking! Stela is a small, opinionated codebase; contributions are welcome, and
the conventions below keep it that way.

## Setup

Node ≥ 22.5. pnpm via `corepack enable` or `npx pnpm`.

```bash
npx pnpm install
npx pnpm dev        # app on :5173 with a dev identity and sqlite in .data/
```

## Gates (all must pass)

```bash
npx pnpm -r check   # svelte-check + tsc --strict — 0 errors, 0 warnings
npx pnpm -r test    # vitest — sqlite storage tests need nothing extra
```

The Azure-driver leg of the storage conformance suite needs the Azurite emulator
(`npx pnpm dev:storage`); it's optional locally and runs in CI.

## Hard rules

These invariants are what keep the codebase honest — PRs that break them will be asked to
restructure:

- **Storage SDKs stay behind the `Store` interface** — nothing outside
  `packages/app/src/lib/server/storage/` may import `node:sqlite` or the Azure SDKs. New
  storage backends implement `Store` and join the conformance suite.
- **Identity headers are read only in `packages/app/src/lib/server/auth/`** — everything
  else uses `getCurrentUser()` / `authenticateApiKey()` / `locals.user`.
- **Route handlers go through `lib/server/guards.ts`** for auth/authz/validation.
- **Versions are immutable** — republish appends; nothing edits a published version.
- Shared DTOs live in `packages/shared` (Zod) and are imported by UI, API, and MCP alike.
- TypeScript strict everywhere; Svelte 5 runes mode; no `any` smuggling.

## Design

UI changes should speak the design language (*cut basalt · ochre pigment · lapis seal*) —
read [`DESIGN.md`](DESIGN.md) first. Tokens over hardcoded colors,
always.
