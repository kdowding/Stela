<script lang="ts">
  import type { PageData } from "./$types";
  import type { Artifact, Version } from "@stela/shared";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import CommentOverlay from "$lib/components/CommentOverlay.svelte";
  import CommentPanel from "$lib/components/CommentPanel.svelte";
  import { CommentsController } from "$lib/comments/CommentsController.svelte";
  import SharePanel from "$lib/components/SharePanel.svelte";
  import Popover from "$lib/components/Popover.svelte";
  import Menu from "$lib/components/Menu.svelte";
  import DeleteDialog from "$lib/components/DeleteDialog.svelte";
  import Logo from "$lib/components/Logo.svelte";
  import UserMenu from "$lib/components/UserMenu.svelte";
  import ConnectGuide from "$lib/components/ConnectGuide.svelte";

  let { data }: { data: PageData } = $props();

  // The signed-in user comes from the layout's server load (runs on every route, even though the
  // viewer hides the portal chrome) — so the account pill can live in the viewer bar too.
  let user = $derived($page.data.user);

  // svelte-ignore state_referenced_locally
  let artifact = $state<Artifact>(data.artifact);
  // The version shown in the iframe (bound to the picker). Initialized from the server-validated
  // ?v= deep-link (falls back to current) so revision links / bookmarks land on the right version.
  // svelte-ignore state_referenced_locally
  let version = $state(data.requestedVersion);
  // The newest version we know exists + the picker's options — kept fresh by the live poll below.
  // svelte-ignore state_referenced_locally
  let latest = $state(data.artifact.currentVersion);
  // svelte-ignore state_referenced_locally
  let versions = $state<Version[]>(data.versions);
  let commentMode = $state(false);
  let shareOpen = $state(false);
  let deleteOpen = $state(false);
  let shareBtn = $state<HTMLButtonElement>();
  // Mobile: the bar's owner/account actions collapse into a "⋯" overflow menu (kebab).
  let overflowOpen = $state(false);
  let kebabBtn = $state<HTMLButtonElement>();

  // A few mobile swaps can't be done in CSS alone: the logo drops to mark-only, and the Share popover
  // re-anchors to the kebab (the inline Share button is hidden). Track the breakpoint reactively.
  let narrow = $state(false);
  $effect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const sync = () => (narrow = mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  });

  // Live-revision notice: 'applied' = we auto-advanced the owner; 'prompt' = a newer version exists and
  // we let the viewer choose. The owner sitting on the latest version auto-advances; everyone else is
  // prompted and never moved — and nobody mid-comment or on an older revision is moved at all.
  let notice = $state<{ kind: "applied" | "prompt"; version: number } | null>(null);

  // svelte-ignore state_referenced_locally
  const isOwner = data.canManage;
  // ?embed=1 makes /raw inject the page-aware comment bridge (bridge.client.js) into this render only.
  let rawSrc = $derived(`/a/${artifact.id}/raw?v=${version}&embed=1`);
  let behind = $derived(version < latest); // viewing an older revision than the newest

  // The artifact iframe + the "view" it currently reports. A multi-page artifact (e.g. a mockup that
  // swaps screens in place) tells us which page is showing via the embed bridge; the overlay uses it to
  // scope comment pins to the page they were placed on. null = single-page / nothing detected → pins
  // are page-global (pre-page-aware behavior).
  let frame = $state<HTMLIFrameElement>();
  let view = $state<{ key: string; label: string } | null>(null);

  // The bridge posts {source:'stela-bridge', type:'view', key, label} from inside the sandboxed
  // iframe. The opaque origin can't be checked, so we validate by source identity + message shape.
  // Pin positions streamed from the bridge — dom-anchored pins track the content as it scrolls/reflows.
  // Keyed by comment id; a pin with no entry falls back to its stored xNorm/yNorm.
  let pinPositions = $state<Record<string, { xNorm: number; yNorm: number; visible: boolean; resolved: boolean }>>({});
  let probeSeq = 0;
  const pendingProbes = new Map<number, (dom: unknown) => void>();

  $effect(() => {
    function onMessage(e: MessageEvent) {
      if (!frame || e.source !== frame.contentWindow) return;
      const d = e.data as { source?: string; type?: string; [k: string]: unknown } | null;
      if (!d || d.source !== "stela-bridge") return;
      if (d.type === "view") {
        view = d.key ? { key: String(d.key), label: d.label ? String(d.label) : "" } : null;
      } else if (d.type === "positions") {
        const next: Record<string, { xNorm: number; yNorm: number; visible: boolean; resolved: boolean }> = {};
        for (const p of (d.pins as Array<{ id: string; xNorm?: number; yNorm?: number; visible?: boolean; resolved?: boolean }>) ?? []) {
          next[p.id] = { xNorm: p.xNorm ?? 0, yNorm: p.yNorm ?? 0, visible: !!p.visible, resolved: !!p.resolved };
        }
        pinPositions = next;
      } else if (d.type === "probed") {
        const resolve = pendingProbes.get(d.reqId as number);
        if (resolve) {
          pendingProbes.delete(d.reqId as number);
          resolve(d.dom ?? null);
        }
      } else if (d.type === "ready") {
        // The bridge just attached its listeners — (re)send the track list now that it can hear us.
        sendTrack();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  // A version switch reloads the iframe; drop the stale view until the fresh bridge reports (fail-safe
  // to page-global meanwhile).
  $effect(() => {
    void version;
    view = null;
  });

  // Once the iframe document is up, ask its bridge to (re)report — covers the load-order race where the
  // bridge's first emit fires before this page's listener is attached.
  function onFrameLoad() {
    frame?.contentWindow?.postMessage({ source: "stela-host", type: "hello" }, "*");
    sendTrack();
  }

  // Comments are shared between the canvas pins (CommentOverlay) and the side panel (CommentPanel) via
  // one controller; the viewer keeps it pointed at the current artifact / version / page.
  let panelOpen = $state(false);
  const comments = new CommentsController();
  $effect(() => {
    comments.artifactId = artifact.id;
    comments.version = version;
    comments.comments = [];
    comments.openThreadId = null;
    void comments.load();
  });
  $effect(() => {
    comments.view = view;
  });
  // Opening a thread (e.g. clicking a pin) brings the panel forward.
  $effect(() => {
    if (comments.openThreadId) panelOpen = true;
  });
  // Ask the embed bridge to drive the artifact to a page (jump-to-pin from the panel's off-page rows).
  function navigateArtifact(key: string) {
    frame?.contentWindow?.postMessage({ source: "stela-host", type: "navigate", key }, "*");
  }
  // Ask the bridge what element is at a clicked point, to capture a dom-anchor when placing a pin.
  function probeAnchor(xNorm: number, yNorm: number): Promise<unknown> {
    return new Promise((resolve) => {
      const reqId = ++probeSeq;
      pendingProbes.set(reqId, resolve);
      frame?.contentWindow?.postMessage({ source: "stela-host", type: "probe", reqId, xNorm, yNorm }, "*");
      setTimeout(() => {
        if (pendingProbes.has(reqId)) {
          pendingProbes.delete(reqId);
          resolve(null);
        }
      }, 1500);
    });
  }
  // Tell the bridge which pins to position (those with a dom-anchor). Re-sent on change + on iframe load.
  function sendTrack() {
    // $state.snapshot is essential: comments are reactive $state, so c.anchor.dom is a Proxy, and
    // postMessage can't structured-clone a Svelte proxy (it throws and the track silently never lands).
    const pins = comments.comments
      .filter((c) => !c.parentId && c.anchor?.dom)
      .map((c) => ({ id: c.id, dom: $state.snapshot(c.anchor!.dom) }));
    frame?.contentWindow?.postMessage({ source: "stela-host", type: "track", pins }, "*");
  }
  $effect(() => {
    void comments.comments;
    sendTrack();
  });

  function show(v: number) {
    version = v;
    notice = null;
  }

  async function refreshVersions() {
    try {
      const r = await fetch(`/api/artifacts/${artifact.id}/versions`, {
        headers: { accept: "application/json" },
      });
      if (r.ok) versions = (await r.json()) as Version[];
    } catch {
      /* transient — the next poll retries */
    }
  }

  // Apply a freshly-learned latest version. Owner sitting on the latest, not mid-comment → advance them
  // (the claude.ai author feel). Everyone else is only prompted; anyone on an older revision or
  // composing a comment is never moved.
  async function applyLatest(newVersion: number) {
    if (!Number.isFinite(newVersion) || newVersion <= latest) return;
    const wasOnLatest = version === latest;
    latest = newVersion;
    await refreshVersions();
    if (wasOnLatest && !commentMode && isOwner) {
      version = newVersion;
      notice = { kind: "applied", version: newVersion };
    } else {
      notice = { kind: "prompt", version: newVersion };
    }
  }

  // One-shot catch-up after a reconnect or tab refocus, in case a push was missed while disconnected.
  async function catchUp() {
    try {
      const r = await fetch(`/api/artifacts/${artifact.id}`, { headers: { accept: "application/json" } });
      if (r.ok) await applyLatest(((await r.json()) as Artifact).currentVersion);
    } catch {
      /* transient — the stream will resync */
    }
  }

  // Follow ?v= on query-only navigation (e.g. clicking a Revisions deep-link while the viewer is
  // already open): re-point when the server-validated requested version actually changes. Tracked
  // separately from `version` so the picker and live-update can still set `version` locally without
  // this effect fighting them.
  // svelte-ignore state_referenced_locally
  let lastRequested = data.requestedVersion;
  $effect(() => {
    if (data.requestedVersion !== lastRequested) {
      lastRequested = data.requestedVersion;
      version = data.requestedVersion;
      notice = null;
    }
  });

  // Real-time: the sandboxed iframe can't reach the network, so the portal holds a Server-Sent-Events
  // stream and the server pushes the new version the instant it's published (routes/.../events).
  // EventSource auto-reconnects on a drop; the refocus catch-up covers anything missed in between.
  $effect(() => {
    const es = new EventSource(`/api/artifacts/${artifact.id}/events`);
    const onVersion = (e: MessageEvent) => void applyLatest(Number(e.data));
    es.addEventListener("version", onVersion);
    const onVisible = () => {
      if (!document.hidden) void catchUp();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      es.removeEventListener("version", onVersion);
      es.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  });

  // The 'updated' confirmation is transient; the 'new version' prompt stays until the viewer acts.
  $effect(() => {
    if (notice?.kind !== "applied") return;
    const t = setTimeout(() => {
      if (notice?.kind === "applied") notice = null;
    }, 4000);
    return () => clearTimeout(t);
  });

</script>

<svelte:head>
  <title>{artifact.title} · Stela</title>
  <!-- Intentionally NO per-artifact favicon override: the browser-tab icon stays the Stela mountain
       logo (app.html) on every page, including artifact viewers. The artifact's own emoji favicon is
       still stored and shown in the gallery card, just not in the portal tab. -->
</svelte:head>

<div class="v-shell">
  <nav class="v-bar">
    <div class="v-bar-left">
      <a class="v-home" href="/" aria-label="All artifacts">
        <Logo size={20} variant={narrow ? "mark" : "lockup"} />
      </a>
      <span class="v-divider v-divider-left" aria-hidden="true"></span>
      <span class="v-title" title={artifact.title}>{artifact.title}</span>
      <span class="v-vis">{artifact.visibility}</span>
    </div>

    <div class="v-bar-right">
      {#if behind}
        <button type="button" class="btn xs accent v-newer" onclick={() => show(latest)} title="Jump to the newest revision">
          newer ›
        </button>
      {/if}
      <select class="v-select" bind:value={version} aria-label="Version">
        {#each versions as v (v.version)}
          <option value={v.version}>
            v{v.version}{v.version === latest && !narrow ? " · current" : ""}
          </option>
        {/each}
      </select>
      <button
        type="button"
        class="btn xs v-comment {panelOpen ? 'accent' : 'on-dark ghost'}"
        aria-pressed={panelOpen}
        aria-label="Comments"
        onclick={() => (panelOpen = !panelOpen)}
      >
        <svg class="v-comment-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 17 0z" /></svg>
        <span class="v-comment-label">{comments.total > 0 ? `Comments · ${comments.total}` : "Comments"}</span>
      </button>
      {#if data.canManage}
        <!-- display:contents → desktop layout is unchanged; the wrapper only exists so mobile can hide
             both owner actions at once (they move into the kebab menu). -->
        <span class="v-owner-actions">
          <button type="button" class="btn xs primary" bind:this={shareBtn} onclick={() => (shareOpen = !shareOpen)} aria-haspopup="dialog" aria-expanded={shareOpen}>
            Share
          </button>
          <button type="button" class="btn xs on-dark danger" onclick={() => (deleteOpen = true)}>Delete</button>
        </span>
      {/if}
      <span class="v-connect"><ConnectGuide /></span>
      {#if user}
        <span class="v-user">
          <span class="v-divider" aria-hidden="true"></span>
          <UserMenu {user} />
        </span>
      {/if}
      <!-- Mobile-only overflow: in the DOM on desktop too (CSS-hidden) so its bind stays stable. -->
      <button
        type="button"
        class="v-kebab"
        bind:this={kebabBtn}
        onclick={() => (overflowOpen = !overflowOpen)}
        aria-haspopup="menu"
        aria-expanded={overflowOpen}
        aria-label="More options"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
      </button>
    </div>
  </nav>

  <div class="v-stage">
    <!-- Sandboxed: no allow-same-origin (opaque origin → can't reach portal cookies/session) and
         no allow-popups (CSP blocks resource egress but NOT window.open navigation). Combined with
         the strict CSP on /raw, this blocks artifact data exfiltration. Sandbox-origin: see CLAUDE.md.
         screen-wake-lock is delegated (`*` because the sandbox origin is opaque) so kiosk/TV artifacts
         can keep the display awake — worst case is battery drain while the tab is visible; it
         auto-releases when hidden and opens no data channel. -->
    <iframe
      class="v-frame"
      bind:this={frame}
      src={rawSrc}
      title={artifact.title}
      sandbox="allow-scripts"
      allow="screen-wake-lock *"
      onload={onFrameLoad}
    ></iframe>
    <CommentOverlay
      controller={comments}
      bind:commentMode
      positions={pinPositions}
      probe={probeAnchor}
      onOpen={(id) => {
        comments.openThreadId = id;
        panelOpen = true;
      }}
    />
    <CommentPanel
      controller={comments}
      bind:open={panelOpen}
      bind:commentMode
      currentUserId={user?.id}
      canManage={data.canManage}
      onNavigate={navigateArtifact}
    />

    {#if notice}
      <div class="v-toast" class:applied={notice.kind === "applied"} role="status" aria-live="polite">
        <span class="v-toast-dot" aria-hidden="true"></span>
        {#if notice.kind === "applied"}
          <span>Updated to v{notice.version}</span>
        {:else}
          <span>Version {notice.version} published</span>
          <button
            type="button"
            class="v-toast-btn"
            onclick={() => {
              if (notice) show(notice.version);
            }}
          >
            View
          </button>
        {/if}
        <button type="button" class="v-toast-x" aria-label="Dismiss" onclick={() => (notice = null)}>
          ✕
        </button>
      </div>
    {/if}
  </div>
</div>

<!-- Mobile overflow menu (anchored to the kebab). Holds the actions that don't fit the compact bar:
     jump-to-newest, the owner actions, and the account links (the UserMenu chip is hidden on mobile). -->
<Popover anchor={kebabBtn} bind:open={overflowOpen} placement="bottom-end" label="Artifact options">
  <Menu label="Artifact options">
    {#if behind}
      <button type="button" class="menu-item" role="menuitem" onclick={() => { overflowOpen = false; show(latest); }}>
        <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg></span>
        Jump to newest (v{latest})
      </button>
      <div class="menu-sep"></div>
    {/if}
    {#if data.canManage}
      <button type="button" class="menu-item" role="menuitem" onclick={() => { overflowOpen = false; shareOpen = true; }}>
        <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></svg></span>
        Change sharing
      </button>
      <button type="button" class="menu-item danger" role="menuitem" onclick={() => { overflowOpen = false; deleteOpen = true; }}>
        <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg></span>
        Delete artifact
      </button>
    {/if}
    {#if user}
      <div class="menu-sep"></div>
      <a class="menu-item" role="menuitem" href="/" onclick={() => (overflowOpen = false)}>
        <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg></span>
        All artifacts
      </a>
      <a class="menu-item" role="menuitem" href="/.auth/logout">
        <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg></span>
        Sign out
      </a>
    {/if}
  </Menu>
</Popover>

{#if data.canManage}
  <Popover anchor={narrow ? kebabBtn : shareBtn} bind:open={shareOpen} placement="bottom-end" label="Share settings">
    <SharePanel
      {artifact}
      onClose={() => (shareOpen = false)}
      onSaved={(updated) => {
        artifact = updated;
        shareOpen = false;
      }}
    />
  </Popover>
{/if}

{#if deleteOpen}
  <DeleteDialog
    id={artifact.id}
    title={artifact.title}
    onClose={() => (deleteOpen = false)}
    onDeleted={() => goto("/")}
  />
{/if}

<style>
  .v-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    /* Dynamic viewport height: on mobile, 100vh is the *large* viewport (URL bar hidden), so the
       artifact's bottom gets clipped when the bar is showing. 100dvh always fills the visible area;
       it equals 100vh on desktop. */
    height: 100dvh;
  }
  .v-bar {
    flex: 0 0 auto;
    height: 42px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 10px;
    background: linear-gradient(180deg, #191a1f 0%, var(--ink) 100%);
    color: #fff;
    position: relative;
  }
  .v-bar::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: var(--grad-brand);
    opacity: 0.9;
  }
  .v-bar-left {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .v-home {
    color: #fff;
    flex: 0 0 auto;
    display: inline-flex;
  }
  .v-home:hover {
    text-decoration: none;
    opacity: 0.9;
  }
  .v-divider {
    width: 1px;
    height: 18px;
    background: rgba(255, 255, 255, 0.16);
    flex: 0 0 auto;
  }
  .v-title {
    font-size: 13px;
    font-weight: 600;
    color: #ece6d8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .v-vis {
    flex: 0 0 auto;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: #b3ada0;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: var(--radius-pill);
    padding: 2px 7px;
  }
  .v-bar-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }
  .v-select {
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    color: #fff;
    background: rgba(255, 255, 255, 0.09);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: var(--radius-pill);
    padding: 5px 9px;
    cursor: pointer;
  }
  .v-select:hover {
    background: rgba(255, 255, 255, 0.14);
  }
  .v-select option {
    color: initial;
  }
  .v-stage {
    flex: 1 1 auto;
    position: relative;
    background: #fff;
    min-height: 0;
    /* Clip the comments panel's slide-in/out travel so it never spawns a transient scrollbar. */
    overflow: hidden;
  }
  .v-frame {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: #fff;
  }

  /* live revision toast */
  .v-toast {
    position: absolute;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%);
    z-index: 8;
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--ink);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: var(--radius-pill);
    padding: 8px 10px 8px 16px;
    font-size: 13px;
    box-shadow: var(--shadow-lg);
    animation: v-toast-in 0.18s var(--ease);
  }
  .v-toast.applied {
    background: #3a2408;
    border-color: #7c521f;
  }
  .v-toast-dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ochre);
  }
  .v-toast-btn {
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    color: var(--pigment-ink);
    background: var(--ochre);
    border: 0;
    border-radius: var(--radius-pill);
    padding: 4px 12px;
    cursor: pointer;
  }
  .v-toast-btn:hover {
    background: #b9752f;
  }
  .v-toast-x {
    border: 0;
    background: transparent;
    color: #b3ada0;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    width: 22px;
    height: 22px;
    border-radius: 50%;
  }
  .v-toast-x:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
  }
  @keyframes v-toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }

  /* Desktop defaults: the Comment icon is hidden (label-only, as before); the wrappers are layout-
     transparent so the bar is byte-for-byte unchanged; the kebab is hidden but stays in the DOM so
     its bind:this stays valid for the Share popover's mobile anchor. */
  .v-comment-ic {
    display: none;
  }
  .v-owner-actions,
  .v-user,
  .v-connect {
    display: contents;
  }

  /* The viewer bar is dense, so the "Connect" pill stays full only on wide desktop; from 1024px
     down it collapses to an icon (ConnectGuide's own ≤768 rule then carries it on through mobile), so
     the bar never overflows at small-desktop / tablet-landscape widths. */
  @media (max-width: 1024px) {
    .v-connect :global(.trigger.nav) {
      width: 34px;
      height: 34px;
      padding: 0;
      justify-content: center;
    }
    .v-connect :global(.trigger.nav .trigger-label) {
      display: none;
    }
    /* In the same dense range, the account chip goes avatar-only (it already does at ≤768; this just
       extends it on the viewer) so the title keeps its room — the name still shows in the open menu. */
    .v-user :global(.un),
    .v-user :global(.uc-chev) {
      display: none;
    }
    .v-user :global(.user-chip) {
      gap: 0;
      padding: 4px;
    }
  }
  .v-kebab {
    display: none;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.06);
    border-radius: 50%;
    color: #ece6d8;
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .v-kebab svg {
    width: 18px;
    height: 18px;
  }
  .v-kebab:hover,
  .v-kebab[aria-expanded="true"] {
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.28);
  }

  /* ---- mobile viewer bar (≤768; desktop ≥769 unaffected) ----
     Compact bar: [logo mark] [title] [version] [comment ●] [⋯]. Owner actions + account move into
     the kebab menu; the visibility pill, dividers and inline "newer" jump are dropped (the jump
     reappears in the kebab). */
  @media (max-width: 768px) {
    .v-bar {
      height: 48px;
      padding: 0 8px;
      gap: 8px;
    }
    .v-bar-left {
      gap: 8px;
    }
    .v-divider-left,
    .v-vis,
    .v-newer,
    .v-owner-actions,
    .v-user {
      display: none;
    }
    .v-kebab {
      display: inline-flex;
    }
    .v-select {
      font-size: 12px;
      padding: 5px 7px;
      max-width: 124px;
    }
    .v-comment {
      width: 34px;
      height: 34px;
      padding: 0;
    }
    .v-comment-ic {
      display: block;
    }
    .v-comment-label {
      display: none;
    }
  }
</style>
