import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clientFor } from '../api/client.js';
import { frequencyLabel, type Series } from '../api/types.js';

export function registerListRecurringSeries(server: McpServer): void {
  server.registerTool(
    'list_recurring_series',
    {
      title: 'List recurring payments and income on a Perch account',
      description:
        'List the recurring payments and income (series) on a specific Perch account. ' +
        'Each series is a template — for example "Netflix every month $15.99" or "Paycheck biweekly $2,400." ' +
        "Call list_accounts first if you don't already know the accountId. " +
        'Read-only.',
      inputSchema: {
        accountId: z
          .string()
          .uuid()
          .describe('UUID of the Perch account. Get this from list_accounts.'),
        includeEnded: z
          .boolean()
          .optional()
          .describe('Include series whose end_date has passed or whose count is exhausted. Defaults to false.'),
      },
    },
    async ({ accountId, includeEnded }, extra) => {
      const series = await clientFor(extra).get<Series[]>(
        `/api/v1/accounts/${encodeURIComponent(accountId)}/series`,
      );

      const filtered = includeEnded ? series : series.filter((s) => s.status === 'active');

      const summary = {
        accountId,
        count: filtered.length,
        series: filtered.map((s) => ({
          id: s.id,
          description: s.description,
          amount: s.amount,
          direction: s.direction,
          frequency: frequencyLabel(s.frequency),
          interval: s.interval,
          startDate: s.startDate,
          endDate: s.endDate,
          status: s.status,
        })),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
