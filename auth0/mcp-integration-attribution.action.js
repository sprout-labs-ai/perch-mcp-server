/**
 * Auth0 Post-Login Action — MCP assistant attribution.
 *
 * When a user authorizes an assistant (ChatGPT / Claude) for the Perch MCP
 * audience, map the connecting OAuth client's NAME to a Perch integration slug
 * and stamp it as a namespaced access-token claim:
 *
 *     https://<mcp-audience>/integration = "chatgpt" | "claude"
 *
 * perch-api reads this claim (middleware/auth.ts → req.integrationSlug) to
 * attribute activity to the right assistant. Under Dynamic Client Registration
 * the client_id is dynamic and unguessable, so the client *name* is the only
 * reliable join key — hence this Action rather than a static client_id table.
 *
 * Per-tenant binding: set the Action secret `MCP_AUDIENCE` to that tenant's MCP
 * resource identifier (dev: https://mcp-dev.theperch.app, staging:
 * https://mcp-staging.theperch.app, prod: https://mcp.theperch.app). One code
 * body, one secret per environment.
 *
 * Safe by construction: only fires for MCP-audience transactions, only stamps a
 * claim for a recognised assistant, and never affects normal app login.
 */
exports.onExecutePostLogin = async (event, api) => {
  const mcpAudience = event.secrets && event.secrets.MCP_AUDIENCE;
  if (!mcpAudience) return;

  // The audience(s) requested in this authorize transaction. Check both the
  // raw query param and the resolved resource server; normalize to an array.
  const requested = []
    .concat(event.request && event.request.query && event.request.query.audience ? event.request.query.audience : [])
    .concat(event.resource_server && event.resource_server.identifier ? event.resource_server.identifier : []);
  if (!requested.includes(mcpAudience)) return;

  const name = ((event.client && event.client.name) || '').toLowerCase();
  let slug = null;
  if (name.includes('chatgpt') || name.includes('openai')) slug = 'chatgpt';
  else if (name.includes('claude') || name.includes('anthropic')) slug = 'claude';
  if (!slug) return; // unrecognised assistant → no claim; perch-api attributes nothing

  api.accessToken.setCustomClaim(`${mcpAudience}/integration`, slug);
};
