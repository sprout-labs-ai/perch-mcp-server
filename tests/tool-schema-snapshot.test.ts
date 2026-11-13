/**
 * Contract test for the tool surface MCP hosts see.
 *
 * Tool names, titles, descriptions and input schemas are what Claude /
 * ChatGPT use to decide when and how to call a tool. A silent change there
 * (renamed param, loosened validation, dropped description) is a behavior
 * change for every connected assistant, so it should show up in review as a
 * snapshot diff. Update intentionally with `npx vitest run -u`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { connectClient } from './helpers/harness.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  // Register every tool, admin ones included, so the whole surface is pinned.
  process.env.PERCH_MCP_CLIENT_ID = 'mcp_snapshot';
  process.env.PERCH_MCP_CLIENT_SECRET = 'snapshot-secret';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function listTools() {
  const h = await connectClient();
  try {
    const { tools } = await h.client.listTools();
    return [...tools].sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await h.close();
  }
}

describe('tools/list contract', () => {
  it('matches the committed snapshot', async () => {
    expect(await listTools()).toMatchSnapshot();
  });

  it('every tool has a title, says it is read-only, and names its scope', async () => {
    for (const tool of await listTools()) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toMatch(/Read-only\.$/);
      expect(tool.description, tool.name).toMatch(/scope/);
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
  });
});
