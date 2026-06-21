/**
 * Auth0 Post-Login Action — MCP assistant attribution.
 *
 * When a user authorizes an assistant (ChatGPT, Claude, Gemini, …) for the
 * Perch MCP audience, map the connecting OAuth client's NAME to a Perch
 * integration slug and stamp it as a namespaced access-token claim:
 *
 *     https://<mcp-audience>/integration = "chatgpt" | "claude" | "gemini" | …
 *
 * perch-api reads this claim (middleware/auth.ts → req.integrationSlug) to
 * attribute activity to the right assistant. Under Dynamic Client Registration
 * the client_id is dynamic and unguessable, so the client *name* is the only
 * reliable join key — hence this Action rather than a static client_id table.
 *
 * REGISTRY-DRIVEN: the name→slug map is NOT hard-coded here. It is fetched from
 * perch-api's public catalog
 * (GET <PERCH_API_BASE_URL>/api/v1/integrations/attribution-map), which returns
 * `{ integrations: [{ slug, namePatterns: [..lowercased substrings..] }] }`
 * derived from the admin-managed `integrations` registry. So onboarding a new
 * assistant is just: add it in perch-admin and fill its name patterns — no edit
 * or redeploy of this Action per assistant.
 *
 * Per-tenant secrets (Action → Settings → Secrets):
 *   MCP_AUDIENCE        that tenant's MCP resource identifier
 *                       (dev https://mcp-dev.theperch.app, staging
 *                       https://mcp-staging.theperch.app, prod
 *                       https://mcp.theperch.app)
 *   PERCH_API_BASE_URL  that tenant's perch-api origin (no trailing slash),
 *                       e.g. https://api.theperch.app
 *
 * Resilience: the map is cached in the warm Action container (5-min TTL). If a
 * refresh fails, the last good map is reused regardless of age (serve-stale),
 * so a perch-api blip degrades to "use the previous map" — never a broken
 * login. With no cached map and a failed fetch, no claim is stamped (same as an
 * unrecognised client today).
 *
 * Safe by construction: only fires for MCP-audience transactions, only stamps a
 * claim for a recognised assistant, and never affects normal app login.
 */

const MAP_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

// Warm-container cache, shared across invocations of the same Action instance.
let _cache = { fetchedAt: 0, integrations: null };

async function loadAttributionMap(baseUrl) {
  const fresh = _cache.integrations && Date.now() - _cache.fetchedAt < MAP_TTL_MS;
  if (fresh) return _cache.integrations;

  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/integrations/attribution-map`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`attribution-map HTTP ${res.status}`);
    const body = await res.json();
    const integrations = Array.isArray(body && body.integrations) ? body.integrations : [];
    _cache = { fetchedAt: Date.now(), integrations };
    return integrations;
  } catch (err) {
    // Serve-stale on error: prefer a previous map over no attribution at all.
    console.log(`[mcp-attribution] map refresh failed: ${err && err.message}`);
    return _cache.integrations; // null if we never succeeded
  } finally {
    clearTimeout(timer);
  }
}

/** First integration whose any pattern is a substring of the client name. */
function slugForClientName(integrations, clientName) {
  const name = (clientName || '').toLowerCase();
  if (!name) return null;
  for (const entry of integrations) {
    if (!entry || !entry.slug || !Array.isArray(entry.namePatterns)) continue;
    for (const pattern of entry.namePatterns) {
      if (typeof pattern === 'string' && pattern && name.includes(pattern)) {
        return entry.slug;
      }
    }
  }
  return null;
}

exports.onExecutePostLogin = async (event, api) => {
  const secrets = event.secrets || {};
  const mcpAudience = secrets.MCP_AUDIENCE;
  const perchApiBaseUrl = secrets.PERCH_API_BASE_URL;
  if (!mcpAudience || !perchApiBaseUrl) return;

  // The audience(s) requested in this authorize transaction. Check both the
  // raw query param and the resolved resource server; normalize to an array.
  const requested = []
    .concat(event.request && event.request.query && event.request.query.audience ? event.request.query.audience : [])
    .concat(event.resource_server && event.resource_server.identifier ? event.resource_server.identifier : []);
  if (!requested.includes(mcpAudience)) return;

  const integrations = await loadAttributionMap(perchApiBaseUrl);
  if (!integrations || integrations.length === 0) return; // no map → attribute nothing

  const slug = slugForClientName(integrations, event.client && event.client.name);
  if (!slug) return; // unrecognised assistant → no claim; perch-api attributes nothing

  api.accessToken.setCustomClaim(`${mcpAudience}/integration`, slug);
};
