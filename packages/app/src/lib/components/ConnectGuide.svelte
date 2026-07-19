<script lang="ts">
  import { page } from "$app/state";
  import Popover from "./Popover.svelte";

  let { variant = "nav" }: { variant?: "nav" | "hero" } = $props();

  let open = $state(false);
  let trigger = $state<HTMLButtonElement>();
  let tab = $state<"any" | "code" | "web">("any");
  let copied = $state<string | null>(null);

  // The MCP endpoint of THIS deployment — derived from the URL the user is browsing,
  // so it is right on any domain, in docker, and on localhost alike.
  const MCP_URL = $derived(`${page.url.origin}/mcp`);
  const CC_CMD = $derived(`claude mcp add --transport http stela ${MCP_URL}`);

  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = key;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = null), 1600);
    } catch {
      /* clipboard blocked — the text is still selectable as a fallback */
    }
  }
</script>

{#snippet glyph(cls: string)}
  <!-- the connection motif: an agent node wired to a slab -->
  <svg class={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="5" cy="12" r="2.4" />
    <path d="M7.5 12 H12.5" />
    <path d="M14 20 V8.5 Q14 5.5 17.5 5.5 Q21 5.5 21 8.5 V20" />
    <path d="M16.5 10 H18.5" />
  </svg>
{/snippet}

<button
  type="button"
  class="trigger {variant}"
  bind:this={trigger}
  onclick={() => (open = !open)}
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-label="Connect an agent to Stela"
>
  {@render glyph("cmark")}
  <span class="trigger-label">Connect</span>
</button>

<Popover anchor={trigger} bind:open placement="bottom-end" width={372} label="Connect an agent to Stela">
  <div class="guide">
    <div class="g-head">
      {@render glyph("cmark lg")}
      <strong>Publish from your agent</strong>
    </div>
    <p class="g-sub">
      Connect Stela to any MCP-capable agent — then publish &amp; edit artifacts straight from the
      chat (“Stela this”).
    </p>

    <div class="tabs" role="tablist" aria-label="Where to connect Stela">
      <button
        type="button"
        role="tab"
        id="tab-any"
        aria-controls="panel-any"
        aria-selected={tab === "any"}
        onclick={() => (tab = "any")}
      >
        Any agent
      </button>
      <button
        type="button"
        role="tab"
        id="tab-code"
        aria-controls="panel-code"
        aria-selected={tab === "code"}
        onclick={() => (tab = "code")}
      >
        Claude Code
      </button>
      <button
        type="button"
        role="tab"
        id="tab-web"
        aria-controls="panel-web"
        aria-selected={tab === "web"}
        onclick={() => (tab = "web")}
      >
        claude.ai
      </button>
    </div>

    {#if tab === "any"}
      <div role="tabpanel" id="panel-any" aria-labelledby="tab-any">
        <ol class="steps">
          <li>In your agent, add a <b>remote MCP server</b> (custom connector, Streamable HTTP).</li>
          <li>
            Point it at this server URL:
            <span class="url">
              <code>{MCP_URL}</code>
              <button type="button" class="copy" onclick={() => copy(MCP_URL, "url")}>
                {copied === "url" ? "Copied ✓" : "Copy"}
              </button>
            </span>
          </li>
          <li>Authorize on the Stela screen — sign in &amp; Approve in the browser.</li>
          <li>Done — say <b>“publish this to Stela”</b> in any chat.</li>
        </ol>
        <p class="g-note">
          ChatGPT, Grok, and Copilot Studio hosts are allowlisted out of the box; admit others via
          <code>OAUTH_ALLOWED_CLIENT_HOSTS</code>.
        </p>
      </div>
    {:else if tab === "code"}
      <div role="tabpanel" id="panel-code" aria-labelledby="tab-code">
        <ol class="steps">
          <li>
            Run this in your terminal:
            <span class="cmd">
              <code>{CC_CMD}</code>
              <button type="button" class="copy" onclick={() => copy(CC_CMD, "cmd")}>
                {copied === "cmd" ? "Copied ✓" : "Copy"}
              </button>
            </span>
          </li>
          <li>In <b>Claude Code</b>, run <b>/mcp</b> and authenticate — sign in &amp; Approve in the browser.</li>
          <li>Done — say <b>“publish this to Stela”</b> in any session.</li>
        </ol>
      </div>
    {:else}
      <div role="tabpanel" id="panel-web" aria-labelledby="tab-web">
        <ol class="steps">
          <li>In <b>claude.ai</b>, open <b>Customize → Connectors</b> → <b>Add custom connector</b>.</li>
          <li>
            Paste this server URL:
            <span class="url">
              <code>{MCP_URL}</code>
              <button type="button" class="copy" onclick={() => copy(MCP_URL, "url")}>
                {copied === "url" ? "Copied ✓" : "Copy"}
              </button>
            </span>
          </li>
          <li>Click <b>Add</b>, then <b>Authorize</b> on the Stela screen — sign in &amp; Approve.</li>
          <li>Done — say <b>“publish this to Stela”</b> in any chat.</li>
        </ol>
      </div>
    {/if}
    <p class="g-foot">Viewing shared artifacts needs no setup — connecting is only for publishing.</p>
  </div>
</Popover>

<style>
  .cmark {
    width: 16px;
    height: 16px;
    color: var(--ochre-bright);
    flex: 0 0 auto;
  }
  .trigger.hero .cmark {
    color: currentColor; /* dark-on-ochre hero button — the glyph follows the label */
  }
  .cmark.lg {
    width: 20px;
    height: 20px;
  }

  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font: inherit;
    font-weight: 600;
    border-radius: var(--radius-pill);
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease),
      transform var(--t-fast) var(--ease);
  }
  .trigger.nav {
    padding: 5px 13px 5px 11px;
    font-size: 13px;
    color: #ece6d8;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.14);
  }
  .trigger.nav:hover {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.26);
  }
  .trigger.hero {
    padding: 9px 18px 9px 15px;
    font-size: 14px;
    color: #241203;
    background: linear-gradient(150deg, #e8ae74 0%, #d08a4a 72%);
    border: 1px solid transparent;
    box-shadow: 0 6px 18px -6px rgba(0, 0, 0, 0.5);
  }
  .trigger.hero:hover {
    transform: translateY(-1px);
    box-shadow: 0 11px 26px -8px rgba(0, 0, 0, 0.55);
  }

  /* Mobile: the nav trigger collapses to an icon-only circle (the connection glyph), matching the bell.
     The hero trigger keeps its label — it's the primary call-to-action on the home page. */
  @media (max-width: 768px) {
    .trigger.nav {
      width: 34px;
      height: 34px;
      padding: 0;
      justify-content: center;
    }
    .trigger.nav .trigger-label {
      display: none;
    }
  }

  .guide {
    padding: 16px 16px 14px;
  }
  .g-head {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 8px;
  }
  .g-head strong {
    font-size: 15px;
    font-weight: 700;
    color: var(--fg);
  }
  .g-sub {
    margin: 0 0 15px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text);
  }
  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 12px;
    counter-reset: s;
  }
  .steps li {
    position: relative;
    padding-left: 30px;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--text);
    counter-increment: s;
  }
  .steps li::before {
    content: counter(s);
    position: absolute;
    left: 0;
    top: -1px;
    width: 21px;
    height: 21px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 700;
    color: #fff;
    background: var(--grad-brand);
  }
  .steps :global(b) {
    color: var(--fg);
    font-weight: 650;
  }
  .url {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 7px;
    background: var(--surface-tint);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px 4px 4px 10px;
  }
  .url code {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: #d8d2c3;
    background: none;
    padding: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .copy {
    flex: 0 0 auto;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
    background: rgba(var(--ochre-rgb), 0.18);
    color: #7fd0a1;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    padding: 5px 11px;
    transition: background var(--t-fast) var(--ease);
  }
  .copy:hover {
    background: rgba(var(--ochre-rgb), 0.3);
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 4px;
    margin-bottom: 16px;
    background: var(--surface-tint);
    border-radius: 10px;
  }
  .tabs button {
    flex: 1;
    border: 0;
    border-radius: 7px;
    padding: 7px 8px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 650;
    color: var(--muted);
    background: transparent;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .tabs button:hover {
    color: var(--text);
  }
  .tabs button[aria-selected="true"] {
    color: #fff;
    background: var(--grad-brand);
  }
  .cmd {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 7px;
    background: var(--surface-tint);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .cmd code {
    font-size: 12px;
    line-height: 1.5;
    color: #d8d2c3;
    background: none;
    padding: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .cmd .copy {
    align-self: flex-end;
  }
  .g-note {
    margin: 12px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted);
  }
  .g-note code {
    font-size: 11px;
    color: #d8d2c3;
    background: var(--surface-tint);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 5px;
  }
  .g-foot {
    margin: 14px 0 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--muted);
  }
</style>
