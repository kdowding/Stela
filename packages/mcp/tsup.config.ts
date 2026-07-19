import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  // @stela/shared ships TypeScript source only (internal workspace package),
  // so it must be bundled — otherwise Node can't resolve it at runtime.
  noExternal: ["@stela/shared"],
});
