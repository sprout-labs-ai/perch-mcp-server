/**
 * POST /mcp failure path: if building or connecting the per-request server
 * throws, the handler must answer with a JSON-RPC internal error (500) and
 * must not leak the error detail to the client.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

vi.mock('../src/server.js', () => ({
  buildServer: () => {
    throw new Error('secret internal detail');
  },
}));

// Accept any bearer so the request reaches the handler.
vi.mock('../src/auth/jwksVerifier.js', () => ({
  JwksVerifier: class {
    async verifyAccessToken(token: string) {
      return { token, clientId: 'c', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600 };
    }
  },
}));

let server: Server;
let url: string;

beforeAll(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { startHttp } = await import('../src/transport/http.js');
  const realListen = (express.application as any).listen;
  (express.application as any).listen = function patched(...args: any[]) {
    server = realListen.apply(this, args) as Server;
    return server;
  };
  try {
    await startHttp({
      port: 0, host: '127.0.0.1', publicUrl: 'https://mcp.theperch.app',
      issuer: 'https://mcp-auth.example.test', audience: 'https://mcp.theperch.app',
    });
  } finally {
    (express.application as any).listen = realListen;
  }
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('POST /mcp handler error', () => {
  it('returns a generic JSON-RPC internal error with status 500', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer anything',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null,
    });
    expect(JSON.stringify(body)).not.toContain('secret internal detail');
  });
});
