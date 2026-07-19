<script module lang="ts">
  // Preview-load concurrency gate, shared by every ArtifactCard on the page. Mounting a live preview
  // iframe is expensive (HTML parse + script execution + layout of a full-size document), so on a large
  // gallery we cap how many load at once: a card requests a slot before mounting its iframe and releases
  // it the moment the iframe finishes loading — turning a thundering herd into a steady trickle. The slot
  // covers only the *loading* phase, so already-loaded cards hold nothing and never block new loads.
  const MAX_CONCURRENT_PREVIEW_LOADS = 3;
  let activeLoads = 0;
  const waiting: Array<() => void> = [];

  function pumpPreviewQueue() {
    while (activeLoads < MAX_CONCURRENT_PREVIEW_LOADS && waiting.length > 0) {
      const grant = waiting.shift()!;
      activeLoads++;
      grant();
    }
  }

  // Request a load slot; `onGrant` fires when one is free. Returns a disposer that releases the slot
  // (call when loading finishes) or cancels the still-queued request (call on teardown). Idempotent, so
  // calling it on both load and teardown is safe.
  function requestPreviewSlot(onGrant: () => void): () => void {
    let granted = false;
    let done = false;
    const grant = () => {
      granted = true;
      onGrant();
    };
    waiting.push(grant);
    pumpPreviewQueue();
    return () => {
      if (done) return;
      done = true;
      if (granted) {
        activeLoads--;
        pumpPreviewQueue();
      } else {
        const i = waiting.indexOf(grant);
        if (i >= 0) waiting.splice(i, 1);
      }
    };
  }
</script>

<script lang="ts">
  import { tick } from "svelte";
  import type { Artifact } from "@stela/shared";
  import Popover from "./Popover.svelte";
  import Menu from "./Menu.svelte";
  import SharePanel from "./SharePanel.svelte";
  import RevisionsPanel from "./RevisionsPanel.svelte";
  import DeleteDialog from "./DeleteDialog.svelte";

  let {
    artifact,
    manageable = false,
    onDeleted,
    onUpdated,
  }: {
    artifact: Artifact;
    manageable?: boolean;
    onDeleted?: (id: string) => void;
    onUpdated?: (a: Artifact) => void;
  } = $props();

  // Live preview — lazily mounted AND recycled so a large gallery stays cheap. Each card shows a shimmer
  // skeleton immediately; its preview iframe mounts only when the card nears the viewport, loads behind
  // the concurrency gate above, and is torn down again once the card scrolls well away. So the number of
  // live, animating documents is bounded by what's on screen — not by gallery size — and off-screen cards
  // cost nothing. ?v= keeps the immutable HTML cached, so re-mounting on scroll-back is instant.
  const BASE_W = 1280;
  const PREVIEW_ROOT_MARGIN = "400px"; // mount/keep the iframe within this band around the viewport
  const RETAIN_MS = 2500; // grace before tearing a scrolled-away preview down (anti-thrash + scroll-back)
  const LOAD_TIMEOUT_MS = 8000; // safety: free the load slot even if onload never fires, so one stuck
  //                               artifact can't hold a slot and starve the rest of the gallery

  let previewW = $state(0);
  let previewH = $state(0);
  let scale = $derived(previewW > 0 ? previewW / BASE_W : 0);
  let cardEl = $state<HTMLElement>();
  let inView = $state(false); // within the preview band right now (raw observer state)
  let visible = $state(false); // iframe should be mounted (inView + retention grace)
  let slotGranted = $state(false); // load gate handed this card a slot → safe to mount the iframe
  let loaded = $state(false); // iframe finished loading → fade it in over the skeleton

  // Keep the observer alive (don't disconnect on first hit) so the preview can recycle as the card
  // scrolls in and out of view.
  $effect(() => {
    if (!cardEl) return;
    const io = new IntersectionObserver(
      (entries) => {
        inView = entries[entries.length - 1].isIntersecting;
      },
      { rootMargin: PREVIEW_ROOT_MARGIN },
    );
    io.observe(cardEl);
    return () => io.disconnect();
  });

  // Mount as soon as the card is in view; delay teardown by RETAIN_MS so edge jitter and quick
  // scroll-backs don't thrash the iframe.
  $effect(() => {
    if (inView) {
      visible = true;
    } else if (visible) {
      const t = setTimeout(() => (visible = false), RETAIN_MS);
      return () => clearTimeout(t);
    }
  });

  // While mounted, hold a load slot from request until the iframe finishes loading, then release it so
  // the next queued card can start. On teardown (scrolled away) cancel/release and reset, so a later
  // re-mount starts clean.
  let releaseSlot: (() => void) | null = null;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;

  // Release the slot (and cancel the safety timer). Idempotent — safe to call on load, timeout, or
  // teardown; the iframe is left mounted, so a slow preview that releases on timeout can still finish.
  function freeSlot() {
    if (loadTimer !== null) {
      clearTimeout(loadTimer);
      loadTimer = null;
    }
    releaseSlot?.();
    releaseSlot = null;
  }

  $effect(() => {
    if (!visible) return;
    releaseSlot = requestPreviewSlot(() => {
      slotGranted = true;
      loadTimer = setTimeout(freeSlot, LOAD_TIMEOUT_MS);
    });
    return () => {
      freeSlot();
      slotGranted = false;
      loaded = false;
    };
  });

  function onPreviewLoad() {
    loaded = true;
    freeSlot(); // loading done — free the slot but keep the iframe mounted
  }

  // Anchored popovers (one at a time), all positioned off the kebab button.
  let kebab = $state<HTMLButtonElement>();
  let menuOpen = $state(false);
  let shareOpen = $state(false);
  let revsOpen = $state(false);
  let deleteOpen = $state(false);

  // Inline rename
  let renaming = $state(false);
  let draftTitle = $state("");
  let savingTitle = $state(false);
  let titleInput = $state<HTMLInputElement>();

  function toggleMenu() {
    shareOpen = false;
    revsOpen = false;
    menuOpen = !menuOpen;
  }
  function openMenuAt() {
    shareOpen = false;
    revsOpen = false;
    menuOpen = true;
  }

  async function startRename() {
    menuOpen = false;
    draftTitle = artifact.title;
    renaming = true;
    await tick();
    titleInput?.focus();
    titleInput?.select();
  }
  function cancelRename() {
    renaming = false;
    savingTitle = false;
  }
  async function saveTitle() {
    if (!renaming) return;
    const title = draftTitle.trim();
    if (!title || title === artifact.title) {
      cancelRename();
      return;
    }
    savingTitle = true;
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (res.ok) {
        onUpdated?.((await res.json()) as Artifact);
        renaming = false;
      }
    } catch {
      /* keep editing on failure */
    }
    savingTitle = false;
  }
  function onRenameKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void saveTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  async function copyLink() {
    menuOpen = false;
    try {
      await navigator.clipboard.writeText(`${location.origin}/a/${artifact.id}`);
    } catch {
      /* clipboard may be blocked */
    }
  }
</script>

<article class="card" data-visibility={artifact.visibility} oncontextmenu={(e) => { e.preventDefault(); openMenuAt(); }}>
  <a
    class="card-preview"
    href="/a/{artifact.id}"
    aria-label="Open {artifact.title}"
    bind:this={cardEl}
    bind:clientWidth={previewW}
    bind:clientHeight={previewH}
  >
    <!-- Skeleton: brand gradient + emoji/glyph, with a shimmer sweep while the preview is loading.
         Sits behind the iframe and stays as the placeholder until the preview fades in. -->
    <div class="tile">
      <span class="tile-glyph" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none"><path d="M5 25 L13 12 L18.5 21 L21.5 16 L27 25" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" /><circle cx="13" cy="9.4" r="2.4" fill="currentColor" /></svg>
      </span>
      {#if visible && !loaded}<span class="shimmer" aria-hidden="true"></span>{/if}
    </div>

    {#if slotGranted}
      <div class="thumb" class:show={loaded} aria-hidden="true">
        <iframe
          title="preview"
          src="/a/{artifact.id}/raw?v={artifact.currentVersion}"
          tabindex="-1"
          sandbox="allow-scripts"
          onload={onPreviewLoad}
          style:width="{BASE_W}px"
          style:height="{scale > 0 ? previewH / scale : 0}px"
          style:transform="scale({scale})"
        ></iframe>
      </div>
    {/if}

    <span class="open-hint">Open ›</span>
  </a>

  <div class="card-body">
    <div class="cb-top">
      {#if renaming}
        <input
          class="cb-rename"
          bind:this={titleInput}
          bind:value={draftTitle}
          disabled={savingTitle}
          aria-label="Rename artifact"
          onkeydown={onRenameKey}
          onblur={saveTitle}
        />
      {:else}
        <a class="cb-title" href="/a/{artifact.id}">
          <span class="cb-titletext">{artifact.title}</span>
        </a>
      {/if}

      <button
        type="button"
        class="kebab"
        bind:this={kebab}
        onclick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Artifact actions"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
      </button>
    </div>

    <div class="cb-meta">
      <span class="badge {artifact.visibility}">{artifact.visibility}</span>
      <span class="v">v{artifact.currentVersion}</span>
      <span class="owner" title={artifact.ownerName}>{artifact.ownerName}</span>
    </div>
  </div>

  <div class="card-bar"></div>
</article>

<!-- Context menu -->
<Popover anchor={kebab} bind:open={menuOpen} placement="bottom-end" label="Artifact actions">
  <Menu label="Artifact actions">
    <a class="menu-item" role="menuitem" href="/a/{artifact.id}" onclick={() => (menuOpen = false)}>
      <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg></span>
      Open
    </a>
    <button type="button" class="menu-item" role="menuitem" onclick={copyLink}>
      <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07l-1 1" /><path d="M14 11a5 5 0 0 0-7.07 0l-1.41 1.41a5 5 0 0 0 7.07 7.07l1-1" /></svg></span>
      Copy link
    </button>

    {#if manageable}
      <div class="menu-sep"></div>
      <button type="button" class="menu-item" role="menuitem" onclick={startRename}>
        <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></span>
        Rename
      </button>
      <button type="button" class="menu-item" role="menuitem" onclick={() => { menuOpen = false; shareOpen = true; }}>
        <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></svg></span>
        Change sharing
        <span class="mi-trail">›</span>
      </button>
      <button type="button" class="menu-item" role="menuitem" onclick={() => { menuOpen = false; revsOpen = true; }}>
        <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l3 2" /></svg></span>
        Revisions
        <span class="mi-trail">›</span>
      </button>
      <div class="menu-sep"></div>
      <button type="button" class="menu-item danger" role="menuitem" onclick={() => { menuOpen = false; deleteOpen = true; }}>
        <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg></span>
        Delete artifact
      </button>
    {/if}
  </Menu>
</Popover>

{#if manageable}
  <Popover anchor={kebab} bind:open={shareOpen} placement="bottom-end" label="Share settings">
    <SharePanel
      {artifact}
      onClose={() => (shareOpen = false)}
      onSaved={(updated) => { onUpdated?.(updated); shareOpen = false; }}
    />
  </Popover>

  <Popover anchor={kebab} bind:open={revsOpen} placement="bottom-end" label="Revisions">
    <RevisionsPanel
      {artifact}
      canManage={manageable}
      onClose={() => (revsOpen = false)}
      onChanged={(currentVersion) => onUpdated?.({ ...artifact, currentVersion })}
    />
  </Popover>

  {#if deleteOpen}
    <DeleteDialog
      id={artifact.id}
      title={artifact.title}
      onClose={() => (deleteOpen = false)}
      onDeleted={() => { deleteOpen = false; onDeleted?.(artifact.id); }}
    />
  {/if}
{/if}

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    overflow: hidden;
    box-shadow: var(--shadow-sm);
    transition:
      box-shadow var(--t-med) var(--ease),
      transform var(--t-med) var(--ease),
      border-color var(--t-med) var(--ease);
  }
  .card:hover {
    box-shadow: var(--shadow-md);
    transform: translateY(-2px);
    border-color: var(--line-ochre);
  }

  /* preview — the knocked corner of the slab: the top-right chamfer clips the
     canvas and lets the card's stone show through as a cut facet. */
  .card-preview {
    position: relative;
    display: block;
    aspect-ratio: 16 / 10;
    overflow: hidden;
    background: linear-gradient(135deg, #212228 0%, #17181c 60%, #1e2026 100%);
    clip-path: polygon(
      0 0,
      calc(100% - var(--chamfer)) 0,
      100% var(--chamfer),
      100% 100%,
      0 100%
    );
  }
  .card-preview:hover {
    text-decoration: none;
  }
  .tile {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .tile-glyph {
    color: #b3ada0;
    width: 46px;
    height: 46px;
  }
  .tile-glyph svg {
    width: 100%;
    height: 100%;
  }
  .thumb {
    position: absolute;
    inset: 0;
    overflow: hidden;
    /* Transparent + faded out until the iframe loads, then fades in over the skeleton ("pops in"). */
    background: transparent;
    opacity: 0;
    transition: opacity 0.4s var(--ease);
  }
  .thumb.show {
    opacity: 1;
  }
  .thumb iframe {
    border: 0;
    transform-origin: top left;
    pointer-events: none;
    background: #fff;
  }
  /* Loading shimmer swept across the skeleton while the preview iframe loads. Animates `transform`
     only (compositor thread, no per-frame paint), so a screenful of shimmering cards stays smooth. */
  .shimmer {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .shimmer::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      100deg,
      transparent 30%,
      rgba(255, 255, 255, 0.09) 50%,
      transparent 70%
    );
    transform: translateX(-100%);
    animation: shimmer 1.3s ease-in-out infinite;
  }
  @keyframes shimmer {
    to {
      transform: translateX(100%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .shimmer::after {
      animation: none;
    }
    .thumb {
      transition: none;
    }
  }
  .open-hint {
    position: absolute;
    right: 10px;
    bottom: 10px;
    z-index: 2;
    font-size: 12px;
    font-weight: 700;
    color: #fff;
    background: rgba(var(--ink-rgb), 0.78);
    border-radius: var(--radius-pill);
    padding: 4px 11px;
    opacity: 0;
    transform: translateY(4px);
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-fast) var(--ease);
  }
  .card:hover .open-hint {
    opacity: 1;
    transform: translateY(0);
  }

  /* body */
  .card-body {
    padding: 12px 13px 13px;
  }
  .cb-top {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  .cb-title {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--fg);
    font-weight: 700;
    font-size: 15px;
    line-height: 1.3;
  }
  .cb-title:hover {
    text-decoration: none;
    color: var(--accent);
  }
  .cb-titletext {
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .cb-rename {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-weight: 700;
    font-size: 15px;
    color: var(--fg);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 4px 7px;
    box-shadow: var(--focus);
  }
  .kebab {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    margin: -4px -5px 0 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: var(--muted);
    border-radius: 50%;
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .kebab svg {
    width: 18px;
    height: 18px;
  }
  .kebab:hover,
  .kebab[aria-expanded="true"] {
    background: var(--surface-tint);
    color: var(--fg);
  }
  .cb-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
  .v {
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--muted);
  }
  .owner {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 45%;
  }

  /* accent bar by visibility */
  .card-bar {
    height: 4px;
    margin-top: auto;
    background: var(--grad-brand);
  }
  .card[data-visibility="private"] .card-bar {
    background: linear-gradient(90deg, #4a4c53, #6a6d76);
  }
  .card[data-visibility="everyone"] .card-bar {
    background: linear-gradient(90deg, var(--ochre), var(--ochre-bright));
  }
  .card[data-visibility="restricted"] .card-bar {
    background: linear-gradient(90deg, var(--lapis-bright), var(--lapis));
  }
</style>
