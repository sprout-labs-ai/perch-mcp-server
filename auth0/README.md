# Auth0 configuration for the Perch MCP server

The MCP server relies on three pieces of per-tenant Auth0 config so that
assistants (ChatGPT / Claude) can connect via Dynamic Client Registration and so
perch-api can attribute their activity. Apply per tenant (`perch-dev`,
`perch-staging`, `perch-production`).

MCP resource identifiers (audiences):
- dev: `https://mcp-dev.theperch.app`
- staging: `https://mcp-staging.theperch.app`
- prod: `https://mcp.theperch.app`

## 1. Enable Dynamic Client Registration + strict mode

Strict mode is **required** — in the legacy permissive mode Auth0 silently drops
the API scopes and issues `scope: "openid"` only.

```bash
# Merge into the existing flags (don't replace the whole object).
auth0 api patch "tenants/settings" --data '{"flags":{ ...current flags..., "enable_dynamic_client_registration":true},"dynamic_client_registration_security_mode":"strict"}'
```

## 2. Let DCR'd third-party clients get user MCP tokens

Set the MCP API's user subject policy to `allow_all` (scoped to the MCP audience
only — does not affect normal Perch login). Find the resource-server id with
`auth0 apis list`.

```bash
auth0 api patch "resource-servers/<MCP_API_ID>" \
  --data '{"subject_type_authorization":{"user":{"policy":"allow_all"},"client":{"policy":"require_client_grant"}}}'
```

## 3. Attribution Action

`mcp-integration-attribution.action.js` maps the connecting client's name →
integration slug and stamps the `<mcp-audience>/integration` claim that perch-api
reads. Create, set the per-tenant secret, deploy, and bind to the post-login flow:

```bash
auth0 actions create \
  --name "MCP Integration Attribution" \
  --trigger post-login \
  --code "$(cat auth0/mcp-integration-attribution.action.js)" \
  --secret "MCP_AUDIENCE=https://mcp-dev.theperch.app"   # per tenant

# then deploy + add to the post-login flow (Dashboard → Actions → Flows → Login,
# or via the Management API PATCH /actions/triggers/post-login/bindings).
```

## Reverting

- Resource server: set `user.policy` back to `require_client_grant`.
- Tenant: set `enable_dynamic_client_registration` false (and remove the security
  mode override).
- Action: remove it from the post-login flow binding.
