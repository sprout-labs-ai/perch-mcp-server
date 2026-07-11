# Consumer Integrations — perch-mcp-server ⇄ perch-api handoff

How the **consumer Integrations** feature (Settings → Integrations in
perch-apple: connect/disconnect assistants, view permissions, see an access
activity log, set privacy controls) is wired to the existing **Auth0 OAuth 2.1
+ resource-scope** mechanism the MCP server hosts at `mcp.theperch.app`.

This is the source of truth for the cross-repo contract. The wire shape itself
is owned by the iOS client — `perch-apple/.../IntegrationsDTO.swift` and
`IntegrationLabels.swift`.

> **TL;DR.** "Connect an assistant" *is* an Auth0 OAuth 2.1 authorization-code
> grant for the `mcp.theperch.app` resource. perch-api owns the consumer
> registry, connection state, activity log, and privacy controls (mostly built
> — see `routes/integrations.ts`, migration `045_integrations.sql`).
> perch-mcp-server owns the scope↔permission mapping, per-tool activity
> emission, and privacy-control surfacing. Three pieces of glue remain and are
> **jointly owned** (§7).

---

## 1. Roles & boundaries

| Concern | Lives in | Notes |
|---|---|---|
| Which assistants are connectable, name/icon, default permissions, sort/availability | **perch-api** `integrations` table | Registry. Consumer-safe — never exposes MCP/client detail. |
| Per-user connection status, `connected_at`, `last_used_at` | **perch-api** `user_integration_connections` | |
| Per-connection permission flags (display) | **perch-api** `user_integration_permissions` | Seeded at connect from granted scopes (§3). |
| Access activity log | **perch-api** `user_integration_activity` | Rows written by perch-mcp-server emission (§4) + the connect event. |
| Account-wide privacy controls | **perch-api** `user_integration_privacy_controls` | `allow_integrations`, `require_approval_for_changes`. |
| One-time connect tickets | **perch-api** `user_integration_connect_tokens` | Bound to the user at mint. |
| OAuth clients (client_id/secret, redirect URIs), user grants, token issuance | **Auth0** | Discovered, never stored by us beyond the `azp` join (§2). |
| Scope ↔ permission mapping; calm activity summaries; privacy-error surfacing | **perch-mcp-server** | `src/auth/permissions.ts`, `src/activity/*`, `src/api/client.ts`. |

**Consumer-safe invariant.** Nothing on the consumer path (`/api/v1/integrations*`)
returns MCP server URLs, client ids/secrets, tokens, scopes, or transport
detail. The only URL the client ever sees is the opaque one-time `connectUrl`,
which it opens in a Safari sheet and never renders as text.

---

## 2. Connection identity — the `azp → integration` join  ⚠️ JOINT

Each connected assistant is an **Auth0 OAuth client**. Its access token carries
`azp` (authorized party = the `client_id` that requested the token).
perch-mcp-server's `JwksVerifier` already surfaces this as `authInfo.clientId`,
and forwards the token verbatim to perch-api, which reads `sub` → user.

**The missing link:** perch-api has no way to map `azp` → an `integrations.id`
slug (`chatgpt` / `claude`). The `integrations` table (045) has no client-id
column.

**Decision:** store the mapping in perch-api (it owns the registry + DB).
A connected assistant brand may register more than one OAuth client (prod/dev,
ChatGPT vs ChatGPT-Enterprise), so use an array:

```sql
-- perch-api migration (e.g. 046_integration_oauth_clients.sql)
ALTER TABLE integrations ADD COLUMN auth0_client_ids TEXT[] NOT NULL DEFAULT '{}';
-- backfill once the Auth0 clients exist:
--   UPDATE integrations SET auth0_client_ids = ARRAY['<chatgpt prod client_id>'] WHERE id = 'chatgpt';
--   UPDATE integrations SET auth0_client_ids = ARRAY['<claude prod client_id>']  WHERE id = 'claude';
CREATE INDEX IF NOT EXISTS idx_integrations_auth0_client_ids
  ON integrations USING GIN (auth0_client_ids);
```

perch-api captures `azp` in `getUserFromAuth` for MCP-audienced tokens
(`req.integrationClientId = req.auth.azp`) and resolves it to a slug:

```sql
SELECT id FROM integrations WHERE $1 = ANY(auth0_client_ids) AND is_available LIMIT 1;
```

`azp` is **never** returned to the client — it is an internal join key only.

---

## 3. Connect handoff — the OAuth 2.1 authorize flow

`routes/integrations.ts` already mints a one-time, hashed, short-lived ticket
and returns a `connectUrl` (→ Safari sheet); the consent page POSTs the ticket
to `/:id/connect/complete`, which flips the connection to `connected` and seeds
permission rows. **What that consent page does — the Auth0 handshake — is the
main open follow-up.** Designed end to end:

1. **`POST /api/v1/integrations/:id/connect`** (built). Honors
   `allow_integrations` (403 `integrations_disabled` when off), mints a ticket,
   returns `connectUrl = https://theperch.app/integrations/:id/authorize?ticket=…`.
2. **Hosted consent page** (`theperch.app`, ⚠️ not built). Validates the ticket
   (user-bound), shows the calm permission preview (registry defaults), and on
   "Allow" starts an **Auth0 OAuth 2.1 authorization-code + PKCE** request:
   - `audience = https://mcp.theperch.app`
   - `client_id =` the integration's Auth0 client
   - `scope =` the resource scopes for the integration's default permissions,
     derived via the §5 mapping (`PERMISSION_TO_SCOPE`). e.g. defaults
     `current_balance, upcoming_items, forecast, activity_history` →
     `read:accounts read:schedule read:forecast read:series`.
   - `redirect_uri =` the assistant's own callback (ChatGPT/Claude complete the
     grant on their side; they are the OAuth client).
3. **Auth0** records the user's grant and issues the assistant a token for the
   MCP audience carrying exactly the granted scopes.
4. The consent page calls **`POST /:id/connect/complete`** with the ticket
   (built) → connection `connected`, permission rows seeded.

**Persisting granted scopes → permission rows (⚠️ JOINT refinement).** Today
`/connect/complete` seeds `user_integration_permissions` from the registry
`default_permission_keys`. To make the detail screen reflect *what was actually
granted*, seed from the granted scopes instead, using
`permissionsFromGrantedScopes(grantedScopes)` (§5). The granted scope set comes
from the Auth0 grant (introspect, or read the issued token's `scope`) at
completion. Until that's wired, registry defaults are a faithful approximation
(the consent page requests exactly the default permissions' scopes).

**What's discovered from Auth0 vs stored in perch-api:** Auth0 owns the client
definitions, the user→client grant, and token issuance. perch-api stores only
the *projection* a consumer needs — connection status, the granted permission
keys, timestamps — plus the `azp` join. No secrets or tokens are stored.

---

## 4. Access activity emission

`perch-mcp-server` emits one calm entry per **successful** user-tool call from a
connected assistant. It has no DB, so it POSTs to a perch-api sink.

**This side (built):**
- `src/activity/summaries.ts` — fixed, PII-free sentence + permission key per
  tool. Never interpolated with args/IDs/amounts.
- `src/activity/emit.ts` — `recordToolActivity(extra, toolName)`:
  `POST /api/v1/integrations/activity  { summary, permissionKey }`, forwarding
  the inbound token. HTTP transport only (requires `azp`); best-effort
  (swallows all errors); fire-and-forget (never delays the answer).
- `src/activity/instrument.ts` — wraps `registerTool` so the five user tools
  emit after success. Admin/M2M tools untouched.

**perch-api side (⚠️ NOT built — the sink endpoint):**

```
POST /api/v1/integrations/activity          (MCP-audienced token; user-scoped)
body: { summary: string, permissionKey?: string }
```

Behavior: derive `userId` from `sub`; resolve `azp → integration_id` (§2); if no
mapping, **204 no-op** (don't error a logging call). Otherwise insert one
`user_integration_activity` row `(user_id, integration_id, summary,
permission_key)` and bump `user_integration_connections.last_used_at = NOW()`.
Validate/cap `summary` length; store **only** the provided summary token — never
the request body of the underlying tool. Rate-limit/debounce is optional.

> Why emit from here, not from perch-api request middleware: only the tool layer
> knows the *tool-level* intent and can produce one clean human summary per
> user action. A single tool (e.g. `simulate_forecast`) may make several
> underlying REST calls; middleware would log each path, not the calm action.

---

## 5. Scope ↔ permission mapping

Canonical, in `src/auth/permissions.ts` (mirrored by perch-api):

| Consumer permission | MCP scope | Tool(s) | Status |
|---|---|---|---|
| `current_balance` | `read:accounts` | `list_accounts` | live |
| `upcoming_items` | `read:schedule` | `list_scheduled_items` | live |
| `activity_history` | `read:series` | `list_recurring_series` | live |
| `forecast` | `read:forecast` | `get_forecast_curve`, `simulate_forecast` | live |
| `suggestions` | — (none) | — | **not yet available** |
| `changes` | — (none) | — | **not yet available** (write) |

All four live scopes pair 1:1 with a permission, leaving exactly `suggestions`
and `changes` unbacked. The one non-obvious pairing is **`read:series ↔
activity_history`** (recurring payments/income = the account's ongoing financial
activity) — flagged for joint confirmation before GA.

`permissionsFromGrantedScopes(grantedScopes)` returns the full canonical list
with `enabled` reflecting the grant; unbacked permissions are always
`enabled:false` (perch-api may OR-in registry "coming soon" defaults for those
two before sending to the client).

---

## 6. Privacy-control enforcement

**`allow_integrations` (account kill switch).**
- *Connect* — already enforced in `routes/integrations.ts` (403
  `integrations_disabled`).
- *Per request* (⚠️ JOINT) — perch-api should refuse MCP-audienced requests for
  a user whose control is off, with `403 { code: "INTEGRATIONS_DISABLED" }`
  (middleware on MCP-reachable routes, after `getUserFromAuth`). perch-mcp-server
  already maps that code to calm guidance (`src/api/client.ts`). Toggling it off
  should also mark the user's connections `not_connected` and ideally revoke the
  Auth0 grants so issued tokens stop working (forward-looking).

**`require_approval_for_changes` (gate writes).** All tools are read-only today,
so nothing is gated yet. Forward-looking design: a future write/"changes" tool
declares it mutates; perch-api checks the control and returns `403 { code:
"APPROVAL_REQUIRED" }` until the user approves in-app; perch-mcp-server already
maps that code to calm guidance. The `changes` permission stays not-grantable
until those tools exist.

---

## 7. Open items / jointly owned

1. **`azp → integration` mapping** (§2) — perch-api migration adds
   `integrations.auth0_client_ids`, captures `azp`, resolves the slug. *Blocks
   activity emission and connected-scope display from being assistant-aware.*
2. **Activity sink endpoint** `POST /api/v1/integrations/activity` (§4) —
   perch-api. *This server's emit code already targets it; until it ships,
   emission is a harmless swallowed 404.*
3. **Hosted consent page + granted-scope persistence** (§3) — the Auth0
   authorize handshake and seeding permission rows from the actual grant.
4. **Per-request `allow_integrations` enforcement** + grant revocation on
   toggle-off (§6) — perch-api middleware; client mapping is done here.
5. **`read:series ↔ activity_history`** pairing — confirm or re-map (§5).
6. **Deferred — `suggestions` / `changes` tools.** Both imply tools beyond
   today's five read-only ones (a recommendations reader; write/mutation tools).
   No scopes are invented for them. When `changes` lands it must define a `write`
   scope on the MCP resource server and route through
   `require_approval_for_changes`.

## 8. As-built in perch-mcp-server

- `src/auth/permissions.ts` — mapping + `permissionsFromGrantedScopes`.
- `src/activity/{summaries,emit,instrument}.ts` — emission.
- `src/api/client.ts` — `INTEGRATIONS_DISABLED` / `APPROVAL_REQUIRED` mapping.
- `src/server.ts` — `instrumentToolActivity(server)` wired before tool registration.
- Tests: `tests/permissions.test.ts`, `tests/activity.test.ts`,
  `tests/client-privacy-errors.test.ts`.
