<script lang="ts">
  import { isValidPrincipal, type Artifact, type Visibility, type UpdateSharingRequest } from "@stela/shared";

  let {
    artifact,
    onClose,
    onSaved,
  }: {
    artifact: Artifact;
    onClose: () => void;
    onSaved: (a: Artifact) => void;
  } = $props();

  const VIS_OPTIONS: { value: Visibility; title: string; sub: string }[] = [
    { value: "private", title: "Private", sub: "Only you" },
    { value: "everyone", title: "Everyone", sub: "Anyone signed in to this server" },
    { value: "restricted", title: "Specific people", sub: "Only people you add" },
  ];

  // svelte-ignore state_referenced_locally
  let visibility = $state<Visibility>(artifact.visibility);
  // svelte-ignore state_referenced_locally
  let principals = $state<string[]>([...artifact.allowedPrincipals]);
  let newPrincipal = $state("");
  let saving = $state(false);
  let errorMsg = $state<string | null>(null);
  let copied = $state(false);

  // svelte-ignore state_referenced_locally
  const shareUrl =
    typeof location !== "undefined" ? `${location.origin}/a/${artifact.id}` : `/a/${artifact.id}`;

  function addPrincipal() {
    const v = newPrincipal.trim();
    if (!v) return;
    if (!isValidPrincipal(v)) {
      errorMsg = "Enter a valid email address or user id.";
      return;
    }
    if (!principals.includes(v)) principals = [...principals, v];
    newPrincipal = "";
    errorMsg = null;
  }
  function removePrincipal(p: string) {
    principals = principals.filter((x) => x !== p);
  }
  function onAddKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      addPrincipal();
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // clipboard may be blocked — ignore
    }
  }

  // Map status to a fixed message — never echo arbitrary server/proxy response text.
  function sharingErrorFor(status: number): string {
    if (status === 403 || status === 404) return "You can no longer manage this artifact.";
    if (status === 413) return "Too many people added — remove some and try again.";
    if (status === 429) return "Too many requests — wait a moment and try again.";
    if (status === 400) return "Those sharing settings aren't valid.";
    return "Couldn't save sharing settings. Please try again.";
  }

  async function save() {
    saving = true;
    errorMsg = null;
    const body: UpdateSharingRequest = {
      visibility,
      allowedPrincipals: visibility === "restricted" ? principals : [],
    };
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}/sharing`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        errorMsg = sharingErrorFor(res.status);
        saving = false;
        return;
      }
      onSaved((await res.json()) as Artifact);
    } catch {
      errorMsg = "Couldn't reach the server. Check your connection and try again.";
      saving = false;
    }
  }
</script>

<div class="share-panel">
  <div class="sp-head">
    <span class="sp-eyebrow">Share</span>
    <span class="sp-title" title={artifact.title}>{artifact.title}</span>
  </div>

  <div class="vis-grid">
    {#each VIS_OPTIONS as opt (opt.value)}
      <button
        type="button"
        class="vis-card"
        class:active={visibility === opt.value}
        onclick={() => (visibility = opt.value)}
      >
        <span class="vis-ic" aria-hidden="true">
          {#if opt.value === "private"}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          {:else if opt.value === "everyone"}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18" /><path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" /><path d="M10 9h0M14 9h0M10 13h0M14 13h0" /></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
          {/if}
        </span>
        <span class="vis-text">
          <span class="vis-title">{opt.title}</span>
          <span class="vis-sub">{opt.sub}</span>
        </span>
      </button>
    {/each}
  </div>

  {#if visibility === "restricted"}
    <div class="people">
      <div class="add-row">
        <input
          type="email"
          aria-label="Add a person by email"
          placeholder="name@example.com"
          bind:value={newPrincipal}
          onkeydown={onAddKey}
        />
        <button type="button" class="btn ghost sm" onclick={addPrincipal}>Add</button>
      </div>
      {#if principals.length === 0}
        <p class="muted-note">No one added yet — only you can view.</p>
      {:else}
        <ul class="chips">
          {#each principals as p (p)}
            <li class="chip">
              <span>{p}</span>
              <button type="button" aria-label="Remove {p}" onclick={() => removePrincipal(p)}>×</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <div class="link-row">
    <input type="text" readonly value={shareUrl} aria-label="Share link" />
    <button type="button" class="btn ghost sm" onclick={copyLink}>
      {copied ? "Copied!" : "Copy link"}
    </button>
  </div>

  {#if errorMsg}<p class="error-text">{errorMsg}</p>{/if}

  <div class="sp-actions">
    <button type="button" class="btn ghost sm" onclick={onClose}>Cancel</button>
    <button type="button" class="btn primary sm" onclick={save} disabled={saving}>
      {saving ? "Saving…" : "Save"}
    </button>
  </div>
</div>

<style>
  .share-panel {
    padding: 14px;
    width: 340px;
    max-width: calc(100vw - 24px);
  }
  .sp-head {
    display: flex;
    flex-direction: column;
    margin-bottom: 12px;
  }
  .sp-eyebrow {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
  }
  .sp-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vis-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .sp-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
</style>
