import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAdminClient } from '../api/adminClient.js';

export function registerAdminGetUser(server: McpServer): void {
  server.registerTool(
    'admin_get_user',
    {
      title: 'Admin: get a user',
      description:
        'Fetch the full admin detail record for a single Perch user by their internal UUID — ' +
        'profile, customer/billing linkage, subscription + access state, household, and Plaid items. ' +
        'Use when investigating a specific user (support, billing questions, debugging their data). ' +
        'Requires the MCP client to hold the `users:read` scope. Read-only.',
      inputSchema: {
        user_id: z.string().uuid().describe('Internal Perch user UUID (not the Auth0 id).'),
      },
    },
    async ({ user_id }) => {
      const data = await getAdminClient().get<unknown>(`/api/v1/admin/users/${encodeURIComponent(user_id)}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}
