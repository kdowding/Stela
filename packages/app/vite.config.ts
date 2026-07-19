import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  // @stela/shared ships TypeScript source (internal package); let Vite transpile it for SSR.
  ssr: {
    noExternal: ["@stela/shared"],
  },
});
