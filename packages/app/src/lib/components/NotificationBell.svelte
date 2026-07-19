<script lang="ts">
  import { goto } from "$app/navigation";
  import Popover from "./Popover.svelte";

  // Mirrors the /api/notifications JSON (declared locally to avoid importing a $lib/server type).
  type Notification = {
    artifactId: string;
    artifactTitle: string;
    commentId: string;
    version: number;
    authorName: string;
    snippet: string;
    createdAt: string;
  };

  let items = $state<Notification[]>([]);
  let open = $state(false);
  let trigger = $state<HTMLButtonElement>();
  let count = $derived(items.length);

  async function refresh() {
    try {
      const r = await fetch("/api/notifications", { headers: { accept: "application/json" } });
      if (r.ok) items = (await r.json()) as Notification[];
    } catch {
      /* transient — the stream / next refresh recovers */
    }
  }

  // Live: the server pushes a nudge over SSE when a new comment lands for this user; we refetch.
  // EventSource auto-reconnects; the refocus refresh covers anything missed while disconnected.
  $effect(() => {
    void refresh();
    const es = new EventSource("/api/notifications/events");
    const onNotify = () => void refresh();
    es.addEventListener("notify", onNotify);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      es.removeEventListener("notify", onNotify);
      es.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  });

  async function openItem(n: Notification) {
    open = false;
    items = items.filter((i) => i.artifactId !== n.artifactId); // optimistic: opening clears the artifact
    try {
      await fetch(`/api/notifications?artifactId=${encodeURIComponent(n.artifactId)}`, {
        method: "DELETE",
      });
    } catch {
      /* best-effort — refresh will reconcile */
    }
    void goto(`/a/${n.artifactId}?v=${n.version}`);
  }

  async function markAll() {
    items = [];
    try {
      await fetch("/api/notifications", { method: "DELETE" });
    } catch {
      /* best-effort */
    }
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
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
</script>

<button
  type="button"
  class="notif-bell"
  class:has-unread={count > 0}
  bind:this={trigger}
  onclick={() => (open = !open)}
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications"}
>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
  {#if count > 0}
    <span class="notif-badge" aria-hidden="true">{count > 99 ? "99+" : count}</span>
  {/if}
</button>

<Popover anchor={trigger} bind:open placement="bottom-end" label="Notifications" width={340}>
  <div class="notif-panel">
    <div class="np-head">
      <span class="np-title">Notifications</span>
      {#if count > 0}
        <button type="button" class="np-clear" onclick={markAll}>Mark all read</button>
      {/if}
    </div>

    {#if count === 0}
      <p class="np-empty">You're all caught up.</p>
    {:else}
      <ul class="np-list">
        {#each items as n (n.artifactId + ":" + n.commentId)}
          <li>
            <button type="button" class="np-item" onclick={() => openItem(n)}>
              <span class="np-av" aria-hidden="true">{initials(n.authorName)}</span>
              <span class="np-body">
                <span class="np-line">
                  <strong>{n.authorName}</strong> commented on
                  <strong>{n.artifactTitle}</strong>
                  <span class="np-ver">v{n.version}</span>
                </span>
                <span class="np-snippet">{n.snippet}</span>
                <span class="np-time">{formatTime(n.createdAt)}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Popover>

<style>
  .notif-bell {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-pill);
    color: #ece6d8;
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .notif-bell:hover {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.26);
  }
  .notif-bell svg {
    width: 17px;
    height: 17px;
  }
  .notif-badge {
    position: absolute;
    top: -5px;
    right: -5px;
    min-width: 17px;
    height: 17px;
    padding: 0 4px;
    border-radius: 9px;
    background: var(--ochre);
    color: var(--pigment-ink, #1f1206);
    font-size: 10.5px;
    font-weight: 800;
    line-height: 17px;
    text-align: center;
    box-shadow: 0 0 0 2px var(--ink);
  }
  .notif-panel {
    width: 340px;
    max-width: calc(100vw - 24px);
    padding: 6px;
  }
  .np-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px 6px;
  }
  .np-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--fg);
  }
  .np-clear {
    border: 0;
    background: transparent;
    color: var(--accent, #d08a4a);
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .np-clear:hover {
    text-decoration: underline;
  }
  .np-empty {
    margin: 0;
    padding: 18px 12px 22px;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
  }
  .np-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 60vh;
    overflow-y: auto;
  }
  .np-item {
    display: flex;
    gap: 10px;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    padding: 9px 10px;
    border-radius: 8px;
    cursor: pointer;
    font: inherit;
  }
  .np-item:hover {
    background: var(--surface-tint);
  }
  .np-av {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--grad-brand);
    color: #fff;
    font-size: 10.5px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .np-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .np-line {
    font-size: 13px;
    color: var(--fg);
    line-height: 1.35;
  }
  .np-ver {
    color: var(--muted);
    font-size: 11.5px;
    font-weight: 600;
  }
  .np-snippet {
    font-size: 12.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .np-time {
    font-size: 11.5px;
    color: var(--muted);
  }
</style>
