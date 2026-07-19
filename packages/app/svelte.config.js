import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // SvelteKit's built-in CSRF check 403s cross-site form-encoded POSTs, and it runs BEFORE the
    // `handle` hook so it can't be bypassed there. The OAuth token endpoint must accept claude.ai's
    // server-to-server, form-encoded POST to /oauth/token — authenticated by the auth code + PKCE
    // (not a cookie), so it isn't CSRF-relevant. Disable the built-in check and rely on the app's own
    // control: `assertSameOrigin` guards every cookie-authenticated browser-mutation route (incl. the
    // OAuth consent actions), and the browser's CORS preflight already blocks cross-origin JSON
    // mutations. See lib/server/guards.assertSameOrigin + docs/deployment.md.
    csrf: { checkOrigin: false },
  },
};

export default config;
