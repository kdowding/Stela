import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CROSS_IMPL_TOOL_NAMES } from "@stela/shared";
import { buildLocalServer } from "./server";

// Drift guard: the CLI MCP must expose the tools both surfaces share, plus its own login/logout. If
// a tool is added/removed here without updating the shared contract (or the connector), this fails.
describe("CLI MCP tool surface", () => {
  it("registers the cross-implementation tools plus login/logout", () => {
    const spy = vi.spyOn(McpServer.prototype, "registerTool");
    try {
      buildLocalServer();
      const names = spy.mock.calls.map((c) => c[0] as string);
      expect(new Set(names)).toEqual(new Set([...CROSS_IMPL_TOOL_NAMES, "login", "logout"]));
    } finally {
      spy.mockRestore();
    }
  });
});
