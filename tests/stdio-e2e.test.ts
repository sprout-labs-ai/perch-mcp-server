/**
 * End-to-end over stdio — the default install path (Claude Desktop, Claude
 * Code). Spawns the real entry point (`src/index.ts` via tsx) as a child
 * process, exactly as an MCP host would, and talks to it with the SDK's
 * StdioClientTransport. perch-api is a local stub server.
 *
 * This is the automated, CI-safe version of scripts/smoke-test.mjs: it
 * proves the binary starts, keeps stdout clean for JSON-RPC, authenticates
 * with the PAT and returns real tool results.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(__dirname, '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const ENTRY = path.join(ROOT, 'src', 'index.ts');

let api: Server;
let apiUrl: string;
const seenAuth: string[] = [];

/** Child env without anything from the developer's shell that changes behavior. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('PERCH_') || k.startsWith('HYDRA_') || k.startsWith('MCP_')) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

beforeAll(async () => {
  api = createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? '');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/accounts') {
      res.end(JSON.stringify([
        { id: 'a1', name: 'Checking', isDefault: true, currentBalance: 10,
          isPlaidLinked: false, autoSyncBalance: false, lastBalanceUpdate: null },
        { id: 'a2', name: 'Savings', isDefault: false, currentBalance: 5,
          isPlaidLinked: false, autoSyncBalance: false, lastBalanceUpdate: null },
      ]));
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ code: 'TOKEN_REVOKED' }));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => api.close(() => r()));
});

describe('stdio transport (spawned binary)', () => {
  it('serves initialize, tools/list and tools/call over stdin/stdout', async () => {
    const transport = new StdioClientTransport({
      command: TSX,
      args: [ENTRY],
      env: childEnv({ PERCH_API_URL: apiUrl, PERCH_API_TOKEN: 'pat_stdio_e2e' }),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-e2e', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(5);

      const ok = await client.callTool({ name: 'list_accounts', arguments: {} });
      const body = JSON.parse((ok.content as Array<{ text: string }>)[0].text);
      expect(body.totalCurrentBalance).toBe(15);
      expect(seenAuth.at(-1)).toBe('Bearer pat_stdio_e2e');

      // Upstream auth errors come back as readable tool errors, and the
      // process stays up for the next call.
      const err = await client.callTool({
        name: 'list_recurring_series',
        arguments: { accountId: '11111111-1111-4111-8111-111111111111' },
      });
      expect(err.isError).toBe(true);
      expect(JSON.stringify(err.content)).toMatch(/revoked/);

      const again = await client.callTool({ name: 'list_accounts', arguments: {} });
      expect(again.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('exits non-zero with a clear message when HTTP mode is missing HYDRA_ISSUER', async () => {
    const child = spawn(TSX, [ENTRY, '--http'], {
      env: childEnv({ PORT: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise<number | null>((r) => child.on('exit', r));

    expect(code).toBe(1);
    expect(stderr).toMatch(/HYDRA_ISSUER env var is required/);
    // stdout is reserved for JSON-RPC and must stay clean.
    expect(stdout).toBe('');
  });
});
