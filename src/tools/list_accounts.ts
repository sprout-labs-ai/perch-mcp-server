import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clientFor } from '../api/client.js';
import type { Account } from '../api/types.js';

export function registerListAccounts(server: McpServer): void {
  server.registerTool(
    'list_accounts',
    {
      title: 'List Perch accounts',
      description:
        "List the user's Perch accounts with their current balances. " +
        'Use this when the user asks how much money they have, where their money is, ' +
        'or whenever you need an accountId before calling another tool. ' +
        'Requires the `read:accounts` scope. Read-only.',
      inputSchema: {},
    },
    async (_args, extra) => {
      const accounts = await clientFor(extra).get<Account[]>('/api/v1/accounts');
      const summary = {
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.name,
          isDefault: a.isDefault,
          currentBalance: a.currentBalance,
          isPlaidLinked: a.isPlaidLinked,
          autoSyncBalance: a.autoSyncBalance,
          lastBalanceUpdate: a.lastBalanceUpdate,
        })),
        totalCurrentBalance: accounts.reduce((sum, a) => sum + (a.currentBalance ?? 0), 0),
        defaultAccountId: accounts.find((a) => a.isDefault)?.id ?? null,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
