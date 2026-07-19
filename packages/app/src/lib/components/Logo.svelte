<script lang="ts">
  let {
    size = 24,
    variant = "mark",
  }: {
    /** Pixel height of the mark. */
    size?: number;
    /** "mark" = just the glyph tile; "lockup" = tile + wordmark. */
    variant?: "mark" | "lockup";
  } = $props();
</script>

<span class="logo" class:lockup={variant === "lockup"}>
  <!-- The boustrophedon: one continuous incision snaking through three rows — the way
       the oldest stelae were actually written, "as the ox plows" — ending in the ochre
       seal. Set in a chamfered tile: the cut slab. currentColor throughout so the mark
       works on dark chrome (limestone context) and light tiles (dark-stone context). -->
  <svg
    class="mark"
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    aria-hidden="true"
  >
    <!-- the slab tile: rounded corners, one knocked corner top-right -->
    <path
      d="M3 8 Q3 3 8 3 H20.5 L29 11.5 V24 Q29 29 24 29 H8 Q3 29 3 24 Z"
      stroke="currentColor"
      opacity="0.38"
      stroke-width="1.7"
      stroke-linejoin="round"
    />
    <!-- the inscription: one line, three rows, boustrophedon -->
    <path
      d="M9.5 11 H18.5 Q22.5 11 22.5 14.5 Q22.5 18 18.5 18 H13.5 Q9.5 18 9.5 21.5 Q9.5 25 13.5 25 H16.5"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      fill="none"
    />
    <!-- the seal: pigment at the line's end -->
    <circle cx="21.8" cy="25" r="2" fill="#d08a4a" />
  </svg>

  {#if variant === "lockup"}
    <span class="word">stela</span>
  {/if}
</span>

<style>
  .logo {
    display: inline-flex;
    align-items: center;
    color: inherit;
  }
  .logo.lockup {
    gap: 10px;
  }
  .mark {
    display: block;
    flex: 0 0 auto;
  }
  .word {
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 1.06em;
    letter-spacing: 0.22em;
    line-height: 1;
    color: currentColor;
    text-transform: lowercase;
  }
</style>
