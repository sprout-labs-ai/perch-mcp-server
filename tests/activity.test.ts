/**
 * Access-activity emission + instrumentation.
 *
 * Verifies the privacy-safe contract:
 *   - emission happens only for connected-assistant (HTTP, `azp`-bearing) calls
 *   - the body carries ONLY a fixed calm summary + permission key — no PII, no
 *     args, no IDs, no transport detail
 *   - emission is best-effort: a failing sink never throws
 *   - the dispatch wrapper logs after success, only for tracked tools, and
 *     never alters the tool result
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { recordToolActivity } from '../src/activity/emit.js';
import { TOOL_ACTIVITY_SUMMARIES, isActivityTrackedTool } from '../src/activity/summaries.js';
import { instrumentToolActivity } from '../src/activity/instrument.js';
import { PERMISSION_KEYS } from '../src/auth/permissions.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.PERCH_API_URL = 'https://api.test.perch.app';
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

function mockFetchOk() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
}

describe('TOOL_ACTIVITY_SUMMARIES', () => {
  it('covers exactly the five read-only user tools', () => {
    expect(Object.keys(TOOL_ACTIVITY_SUMMARIES).sort()).toEqual(
      ['get_forecast_curve', 'list_accounts', 'list_recurring_series', 'list_scheduled_items', 'simulate_forecast'].sort(),
    );
  });

  it('every summary references a known permission key and carries no interpolation markers', () => {
    for (const { summary, permissionKey } of Object.values(TOOL_ACTIVITY_SUMMARIES)) {
      expect(PERMISSION_KEYS).toContain(permissionKey);
      // Fixed sentences only — never templated.
      expect(summary).not.toMatch(/[${}]/);
    }
  });

  it('admin tools are not tracked', () => {
    expect(isActivityTrackedTool('admin_get_user')).toBe(false);
    expect(isActivityTrackedTool('list_accounts')).toBe(true);
  });
});

describe('recordToolActivity', () => {
  it('POSTs only summary + permissionKey for a connected-assistant call', async () => {
    const fetchSpy = mockFetchOk();
    await recordToolActivity({ authInfo: { token: 'jwt-abc', clientId: 'azp-chatgpt' } }, 'list_accounts');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.test.perch.app/api/v1/integrations/activity');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init!.body as string);
    // Exactly the two privacy-safe fields — nothing else.
    expect(body).toEqual({ summary: 'Checked your account balances', permissionKey: 'current_balance' });
    expect(Object.keys(body)).toHaveLength(2);
  });

  it('forwards the inbound token as the Authorization bearer', async () => {
    const fetchSpy = mockFetchOk();
    await recordToolActivity({ authInfo: { token: 'jwt-abc', clientId: 'azp-x' } }, 'get_forecast_curve');
    const init = fetchSpy.mock.calls[0][1];
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-abc');
  });

  it('skips when there is no clientId (stdio / PAT — not a consumer connection)', async () => {
    const fetchSpy = mockFetchOk();
    await recordToolActivity({ authInfo: { token: 'pat_xyz' } }, 'list_accounts');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips when there is no authInfo at all', async () => {
    const fetchSpy = mockFetchOk();
    await recordToolActivity(undefined, 'list_accounts');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips untracked tools (e.g. admin)', async () => {
    const fetchSpy = mockFetchOk();
    await recordToolActivity({ authInfo: { token: 'jwt', clientId: 'azp' } }, 'admin_get_user');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never throws when the sink fails (best-effort)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(
      recordToolActivity({ authInfo: { token: 'jwt', clientId: 'azp' } }, 'list_accounts'),
    ).resolves.toBeUndefined();
  });

  it('never throws on a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      recordToolActivity({ authInfo: { token: 'jwt', clientId: 'azp' } }, 'list_accounts'),
    ).resolves.toBeUndefined();
  });
});

describe('instrumentToolActivity', () => {
  function fakeServer() {
    const registered: Array<{ name: string; handler: Function }> = [];
    const server = {
      registerTool(name: string, _config: unknown, handler: Function) {
        registered.push({ name, handler });
        return { name };
      },
    };
    return { server, registered };
  }

  it('wraps tracked tools and emits after a successful result, leaving the result intact', async () => {
    const fetchSpy = mockFetchOk();
    const { server, registered } = fakeServer();
    instrumentToolActivity(server as never);

    const expected = { content: [{ type: 'text', text: 'ok' }] };
    server.registerTool('list_accounts', {}, async () => expected);

    const result = await registered[0].handler({}, { authInfo: { token: 'jwt', clientId: 'azp' } });
    expect(result).toBe(expected);

    // Emission is fire-and-forget; let the microtask flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('does not wrap untracked tools', async () => {
    const fetchSpy = mockFetchOk();
    const { server, registered } = fakeServer();
    instrumentToolActivity(server as never);

    server.registerTool('admin_get_user', {}, async () => ({ ok: true }));
    await registered[0].handler({}, { authInfo: { token: 'jwt', clientId: 'azp' } });

    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not emit when the tool handler throws', async () => {
    const fetchSpy = mockFetchOk();
    const { server, registered } = fakeServer();
    instrumentToolActivity(server as never);

    server.registerTool('list_accounts', {}, async () => {
      throw new Error('boom');
    });

    await expect(registered[0].handler({}, { authInfo: { token: 'jwt', clientId: 'azp' } })).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
