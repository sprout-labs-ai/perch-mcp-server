import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAdminClient } from '../api/adminClient.js';

export function registerAdminGetUserActivity(server: McpServer): void {
  server.registerTool(
    'admin_get_user_activity',
    {
      title: 'Admin: get a user\'s activity',
      description:
        "Fetch a user's recent activity feed — auth lifecycle events, sync events, match/recurring " +
        'signals, and other timeline entries the admin dashboard surfaces. Use to reconstruct what a ' +
        'user did recently when triaging a support report. ' +
        'Requires the MCP client to hold the `users:read` scope. Read-only.',
      inputSchema: {
        user_id: z.string().uuid().describe('Internal Perch user UUID.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max events to return. Default 50.'),
      },
    },
    async ({ user_id, limit }) => {
      const data = await getAdminClient().get<unknown>(
        `/api/v1/admin/users/${encodeURIComponent(user_id)}/activity`,
        { limit },
      );
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}
