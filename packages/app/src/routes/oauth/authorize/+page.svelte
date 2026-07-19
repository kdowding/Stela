<script lang="ts">
  import type { PageData } from "./$types";
  import Logo from "$lib/components/Logo.svelte";
  // Official vendor logo SVGs (sourced into src/lib/brands). Inlined at build via ?raw so the consent
  // page stays self-contained — no asset request. To brand a new vendor, add its key to brandFor() +
  // a themed tile in the CSS, and drop its mark here.
  import grokMark from "$lib/brands/grok.svg?raw";
  import openaiMark from "$lib/brands/openai.svg?raw";
  import copilotMark from "$lib/brands/copilot-color.svg?raw";

  let { data }: { data: PageData } = $props();
  const r = $derived(data.request);

  const initials = $derived(
    (
      (data.user.name || data.user.email || "?")
        .trim()
        .split(/\s+/)
        .map((w) => w[0])
        .slice(0, 2)
        .join("") || "?"
    ).toUpperCase(),
  );
  // Identify the connecting client to brand the tile. The OAuth callback HOST is the reliable signal —
  // a client's registered name can be arbitrary (Copilot via Power Platform registers under the user's
  // connector name, e.g. "stela", not "Copilot"), but its redirect host is fixed per vendor. Fall back
  // to the registered name for loopback clients (Claude Code redirects to 127.0.0.1, no vendor host).
  // Unknown → neutral tile with the name's initial.
  type Brand = { key: "claude" | "grok" | "openai" | "copilot" | "generic"; initial: string };
  function brandFor(name: string | undefined, redirectUri: string | undefined): Brand {
    let host = "";
    try {
      host = redirectUri ? new URL(redirectUri).hostname.toLowerCase() : "";
    } catch {
      host = "";
    }
    if (host === "claude.ai" || host === "claude.com") return { key: "claude", initial: "C" };
    if (host === "grok.com") return { key: "grok", initial: "G" };
    if (host === "chatgpt.com") return { key: "openai", initial: "O" };
    if (host === "global.consent.azure-apim.net") return { key: "copilot", initial: "C" }; // Copilot Studio / Power Platform
    const n = name || "";
    if (/claude|anthropic/i.test(n)) return { key: "claude", initial: "C" };
    if (/grok|xai|x\.ai/i.test(n)) return { key: "grok", initial: "G" };
    if (/chatgpt|openai/i.test(n)) return { key: "openai", initial: "O" };
    if (/copilot|microsoft/i.test(n)) return { key: "copilot", initial: "C" };
    return { key: "generic", initial: (n.trim()[0] || "?").toUpperCase() };
  }
  const brand = $derived(brandFor(data.clientName, r.redirectUri));
  // Monochrome marks (grok/openai) inherit the tile's accent via currentColor; full-color ones
  // (copilot) carry their own fills. Claude keeps its inline clay mark (handled separately below).
  const VENDOR_MARKS: Partial<Record<Brand["key"], string>> = {
    grok: grokMark,
    openai: openaiMark,
    copilot: copilotMark,
  };
  const mark = $derived(VENDOR_MARKS[brand.key]);
</script>

<svelte:head><title>Authorize · Stela</title></svelte:head>

{#snippet check()}
  <svg class="ck" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M3.2 8.4l3 3 6.6-7"
      fill="none"
      stroke="currentColor"
      stroke-width="2.1"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
{/snippet}

<div class="screen">
  <div class="stage">
    <div class="brand"><Logo variant="lockup" size={25} /></div>

    <form class="card" method="POST">
      <span class="accent" aria-hidden="true"></span>

      <div class="link" aria-hidden="true">
        <span
          class="node client"
          class:claude={brand.key === "claude"}
          class:grok={brand.key === "grok"}
          class:openai={brand.key === "openai"}
          class:copilot={brand.key === "copilot"}
        >
          {#if brand.key === "claude"}
            <svg class="cmark" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
              />
            </svg>
          {:else if mark}
            <span class="logomark">{@html mark}</span>
          {:else}
            {brand.initial}
          {/if}
        </span>
        <span class="wire"></span>
        <span class="node host"><Logo variant="mark" size={26} /></span>
      </div>

      <p class="kicker">Connection request</p>
      <h1>Authorize {data.clientName}</h1>
      <p class="lead">
        <strong>{data.clientName}</strong> wants to connect to Stela and publish &amp; manage artifacts
        on your behalf.
      </p>

      <div class="who">
        <span class="who-av" aria-hidden="true">{initials}</span>
        <span class="who-text">
          <span class="who-name">{data.user.name}</span>
          {#if data.user.email}<span class="who-mail">{data.user.email}</span>{/if}
        </span>
        <span class="who-tag">You</span>
      </div>

      <ul class="perms">
        <li><span class="ckwrap">{@render check()}</span> Create, update &amp; read your artifacts</li>
        <li><span class="ckwrap">{@render check()}</span> List artifacts shared with you or everyone</li>
        <li><span class="ckwrap">{@render check()}</span> Manage sharing on artifacts you own</li>
      </ul>

      <input type="hidden" name="response_type" value="code" />
      <input type="hidden" name="client_id" value={r.clientId} />
      <input type="hidden" name="redirect_uri" value={r.redirectUri} />
      <input type="hidden" name="code_challenge" value={r.codeChallenge} />
      <input type="hidden" name="code_challenge_method" value="S256" />
      <input type="hidden" name="scope" value={r.scope} />
      <input type="hidden" name="state" value={r.state} />
      <input type="hidden" name="resource" value={r.resource} />

      <div class="actions">
        <button class="deny" type="submit" formaction="?/deny">Deny</button>
        <button class="approve" type="submit" formaction="?/approve">
          Approve<span class="chev" aria-hidden="true">›</span>
        </button>
      </div>
    </form>

    <p class="fine">
      <svg class="lock" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4.5 7V5.2a3.5 3.5 0 117 0V7"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
        <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.6" fill="currentColor" />
      </svg>
      Approving returns you to {data.clientName}. Revoke anytime by removing the connector.
    </p>
  </div>
</div>

<style>
  .screen {
    position: relative;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 32px 20px;
    background:
      radial-gradient(1100px 560px at 82% -12%, rgba(208, 138, 74, 0.16), transparent 56%),
      radial-gradient(880px 600px at -8% 112%, rgba(100, 127, 221, 0.14), transparent 55%),
      linear-gradient(168deg, #17181c 0%, #121316 46%, #0d0e10 100%);
    overflow: hidden;
  }
  /* faint brand dot-grid + a soft focal glow behind the card — the signature texture, so the navy
     reads with depth instead of flat. Purely decorative. */
  .screen::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      radial-gradient(circle, rgba(255, 255, 255, 0.04) 1px, transparent 1.6px),
      radial-gradient(620px 420px at 50% 42%, rgba(255, 255, 255, 0.05), transparent 60%);
    background-size:
      24px 24px,
      100% 100%;
    background-repeat: repeat, no-repeat;
  }

  .stage {
    position: relative;
    width: 100%;
    max-width: 452px;
    animation: rise 0.42s cubic-bezier(0.215, 0.61, 0.355, 1) both;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
  }

  .brand {
    display: flex;
    justify-content: center;
    margin-bottom: 22px;
    color: #ece6d8;
  }

  .card {
    position: relative;
    background: #f4efe3;
    border-radius: 20px;
    padding: 32px 34px 30px;
    box-shadow:
      0 1px 0 rgba(255, 253, 246, 0.6) inset,
      0 28px 70px -18px rgba(0, 0, 0, 0.62),
      0 6px 22px -10px rgba(10, 11, 13, 0.5);
    overflow: hidden;
  }
  .accent {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: linear-gradient(90deg, #647fdd 0%, #a586a0 48%, #d08a4a 100%);
  }

  /* the "Claude → Stela" connection motif */
  .link {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 6px 0 22px;
  }
  .node {
    width: 50px;
    height: 50px;
    border-radius: 15px;
    display: grid;
    place-items: center;
    flex: 0 0 auto;
  }
  .node.client {
    background: #ede8da;
    border: 1px solid #e0d9c6;
    color: #35418f;
    font-weight: 800;
    font-size: 22px;
  }
  /* Claude's mark in its clay tone on a warm tile — so the two brands read as "warm Claude → cool Stela". */
  .node.client.claude {
    background: #f6efe7;
    border-color: #ead9c8;
    color: #d97757;
  }
  .cmark {
    width: 27px;
    height: 27px;
  }
  /* Known-vendor tiles: a brand-tinted surface + the vendor's accent for the monogram, mirroring the
     Claude tile. To show an official logo instead, add a mark branch in the markup — it inherits this
     tile. (Each logo is the vendor's own SVG, sourced under their brand guidelines.) */
  .node.client.grok {
    background: #f1f1f3;
    border-color: #d9dadf;
    color: #15171a;
  }
  .node.client.openai {
    background: #e7f5f0;
    border-color: #c7e7dc;
    color: #0e8f6e;
  }
  .node.client.copilot {
    background: #e9f2fc;
    border-color: #cfe2f7;
    color: #1f6fc4;
  }
  /* Inlined vendor logo SVG, sized to the tile; a monochrome mark inherits the tile's `color`. */
  .logomark {
    display: grid;
    place-items: center;
    line-height: 0;
  }
  .logomark :global(svg) {
    width: 27px;
    height: 27px;
    display: block;
  }
  .node.host {
    background: #fffdf6;
    border: 1px solid #e0d9c6;
    color: #2a2620; /* dark-stone context for the slab mark */
    box-shadow:
      0 0 0 3px rgba(208, 138, 74, 0.14),
      0 8px 18px -8px rgba(100, 127, 221, 0.35);
  }
  .wire {
    flex: 1;
    height: 2px;
    background-image: linear-gradient(90deg, #cbc2ae 0 4px, transparent 4px);
    background-size: 9px 2px;
    border-radius: 2px;
  }

  .kicker {
    margin: 0 0 7px;
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: #b06f2e;
    font-family: var(--font-mono);
  }
  h1 {
    margin: 0 0 10px;
    font-size: 25px;
    font-weight: 800;
    line-height: 1.15;
    letter-spacing: -0.01em;
    color: #241f16;
  }
  .lead {
    margin: 0 0 20px;
    font-size: 15px;
    line-height: 1.6;
    color: #5a5446;
  }
  .lead strong {
    color: #241f16;
    font-weight: 700;
  }

  .who {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 13px;
    margin-bottom: 22px;
    background: #ece6d7;
    border: 1px solid #e0d9c6;
    border-radius: 13px;
  }
  .who-av {
    width: 38px;
    height: 38px;
    flex: 0 0 auto;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 13px;
    font-weight: 700;
    color: #fff;
    letter-spacing: 0.02em;
    background: linear-gradient(135deg, #35418f 0%, #d08a4a 100%);
  }
  .who-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.3;
  }
  .who-name {
    font-weight: 650;
    font-size: 14.5px;
    color: #241f16;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .who-mail {
    font-size: 13px;
    color: #786f5c;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .who-tag {
    margin-left: auto;
    flex: 0 0 auto;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #6a6350;
    background: #e0d9c6;
    border-radius: 100px;
    padding: 3px 9px;
  }

  .perms {
    list-style: none;
    margin: 0 0 26px;
    padding: 0;
    display: grid;
    gap: 11px;
  }
  .perms li {
    display: flex;
    align-items: center;
    gap: 11px;
    font-size: 14.5px;
    color: #45402f;
  }
  .ckwrap {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: #a8672a;
    background: rgba(208, 138, 74, 0.16);
  }
  .ck {
    width: 13px;
    height: 13px;
  }

  .actions {
    display: flex;
    gap: 11px;
  }
  .actions button {
    flex: 1;
    font: inherit;
    font-weight: 650;
    font-size: 15px;
    letter-spacing: 0.01em;
    border-radius: 100px;
    padding: 12px 22px;
    border: 1px solid transparent;
    cursor: pointer;
    transition:
      transform 0.14s cubic-bezier(0.215, 0.61, 0.355, 1),
      box-shadow 0.14s ease,
      background 0.14s ease;
  }
  .deny {
    flex: 0 0 auto;
    min-width: 104px;
    background: #faf7ee;
    color: #6a6350;
    border-color: #d8d1bd;
  }
  .deny:hover {
    background: #efe9d9;
    color: #241f16;
  }
  .approve {
    color: #241203;
    background: linear-gradient(135deg, #e0a05f 0%, #c47f38 100%);
    box-shadow: 0 6px 16px -4px rgba(208, 138, 74, 0.5);
  }
  .approve:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(208, 138, 74, 0.55);
  }
  .approve:active {
    transform: translateY(0);
  }
  .chev {
    margin-left: 7px;
    font-weight: 700;
  }
  .actions button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(100, 127, 221, 0.55);
  }

  .fine {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    margin: 18px 4px 0;
    font-size: 12.5px;
    line-height: 1.5;
    text-align: center;
    color: #8b867a;
  }
  .lock {
    width: 13px;
    height: 13px;
    flex: 0 0 auto;
    color: #6f6a5e;
  }

  @media (max-width: 480px) {
    .card {
      padding: 26px 22px 24px;
    }
    h1 {
      font-size: 22px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .stage {
      animation: none;
    }
  }
</style>
