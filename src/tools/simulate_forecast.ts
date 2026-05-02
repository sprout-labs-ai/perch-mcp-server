import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { perchClient } from '../api/client.js';
import type { ForecastSimulateResponse, HypotheticalItem } from '../api/types.js';

export function registerSimulateForecast(server: McpServer): void {
  server.registerTool(
    'simulate_forecast',
    {
      title: 'Simulate the forecast with hypothetical items (what-if)',
      description:
        'Re-run the balance projection with caller-supplied hypothetical items merged into the schedule. ' +
        'Use this when the user asks "what if I add", "what would happen if", "could I afford", ' +
        'or any what-if question about future balance. ' +
        'Hypothetical items are NOT persisted — this is a pure compute, the user\'s real schedule is unchanged. ' +
        'Each hypothetical needs an occursOn date (YYYY-MM-DD), a signed amount as a decimal string ' +
        '(negative for expenses like "-500.00", positive for income like "1200.00"), and a description. ' +
        "Call list_accounts first if you don't already know the accountId. " +
        'Read-only.',
      inputSchema: {
        accountId: z
          .string()
          .uuid()
          .describe('UUID of the Perch account.'),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('How many days forward to project from today. Default 30, max 365.'),
        granularity: z
          .enum(['daily', 'event'])
          .optional()
          .describe('"daily" for plot-ready contiguous points, "event" for sparse output. Default "daily".'),
        hypotheticalItems: z
          .array(
            z.object({
              occursOn: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
                .describe('Date the hypothetical item occurs.'),
              amount: z
                .string()
                .regex(/^-?\d+(\.\d{1,2})?$/, 'must be a signed decimal with at most 2 places')
                .describe('Signed amount as a decimal string. Negative for expense ("-500.00"), positive for income ("1200.00").'),
              description: z
                .string()
                .min(1)
                .max(500)
                .describe('Short label, e.g. "Surprise dental bill", "Bonus".'),
            }),
          )
          .min(1)
          .max(50)
          .describe('Non-empty list of hypothetical items to merge into the projection. Up to 50.'),
      },
    },
    async ({ accountId, days, granularity, hypotheticalItems }) => {
      const data = await perchClient.post<ForecastSimulateResponse>(
        '/api/v1/forecast/simulate',
        { accountId, days, granularity, hypotheticalItems },
      );

      const startBalance = parseFloat(data.startingBalance);
      const endBalance = parseFloat(data.points.at(-1)?.projectedBalance ?? data.startingBalance);
      const hypotheticalImpact = (hypotheticalItems as HypotheticalItem[])
        .reduce((sum, h) => sum + Math.round(parseFloat(h.amount) * 100), 0);

      const summary = {
        accountId: data.accountId,
        startingBalance: data.startingBalance,
        startingAt: data.startingAt,
        granularity: data.granularity,
        endBalance: endBalance.toFixed(2),
        netChange: (endBalance - startBalance).toFixed(2),
        appliedHypotheticals: data.appliedHypotheticals,
        netHypotheticalImpact: (hypotheticalImpact / 100).toFixed(2),
        points: data.points,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
