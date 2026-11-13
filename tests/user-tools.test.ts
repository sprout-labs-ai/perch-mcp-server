/**
 * User-scoped tool handlers, driven through a real MCP client.
 *
 * For each tool we lock down: the perch-api request it makes (path, query or
 * body), the summary it computes for the LLM (totals, net change, filtering),
 * input validation, and how upstream errors reach the assistant.
 *
 * stdio/PAT mode is the default here; the HTTP-mode block at the bottom
 * covers token forwarding and access-activity emission.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ACCOUNT_ID,
  connectClient,
  json,
  mockPerchApi,
  parseToolText,
} from './helpers/harness.js';

const ORIGINAL_ENV = { ...process.env };
const API = 'http://perch.test';

beforeEach(() => {
  vi.resetModules();
  process.env.PERCH_API_URL = API;
  process.env.PERCH_API_TOKEN = 'pat_test_token';
  delete process.env.PERCH_MCP_CLIENT_ID;
  delete process.env.PERCH_MCP_CLIENT_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const h = await connectClient();
  try {
    return await h.client.callTool({ name, arguments: args });
  } finally {
    await h.close();
  }
}

/** Asserts the call failed input validation, however the SDK surfaces it. */
async function expectInvalidArgs(name: string, args: Record<string, unknown>) {
  const h = await connectClient();
  try {
    const result = await h.client.callTool({ name, arguments: args }).catch((err: Error) => err);
    if (result instanceof Error) {
      expect(result.message).toMatch(/invalid/i);
    } else {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/invalid/i);
    }
  } finally {
    await h.close();
  }
}

// ──────────────────────────────────────────────────────────────────────────────

describe('list_accounts', () => {
  const accounts = [
    {
      id: 'a1', name: 'Checking', isDefault: true, currentBalance: 1200.5,
      isPlaidLinked: true, autoSyncBalance: true, lastBalanceUpdate: '2026-11-01T00:00:00Z',
      createdAt: 'x', updatedAt: 'y',
    },
    {
      id: 'a2', name: 'Savings', isDefault: false, currentBalance: 300,
      isPlaidLinked: false, autoSyncBalance: false, lastBalanceUpdate: null,
      createdAt: 'x', updatedAt: 'y',
    },
  ];

  it('calls GET /api/v1/accounts with the PAT and summarizes balances', async () => {
    const { requests } = mockPerchApi({ 'GET /api/v1/accounts': () => json(accounts) });

    const result = await callTool('list_accounts');
    const body = parseToolText(result);

    expect(requests).toHaveLength(1);
    expect(requests[0].headers.Authorization).toBe('Bearer pat_test_token');
    expect(body.totalCurrentBalance).toBeCloseTo(1500.5);
    expect(body.defaultAccountId).toBe('a1');
    expect(body.accounts).toHaveLength(2);
    // Only the documented fields are passed through — no createdAt/updatedAt.
    expect(Object.keys(body.accounts[0]).sort()).toEqual([
      'autoSyncBalance', 'currentBalance', 'id', 'isDefault', 'isPlaidLinked', 'lastBalanceUpdate', 'name',
    ]);
  });

  it('handles no accounts and a null balance', async () => {
    mockPerchApi({
      'GET /api/v1/accounts': () => json([{ ...accounts[1], currentBalance: null }]),
    });
    const body = parseToolText(await callTool('list_accounts'));
    expect(body.totalCurrentBalance).toBe(0);
    expect(body.defaultAccountId).toBeNull();
  });

  it('surfaces perch-api privacy errors as a tool error with calm guidance', async () => {
    mockPerchApi({
      'GET /api/v1/accounts': () => json({ code: 'INTEGRATIONS_DISABLED' }, 403),
    });
    const result = await callTool('list_accounts');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Integrations are turned off/);
  });

  it('reports a missing PAT in stdio mode as a tool error, not a crash', async () => {
    delete process.env.PERCH_API_TOKEN;
    mockPerchApi({});
    const result = await callTool('list_accounts');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/PERCH_API_TOKEN/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe('list_recurring_series', () => {
  const series = [
    { id: 's1', description: 'Netflix', amount: 15.99, direction: 'expense', frequency: 2, interval: 1,
      startDate: '2026-01-01', endDate: null, status: 'active' },
    { id: 's2', description: 'Old gym', amount: 40, direction: 'expense', frequency: 2, interval: 1,
      startDate: '2025-01-01', endDate: '2025-12-31', status: 'ended' },
    { id: 's3', description: 'Odd one', amount: 1, direction: 'income', frequency: 9, interval: 1,
      startDate: '2026-01-01', endDate: null, status: 'active' },
  ];

  it('hits the per-account series path and hides ended series by default', async () => {
    const { requests } = mockPerchApi({
      [`GET /api/v1/accounts/${ACCOUNT_ID}/series`]: () => json(series),
    });
    const body = parseToolText(await callTool('list_recurring_series', { accountId: ACCOUNT_ID }));

    expect(requests[0].url.pathname).toBe(`/api/v1/accounts/${ACCOUNT_ID}/series`);
    expect(body.accountId).toBe(ACCOUNT_ID);
    expect(body.count).toBe(2);
    expect(body.series.map((s: { id: string }) => s.id)).toEqual(['s1', 's3']);
    // Numeric frequency → label; unknown codes don't crash.
    expect(body.series[0].frequency).toBe('monthly');
    expect(body.series[1].frequency).toBe('unknown');
  });

  it('includes ended series when includeEnded is true', async () => {
    mockPerchApi({ [`GET /api/v1/accounts/${ACCOUNT_ID}/series`]: () => json(series) });
    const body = parseToolText(
      await callTool('list_recurring_series', { accountId: ACCOUNT_ID, includeEnded: true }),
    );
    expect(body.count).toBe(3);
  });

  it('rejects a non-UUID accountId before calling perch-api', async () => {
    const { requests } = mockPerchApi({});
    await expectInvalidArgs('list_recurring_series', { accountId: 'not-a-uuid' });
    expect(requests).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe('list_scheduled_items', () => {
  const response = {
    accountId: ACCOUNT_ID,
    from: '2026-11-01',
    to: '2026-11-30',
    items: [
      { seriesId: 's1', occursOn: '2026-11-03', amount: '-15.99', description: 'Netflix',
        direction: 'expense', frequency: 'monthly', isPaid: false, paidAt: null, isRescheduled: false },
      { seriesId: 's2', occursOn: '2026-11-15', amount: '2400.00', description: 'Paycheck',
        direction: 'income', frequency: 'weekly', isPaid: true, paidAt: '2026-11-15T12:00:00Z', isRescheduled: false },
      // 0.1 + 0.2 style float traps: cents math must stay exact.
      { seriesId: 's3', occursOn: '2026-11-20', amount: '-0.10', description: 'a',
        direction: 'expense', frequency: 'daily', isPaid: false, paidAt: null, isRescheduled: false },
      { seriesId: 's3', occursOn: '2026-11-21', amount: '-0.20', description: 'b',
        direction: 'expense', frequency: 'daily', isPaid: false, paidAt: null, isRescheduled: true },
    ],
  };

  it('passes the window and limit as query params and computes the net', async () => {
    const { requests } = mockPerchApi({ 'GET /api/v1/scheduled-items': () => json(response) });
    const body = parseToolText(
      await callTool('list_scheduled_items', {
        accountId: ACCOUNT_ID, from: '2026-11-01', to: '2026-11-30', limit: 10,
      }),
    );

    const q = requests[0].url.searchParams;
    expect(q.get('accountId')).toBe(ACCOUNT_ID);
    expect(q.get('from')).toBe('2026-11-01');
    expect(q.get('to')).toBe('2026-11-30');
    expect(q.get('limit')).toBe('10');

    expect(body.window).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(body.count).toBe(4);
    expect(body.netForWindow).toBe('2383.71');
    expect(body.items[1].paidAt).toBe('2026-11-15T12:00:00Z');
  });

  it('omits unset optional params from the query string', async () => {
    const { requests } = mockPerchApi({
      'GET /api/v1/scheduled-items': () => json({ ...response, items: [] }),
    });
    const body = parseToolText(await callTool('list_scheduled_items', { accountId: ACCOUNT_ID }));
    const q = requests[0].url.searchParams;
    expect([...q.keys()]).toEqual(['accountId']);
    expect(body.netForWindow).toBe('0.00');
  });

  it('rejects malformed dates and out-of-range limits', async () => {
    mockPerchApi({});
    await expectInvalidArgs('list_scheduled_items', { accountId: ACCOUNT_ID, from: '11/01/2026' });
    await expectInvalidArgs('list_scheduled_items', { accountId: ACCOUNT_ID, limit: 501 });
  });
});

// ──────────────────────────────────────────────────────────────────────────────

const curve = {
  accountId: ACCOUNT_ID,
  startingBalance: '1000.00',
  startingAt: '2026-11-12',
  granularity: 'daily',
  points: [
    { date: '2026-11-12', projectedBalance: '1000.00', events: [] },
    { date: '2026-11-13', projectedBalance: '984.01', events: [{ seriesId: 's1', amount: '-15.99', description: 'Netflix' }] },
    { date: '2026-11-14', projectedBalance: '3384.01', events: [
      { seriesId: 's2', amount: '2400.00', description: 'Paycheck' },
      { seriesId: 's9', amount: '0.00', description: 'Marker' },
    ] },
  ],
};

describe('get_forecast_curve', () => {
  it('requests the curve and summarizes end balance, net change and event count', async () => {
    const { requests } = mockPerchApi({ 'GET /api/v1/forecast/curve': () => json(curve) });
    const body = parseToolText(
      await callTool('get_forecast_curve', { accountId: ACCOUNT_ID, days: 3, granularity: 'daily' }),
    );

    const q = requests[0].url.searchParams;
    expect(q.get('days')).toBe('3');
    expect(q.get('granularity')).toBe('daily');
    expect(body.endBalance).toBe('3384.01');
    expect(body.netChange).toBe('2384.01');
    expect(body.eventCount).toBe(3);
    expect(body.points).toHaveLength(3);
  });

  it('falls back to the starting balance when there are no points', async () => {
    mockPerchApi({ 'GET /api/v1/forecast/curve': () => json({ ...curve, points: [] }) });
    const body = parseToolText(await callTool('get_forecast_curve', { accountId: ACCOUNT_ID }));
    expect(body.endBalance).toBe('1000.00');
    expect(body.netChange).toBe('0.00');
    expect(body.eventCount).toBe(0);
  });

  it('rejects days outside 1..365 and unknown granularities', async () => {
    mockPerchApi({});
    await expectInvalidArgs('get_forecast_curve', { accountId: ACCOUNT_ID, days: 0 });
    await expectInvalidArgs('get_forecast_curve', { accountId: ACCOUNT_ID, days: 366 });
    await expectInvalidArgs('get_forecast_curve', { accountId: ACCOUNT_ID, granularity: 'hourly' });
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe('simulate_forecast', () => {
  const hypotheticalItems = [
    { occursOn: '2026-11-20', amount: '-500.00', description: 'Dental bill' },
    { occursOn: '2026-11-25', amount: '1200', description: 'Bonus' },
    { occursOn: '2026-11-26', amount: '-0.1', description: 'Rounding' },
  ];

  it('POSTs the hypotheticals and summarizes their net impact', async () => {
    const { requests } = mockPerchApi({
      'POST /api/v1/forecast/simulate': () => json({ ...curve, appliedHypotheticals: 3 }),
    });
    const body = parseToolText(
      await callTool('simulate_forecast', { accountId: ACCOUNT_ID, days: 30, hypotheticalItems }),
    );

    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers['Content-Type']).toBe('application/json');
    expect(requests[0].body).toEqual({ accountId: ACCOUNT_ID, days: 30, hypotheticalItems });
    expect(body.appliedHypotheticals).toBe(3);
    expect(body.netHypotheticalImpact).toBe('699.90');
    expect(body.endBalance).toBe('3384.01');
    expect(body.netChange).toBe('2384.01');
  });

  it('handles an empty projection', async () => {
    mockPerchApi({
      'POST /api/v1/forecast/simulate': () => json({ ...curve, points: [], appliedHypotheticals: 1 }),
    });
    const body = parseToolText(
      await callTool('simulate_forecast', { accountId: ACCOUNT_ID, hypotheticalItems: [hypotheticalItems[0]] }),
    );
    expect(body.endBalance).toBe('1000.00');
  });

  it('rejects an empty list, bad amounts and bad dates', async () => {
    const { requests } = mockPerchApi({});
    await expectInvalidArgs('simulate_forecast', { accountId: ACCOUNT_ID, hypotheticalItems: [] });
    await expectInvalidArgs('simulate_forecast', {
      accountId: ACCOUNT_ID,
      hypotheticalItems: [{ occursOn: '2026-11-20', amount: '$500', description: 'x' }],
    });
    await expectInvalidArgs('simulate_forecast', {
      accountId: ACCOUNT_ID,
      hypotheticalItems: [{ occursOn: '2026-11-20', amount: '-5.001', description: 'x' }],
    });
    await expectInvalidArgs('simulate_forecast', {
      accountId: ACCOUNT_ID,
      hypotheticalItems: [{ occursOn: 'tomorrow', amount: '-5', description: 'x' }],
    });
    expect(requests).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// HTTP mode: forwarded token + access-activity emission

describe('HTTP mode (authInfo present)', () => {
  const authInfo = {
    token: 'hydra-jwt-for-user',
    clientId: 'claude-ai-client',
    scopes: ['read:accounts'],
  };

  it('forwards the caller token instead of the PAT and records one activity entry', async () => {
    const { requests } = mockPerchApi({
      'GET /api/v1/accounts': () => json([]),
      'POST /api/v1/integrations/activity': () => json({ ok: true }, 201),
    });

    const h = await connectClient({ authInfo });
    try {
      const result = await h.client.callTool({ name: 'list_accounts', arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await h.close();
    }

    await vi.waitFor(() => expect(requests).toHaveLength(2));
    for (const r of requests) expect(r.headers.Authorization).toBe('Bearer hydra-jwt-for-user');
    const activity = requests.find((r) => r.url.pathname === '/api/v1/integrations/activity')!;
    expect(activity.body).toMatchObject({ permissionKey: expect.any(String), summary: expect.any(String) });
  });

  it('still returns the answer when activity logging fails', async () => {
    const { requests } = mockPerchApi({
      'GET /api/v1/accounts': () => json([]),
      'POST /api/v1/integrations/activity': () => json({ error: 'boom' }, 500),
    });
    const h = await connectClient({ authInfo });
    try {
      const result = await h.client.callTool({ name: 'list_accounts', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(parseToolText(result).accounts).toEqual([]);
    } finally {
      await h.close();
    }
    await vi.waitFor(() => expect(requests).toHaveLength(2));
  });

  it('records no activity when the tool call fails', async () => {
    const { requests } = mockPerchApi({
      'GET /api/v1/accounts': () => json({ code: 'PERMISSION_DISABLED' }, 403),
    });
    const h = await connectClient({ authInfo });
    try {
      const result = await h.client.callTool({ name: 'list_accounts', arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
    // Give a stray fire-and-forget emission a chance to show up.
    await new Promise((r) => setTimeout(r, 20));
    expect(requests.map((r) => r.url.pathname)).toEqual(['/api/v1/accounts']);
  });
});
