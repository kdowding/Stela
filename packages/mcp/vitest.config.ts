import { defineConfig } from "vitest/config";

// The MCP server's pure helpers (title extraction, ref parsing, path keys, the artifact map) are
// unit-tested here. No backend needed — these never touch the network; the map tests redirect
// STELA_HOME to a throwaway dir.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
