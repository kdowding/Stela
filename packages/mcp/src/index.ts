#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertSafeApiUrl, buildLocalServer } from "./server";

// Entry point: refuse an unsafe API URL, then connect the stdio transport. All tool wiring lives in
// ./server (buildLocalServer) so it can be unit-tested without owning stdio.
assertSafeApiUrl();
const transport = new StdioServerTransport();
await buildLocalServer().connect(transport);
