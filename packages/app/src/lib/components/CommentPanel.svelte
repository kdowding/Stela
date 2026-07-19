<script lang="ts">
  import { fly } from "svelte/transition";
  import type { Comment } from "@stela/shared";
  import type { CommentsController } from "$lib/comments/CommentsController.svelte";

  let {
    controller,
    open = $bindable(false),
    commentMode = $bindable(false),
    currentUserId,
    canManage = false,
    onNavigate,
  }: {
    controller: CommentsController;
    open?: boolean;
    /** Bound to the overlay: arms pin-placement on the artifact. */
    commentMode?: boolean;
    currentUserId?: string;
    canManage?: boolean;
    /** Drive the artifact to a page (for jumping to an off-page pin). */
    onNavigate?: (key: string) => void;
  } = $props();

  let composerText = $state("");
  let replyText = $state("");
  let confirmingDeleteId = $state<string | null>(null);

  // Off-page pins grouped by their page, with the comments (not just counts) so we can list them.
  let otherPages = $derived.by(() => {
    const m = new Map<string, { key: string; label: string; comments: Comment[] }>();
    for (const c of controller.partition.offPage) {
      if (!c.anchor) continue;
      const k = c.anchor.viewKey ?? "";
      const g = m.get(k) ?? { key: k, label: c.anchor.viewLabel || c.anchor.viewKey || "Another page", comments: [] };
      g.comments.push(c);
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.comments.length - a.comments.length);
  });

  function toggle(id: string) {
    controller.openThreadId = controller.openThreadId === id ? null : id;
    replyText = "";
    confirmingDeleteId = null;
  }

  // An off-page row jumps the artifact to that pin's page first (via the bridge), then opens it; on-page
  // and general rows just toggle open in place.
  function rowClick(c: Comment) {
    const cv = controller.view;
    if (c.anchor?.viewKey && cv && c.anchor.viewKey !== cv.key) {
      onNavigate?.(c.anchor.viewKey);
      controller.openThreadId = c.id;
      replyText = "";
      confirmingDeleteId = null;
    } else {
      toggle(c.id);
    }
  }

  async function postGeneral() {
    if (composerText.trim().length === 0) return;
    const created = await controller.create({ body: composerText.trim(), version: controller.version });
    if (created) {
      composerText = "";
      controller.openThreadId = created.id;
    }
  }

  async function sendReply(parent: Comment) {
    if (replyText.trim().length === 0) return;
    const created = await controller.create({
      body: replyText.trim(),
      version: controller.version,
      parentId: parent.id,
    });
    if (created) replyText = "";
  }

  async function removeIt(c: Comment) {
    const ok = await controller.remove(c.id);
    if (ok) confirmingDeleteId = null;
  }

  function canDelete(c: Comment): boolean {
    return !!currentUserId && (c.authorId === currentUserId || canManage);
  }

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function formatTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
</script>

{#snippet thread(c: Comment, place: string | null)}
  <div class="cp-item" class:open={controller.openThreadId === c.id} class:resolved={c.resolved}>
    <button
      type="button"
      class="cp-row"
      class:hovered={controller.hoveredId === c.id}
      onmouseenter={() => (controller.hoveredId = c.id)}
      onmouseleave={() => {
        if (controller.hoveredId === c.id) controller.hoveredId = null;
      }}
      onclick={() => rowClick(c)}
    >
      <span class="avatar" aria-hidden="true">{initials(c.authorName)}</span>
      <span class="cp-main">
        <span class="cp-meta">
          <span class="cp-author">{c.authorName}</span>
          <span class="cp-time">{formatTime(c.createdAt)}</span>
        </span>
        <span class="cp-text">{c.body}</span>
        <span class="cp-sub">
          {#if c.resolved}<span class="cp-tag ok">Resolved</span>{/if}
          {#if place}<span class="cp-tag">{place}</span>{/if}
          {#if controller.replyCount(c.id) > 0}
            <span class="cp-replies">{controller.replyCount(c.id)} repl{controller.replyCount(c.id) === 1 ? "y" : "ies"}</span>
          {/if}
        </span>
      </span>
    </button>

    {#if controller.openThreadId === c.id}
      <div class="cp-thread">
        {#each controller.repliesByParent.get(c.id) ?? [] as r (r.id)}
          <div class="cp-reply">
            <span class="avatar sm" aria-hidden="true">{initials(r.authorName)}</span>
            <div class="cp-reply-main">
              <div class="cp-meta">
                <span class="cp-author">{r.authorName}</span>
                <span class="cp-time">{formatTime(r.createdAt)}</span>
              </div>
              <div class="cp-text">{r.body}</div>
            </div>
          </div>
        {/each}

        <div class="cp-reply-row">
          <textarea
            bind:value={replyText}
            placeholder="Reply…"
            rows="2"
            onkeydown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                sendReply(c);
              }
            }}
          ></textarea>
          <button type="button" class="btn xs primary" disabled={controller.busy || replyText.trim().length === 0} onclick={() => sendReply(c)}>
            Reply
          </button>
        </div>

        <div class="cp-act">
          {#if confirmingDeleteId === c.id}
            <span class="cp-confirm">Delete?</span>
            <button type="button" class="link-btn" disabled={controller.busy} onclick={() => (confirmingDeleteId = null)}>Cancel</button>
            <button type="button" class="link-btn danger" disabled={controller.busy} onclick={() => removeIt(c)}>Delete</button>
          {:else}
            <button type="button" class="link-btn" disabled={controller.busy} onclick={() => controller.toggleResolved(c)}>
              {c.resolved ? "Reopen" : "Resolve"}
            </button>
            {#if canDelete(c)}
              <button type="button" class="link-btn danger" disabled={controller.busy} onclick={() => (confirmingDeleteId = c.id)}>Delete</button>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/snippet}

{#if open}
  <!-- Slide in/out from the right edge so the artifact's scrollbar (which sits under the panel) is
       covered gradually rather than blinking out. The stage clips the off-screen travel. -->
  <aside class="cp" aria-label="Comments" transition:fly={{ x: 360, duration: 220, opacity: 1 }}>
    <header class="cp-head">
      <span class="cp-title">Comments</span>
      {#if controller.total > 0}<span class="cp-count">{controller.total}</span>{/if}
      <button type="button" class="cp-x" aria-label="Close comments" onclick={() => (open = false)}>×</button>
    </header>

    <div class="cp-composer">
      <textarea bind:value={composerText} placeholder="Add to the discussion…" rows="2"></textarea>
      <div class="cp-composer-actions">
        <button
          type="button"
          class="btn xs {commentMode ? 'accent' : 'ghost'}"
          aria-pressed={commentMode}
          onclick={() => (commentMode = !commentMode)}
          title="Click a spot on the artifact to pin a comment"
        >
          {commentMode ? "Click a spot…" : "📍 Pin a spot"}
        </button>
        <button type="button" class="btn xs primary" disabled={controller.busy || composerText.trim().length === 0} onclick={postGeneral}>
          Comment
        </button>
      </div>
    </div>

    <div class="cp-body">
      {#if controller.total === 0}
        <p class="cp-empty">No comments yet. Start a discussion above, or pin one to a spot on the artifact.</p>
      {/if}

      {#if controller.general.length > 0}
        <section class="cp-section">
          <h3 class="cp-sec-head">Discussion</h3>
          {#each controller.general as c (c.id)}
            {@render thread(c, null)}
          {/each}
        </section>
      {/if}

      {#if controller.partition.onPage.length > 0}
        <section class="cp-section">
          <h3 class="cp-sec-head">{controller.view ? "On this page" : "Pinned"}</h3>
          {#each controller.partition.onPage as c (c.id)}
            {@render thread(c, null)}
          {/each}
        </section>
      {/if}

      {#each otherPages as g (g.key)}
        <section class="cp-section">
          <h3 class="cp-sec-head">Other pages · {g.label}</h3>
          {#each g.comments as c (c.id)}
            {@render thread(c, g.label)}
          {/each}
        </section>
      {/each}
    </div>
  </aside>
{/if}
