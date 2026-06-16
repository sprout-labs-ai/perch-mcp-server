/**
 * `clientFor(extra)` — picks the right PerchClient for the calling
 * tool. The resolver is tiny but it's the seam between HTTP and stdio
 * mode; getting it wrong silently routes user A's tools through user
 * B's token (HTTP would never construct a token-less client) or
 * crashes stdio at startup. Worth locking down.
 *
 * We exercise the resolver by spying on the request layer (mocking
 * fetch) so we can read the Authorization header the client sends.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Force a fresh module instance so the cached stdio client doesn't
  // leak between tests.
  vi.resetModules();
  // Clean env between tests so each one establishes its own state.
  delete process.env.PERCH_API_TOKEN;
  delete process.env.PERCH_API_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────────
// HTTP mode: token comes from extra.authInfo

describe('clientFor — HTTP mode', () => {
  it('uses extra.authInfo.token when present (any baseUrl from env)', async () => {
    process.env.PERCH_API_URL = 'http://localhost:3000';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const { clientFor } = await import('../src/api/client.js');
    const client = clientFor({ authInfo: { token: 'auth0-jwt-from-http' } });
    await client.get('/api/v1/accounts');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:3000/api/v1/accounts');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer auth0-jwt-from-http');
  });

  it('builds a fresh client per call (no cross-request token leakage)', async () => {
    process.env.PERCH_API_URL = 'http://localhost:3000';
    // Mock with an implementation (vs a single Response value) so each
    // call gets a fresh, unread body — Response bodies are consumed
    // once and then unreadable.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('[]', { status: 200 }),
    );

    const { clientFor } = await import('../src/api/client.js');
    await clientFor({ authInfo: { token: 'token-A' } }).get('/api/v1/accounts');
    await clientFor({ authInfo: { token: 'token-B' } }).get('/api/v1/accounts');

    const callA = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const callB = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(callA.Authorization).toBe('Bearer token-A');
    expect(callB.Authorization).toBe('Bearer token-B');
  });

  it('attaches X-Forwarded-By header on outbound calls (perch-api log attribution)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200 }),
    );
    const { clientFor } = await import('../src/api/client.js');
    await clientFor({ authInfo: { token: 'tok' } }).get('/api/v1/accounts');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Forwarded-By']).toMatch(/^perch-mcp-server\//);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// stdio mode: token comes from PERCH_API_TOKEN env

describe('clientFor — stdio mode', () => {
  it('uses PERCH_API_TOKEN when extra is missing or has no authInfo', async () => {
    process.env.PERCH_API_TOKEN = 'pat_envvar_token_value';
    process.env.PERCH_API_URL = 'http://localhost:3000';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('[]', { status: 200 }),
    );

    const { clientFor } = await import('../src/api/client.js');
    await clientFor(undefined).get('/api/v1/accounts');
    await clientFor({}).get('/api/v1/accounts');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer pat_envvar_token_value');
    }
  });

  it('caches the stdio client across calls (same env, same token)', async () => {
    process.env.PERCH_API_TOKEN = 'pat_cached';
    const { clientFor } = await import('../src/api/client.js');
    const c1 = clientFor(undefined);
    const c2 = clientFor(undefined);
    // Same instance (the cache returns the same object reference).
    expect(c1).toBe(c2);
  });

  it('throws a helpful error when PERCH_API_TOKEN is unset and no authInfo provided', async () => {
    const { clientFor } = await import('../src/api/client.js');
    expect(() => clientFor(undefined)).toThrow(/PERCH_API_TOKEN/);
  });

  it('throws when PERCH_API_TOKEN does not look like a PAT', async () => {
    process.env.PERCH_API_TOKEN = 'looks-like-a-jwt-not-a-pat';
    const { clientFor } = await import('../src/api/client.js');
    expect(() => clientFor(undefined)).toThrow(/pat_/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Defaults

describe('clientFor — base URL resolution', () => {
  it('falls back to https://api.perch.app when PERCH_API_URL is unset', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200 }),
    );
    const { clientFor } = await import('../src/api/client.js');
    await clientFor({ authInfo: { token: 'tok' } }).get('/api/v1/accounts');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith('https://api.perch.app/')).toBe(true);
  });

  it('strips trailing slashes from PERCH_API_URL', async () => {
    process.env.PERCH_API_URL = 'http://localhost:3000///';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200 }),
    );
    const { clientFor } = await import('../src/api/client.js');
    await clientFor({ authInfo: { token: 'tok' } }).get('/api/v1/accounts');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe('http://localhost:3000/api/v1/accounts');
  });
});
