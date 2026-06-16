import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListAccounts } from './tools/list_accounts.js';
import { registerListRecurringSeries } from './tools/list_recurring_series.js';
import { registerListScheduledItems } from './tools/list_scheduled_items.js';
import { registerGetForecastCurve } from './tools/get_forecast_curve.js';
import { registerSimulateForecast } from './tools/simulate_forecast.js';
import { registerAdminGetUser } from './tools/admin_get_user.js';
import { registerAdminListUsers } from './tools/admin_list_users.js';
import { registerAdminGetBrandExposures } from './tools/admin_get_brand_exposures.js';
import { registerAdminGetSuppressedSuggestions } from './tools/admin_get_suppressed_suggestions.js';
import { registerAdminGetUserActivity } from './tools/admin_get_user_activity.js';
import { isM2MConfigured } from './auth/m2mToken.js';

export function buildServer(): McpServer {
  const server = new McpServer({
    name: 'perch-mcp-server',
    version: '0.2.0',
  });

  // User-scoped tools — authenticate as the calling user (PAT in stdio
  // mode, forwarded Auth0 JWT in HTTP mode).
  registerListAccounts(server);
  registerListRecurringSeries(server);
  registerListScheduledItems(server);
  registerGetForecastCurve(server);
  registerSimulateForecast(server);

  // Admin (machine-to-machine) tools — authenticate with a server-side
  // client credential, NOT the calling user's identity. Registered ONLY
  // when M2M credentials are configured, so the multi-tenant HTTP
  // deployment (which has no client creds and serves many users) never
  // exposes admin tools. A dedicated stdio instance for an operator —
  // e.g. Claude Code with PERCH_MCP_CLIENT_ID/SECRET set — gets them.
  if (isM2MConfigured()) {
    registerAdminGetUser(server);
    registerAdminListUsers(server);
    registerAdminGetBrandExposures(server);
    registerAdminGetSuppressedSuggestions(server);
    registerAdminGetUserActivity(server);
  }

  return server;
}
