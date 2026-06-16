/**
 * Admin tools must only be registered when the server holds M2M
 * credentials. This is a security boundary: the multi-tenant HTTP
 * deployment has no client creds and serves many users — it must never
 * expose admin tools that act with a shared server-side identity.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const ADMIN_TOOLS = [
  'admin_get_user',
  'admin_list_users',
  'admin_get_brand_exposures',
  'admin_get_suppressed_suggestions',
  'admin_get_user_activity',
];
const USER_TOOLS = [
  'list_accounts',
  'list_recurring_series',
  'list_scheduled_items',
  'get_forecast_curve',
  'simulate_forecast',
];

async function registeredToolNames(): Promise<string[]> {
  vi.resetModules();
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const names: string[] = [];
  vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(function (this: unknown, name: string) {
    names.push(name);
    return undefined as never;
  });
  const { buildServer } = await import('../src/server.js');
  buildServer();
  return names;
}

beforeEach(() => {
  delete process.env.PERCH_MCP_CLIENT_ID;
  delete process.env.PERCH_MCP_CLIENT_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('admin tool registration gating', () => {
  it('registers only user-scoped tools when M2M creds are absent', async () => {
    const names = await registeredToolNames();
    for (const t of USER_TOOLS) expect(names).toContain(t);
    for (const t of ADMIN_TOOLS) expect(names).not.toContain(t);
  });

  it('registers admin tools when both M2M creds are present', async () => {
    process.env.PERCH_MCP_CLIENT_ID = 'mcp_abc';
    process.env.PERCH_MCP_CLIENT_SECRET = 'secret-value';
    const names = await registeredToolNames();
    for (const t of USER_TOOLS) expect(names).toContain(t);
    for (const t of ADMIN_TOOLS) expect(names).toContain(t);
  });

  it('does NOT register admin tools when only the client id is set', async () => {
    process.env.PERCH_MCP_CLIENT_ID = 'mcp_abc';
    const names = await registeredToolNames();
    for (const t of ADMIN_TOOLS) expect(names).not.toContain(t);
  });
});
