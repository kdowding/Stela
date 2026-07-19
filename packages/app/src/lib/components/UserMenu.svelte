<script lang="ts">
  import Popover from "./Popover.svelte";
  import Menu from "./Menu.svelte";

  let { user }: { user: { name: string; email: string } } = $props();

  let open = $state(false);
  let trigger = $state<HTMLButtonElement>();

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
</script>

<button
  type="button"
  class="user-chip"
  bind:this={trigger}
  onclick={() => (open = !open)}
  aria-haspopup="menu"
  aria-expanded={open}
  aria-label="Account menu, {user.name}"
>
  <span class="ua" aria-hidden="true">{initials(user.name)}</span>
  <span class="un">{user.name}</span>
  <svg class="uc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
</button>

<Popover anchor={trigger} bind:open placement="bottom-end" label="Account">
  <Menu label="Account">
    <div class="um-head">
      <span class="um-avatar" aria-hidden="true">{initials(user.name)}</span>
      <div class="um-id">
        <div class="um-name">{user.name}</div>
        <div class="um-email" title={user.email}>{user.email}</div>
      </div>
    </div>
    <div class="menu-sep"></div>
    <a class="menu-item" role="menuitem" href="/" onclick={() => (open = false)}>
      <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg></span>
      All artifacts
    </a>
    <a class="menu-item" role="menuitem" href="/.auth/logout">
      <span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg></span>
      Sign out
    </a>
  </Menu>
</Popover>

<style>
  .user-chip {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-pill);
    padding: 4px 10px 4px 5px;
    color: #ece6d8;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .user-chip:hover {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.26);
  }
  .ua {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--grad-brand);
    color: #fff;
    font-size: 10.5px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    letter-spacing: 0.3px;
  }
  .un {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .uc-chev {
    width: 14px;
    height: 14px;
    opacity: 0.7;
  }
  .um-head {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 6px 10px 8px;
  }
  .um-avatar {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: var(--grad-brand);
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
  }
  .um-id {
    min-width: 0;
  }
  .um-name {
    font-size: 14px;
    font-weight: 700;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .um-email {
    font-size: 12.5px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }

  /* Mobile: collapse the chip to an avatar-only circle. The name/email still appear in the open menu's
     header, so no identity is lost — the topbar just reclaims the space. */
  @media (max-width: 768px) {
    .user-chip {
      gap: 0;
      padding: 4px;
    }
    .un,
    .uc-chev {
      display: none;
    }
  }
</style>
