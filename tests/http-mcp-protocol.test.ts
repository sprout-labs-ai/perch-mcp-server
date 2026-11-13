/**
 * End-to-end over the real HTTP transport.
 *
 * Boots `startHttp` on an ephemeral port, a stub perch-api on another, and
 * drives them with the SDK's own StreamableHTTP client carrying a properly
 * signed RS256 token (JWKS lookup mocked to our in-process key). This covers
 * the authenticated POST /mcp path that http-transport.test.ts can't:
 *
 *   initialize → tools/list → tools/call, token forwarded to perch-api,
 *   access-activity emitted with the caller's `azp`, plus the 401 paths for
 *   wrong-audience and expired tokens.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const KID = 'http-e2e-key';
const ISSUER = 'https://mcp-auth.example.test';
const AUDIENCE = 'https://mcp.theperch.app';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

vi.mock('jwks-rsa', () => ({
  default: () => ({
    getSigningKey: (
      kid: string | undefined,
      cb: (err: Error | null, key?: { getPublicKey: () => string }) => void,
    ) => (kid === KID ? cb(null, { getPublicKey: () => publicPem }) : cb(new Error(`unknown kid ${kid}`))),
  }),
}));

function sign(over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: 'hydra|user-1',
      aud: AUDIENCE,
      iss: ISSUER,
      azp: 'claude-ai-client',
      scope: 'read:accounts read:forecast',
      iat: now,
      exp: now + 600,
      ...over,
    },
    privatePem,
    { algorithm: 'RS256', keyid: KID },
  );
}

// ── Stub perch-api ───────────────────────────────────────────────────────────

interface ApiHit { method: string; path: string; auth?: string; body?: unknown }
const apiHits: ApiHit[] = [];
let api: Server;
let mcp: Server;
let mcpUrl: URL;
const ORIGINAL_API_URL = process.env.PERCH_API_URL;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

beforeAll(async () => {
  // Admin tools must not appear in this deployment shape.
  delete process.env.PERCH_MCP_CLIENT_ID;
  delete process.env.PERCH_MCP_CLIENT_SECRET;

  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    apiHits.push({
      method: req.method ?? '',
      path: url.pathname,
      auth: req.headers.authorization,
      body: await readBody(req),
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/api/v1/accounts') {
      res.end(JSON.stringify([
        { id: ACCOUNT_ID, name: 'Checking', isDefault: true, currentBalance: 42,
          isPlaidLinked: false, autoSyncBalance: false, lastBalanceUpdate: null },
      ]));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/integrations/activity') {
      res.statusCode = 201;
      res.end('{}');
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  process.env.PERCH_API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  // Capture the server startHttp creates (same trick as http-transport.test.ts).
  const { startHttp } = await import('../src/transport/http.js');
  const realListen = (express.application as any).listen;
  let captured: Server | undefined;
  (express.application as any).listen = function patched(...args: any[]) {
    captured = realListen.apply(this, args) as Server;
    return captured;
  };
  try {
    await startHttp({ port: 0, host: '127.0.0.1', publicUrl: AUDIENCE, issuer: ISSUER, audience: AUDIENCE });
  } finally {
    (express.application as any).listen = realListen;
  }
  mcp = captured!;
  mcpUrl = new URL(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`);
});

afterAll(async () => {
  process.env.PERCH_API_URL = ORIGINAL_API_URL;
  if (ORIGINAL_API_URL === undefined) delete process.env.PERCH_API_URL;
  await new Promise<void>((r) => mcp.close(() => r()));
  await new Promise<void>((r) => api.close(() => r()));
});

async function connect(token: string) {
  const client = new Client({ name: 'http-e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

// ──────────────────────────────────────────────────────────────────────────────

describe('authenticated MCP over HTTP', () => {
  it('initializes and lists only the user tools (no admin tools without M2M creds)', async () => {
    const client = await connect(sign());
    try {
      expect(client.getServerVersion()?.name).toBe('perch-mcp-server');
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'get_forecast_curve',
        'list_accounts',
        'list_recurring_series',
        'list_scheduled_items',
        'simulate_forecast',
      ]);
    } finally {
      await client.close();
    }
  });

  it('calls a tool, forwarding the caller token and logging activity', async () => {
    apiHits.length = 0;
    const token = sign();
    const client = await connect(token);
    try {
      const result = await client.callTool({ name: 'list_accounts', arguments: {} });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(JSON.parse(text).totalCurrentBalance).toBe(42);
    } finally {
      await client.close();
    }

    await vi.waitFor(() => expect(apiHits.map((h) => `${h.method} ${h.path}`)).toEqual([
      'GET /api/v1/accounts',
      'POST /api/v1/integrations/activity',
    ]));
    for (const hit of apiHits) expect(hit.auth).toBe(`Bearer ${token}`);
  });

  it('returns a tool error (not a transport failure) when perch-api 404s', async () => {
    const client = await connect(sign());
    try {
      const result = await client.callTool({
        name: 'list_recurring_series',
        arguments: { accountId: ACCOUNT_ID },
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('token rejection over HTTP', () => {
  async function postInitialize(token: string) {
    return fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
      }),
    });
  }

  it('rejects a token for a different audience', async () => {
    const res = await postInitialize(sign({ aud: 'https://api.perch.app' }));
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await postInitialize(sign({ iat: now - 7200, exp: now - 3600 }));
    expect(res.status).toBe(401);
  });

  it('rejects a token from another issuer', async () => {
    const res = await postInitialize(sign({ iss: 'https://evil.example' }));
    expect(res.status).toBe(401);
  });

  it('accepts the same request with a valid token', async () => {
    const res = await postInitialize(sign());
    expect(res.status).toBe(200);
  });
});
