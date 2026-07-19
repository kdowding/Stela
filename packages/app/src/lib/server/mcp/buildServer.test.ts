import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CROSS_IMPL_TOOL_NAMES, DESIGN_GUIDE, STELA_SERVER_META } from "@stela/shared";
import { buildMcpServer } from "./buildServer";

// Drift guard: the remote connector must expose exactly the tools both surfaces share. If a tool is
// added/removed here without updating the shared contract (or the CLI MCP), this fails loudly.
describe("remote MCP tool surface", () => {
  it("registers exactly the cross-implementation tools", () => {
    const spy = vi.spyOn(McpServer.prototype, "registerTool");
    try {
      buildMcpServer({ id: "o", name: "Tester", email: "t@example.com" }, "https://x");
      const names = spy.mock.calls.map((c) => c[0] as string);
      expect(new Set(names)).toEqual(new Set(CROSS_IMPL_TOOL_NAMES));
    } finally {
      spy.mockRestore();
    }
  });

  it("get_design_guide content embeds the CSP and key guidance", () => {
    expect(DESIGN_GUIDE).toContain("default-src 'none'");
    expect(DESIGN_GUIDE.toLowerCase()).toContain("self-contained");
    expect(DESIGN_GUIDE).toContain("validate: true");
    expect(DESIGN_GUIDE).toContain("localStorage");
  });

  it("advertises a fetch-free data: icon in server metadata", () => {
    expect(STELA_SERVER_META.title).toBe("Stela");
    expect(STELA_SERVER_META.icons[0].src).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});
