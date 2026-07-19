<script lang="ts">
  let {
    id,
    title,
    onClose,
    onDeleted,
  }: {
    id: string;
    title: string;
    onClose: () => void;
    /** Called after the artifact is gone (HTTP 204, or 404 = already gone — both succeed). */
    onDeleted: () => void;
  } = $props();

  let deleting = $state(false);
  let errorMsg = $state<string | null>(null);

  // Map status to a fixed message — never echo arbitrary server/proxy response text.
  function deleteErrorFor(status: number): string {
    if (status === 403) return "You can no longer manage this artifact.";
    if (status === 429) return "Too many requests — wait a moment and try again.";
    return "Couldn't delete the artifact. Please try again.";
  }

  async function confirmDelete() {
    deleting = true;
    errorMsg = null;
    try {
      // Same-origin browser DELETE: the Origin header satisfies the server's CSRF guard, and the
      // Easy Auth cookie rides along. 404 = already deleted elsewhere → treat as success (idempotent).
      const res = await fetch(`/api/artifacts/${id}`, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        onDeleted();
        return;
      }
      errorMsg = deleteErrorFor(res.status);
      deleting = false;
    } catch {
      errorMsg = "Couldn't reach the server. Check your connection and try again.";
      deleting = false;
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && !deleting) onClose();
  }}
/>

<button
  type="button"
  class="modal-backdrop"
  aria-label="Cancel"
  onclick={() => {
    if (!deleting) onClose();
  }}
></button>
<div class="modal" role="dialog" aria-modal="true" aria-label="Delete artifact">
  <h2 class="modal-title">Delete “{title}”?</h2>
  <p class="muted-note">
    This permanently deletes the artifact and every version, its revision history, and all comments.
    This can’t be undone.
  </p>

  {#if errorMsg}<p class="error-text">{errorMsg}</p>{/if}

  <div class="modal-actions">
    <button type="button" class="btn ghost" onclick={onClose} disabled={deleting}>Cancel</button>
    <button type="button" class="btn danger" onclick={confirmDelete} disabled={deleting}>
      {deleting ? "Deleting…" : "Delete"}
    </button>
  </div>
</div>
