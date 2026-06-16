import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAdminClient } from '../api/adminClient.js';

export function registerAdminGetSuppressedSuggestions(server: McpServer): void {
  server.registerTool(
    'admin_get_suppressed_suggestions',
    {
      title: 'Admin: get a user\'s suppressed suggestions',
      description:
        "Fetch the suggestions currently suppressed for a user — both recurring suggestions the user " +
        'dismissed and Plaid candidate suggestions that were hidden. Unions across sources, ordered by ' +
        'when they were suppressed. Use to answer "why isn\'t Perch suggesting this recurring charge" ' +
        'or to audit a user\'s dismissed suggestions. ' +
        'Requires the MCP client to hold the `suppressed_suggestions:read` scope. Read-only.',
      inputSchema: {
        user_id: z.string().uuid().describe('Internal Perch user UUID.'),
        kind: z
          .enum(['recurring', 'plaid_candidate', 'all'])
          .optional()
          .describe('Filter by suppression source. Default "all".'),
        includeRestored: z
          .boolean()
          .optional()
          .describe('Include suggestions the user later restored. Default false.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows. Default 50, max 200.'),
        cursor: z.string().optional().describe('Opaque pagination cursor from a previous response.'),
      },
    },
    async ({ user_id, kind, includeRestored, limit, cursor }) => {
      const data = await getAdminClient().get<unknown>(
        `/api/v1/admin/users/${encodeURIComponent(user_id)}/suppressed-suggestions`,
        { kind, includeRestored, limit, cursor },
      );
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}
