/**
 * Granular per-resource read scopes for the MCP audience
 * (`mcp.theperch.app`).
 *
 * These mirror the scopes defined on the MCP Auth0 resource server and are
 * enforced per-tool by perch-api's `requireResourceScope` middleware. They
 * are advertised in the Protected Resource Metadata (RFC 9728) so an MCP
 * client can request only the subset of resources it actually needs
 * (least privilege). A token lacking the scope a tool requires gets a 403
 * `INSUFFICIENT_SCOPE` from perch-api.
 *
 * Tool → required scope:
 *   list_accounts          → read:accounts
 *   list_recurring_series  → read:series
 *   list_scheduled_items   → read:schedule
 *   get_forecast_curve     → read:forecast
 *   simulate_forecast      → read:forecast
 */
export const MCP_RESOURCE_SCOPES = [
  'read:accounts',
  'read:series',
  'read:schedule',
  'read:forecast',
] as const;

export type McpResourceScope = (typeof MCP_RESOURCE_SCOPES)[number];
