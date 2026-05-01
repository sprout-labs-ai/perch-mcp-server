import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListAccounts } from './tools/list_accounts.js';
import { registerListRecurringSeries } from './tools/list_recurring_series.js';

export function buildServer(): McpServer {
  const server = new McpServer({
    name: 'perch-mcp-server',
    version: '0.1.0',
  });

  registerListAccounts(server);
  registerListRecurringSeries(server);

  return server;
}
