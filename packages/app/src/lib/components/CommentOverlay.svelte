<script lang="ts">
  import { tick } from "svelte";
  import type { Comment, DomAnchor } from "@stela/shared";
  import type { CommentsController } from "$lib/comments/CommentsController.svelte";

  let {
    controller,
    commentMode = $bindable(false),
    positions = {},
    probe,
    onOpen,
  }: {
    controller: CommentsController;
    /** Pin-placement mode: while on, the catcher arms and a click drops a pin. */
    commentMode?: boolean;
    /** Live pin positions streamed from the bridge (dom-anchored pins), keyed by comment id. */
    positions?: Record<string, { xNorm: number; yNorm: number; visible: boolean; resolved: boolean }>;
    /** Ask the bridge for a dom-anchor descriptor at a normalized point (placement capture). */
    probe?: (xNorm: number, yNorm: number) => Promise<unknown>;
    /** Open a pin's thread — selects it AND ensures the panel is showing, even if it's already active. */
    onOpen?: (id: string) => void;
  } = $props();

  // Only the draft pin + ghost are local to the canvas; everything else lives on the controller and is
  // shown in the side panel. A comment placed here surfaces as an open thread in the panel.
  let draft = $state<{ xNorm: number; yNorm: number; body: string; dom?: DomAnchor } | null>(null);
  let draftTextarea = $state<HTMLTextAreaElement>();
  let ghost = $state<{ x: number; y: number } | null>(null);
  let layer: HTMLDivElement | undefined;

  let pins = $derived(controller.partition.onPage);

  // A pin's live position: the bridge's streamed coords when it resolved the dom-anchor (so the pin
  // tracks the content + hides when off-page/off-screen); otherwise the stored coordinate — legacy pins,
  // and the hybrid fallback when the element can't be resolved.
  function pinPos(c: Comment) {
    const p = positions[c.id];
    if (p && p.resolved) return p;
    return { xNorm: c.anchor?.xNorm ?? 0, yNorm: c.anchor?.yNorm ?? 0, visible: true };
  }

  // Leaving comment mode, or the artifact navigating to another page, cancels an in-progress pin.
  $effect(() => {
    if (!commentMode) {
      draft = null;
      ghost = null;
    }
  });
  $effect(() => {
    void controller.view?.key;
    draft = null;
  });

  // Cancel a pending draft on an outside click / Escape (a click inside the sandboxed iframe doesn't
  // reach us but blurs the window, so we cancel on that too).
  $effect(() => {
    if (!draft) return;
    const cancel = () => (draft = null);
    const onPointer = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".draft, .pin-pending")) return;
      cancel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
    };
  });

  async function placeDraft(e: MouseEvent) {
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    const xNorm = (e.clientX - rect.left) / rect.width;
    const yNorm = (e.clientY - rect.top) / rect.height;
    draft = { xNorm, yNorm, body: "" };
    await tick();
    draftTextarea?.focus();
    // Capture the DOM anchor in the background so the pin can track the content (the coordinate above is
    // the hybrid fallback). Don't block the composer on the round-trip.
    const dom = (await probe?.(xNorm, yNorm)) as DomAnchor | null;
    if (draft) draft.dom = dom ?? undefined;
  }

  // offsetX/Y on the full-stage catcher is already in the overlay's coordinate space, so the ghost sits
  // exactly where placeDraft will drop the pin.
  function trackGhost(e: PointerEvent) {
    ghost = { x: e.offsetX, y: e.offsetY };
  }

  // Unfold the draft out of the pin: anchor a corner at the pin and expand toward whichever diagonal has
  // room, transform-origin at that corner so c-emerge scales from the pin.
  function cardStyle(xNorm: number, yNorm: number, cardW: number, cardH: number): string {
    const w = layer?.clientWidth ?? 1024;
    const h = layer?.clientHeight ?? 768;
    const px = xNorm * w;
    const py = yNorm * h;
    const gap = 12;
    const expandLeft = px + gap + cardW > w && px - gap - cardW > 0;
    const expandUp = py + gap + cardH > h && py - gap - cardH > 0;
    const xCss = expandLeft
      ? `right:${(100 - xNorm * 100).toFixed(2)}%;margin-right:${gap}px;`
      : `left:${(xNorm * 100).toFixed(2)}%;margin-left:${gap}px;`;
    const yCss = expandUp
      ? `bottom:${(100 - yNorm * 100).toFixed(2)}%;margin-bottom:${gap}px;`
      : `top:${(yNorm * 100).toFixed(2)}%;margin-top:${gap}px;`;
    return `${xCss}${yCss}transform-origin:${expandLeft ? "right" : "left"} ${expandUp ? "bottom" : "top"};`;
  }

  async function submitDraft() {
    if (!layer || !draft || draft.body.trim().length === 0) return;
    const view = controller.view;
    const created = await controller.create({
      body: draft.body.trim(),
      version: controller.version,
      anchor: {
        version: controller.version,
        xNorm: draft.xNorm,
        yNorm: draft.yNorm,
        scrollYNorm: 0,
        renderWidth: layer.clientWidth,
        // Stamp the page the pin was placed on, when the artifact reports one (multi-page artifacts).
        ...(view ? { viewKey: view.key, viewLabel: view.label } : {}),
        // The DOM anchor (when the bridge captured one) makes the pin track the content as it scrolls.
        ...(draft.dom ? { dom: draft.dom } : {}),
      },
    });
    if (created) {
      draft = null;
      commentMode = false;
      onOpen?.(created.id); // surface it in the panel
    }
  }
</script>

<div class="overlay" bind:this={layer}>
  {#if commentMode}
    <button
      type="button"
      class="catcher"
      aria-label="Place a comment"
      onclick={placeDraft}
      onpointermove={trackGhost}
      onpointerleave={() => (ghost = null)}
    ></button>
    {#if ghost}
      <span class="pin-ghost" style="left: {ghost.x}px; top: {ghost.y}px" aria-hidden="true"></span>
    {/if}
  {/if}

  {#each pins as c (c.id)}
    {@const p = pinPos(c)}
    {#if p.visible}
      <button
        type="button"
        class="pin"
        class:resolved={c.resolved}
        class:open={controller.openThreadId === c.id}
        class:hovered={controller.hoveredId === c.id}
        style="left: {p.xNorm * 100}%; top: {p.yNorm * 100}%"
        aria-label="Open comment thread"
        onmouseenter={() => (controller.hoveredId = c.id)}
        onmouseleave={() => {
          if (controller.hoveredId === c.id) controller.hoveredId = null;
        }}
        onclick={() => onOpen?.(c.id)}
      >
        <span class="pin-dot">
          {#if c.resolved}✓{:else if controller.replyCount(c.id) > 0}{controller.replyCount(c.id) + 1}{/if}
        </span>
      </button>
    {/if}
  {/each}

  {#if draft}
    <!-- Pending pin: where the comment lands the moment you save. Cancel removes both. -->
    <span class="pin-pending" style="left: {draft.xNorm * 100}%; top: {draft.yNorm * 100}%" aria-hidden="true">
      <span class="pin-dot"></span>
    </span>
    <div class="draft" style={cardStyle(draft.xNorm, draft.yNorm, 240, 150)}>
      <textarea bind:this={draftTextarea} bind:value={draft.body} placeholder="Add a comment…" rows="3"></textarea>
      <div class="draft-actions">
        <button type="button" class="btn ghost" onclick={() => (draft = null)}>Cancel</button>
        <button
          type="button"
          class="btn primary"
          disabled={controller.busy || draft.body.trim().length === 0}
          onclick={submitDraft}>Comment</button
        >
      </div>
    </div>
  {/if}
</div>
