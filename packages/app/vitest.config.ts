import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const dir = fileURLToPath(new URL(".", import.meta.url));

// A dedicated test config (separate from vite.config.ts so the SvelteKit plugin doesn't run). The
// SvelteKit virtual modules ($app/environment, $env/dynamic/private) are aliased to deterministic
// test doubles; $lib resolves to the source tree.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests share one storage backend — run test files serially to avoid cross-file races.
    fileParallelism: false,
    // Route/integration tests hit the default SQLite driver; point it at a scratch dir so test
    // artifacts never pollute the developer's real .data gallery. (Conformance suites make their
    // own mkdtemp databases and ignore this.)
    env: {
      DATA_DIR: resolve(dir, ".data-test"),
    },
    alias: {
      "$app/environment": resolve(dir, "src/test/mocks/app-environment.ts"),
      "$env/dynamic/private": resolve(dir, "src/test/mocks/env-dynamic-private.ts"),
      $lib: resolve(dir, "src/lib"),
    },
    coverage: {
      provider: "v8",
      include: ["src/lib/server/**", "src/routes/**/*.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
