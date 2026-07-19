<script lang="ts">
  import type { PageData } from "./$types";
  import type { Artifact, Visibility } from "@stela/shared";
  import ArtifactCard from "$lib/components/ArtifactCard.svelte";
  import ConnectGuide from "$lib/components/ConnectGuide.svelte";
  import Logo from "$lib/components/Logo.svelte";

  let { data }: { data: PageData } = $props();

  // Only the user's own artifacts mutate in place (rename / re-share / version delete / delete).
  // svelte-ignore state_referenced_locally
  let mine = $state<Artifact[]>(data.mine);

  // Client-side search / filter / sort over the already-loaded buckets.
  let query = $state("");
  let vis = $state<"all" | Visibility>("all");
  let sort = $state<"updated" | "created" | "name" | "name-desc">("updated");

  const VIS_FILTERS: { v: "all" | Visibility; label: string }[] = [
    { v: "all", label: "All" },
    { v: "private", label: "Private" },
    { v: "everyone", label: "Everyone" },
    { v: "restricted", label: "Shared" },
  ];

  function matches(a: Artifact): boolean {
    if (vis !== "all" && a.visibility !== vis) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    // Search by name, owner, OR who it's shared with (allowedPrincipals = emails/user ids).
    return (
      a.title.toLowerCase().includes(q) ||
      a.ownerName.toLowerCase().includes(q) ||
      a.allowedPrincipals.some((p) => p.toLowerCase().includes(q))
    );
  }

  function arrange(list: Artifact[]): Artifact[] {
    const out = list.filter(matches);
    const byName = (a: Artifact, b: Artifact) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    switch (sort) {
      case "name":
        return out.sort(byName);
      case "name-desc":
        return out.sort((a, b) => byName(b, a));
      case "created":
        return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      default:
        return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
  }

  let fMine = $derived(arrange(mine));
  let fEveryone = $derived(arrange(data.everyone));
  let fShared = $derived(arrange(data.shared));

  let hasData = $derived(mine.length + data.everyone.length + data.shared.length > 0);
  let filtering = $derived(query.trim() !== "" || vis !== "all");
  let shown = $derived(fMine.length + fEveryone.length + fShared.length);
  let noMatches = $derived(hasData && filtering && shown === 0 && !data.storageError);
  // Show the "publish your first artifact" prompt whenever the user owns none of their own — whether
  // that's a brand-new workspace or one where only everyone/shared artifacts exist. Suppressed while
  // filtering (the prompt isn't about the current filter).
  let ownsNone = $derived(mine.length === 0 && !filtering && !data.storageError);

  function replace(a: Artifact) {
    mine = mine.map((x) => (x.id === a.id ? a : x));
  }
  function remove(id: string) {
    mine = mine.filter((x) => x.id !== id);
  }
  function clearFilters() {
    query = "";
    vis = "all";
  }
</script>

{#snippet sectionHead(title: string, count: number)}
  <div class="sec-head">
    <h2>{title}</h2>
    <span class="count">{count}</span>
  </div>
{/snippet}

<section class="hero">
  <div class="hero-inner">
    <p class="murmur">self-contained<span class="dot">·</span>versioned<span class="dot">·</span>pinned in place</p>
    <h1>Your artifacts<span class="seal" aria-hidden="true">.</span></h1>
    <p class="hero-sub">
      Published straight from your agent — shared privately, server-wide, or with specific
      people, with revision history and pinned comments.
    </p>
    <div class="hero-row">
      <span class="hint">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></svg>
        <span>“Stela this”</span>
      </span>
      <div class="stats">
        <span class="stat"><b>{mine.length}</b><i>yours</i></span>
        <span class="stat"><b>{data.everyone.length}</b><i>everyone</i></span>
        <span class="stat"><b>{data.shared.length}</b><i>shared</i></span>
      </div>
    </div>
  </div>
  <!-- decor: the stele field — standing slabs at graded depths, the nearest one lit; its ochre
       incision is the one with pigment. Purely decorative. -->
  <svg class="hero-decor" viewBox="0 0 460 240" preserveAspectRatio="xMaxYMax slice" aria-hidden="true">
    <!-- ground -->
    <defs>
      <linearGradient id="ground" x1="0" y1="0" x2="460" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="rgba(236,230,216,0)" />
        <stop offset="0.55" stop-color="rgba(236,230,216,0.14)" />
        <stop offset="0.8" stop-color="rgba(208,138,74,0.4)" />
        <stop offset="1" stop-color="rgba(208,138,74,0)" />
      </linearGradient>
    </defs>
    <path d="M30 226 H460" stroke="url(#ground)" stroke-width="1.5" />
    <!-- far slabs, sinking into the dark -->
    <path d="M64 226 V140 Q64 124 86 124 Q108 124 108 140 V226" fill="none" stroke="rgba(236,230,216,0.05)" stroke-width="2" />
    <path d="M146 226 V102 Q146 84 173 84 Q200 84 200 102 V226" fill="none" stroke="rgba(236,230,216,0.075)" stroke-width="2" />
    <path d="M236 226 V72 Q236 52 268 52 Q300 52 300 72 V226" fill="none" stroke="rgba(236,230,216,0.09)" stroke-width="2" />
    <path d="M256 84 H282" stroke="rgba(236,230,216,0.08)" stroke-width="2" stroke-linecap="round" />
    <path d="M256 102 H290" stroke="rgba(236,230,216,0.06)" stroke-width="2" stroke-linecap="round" />
    <!-- the near stela, catching the light -->
    <path d="M334 226 V44 Q334 20 379 20 Q424 20 424 44 V204 L404 226 Z" fill="rgba(236,230,216,0.02)" stroke="rgba(236,230,216,0.16)" stroke-width="2.2" stroke-linejoin="round" />
    <path d="M352 52 H406" stroke="rgba(208,138,74,0.6)" stroke-width="2.4" stroke-linecap="round" />
    <path d="M352 74 H392" stroke="rgba(236,230,216,0.13)" stroke-width="2.4" stroke-linecap="round" />
    <path d="M352 96 H402" stroke="rgba(236,230,216,0.13)" stroke-width="2.4" stroke-linecap="round" />
    <path d="M352 118 H382" stroke="rgba(236,230,216,0.09)" stroke-width="2.4" stroke-linecap="round" />
    <circle cx="410" cy="36" r="2.6" fill="#647fdd" opacity="0.7" />
    <!-- pigment dust -->
    <circle cx="222" cy="36" r="2.6" fill="#d08a4a" opacity="0.5" />
    <circle cx="188" cy="62" r="1.8" fill="#d08a4a" opacity="0.3" />
    <circle cx="130" cy="46" r="1.8" fill="#647fdd" opacity="0.3" />
  </svg>
</section>

{#if data.storageError}
  <div class="notice">
    Storage isn't reachable yet. Check the server logs (<code>STORAGE_DRIVER</code> /
    <code>DATA_DIR</code>), then refresh.
  </div>
{/if}

{#if hasData}
  <div class="toolbar">
    <div class="search">
      <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
      <input
        type="text"
        placeholder="Search by name, owner, or who it's shared with…"
        aria-label="Search artifacts"
        bind:value={query}
      />
      {#if query}
        <button type="button" class="clear" aria-label="Clear search" onclick={() => (query = "")}>×</button>
      {/if}
    </div>
    <div class="filters">
      <div class="seg" role="group" aria-label="Filter by visibility">
        {#each VIS_FILTERS as f (f.v)}
          <button type="button" class:active={vis === f.v} onclick={() => (vis = f.v)}>{f.label}</button>
        {/each}
      </div>
      <select class="sort" bind:value={sort} aria-label="Sort artifacts">
        <option value="updated">Recently updated</option>
        <option value="created">Recently created</option>
        <option value="name">Name A–Z</option>
        <option value="name-desc">Name Z–A</option>
      </select>
    </div>
  </div>
{/if}

{#if noMatches}
  <div class="nomatch">
    <h2>No artifacts match</h2>
    <p>Nothing matches your search and filters.</p>
    <button type="button" class="btn ghost sm" onclick={clearFilters}>Clear filters</button>
  </div>
{/if}

{#if !data.storageError}
  {#if fMine.length > 0}
    {@render sectionHead("Yours", fMine.length)}
    <div class="grid">
      {#each fMine as a (a.id)}
        <ArtifactCard artifact={a} manageable onUpdated={replace} onDeleted={remove} />
      {/each}
    </div>
  {:else if ownsNone}
    {@render sectionHead("Yours", 0)}
    <div class="first-artifact">
      <span class="fa-glyph" aria-hidden="true"><Logo variant="mark" size={42} /></span>
      <h3>Publish your first artifact</h3>
      <p>
        Anything your agent publishes shows up here — private by default, or shared server-wide or
        with specific people, with revision history and pinned comments. Connect Stela to your
        agent, then say <b>“Stela this”</b> in any chat.
      </p>
      <ConnectGuide variant="hero" />
    </div>
  {/if}
{/if}

{#if fEveryone.length > 0}
  {@render sectionHead("Shared with everyone", fEveryone.length)}
  <div class="grid">
    {#each fEveryone as a (a.id)}
      <ArtifactCard artifact={a} />
    {/each}
  </div>
{/if}

{#if fShared.length > 0}
  {@render sectionHead("Shared with you", fShared.length)}
  <div class="grid">
    {#each fShared as a (a.id)}
      <ArtifactCard artifact={a} />
    {/each}
  </div>
{/if}

<style>
  /* The field: an open hero, not a box. The raking light comes from the ground
     line below; the stele field stands at the right edge. */
  .hero {
    position: relative;
    padding: 26px 4px 40px;
    margin-bottom: 30px;
  }
  /* the ground: raking light along the bottom edge, brightest where the stelae stand */
  .hero::after {
    content: "";
    position: absolute;
    left: -12px;
    right: -12px;
    bottom: 0;
    height: 1px;
    background: linear-gradient(
      90deg,
      rgba(236, 230, 216, 0.05) 0%,
      rgba(236, 230, 216, 0.12) 45%,
      rgba(208, 138, 74, 0.5) 78%,
      transparent 98%
    );
  }
  .hero-inner {
    position: relative;
    z-index: 1;
    max-width: 640px;
  }
  .murmur {
    margin: 0 0 14px;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: lowercase;
    color: var(--muted);
  }
  .murmur .dot {
    color: var(--ochre);
    margin: 0 10px;
  }
  .hero h1 {
    margin: 0 0 12px;
    font-size: 46px;
    font-weight: 800;
    letter-spacing: -0.025em;
    color: var(--fg);
  }
  .hero h1 .seal {
    color: var(--ochre);
  }
  .hero-sub {
    margin: 0 0 22px;
    color: var(--text);
    font-size: 15px;
    line-height: 1.6;
    max-width: 560px;
  }
  .hero-row {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .hint {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: #dcd6c7;
    background: rgba(236, 230, 216, 0.05);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    padding: 7px 14px;
  }
  .hint svg {
    width: 15px;
    height: 15px;
    color: var(--ochre);
  }
  /* carved tallies */
  .stats {
    display: flex;
    margin-left: auto;
  }
  .stat {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 0 18px;
    border-left: 1px solid var(--border);
  }
  .stat:first-child {
    border-left: 0;
    padding-left: 0;
  }
  .stat b {
    font-family: var(--font-mono);
    color: var(--fg);
    font-size: 21px;
    font-weight: 700;
    line-height: 1.1;
  }
  .stat i {
    font-style: normal;
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.16em;
    text-transform: lowercase;
    color: var(--muted);
  }
  .hero-decor {
    position: absolute;
    right: -8px;
    bottom: 0;
    width: min(52%, 470px);
    height: 105%;
    z-index: 0;
    pointer-events: none;
  }
  @media (max-width: 820px) {
    .hero-decor {
      display: none;
    }
    .hero {
      padding-bottom: 28px;
    }
    .hero h1 {
      font-size: 36px;
    }
  }

  /* search / filter / sort toolbar */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .search {
    position: relative;
    flex: 1 1 280px;
    min-width: 220px;
    max-width: 440px;
  }
  .search .si {
    position: absolute;
    left: 13px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    color: var(--muted);
    pointer-events: none;
  }
  .search input {
    width: 100%;
    height: 40px;
    padding: 0 34px 0 38px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border);
    background: rgba(236, 230, 216, 0.03);
    color: var(--text);
    font: inherit;
    font-size: 14px;
  }
  .search input:focus-visible {
    border-color: var(--accent);
    box-shadow: var(--focus);
  }
  .search .clear {
    position: absolute;
    right: 9px;
    top: 50%;
    transform: translateY(-50%);
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 50%;
    background: var(--surface-tint);
    color: var(--muted);
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
  }
  .search .clear:hover {
    color: var(--fg);
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
    flex-wrap: wrap;
  }
  /* inscription tabs: no pill box — the active filter is the one with pigment
     in its incision */
  .seg {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .seg button {
    border: 0;
    background: transparent;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    padding: 10px 10px 8px;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition:
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .seg button:hover {
    color: var(--fg);
  }
  .seg button.active {
    color: var(--ochre-bright);
    border-bottom-color: var(--ochre);
  }
  .seg button:focus-visible {
    box-shadow: var(--focus);
    border-radius: var(--radius-sm);
  }
  .sort {
    height: 40px;
    padding: 0 12px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border);
    background: rgba(236, 230, 216, 0.03);
    color: var(--text);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  /* section heads as carved rules: a tracked mono label, the count in pigment,
     and an incision running to the page edge */
  .sec-head {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 36px 0 16px;
  }
  .sec-head h2 {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #b3ada0;
  }
  .count {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    color: var(--ochre-bright);
  }
  .sec-head::after {
    content: "";
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, rgba(236, 230, 216, 0.14), transparent 85%);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 18px;
  }

  .notice {
    background: rgba(246, 177, 80, 0.12);
    border: 1px solid rgba(246, 177, 80, 0.32);
    color: #f0c27b;
    border-radius: var(--radius-card);
    padding: 16px 18px;
    margin-bottom: 20px;
  }
  .nomatch {
    text-align: center;
    background: var(--surface);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-card);
    padding: 48px 24px;
  }
  .nomatch h2 {
    margin: 0 0 6px;
    font-size: 18px;
  }
  .nomatch p {
    margin: 0 0 14px;
    color: var(--muted);
  }

  /* "Publish your first artifact" — shown in the Yours section when the user owns none (a fresh
     workspace, or one where only everyone/shared artifacts exist). */
  .first-artifact {
    text-align: center;
    background:
      radial-gradient(560px 220px at 50% -30%, rgba(var(--lapis-rgb), 0.16), transparent 70%),
      var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    padding: 40px 28px 36px;
    box-shadow: var(--shadow-sm);
  }
  .fa-glyph {
    display: inline-flex;
    margin-bottom: 14px;
    filter: drop-shadow(0 7px 16px rgba(var(--lapis-rgb), 0.4));
  }
  .first-artifact h3 {
    margin: 0 0 8px;
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -0.01em;
  }
  .first-artifact p {
    max-width: 560px;
    margin: 0 auto 20px;
    color: var(--text);
    font-size: 14.5px;
    line-height: 1.6;
  }
  .first-artifact :global(b) {
    color: var(--fg);
    font-weight: 650;
  }

  /* ---- mobile (≤768; desktop ≥769 unaffected) ---- */
  @media (max-width: 768px) {
    .hero {
      padding: 24px 20px 22px;
      border-radius: 16px;
      margin-bottom: 20px;
    }
    .hero h1 {
      font-size: 27px;
    }
    .hero-sub {
      font-size: 14.5px;
      margin-bottom: 16px;
    }
    .hero-row {
      gap: 12px;
    }
    /* left-align the stats when the row wraps (margin-left:auto would shove them to the right edge) */
    .stats {
      margin-left: 0;
    }

    /* The toolbar stacks: full-width search, a full-width segment with evenly-sized buttons (bigger
       tap targets), and a full-width sort select below. */
    .toolbar {
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
    }
    .search {
      flex: none;
      width: 100%;
      max-width: none;
      min-width: 0;
    }
    .filters {
      margin-left: 0;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
    }
    .seg {
      display: flex;
    }
    .seg button {
      flex: 1;
      padding: 8px 6px;
    }
    .sort {
      width: 100%;
    }

    .sec-head {
      margin: 26px 0 14px;
    }
    .first-artifact {
      padding: 32px 18px 30px;
    }
  }

  @media (max-width: 440px) {
    .hero {
      padding: 22px 17px 20px;
    }
    .hero h1 {
      font-size: 24px;
    }
  }
</style>
