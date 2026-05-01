#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes — the MCP SDK handles message loop.
}

main().catch((err) => {
  // Stderr only — stdout is the MCP transport channel and must not be polluted.
  console.error('[perch-mcp-server] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
