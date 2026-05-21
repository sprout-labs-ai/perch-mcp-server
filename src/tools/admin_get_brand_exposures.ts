import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAdminClient } from '../api/adminClient.js';

export function registerAdminGetBrandExposures(server: McpServer): void {
  server.registerTool(
    'admin_get_brand_exposures',
    {
      title: 'Admin: get a user\'s brand exposures',
      description:
        "Fetch a user's per-brand exposure signals — impression/selection counts and the derived " +
        "suppression state (normal / demoted / suppressed) plus when the engine auto-suppressed each brand. " +
        'Use to debug "why is the app no longer suggesting brand X for this user" questions. ' +
        'Requires the MCP client to hold the `brand_exposures:read` scope. Read-only.',
      inputSchema: {
        user_id: z.string().uuid().describe('Internal Perch user UUID.'),
        page: z.number().int().min(1).optional().describe('1-based page number. Default 1.'),
        pageSize: z.number().int().min(1).max(200).optional().describe('Rows per page. Default 50, max 200.'),
        sort: z
          .string()
          .optional()
          .describe('Sort key, e.g. "last_shown" (default). Passed through to the API.'),
      },
    },
    async ({ user_id, page, pageSize, sort }) => {
      const data = await getAdminClient().get<unknown>(
        `/api/v1/admin/users/${encodeURIComponent(user_id)}/brand-exposures`,
        { page, pageSize, sort },
      );
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}
