#!/usr/bin/env node
/**
 * Entry point. Dispatches to stdio (default) or HTTP transport based on
 * argv / env. Stderr-only for logging — stdout is reserved for stdio
 * JSON-RPC frames.
 */

import { startStdio } from './transport/stdio.js';
import { startHttp } from './transport/http.js';

function readEnv(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} env var is required for HTTP mode`);
}

async function main(): Promise<void> {
  const useHttp = process.argv.includes('--http')
    || process.env.PERCH_MCP_TRANSPORT === 'http';

  if (!useHttp) {
    await startStdio();
    return;
  }

  await startHttp({
    port: Number(process.env.PORT ?? '3001'),
    host: process.env.HOST ?? '127.0.0.1',
    publicUrl: readEnv('PERCH_MCP_PUBLIC_URL', 'http://127.0.0.1:3001'),
    issuer: readEnv('HYDRA_ISSUER'),
    audience: readEnv('MCP_AUDIENCE', 'https://mcp.theperch.app'),
    allowedHosts: process.env.ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean),
  });
}

main().catch((err) => {
  // Stderr only — stdout is the MCP transport channel and must not be polluted.
  console.error('[perch-mcp-server] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
