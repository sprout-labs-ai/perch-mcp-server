import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListAccounts } from './tools/list_accounts.js';
import { registerListRecurringSeries } from './tools/list_recurring_series.js';
import { registerListScheduledItems } from './tools/list_scheduled_items.js';
import { registerGetForecastCurve } from './tools/get_forecast_curve.js';
import { registerSimulateForecast } from './tools/simulate_forecast.js';

export function buildServer(): McpServer {
  const server = new McpServer({
    name: 'perch-mcp-server',
    version: '0.2.0',
  });

  registerListAccounts(server);
  registerListRecurringSeries(server);
  registerListScheduledItems(server);
  registerGetForecastCurve(server);
  registerSimulateForecast(server);

  return server;
}
