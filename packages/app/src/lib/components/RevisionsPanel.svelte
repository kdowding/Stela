<script lang="ts">
  import type { Artifact, Version, DeleteVersionResponse } from "@stela/shared";

  let {
    artifact,
    canManage = false,
    onClose,
    onChanged,
  }: {
    artifact: Artifact;
    canManage?: boolean;
    onClose: () => void;
    /** Called after a version is deleted with the artifact's resulting currentVersion. */
    onChanged?: (currentVersion: number) => void;
  } = $props();

  let versions = $state<Version[]>([]);
  let loading = $state(true);
  // svelte-ignore state_referenced_locally
  let current = $state(artifact.currentVersion);
  let confirming = $state<number | null>(null);
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);

  async function load() {
    loading = true;
    try {
      const r = await fetch(`/api/artifacts/${artifact.id}/versions`, {
        headers: { accept: "application/json" },
      });
      if (r.ok) versions = (await r.json()) as Version[];
    } catch {
      /* leave empty */
    }
    loading = false;
  }

  $effect(() => {
    void load();
  });

  function deleteErrorFor(status: number): string {
    if (status === 409) return "Can't delete the only version.";
    if (status === 403 || status === 404) return "You can no longer manage this.";
    if (status === 429) return "Too many requests — try again shortly.";
    return "Couldn't delete that version.";
  }

  async function del(v: number) {
    busy = true;
    errorMsg = null;
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}/versions/${v}`, { method: "DELETE" });
      if (!res.ok) {
        errorMsg = deleteErrorFor(res.status);
        busy = false;
        return;
      }
      const body = (await res.json()) as DeleteVersionResponse;
      versions = versions.filter((x) => x.version !== v);
      current = body.currentVersion;
      confirming = null;
      onChanged?.(body.currentVersion);
    } catch {
      errorMsg = "Couldn't reach the server.";
    }
    busy = false;
  }

  function fmt(iso: string): string {
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

<div class="revs">
  <div class="revs-head">
    <span class="revs-eyebrow">Revisions</span>
    <span class="revs-title" title={artifact.title}>{artifact.title}</span>
  </div>

  {#if loading}
    <p class="revs-empty">Loading…</p>
  {:else if versions.length === 0}
    <p class="revs-empty">No revisions found.</p>
  {:else}
    <ul class="revs-list">
      {#each versions as v (v.version)}
        <li class="rev" class:is-current={v.version === current}>
          {#if confirming === v.version}
            <div class="rev-confirm">
              <span>Delete v{v.version}?</span>
              <div class="rev-confirm-actions">
                <button type="button" class="btn ghost sm" disabled={busy} onclick={() => (confirming = null)}>Cancel</button>
                <button type="button" class="btn danger sm" disabled={busy} onclick={() => del(v.version)}>
                  {busy ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          {:else}
            <a class="rev-main" href="/a/{artifact.id}?v={v.version}">
              <span class="rev-v">v{v.version}</span>
              {#if v.version === current}<span class="rev-cur">current</span>{/if}
              <span class="rev-when">{fmt(v.publishedAt)}</span>
              {#if v.note}<span class="rev-note" title={v.note}>{v.note}</span>{/if}
            </a>
            {#if canManage}
              <button
                type="button"
                class="rev-del"
                aria-label="Delete v{v.version}"
                title={versions.length <= 1 ? "Can't delete the only version" : "Delete this version"}
                disabled={versions.length <= 1}
                onclick={() => (confirming = v.version)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
              </button>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if errorMsg}<p class="error-text">{errorMsg}</p>{/if}

  <div class="revs-foot">
    <button type="button" class="btn ghost sm" onclick={onClose}>Close</button>
  </div>
</div>

<style>
  .revs {
    padding: 12px;
    width: 304px;
    max-width: calc(100vw - 24px);
  }
  .revs-head {
    display: flex;
    flex-direction: column;
    margin-bottom: 8px;
    padding: 0 2px;
  }
  .revs-eyebrow {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
  }
  .revs-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .revs-empty {
    color: var(--muted);
    font-size: 13px;
    padding: 8px 2px;
    margin: 0;
  }
  .revs-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 280px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .rev {
    display: flex;
    align-items: center;
    gap: 4px;
    border-radius: var(--radius-sm);
  }
  .rev:hover {
    background: var(--surface-tint);
  }
  .rev-main {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    color: var(--fg);
    border-radius: var(--radius-sm);
  }
  .rev-main:hover {
    text-decoration: none;
  }
  .rev-v {
    font-weight: 700;
    font-size: 13px;
  }
  .rev-cur {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--ok);
    background: var(--ok-tint);
    border-radius: var(--radius-pill);
    padding: 1px 7px;
  }
  .rev-when {
    font-size: 12px;
    color: var(--muted);
  }
  .rev-note {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .rev-del {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: var(--muted);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .rev-del svg {
    width: 15px;
    height: 15px;
  }
  .rev-del:hover:not(:disabled) {
    background: var(--danger-tint);
    color: var(--danger);
  }
  .rev-del:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .rev-confirm {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
  }
  .rev-confirm-actions {
    display: flex;
    gap: 6px;
  }
  .revs-foot {
    display: flex;
    justify-content: flex-end;
    margin-top: 10px;
  }
</style>
