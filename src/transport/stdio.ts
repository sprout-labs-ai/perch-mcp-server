/**
 * stdio transport — the default install path. The MCP host (Claude
 * Desktop, etc.) spawns this binary as a child process and communicates
 * over stdin/stdout. Auth comes from the env-provided PAT (see
 * api/client.ts). Stderr is the only safe place to log; stdout is
 * reserved for JSON-RPC frames.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '../server.js';

export async function startStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes — the MCP SDK handles the message loop.
}
