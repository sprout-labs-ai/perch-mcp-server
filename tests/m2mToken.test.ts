/**
 * M2MTokenProvider — the server-side credential exchange behind the admin
 * tools. The risky bits are caching (don't exchange on every call),
 * refresh skew (don't hand out a token about to lapse), 401/503
 * translation (actionable errors), and in-flight collapse (a burst of
 * tool calls must not fan out into N token requests).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { M2MTokenProvider, M2MAuthError } from '../src/auth/m2mToken.js';

const BASE = 'http://localhost:3000';

function tokenResponse(token: string, expiresIn: number) {
  return new Response(
    JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: expiresIn, scope: 'users:read' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeProvider() {
  return new M2MTokenProvider({ baseUrl: BASE, clientId: 'mcp_test', clientSecret: 'sekret' });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M2MTokenProvider.getToken', () => {
  it('exchanges credentials and returns the access token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenResponse('tok-1', 300));
    const provider = makeProvider();
    const token = await provider.getToken();

    expect(token).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:3000/api/v1/oauth/token');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ grant_type: 'client_credentials', client_id: 'mcp_test', client_secret: 'sekret' });
  });

  it('caches the token across calls while it is fresh', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenResponse('tok-cached', 300));
    const provider = makeProvider();
    await provider.getToken();
    await provider.getToken();
    await provider.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes once the token enters the 30s pre-expiry skew window', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenResponse('tok-old', 300))
      .mockResolvedValueOnce(tokenResponse('tok-new', 300));
    const provider = makeProvider();

    const first = await provider.getToken();
    expect(first).toBe('tok-old');

    // 300s TTL − 30s skew = refresh after 270s. Advance past that.
    vi.advanceTimersByTime(271_000);
    const second = await provider.getToken();
    expect(second).toBe('tok-new');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent refreshes into a single exchange', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending as Promise<Response>);
    const provider = makeProvider();

    const a = provider.getToken();
    const b = provider.getToken();
    const c = provider.getToken();
    resolveFetch(tokenResponse('tok-shared', 300));
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    expect(ra).toBe('tok-shared');
    expect(rb).toBe('tok-shared');
    expect(rc).toBe('tok-shared');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws an actionable M2MAuthError on 401 (bad/revoked client)', async () => {
    // mockImplementation (not mockResolvedValue) so each call gets a
    // fresh, unread Response body.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    );
    const provider = makeProvider();
    await expect(provider.getToken()).rejects.toMatchObject({
      name: 'M2MAuthError',
      status: 401,
    });
    await expect(provider.getToken()).rejects.toThrow(/PERCH_MCP_CLIENT_ID/);
  });

  it('throws a config-specific error on 503 (server missing M2M_JWT_SECRET)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'server_misconfigured' }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
    );
    const provider = makeProvider();
    await expect(provider.getToken()).rejects.toMatchObject({ status: 503 });
    await expect(provider.getToken()).rejects.toThrow(/M2M_JWT_SECRET/);
  });

  it('refresh() forces a new exchange even when a cached token is fresh', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenResponse('tok-1', 300))
      .mockResolvedValueOnce(tokenResponse('tok-2', 300));
    const provider = makeProvider();

    expect(await provider.getToken()).toBe('tok-1');
    expect(await provider.refresh()).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('M2MAuthError', () => {
  it('is an Error with status', () => {
    const err = new M2MAuthError(401, 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
  });
});
