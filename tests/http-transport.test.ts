/**
 * HTTP transport — public surface tests.
 *
 * Boots the Express app on an ephemeral port and hits the four
 * endpoints with `fetch`. We're verifying:
 *
 *   - GET /health works without auth
 *   - GET /.well-known/oauth-protected-resource returns the right
 *     RFC 9728 shape pointing at our Hydra issuer
 *   - POST /mcp without auth → 401 + WWW-Authenticate with the PRM URL
 *     (this is the trigger for MCP clients to discover the auth server)
 *   - POST /mcp with a bogus token → 401 (NOT 500 — exercises the
 *     InvalidTokenError mapping in JwksVerifier)
 *   - GET /mcp and DELETE /mcp → 405 in stateless mode
 *
 * Hydra itself is not contacted: the JWKS lookup is mocked to always
 * fail, which is fine because every test in this file uses either no
 * token or a syntactically invalid one. The valid-token path is
 * covered by jwksVerifier.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

vi.mock('jwks-rsa', () => ({
  default: () => ({
    getSigningKey: (
      _kid: string | undefined,
      cb: (err: Error | null, key?: { getPublicKey: () => string }) => void,
    ) => cb(new Error('JWKS not available in unit test')),
  }),
}));

import { startHttp } from '../src/transport/http.js';

const PUBLIC_URL = 'https://mcp.theperch.app';
const ISSUER = 'https://mcp-auth.example.test';
const AUDIENCE = 'https://mcp.theperch.app';

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  // Race-free port assignment: bind to 0, capture what we got.
  // startHttp doesn't return the server directly, so we patch
  // app.listen to surface it. Keeps production code unchanged.
  const realListen = (express.application as any).listen;
  let captured: Server | undefined;
  (express.application as any).listen = function patched(...args: any[]) {
    const s = realListen.apply(this, args) as Server;
    captured = s;
    return s;
  };
  try {
    await startHttp({
      port: 0,
      host: '127.0.0.1',
      publicUrl: PUBLIC_URL,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } finally {
    (express.application as any).listen = realListen;
  }
  if (!captured) throw new Error('failed to capture http server');
  server = captured;
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ──────────────────────────────────────────────────────────────────────────────
// /health

describe('GET /health', () => {
  it('returns 200 with status payload (no auth required)', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// PRM (RFC 9728)

describe('GET /.well-known/oauth-protected-resource', () => {
  it('returns the protected resource metadata pointing at this server (DCR shim)', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe(AUDIENCE);
    expect(body.authorization_servers).toEqual([PUBLIC_URL]);
    // Granular per-resource read scopes, enforced per-tool by perch-api.
    expect(body.scopes_supported).toEqual([
      'read:accounts',
      'read:series',
      'read:schedule',
      'read:forecast',
    ]);
    expect(body.bearer_methods_supported).toEqual(['header']);
  });

  it('does not require auth', async () => {
    // No Authorization header — must still serve.
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// /mcp auth surface

describe('POST /mcp authentication', () => {
  it('returns 401 with WWW-Authenticate pointing at PRM when no auth header is present', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate') ?? '';
    expect(wwwAuth.toLowerCase()).toContain('bearer');
    expect(wwwAuth).toContain('error="invalid_token"');
    // PRM URL must be advertised so MCP clients can discover the
    // authorization server and start an OAuth flow.
    expect(wwwAuth).toContain(`${PUBLIC_URL}/.well-known/oauth-protected-resource`);
  });

  it('returns 401 (not 500) for a bogus bearer token', async () => {
    // Verifies the InvalidTokenError mapping in JwksVerifier — without
    // it, verification failures bubble as 500.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-a-real-jwt',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate') ?? '';
    expect(wwwAuth).toContain('error="invalid_token"');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// /mcp method routing (stateless)

describe('/mcp non-POST methods (stateless mode)', () => {
  it('GET /mcp returns 405', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { Authorization: 'Bearer doesntmatter' },
    });
    expect(res.status).toBe(405);
  });

  it('DELETE /mcp returns 405', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer doesntmatter' },
    });
    expect(res.status).toBe(405);
  });
});
