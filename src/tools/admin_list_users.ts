import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAdminClient } from '../api/adminClient.js';

export function registerAdminListUsers(server: McpServer): void {
  server.registerTool(
    'admin_list_users',
    {
      title: 'Admin: list users',
      description:
        'List Perch users, paginated and filtered by account status. ' +
        'Returns a page of user summaries plus pagination metadata. ' +
        'Use to browse the user base or find recently-created accounts. ' +
        'This endpoint does NOT do free-text search — to find a specific user by email or name, ' +
        'use the dedicated search surface in the admin portal. ' +
        'Requires the MCP client to hold the `users:read` scope. Read-only.',
      inputSchema: {
        page: z.number().int().min(1).optional().describe('1-based page number. Default 1.'),
        pageSize: z.number().int().min(1).max(100).optional().describe('Rows per page. Default 20.'),
        status: z
          .enum(['active', 'deleted', 'all'])
          .optional()
          .describe('Account status filter. Default "active".'),
      },
    },
    async ({ page, pageSize, status }) => {
      const data = await getAdminClient().get<unknown>('/api/v1/admin/users', { page, pageSize, status });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}
