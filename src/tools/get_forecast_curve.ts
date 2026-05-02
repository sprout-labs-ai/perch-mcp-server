import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { perchClient } from '../api/client.js';
import type { ForecastCurveResponse } from '../api/types.js';

export function registerGetForecastCurve(server: McpServer): void {
  server.registerTool(
    'get_forecast_curve',
    {
      title: 'Get a chart-ready balance projection',
      description:
        "Project a Perch account's balance forward over the next N days as a time series. " +
        'Returns server-computed running balances so you do NOT need to do balance math yourself — ' +
        'just describe or chart the points. ' +
        'Use this when the user asks "what will my balance look like in 30 days", "graph my cash flow", ' +
        'or anything about future balance trajectory. ' +
        'Two granularities: ' +
        '"daily" emits one point per calendar day for a contiguous chart (best for plotting); ' +
        '"event" emits a starting point plus one point per event-bearing day (smaller, best for tables). ' +
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
          .describe('"daily" for plot-ready contiguous points, "event" for sparse table-friendly output. Default "daily".'),
      },
    },
    async ({ accountId, days, granularity }) => {
      const data = await perchClient.get<ForecastCurveResponse>(
        '/api/v1/forecast/curve',
        { accountId, days, granularity },
      );

      // Inline summary at the top so the LLM can answer "what's the
      // bottom line" without having to scan through every point.
      const startBalance = parseFloat(data.startingBalance);
      const endBalance = parseFloat(data.points.at(-1)?.projectedBalance ?? data.startingBalance);
      const eventCount = data.points.reduce((n, p) => n + p.events.length, 0);

      const summary = {
        accountId: data.accountId,
        startingBalance: data.startingBalance,
        startingAt: data.startingAt,
        granularity: data.granularity,
        endBalance: endBalance.toFixed(2),
        netChange: (endBalance - startBalance).toFixed(2),
        eventCount,
        points: data.points,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
