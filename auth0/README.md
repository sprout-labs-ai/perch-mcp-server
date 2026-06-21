# Auth0 configuration for the Perch MCP server

Per-tenant Auth0 setup so assistants (ChatGPT / Claude) can connect to the Perch
MCP server via Dynamic Client Registration, **including passwordless-email
users**, and so perch-api can attribute their activity. **Verified end-to-end on
`perch-dev` (2026-06-19)** with a real passwordless user; replicate on
`perch-staging` and `perch-production`.

> ⚠️ These are identity-infra writes on a shared tenant. Partial `tenants/settings`
> PATCHes are destructive (one wiped `universal_login`, dropping `identifier_first`
> + theme). Run them deliberately, ideally one at a time, and re-check after each.

MCP resource identifiers (audiences): dev `https://mcp-dev.theperch.app`,
staging `https://mcp-staging.theperch.app`, prod `https://mcp.theperch.app`.

## 1. Enable Dynamic Client Registration
```bash
auth0 api patch "tenants/settings" --data '{"flags":{"enable_dynamic_client_registration":true}}'
```
(Auth0 merges `flags` — send only this key; don't resend the whole object.)
Strict DCR mode (`dynamic_client_registration_security_mode:"strict"`) did **not**
persist on perch-dev and proved unnecessary — the 4 scopes survive without it.

## 2. Let DCR'd third-party clients get user MCP tokens
**Dashboard → Applications → APIs → "Perch MCP" → Settings → "Default Permissions
for Third-Party Applications" → Authorized for User-Delegated Access → check
`read:accounts`, `read:series`, `read:schedule`, `read:forecast` → Save.**

This is THE lever — it issues a client grant so DCR clients can request these
scopes. It is **not** stored on the resource-server object (so it won't show in
`auth0 api get resource-servers/<id>`). Setting the resource server's
`subject_type_authorization.user.policy=allow_all` is neither sufficient nor the
real mechanism.

## 3. Passwordless-email login for assistants  ← the non-obvious part
Third-party (DCR) clients can only use **domain** connections. To let
passwordless-email users authenticate through an assistant:
- Promote the passwordless **`email`** connection to a domain connection:
  ```bash
  auth0 api patch "connections/<email-conn-id>" --data '{"is_domain_connection":true}'
  ```
- **Do NOT make the database (`Username-Password-Authentication`) connection a
  domain connection.** A domain DB connection forces the identifier-first flow to
  a PASSWORD prompt and blocks passwordless — and it leaks into first-party apps,
  breaking their login too.
- Leave social (`google`, `apple`) off-domain unless you want them offered to
  assistants (they out-render passwordless when domain-level).

Verified working dev state: **only `email` is a domain connection.**
Also ensure identifier-first is on: `auth0 api patch "prompts" --data '{"identifier_first":true}'`.

## 4. Attribution Action
`mcp-integration-attribution.action.js` maps the connecting client's name →
integration slug and stamps the `<mcp-audience>/integration` claim perch-api reads.

The name→slug map is **registry-driven**: the Action fetches it from perch-api's
public catalog (`GET <PERCH_API_BASE_URL>/api/v1/integrations/attribution-map`,
derived from the admin-managed `integrations` table). So **onboarding a new
assistant needs NO change to this Action** — add it in perch-admin (System →
Assistants) and fill its client-name patterns there. The Action only changes if
the matching logic itself does.

```bash
auth0 actions create --name "MCP Integration Attribution" --trigger post-login \
  --code "$(cat auth0/mcp-integration-attribution.action.js)" \
  --secret "MCP_AUDIENCE=https://mcp-dev.theperch.app" \      # per tenant
  --secret "PERCH_API_BASE_URL=https://api-dev.theperch.app"  # per tenant, perch-api origin
auth0 actions deploy <action-id>
```
Both secrets are required; with either unset the Action no-ops. The map is cached
in the warm Action container (5-min TTL) and served stale on a fetch error, so a
perch-api blip never breaks login — it just reuses the last good map.

**Then BIND it to the post-login flow** — Dashboard → Actions → Triggers →
post-login → drag it in → Apply. Deploying alone does nothing; an unbound action
silently no-ops (the `integration` claim comes back `undefined`).

## Verify
Register a test client (`POST https://<tenant-domain>/oidc/register`, open) named
like "ChatGPT", then run `scripts/verify-mcp-oauth.mjs --client-id <id>` and
confirm the token has the 4 scopes + `integration: chatgpt`.

## Reverting
- Connections: set `is_domain_connection:false`.
- DCR: `flags.enable_dynamic_client_registration:false`.
- Action: remove it from the post-login binding.
