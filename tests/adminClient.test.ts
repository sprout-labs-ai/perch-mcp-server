/**
 * AdminClient — the M2M-authenticated HTTP layer behind the admin tools.
 * The behavior worth locking down: it attaches the M2M bearer, and on a
 * 401 it force-refreshes the token and retries exactly once (a 5-minute
 * token can lapse between calls), surfacing a real auth failure only when
 * the retry also 401s. Scope 403s map to an actionable message.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdminClient } from '../src/api/adminClient.js';
import { M2MTokenProvider } from '../src/auth/m2mToken.js';
import { PerchApiError } from '../src/api/client.js';

const BASE = 'http://localhost:3000';

/** A token provider stub that hands out a sequence of tokens, one per refresh. */
function stubProvider(tokens: string[]): M2MTokenProvider {
  let i = 0;
  const provider = Object.create(M2MTokenProvider.prototype) as M2MTokenProvider;
  let current = tokens[0];
  (provider as unknown as { getToken: () => Promise<string> }).getToken = async () => current;
  (provider as unknown as { refresh: () => Promise<string> }).refresh = async () => {
    i += 1;
    current = tokens[Math.min(i, tokens.length - 1)];
    return current;
  };
  return provider;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdminClient.get', () => {
  it('attaches the M2M bearer + attribution header and returns JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'u1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const client = new AdminClient(BASE, stubProvider(['tok-A']));
    const data = await client.get<{ id: string }>('/api/v1/admin/users/u1');

    expect(data).toEqual({ id: 'u1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-A');
    expect(headers['X-Forwarded-By']).toMatch(/^perch-mcp-server\//);
  });

  it('serializes query params, skipping undefined', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const client = new AdminClient(BASE, stubProvider(['tok']));
    await client.get('/api/v1/admin/users', { page: 2, pageSize: undefined, status: 'all' });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('page=2');
    expect(url).toContain('status=all');
    expect(url).not.toContain('pageSize');
  });

  it('refreshes the token and retries once on 401, then succeeds', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":"Unauthorized"}', { status: 401, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = new AdminClient(BASE, stubProvider(['stale-tok', 'fresh-tok']));

    const data = await client.get<{ ok: boolean }>('/api/v1/admin/users/u1');
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call used the stale token, retry used the refreshed one.
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>).toMatchObject({ Authorization: 'Bearer stale-tok' });
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>).toMatchObject({ Authorization: 'Bearer fresh-tok' });
  });

  it('throws PerchApiError(401) when the retry also 401s', async () => {
    // Fresh Response per fetch (each get() does 2 fetches; bodies read once).
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"error":"Unauthorized"}', { status: 401, headers: { 'Content-Type': 'application/json' } }),
    );
    const client = new AdminClient(BASE, stubProvider(['t1', 't2']));
    await expect(client.get('/api/v1/admin/users/u1')).rejects.toBeInstanceOf(PerchApiError);
    await expect(client.get('/api/v1/admin/users/u1')).rejects.toThrow(/revoked/i);
  });

  it('maps a 403 INSUFFICIENT_SCOPE to an actionable message naming the scope', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({ error: 'Insufficient scope', code: 'INSUFFICIENT_SCOPE', required: 'brand_exposures:read' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new AdminClient(BASE, stubProvider(['tok']));
    await expect(client.get('/api/v1/admin/users/u1/brand-exposures')).rejects.toMatchObject({
      status: 403,
      code: 'INSUFFICIENT_SCOPE',
    });
    await expect(client.get('/api/v1/admin/users/u1/brand-exposures')).rejects.toThrow(/brand_exposures:read/);
  });

  it('does not retry on a non-401 error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } }),
    );
    const client = new AdminClient(BASE, stubProvider(['tok']));
    await expect(client.get('/api/v1/admin/users/u1')).rejects.toBeInstanceOf(PerchApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
