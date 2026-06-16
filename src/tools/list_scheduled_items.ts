import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clientFor } from '../api/client.js';
import type { ScheduledItemsResponse } from '../api/types.js';

export function registerListScheduledItems(server: McpServer): void {
  server.registerTool(
    'list_scheduled_items',
    {
      title: 'List upcoming scheduled items on a Perch account',
      description:
        'List the actual upcoming occurrences (with concrete dates and amounts) on a Perch account ' +
        'over a date window. This expands recurring series into individual events and applies any ' +
        'overrides (skips, reschedules, amount changes). ' +
        'Prefer this over list_recurring_series whenever the user asks "what\'s coming up", ' +
        '"what bills are due", or anything date-specific — list_recurring_series only gives templates, ' +
        'this gives concrete dates. ' +
        'Amounts are signed: negative for expenses, positive for income/refunds. ' +
        'Each item carries isPaid plus paidAt — the ISO-8601 timestamp of when the user ' +
        'marked that occurrence paid (null when unpaid). Use paidAt to answer "when did I ' +
        'last pay / mark paid <series>?". ' +
        "Call list_accounts first if you don't already know the accountId. " +
        'Requires the `read:schedule` scope. Read-only.',
      inputSchema: {
        accountId: z
          .string()
          .uuid()
          .describe('UUID of the Perch account. Get this from list_accounts.'),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
          .optional()
          .describe('Start of the window (inclusive), YYYY-MM-DD. Defaults to today.'),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
          .optional()
          .describe('End of the window (inclusive), YYYY-MM-DD. Defaults to from + 60 days. Window must be ≤ 365 days.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Maximum items returned. Defaults to 100, max 500.'),
      },
    },
    async ({ accountId, from, to, limit }, extra) => {
      const data = await clientFor(extra).get<ScheduledItemsResponse>(
        '/api/v1/scheduled-items',
        { accountId, from, to, limit },
      );

      // Light shaping for the LLM: items are already sorted by occursOn
      // server-side. Add a small computed summary so the model doesn't have
      // to re-do the math just to answer "what's the net for this window".
      const netCents = data.items.reduce(
        (sum, i) => sum + Math.round(parseFloat(i.amount) * 100),
        0,
      );

      const summary = {
        accountId: data.accountId,
        window: { from: data.from, to: data.to },
        count: data.items.length,
        netForWindow: (netCents / 100).toFixed(2),
        items: data.items,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
