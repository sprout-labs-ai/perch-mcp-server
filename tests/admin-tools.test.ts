/**
 * Admin (M2M) tool handlers, driven through a real MCP client.
 *
 * Verifies each tool exchanges client credentials for an M2M token, calls the
 * right admin endpoint with the right query, passes perch-api's JSON through
 * untouched, and never emits user access-activity.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { connectClient, json, mockPerchApi, parseToolText, USER_ID } from './helpers/harness.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PERCH_API_URL = 'http://perch.test';
  process.env.PERCH_MCP_CLIENT_ID = 'mcp_test_client';
  process.env.PERCH_MCP_CLIENT_SECRET = 'mcp_test_secret';
  delete process.env.PERCH_API_TOKEN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

const tokenRoute = {
  'POST /api/v1/oauth/token': () => json({ access_token: 'm2m-token', expires_in: 300 }),
};

const cases: Array<{
  tool: string;
  args: Record<string, unknown>;
  route: string;
  query: Record<string, string>;
}> = [
  { tool: 'admin_get_user', args: { user_id: USER_ID }, route: `GET /api/v1/admin/users/${USER_ID}`, query: {} },
  {
    tool: 'admin_list_users',
    args: { page: 2, pageSize: 50, status: 'deleted' },
    route: 'GET /api/v1/admin/users',
    query: { page: '2', pageSize: '50', status: 'deleted' },
  },
  {
    tool: 'admin_get_brand_exposures',
    args: { user_id: USER_ID, page: 1, pageSize: 25, sort: 'last_shown' },
    route: `GET /api/v1/admin/users/${USER_ID}/brand-exposures`,
    query: { page: '1', pageSize: '25', sort: 'last_shown' },
  },
  {
    tool: 'admin_get_suppressed_suggestions',
    args: { user_id: USER_ID, kind: 'recurring', includeRestored: true, limit: 10, cursor: 'abc' },
    route: `GET /api/v1/admin/users/${USER_ID}/suppressed-suggestions`,
    query: { kind: 'recurring', includeRestored: 'true', limit: '10', cursor: 'abc' },
  },
  {
    tool: 'admin_get_user_activity',
    args: { user_id: USER_ID, limit: 5 },
    route: `GET /api/v1/admin/users/${USER_ID}/activity`,
    query: { limit: '5' },
  },
];

describe.each(cases)('$tool', ({ tool, args, route, query }) => {
  it('exchanges M2M creds, calls the admin endpoint and passes the JSON through', async () => {
    const payload = { tool, rows: [{ id: 1 }] };
    const { requests } = mockPerchApi({ ...tokenRoute, [route]: () => json(payload) });

    const h = await connectClient();
    let result;
    try {
      result = await h.client.callTool({ name: tool, arguments: args });
    } finally {
      await h.close();
    }

    expect(parseToolText(result)).toEqual(payload);
    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(['POST /api/v1/oauth/token', route]);
    expect(requests[0].body).toMatchObject({
      grant_type: 'client_credentials',
      client_id: 'mcp_test_client',
      client_secret: 'mcp_test_secret',
    });
    const call = requests[1];
    expect(call.headers.Authorization).toBe('Bearer m2m-token');
    expect(Object.fromEntries(call.url.searchParams)).toEqual(query);
  });
});

describe('admin tool errors and validation', () => {
  it('rejects a non-UUID user_id without touching the network', async () => {
    const { requests } = mockPerchApi(tokenRoute);
    const h = await connectClient();
    try {
      const result = await h.client
        .callTool({ name: 'admin_get_user', arguments: { user_id: 'bob' } })
        .catch((err: Error) => ({ isError: true, content: [{ type: 'text', text: err.message }] }));
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
    expect(requests).toHaveLength(0);
  });

  it('surfaces a missing-scope 403 as an actionable tool error', async () => {
    mockPerchApi({
      ...tokenRoute,
      [`GET /api/v1/admin/users/${USER_ID}`]: () =>
        json({ code: 'INSUFFICIENT_SCOPE', required: 'users:read' }, 403),
    });
    const h = await connectClient();
    try {
      const result = await h.client.callTool({ name: 'admin_get_user', arguments: { user_id: USER_ID } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/users:read/);
    } finally {
      await h.close();
    }
  });

  it('surfaces rejected client credentials as a tool error', async () => {
    mockPerchApi({
      'POST /api/v1/oauth/token': () => json({ error: 'invalid_client' }, 401),
    });
    const h = await connectClient();
    try {
      const result = await h.client.callTool({ name: 'admin_list_users', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/PERCH_MCP_CLIENT_ID/);
    } finally {
      await h.close();
    }
  });

  it('never emits user access-activity, even with an HTTP authInfo', async () => {
    const { requests } = mockPerchApi({
      ...tokenRoute,
      'GET /api/v1/admin/users': () => json({ users: [] }),
    });
    const h = await connectClient({ authInfo: { token: 't', clientId: 'claude', scopes: [] } });
    try {
      await h.client.callTool({ name: 'admin_list_users', arguments: {} });
    } finally {
      await h.close();
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(requests.some((r) => r.url.pathname.includes('integrations/activity'))).toBe(false);
  });
});
