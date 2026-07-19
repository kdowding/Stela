<script lang="ts">
  import type { Snippet } from "svelte";
  import { tick } from "svelte";

  let {
    anchor,
    open = $bindable(false),
    placement = "bottom-start",
    gap = 8,
    width,
    label = "Menu",
    children,
    onclose,
  }: {
    /** The trigger element the panel is positioned against (bind:this on the trigger). */
    anchor?: HTMLElement;
    open?: boolean;
    /** Which trigger edge the panel aligns to. */
    placement?: "bottom-start" | "bottom-end";
    gap?: number;
    /** Optional fixed panel width (px). */
    width?: number;
    label?: string;
    children: Snippet;
    onclose?: () => void;
  } = $props();

  let panel = $state<HTMLDivElement>();
  let pos = $state({ top: 0, left: 0, placeUp: false });

  function reposition() {
    if (!anchor || !panel) return;
    const r = anchor.getBoundingClientRect();
    const pw = width ?? panel.offsetWidth;
    const ph = panel.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;

    let left = placement === "bottom-end" ? r.right - pw : r.left;
    left = Math.min(Math.max(margin, left), vw - pw - margin);

    // Flip above the trigger when there isn't room below but there is above.
    const placeUp = r.bottom + gap + ph > vh - margin && r.top - gap - ph > margin;
    const top = placeUp ? r.top - gap - ph : r.bottom + gap;

    pos = { top, left, placeUp };
  }

  function close() {
    if (!open) return;
    open = false;
    onclose?.();
    anchor?.focus();
  }

  // Open lifecycle: measure + position, focus the panel, and wire global listeners.
  $effect(() => {
    if (!open) return;
    let raf = 0;
    void (async () => {
      await tick();
      reposition();
      // Re-measure once more after layout settles (fonts/content), then focus.
      raf = requestAnimationFrame(() => {
        reposition();
        const focusable = panel?.querySelector<HTMLElement>(
          "[data-autofocus], button:not(:disabled), [href], input, [tabindex]:not([tabindex='-1'])",
        );
        (focusable ?? panel)?.focus();
      });
    })();

    const onScroll = () => reposition();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel?.contains(t) || anchor?.contains(t)) return;
      close();
    };
    // A click that lands inside the sandboxed artifact iframe never reaches the document handler above
    // (the event stays in the iframe), but it does steal focus → the window blurs. Close on that, so
    // clicking the artifact dismisses the panel. (Also closes on tab-away, which is fine.) Pairing
    // these two — rather than an overlay scrim — keeps trigger clicks live, so clicking a different
    // popover's trigger closes this one AND opens that one in a single click.
    const onBlur = () => close();

    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("blur", onBlur);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  });
</script>

{#if open}
  <div
    class="popover"
    class:up={pos.placeUp}
    bind:this={panel}
    role="dialog"
    aria-label={label}
    tabindex="-1"
    style:top="{pos.top}px"
    style:left="{pos.left}px"
    style:width={width ? `${width}px` : undefined}
  >
    {@render children()}
  </div>
{/if}

<style>
  .popover {
    position: fixed;
    z-index: 60;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-pop);
    outline: none;
    transform-origin: top center;
    animation: pop-down var(--t-fast) var(--ease);
  }
  .popover.up {
    transform-origin: bottom center;
    animation: pop-up var(--t-fast) var(--ease);
  }
  @keyframes pop-down {
    from {
      opacity: 0;
      transform: translateY(-6px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  @keyframes pop-up {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
</style>
