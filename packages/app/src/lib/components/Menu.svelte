<script lang="ts">
  import type { Snippet } from "svelte";

  let { children, label = "Menu" }: { children: Snippet; label?: string } = $props();

  let root = $state<HTMLDivElement>();

  function items(): HTMLElement[] {
    return root ? Array.from(root.querySelectorAll<HTMLElement>(".menu-item:not(:disabled)")) : [];
  }

  function onkeydown(e: KeyboardEvent) {
    const list = items();
    if (list.length === 0) return;
    const cur = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      list[(cur + 1 + list.length) % list.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      list[(cur - 1 + list.length) % list.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      list[list.length - 1]?.focus();
    }
  }
</script>

<div class="menu" role="menu" aria-label={label} tabindex="-1" bind:this={root} {onkeydown}>
  {@render children()}
</div>
