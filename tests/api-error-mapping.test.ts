/**
 * Error-message mapping in both perch-api clients, plus the admin client's
 * env-backed singleton.
 *
 * These messages are what the assistant relays to the user, so each upstream
 * failure shape (known auth code, unknown code, `message` / `error` body,
 * non-JSON body) should produce a specific, readable error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clientFor, PerchApiError } from '../src/api/client.js';
import { AdminClient, getAdminClient, __resetAdminClientForTests } from '../src/api/adminClient.js';
import { M2MTokenProvider, __resetM2MProviderForTests } from '../src/auth/m2mToken.js';

const ORIGINAL_ENV = { ...process.env };

function respond(status: number, body: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status }));
}

async function caught(p: Promise<unknown>): Promise<PerchApiError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(PerchApiError);
  return err as PerchApiError;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  __resetAdminClientForTests();
  __resetM2MProviderForTests();
});

// ──────────────────────────────────────────────────────────────────────────────

describe('PerchClient error mapping', () => {
  const client = () => clientFor({ authInfo: { token: 'jwt' } });

  it.each([
    ['TOKEN_REVOKED', /has been revoked/],
    ['TOKEN_EXPIRED', /has expired/],
    ['INVALID_TOKEN', /rejected as invalid/],
  ])('401 %s → actionable token message', async (code, message) => {
    respond(401, JSON.stringify({ code }));
    const err = await caught(client().get('/api/v1/accounts'));
    expect(err.status).toBe(401);
    expect(err.code).toBe(code);
    expect(err.message).toMatch(message);
  });

  it('401 with an unknown code falls through to the body message', async () => {
    respond(401, JSON.stringify({ code: 'SOMETHING_NEW', message: 'nope' }));
    const err = await caught(client().get('/api/v1/accounts'));
    expect(err.code).toBe('SOMETHING_NEW');
    expect(err.message).toBe('nope');
  });

  it('uses `error` when there is no `message`', async () => {
    respond(500, JSON.stringify({ error: 'Internal Server Error' }));
    const err = await caught(client().get('/api/v1/accounts'));
    expect(err.status).toBe(500);
    expect(err.message).toBe('Internal Server Error');
  });

  it('handles a non-JSON error body with a status + path message', async () => {
    respond(502, '<html>Bad Gateway</html>');
    const err = await caught(client().post('/api/v1/forecast/simulate', {}));
    expect(err.code).toBeUndefined();
    expect(err.message).toBe('Perch API 502 on /api/v1/forecast/simulate');
  });

  it('a 403 with an unrecognized code is not mistaken for a privacy control', async () => {
    respond(403, JSON.stringify({ code: 'OTHER', error: 'Forbidden' }));
    const err = await caught(client().get('/api/v1/accounts'));
    expect(err.message).toBe('Forbidden');
  });
});

// ──────────────────────────────────────────────────────────────────────────────

function stubProvider(): M2MTokenProvider {
  const p = Object.create(M2MTokenProvider.prototype) as M2MTokenProvider;
  Object.assign(p, { getToken: async () => 'tok', refresh: async () => 'tok2' });
  return p;
}

describe('AdminClient error mapping', () => {
  const admin = () => new AdminClient('http://perch.test', stubProvider());

  it('names "?" when a scope 403 does not say which scope is required', async () => {
    respond(403, JSON.stringify({ code: 'INSUFFICIENT_SCOPE' }));
    const err = await caught(admin().get('/api/v1/admin/users'));
    expect(err.message).toMatch(/missing the "\?" scope required for \/api\/v1\/admin\/users/);
  });

  it.each([
    ['message', JSON.stringify({ message: 'User not found' }), 'User not found'],
    ['error', JSON.stringify({ error: 'Not Found' }), 'Not Found'],
    ['non-JSON', 'oops', 'Perch API 404 on /api/v1/admin/users/x'],
  ])('generic errors use the %s body', async (_label, body, expected) => {
    respond(404, body);
    const err = await caught(admin().get('/api/v1/admin/users/x'));
    expect(err.status).toBe(404);
    expect(err.message).toBe(expected);
  });

  it('skips null query values as well as undefined', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    await admin().get('/api/v1/admin/users', { page: 1, status: undefined, sort: null as unknown as string });
    expect(new URL(String(spy.mock.calls[0][0])).search).toBe('?page=1');
  });
});

describe('getAdminClient singleton', () => {
  beforeEach(() => {
    process.env.PERCH_MCP_CLIENT_ID = 'mcp_x';
    process.env.PERCH_MCP_CLIENT_SECRET = 'secret';
  });

  it('defaults to https://api.perch.app and is cached until reset', async () => {
    delete process.env.PERCH_API_URL;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/oauth/token')
        ? new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200 })
        : new Response('{}', { status: 200 }),
    );

    const a = getAdminClient();
    expect(getAdminClient()).toBe(a);
    await a.get('/api/v1/admin/users');
    expect(String(spy.mock.calls.at(-1)![0])).toBe('https://api.perch.app/api/v1/admin/users');

    __resetAdminClientForTests();
    expect(getAdminClient()).not.toBe(a);
  });
});
