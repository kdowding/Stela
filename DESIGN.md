# Stela design system

**stela — the slab: cut basalt · ochre pigment · lapis seal**

A *stela* is an inscribed stone slab erected for public display. The interface is the slab:
a dark basalt field under raking light, limestone text, and two pigments with real
archaeology behind them — **red ochre**, the pigment ancient carvers rubbed into
inscriptions to make them legible, and **lapis**, the seal-stone blue. Artifacts render in
their own sandboxed canvases and keep whatever theme they ship; the design system below is
the *portal chrome* around them.

Stela's language is kin to [englyph.dev](https://englyph.dev) (*obsidian void · gilded
inscription · verdigris query*): same family, different material — **stone, not void**.
Where englyph is deep-space black with gilded writing, Stela is warm basalt with pigment
pressed into cuts.

## Palette

All tokens live in `packages/app/src/app.css` (`:root`). Never hardcode these values in
components — reference the token.

| Token | Value | Role |
|---|---|---|
| `--ochre` | `#d08a4a` | The pigment. Accent, primary actions, comment pins, `everyone` |
| `--ochre-bright` | `#e8ae74` | Hover / gradient high end |
| `--ochre-deep` | `#7c521f` | Selection, pressed states |
| `--lapis` | `#647fdd` | The seal. Links, `restricted`, secondary actions, focus rings |
| `--lapis-bright` | `#8ba1ea` | Links on dark |
| `--lapis-deep` | `#35418f` | Gradient low end |
| `--pigment-ink` | `#241203` | Text on an ochre fill |
| `--surface-2` | `#121316` | App background (basalt) |
| `--surface` | `#1a1c21` | Cards, menus, modals |
| `--surface-tint` | `#24262d` | Hover, chips, code |
| `--fg` | `#ece6d8` | Limestone — headings, strong text |
| `--text` | `#c8c2b3` | Body text |
| `--muted` | `#8b867a` | Secondary text |
| `--danger` | `#e06c55` | Ember |
| `--ok` | `#56b681` | Malachite |

Visibility badges speak the palette: **private** = bare stone (neutral), **everyone** =
ochre (pigment for all to read), **restricted** = lapis (sealed).

## Typography

- **Body**: Inter — an app wants a reading face, not a flex.
- **The inscription register**: JetBrains Mono (`--font-mono`) with tracked spacing for
  everything that is a *label carved into the chrome* rather than prose: badges, section
  heads, metadata, timestamps, the wordmark. The rule of thumb: if it labels, it's mono;
  if it explains, it's sans.
- **Wordmark**: `stela`, lowercase, mono, `letter-spacing: 0.22em`.

## Motifs

- **The chamfer** (`--chamfer: 12px`): one knocked corner marks a surface as cut stone.
  Card previews clip their top-right corner (`clip-path`), revealing the card's stone as a
  facet. Use sparingly — one cut per surface. `clip-path` clips outer shadows, so pair
  chamfers with hairline borders, not elevation.
- **Incisions**: hairline rules and faint line motifs read as cuts; the *ochre* line among
  bare cuts is the one with pigment — use it to mark the live/current/important row.
- **Pigment dust**: small ochre/lapis dots as decor accents (hero), very low count.
- **The mark**: the *boustrophedon glyph* — one continuous incision snaking through three
  rows, the way the oldest stelae were actually written ("as the ox plows"), ending in the
  ochre seal, set in a chamfered tile (the artifact-card shape). Inscription and circuit
  trace in one stroke. Drawn in `currentColor` so it works on dark chrome (limestone
  context) and light tiles (dark-stone context). Lives in `lib/components/Logo.svelte` and
  `static/favicon.svg` — keep them in sync.
- **The stele field** (home hero): standing slabs at graded depths on a ground line whose
  light runs limestone→ochre; the nearest slab carries the pigmented incision. Section
  heads echo it — tracked mono labels with an incision rule running to the page edge.

## Surfaces

- **Portal chrome** is always dark basalt. The **consent page** (`/oauth/authorize`) is
  the one deliberate inversion: a *limestone tablet* (`#f4efe3`) on basalt, because an
  authorization is an inscription you sign. Vendor tiles on it keep their own brand colors
  (Claude clay, etc.).
- **Buttons**: pill-shaped. `accent` = ochre fill + `--pigment-ink` text (the primary
  verb), `primary` = lapis gradient (secondary emphasis), `ghost`/`subtle` = stone.
- **Focus** is a lapis ring — never ochre, so keyboard focus reads distinctly from CTAs.
- **Selection** is ochre-deep with limestone text.

## Motion

Existing tokens (`--ease`, `--t-fast`, `--t-med`) carry over; nothing bounces. Respect
`prefers-reduced-motion` (already global).
