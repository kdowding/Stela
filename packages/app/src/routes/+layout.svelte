<script lang="ts">
  import "../app.css";
  import { page } from "$app/stores";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";
  import Logo from "$lib/components/Logo.svelte";
  import UserMenu from "$lib/components/UserMenu.svelte";
  import NotificationBell from "$lib/components/NotificationBell.svelte";
  import ConnectGuide from "$lib/components/ConnectGuide.svelte";

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  // The artifact viewer opts into full-bleed via page data; everything else — including an error
  // page thrown on an /a/* route — keeps portal chrome + nav.
  let bare = $derived($page.data.fullBleed === true);

  // Easy Auth appends the session token as a URL fragment (#token={authenticationToken,user}) on the
  // first post-sign-in redirect. The app never reads it, and it shouldn't linger in the address bar or
  // browser history (copy-paste / screen-share leak), so strip it on load. Client-side only ($effect
  // never runs during SSR); replaceState rewrites the URL without a navigation or reload.
  $effect(() => {
    if (location.hash.startsWith("#token=")) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  });
</script>

{#if bare}
  {@render children()}
{:else}
  <div class="app">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Stela home">
        <Logo size={25} variant="lockup" />
      </a>
      <div class="topbar-right">
        <ConnectGuide />
        {#if data.user}
          <NotificationBell />
          <UserMenu user={data.user} />
        {:else}
          <span class="signed-out">Not signed in</span>
        {/if}
      </div>
    </header>
    <main class="content">
      {@render children()}
    </main>
  </div>
{/if}

<style>
  .topbar {
    position: sticky;
    top: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 50px;
    padding: 0 20px;
    color: #fff;
    background: linear-gradient(180deg, #191a1f 0%, var(--ink) 100%);
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04);
  }
  /* the brand blue->green accent line under the chrome (a signature site treatment) */
  .topbar::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: var(--grad-brand);
    opacity: 0.9;
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    color: #fff;
  }
  .brand:hover {
    text-decoration: none;
    opacity: 0.92;
  }
  .signed-out {
    color: #8b867a;
    font-size: 14px;
  }

  @media (max-width: 768px) {
    .topbar {
      padding: 0 14px;
    }
    .topbar-right {
      gap: 8px;
    }
  }
  @media (max-width: 360px) {
    .topbar {
      padding: 0 11px;
    }
  }
</style>
