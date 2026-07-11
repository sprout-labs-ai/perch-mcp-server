# Perch MCP Server

Model Context Protocol server for [Perch](https://perch.app). Connects Perch to any MCP-compatible AI client (Claude Desktop, Claude Code, Cursor, Zed, ChatGPT) so you can ask about your accounts, recurring payments, and forecast in natural language.

## Status

**v0.3 (current):** five read-only tools + two transports.

| Tool | Description |
|---|---|
| `list_accounts` | Your Perch accounts with current balances |
| `list_recurring_series` | The recurring payments and income on a given account (templates) |
| `list_scheduled_items` | Materialized upcoming items on an account, with concrete dates and override-aware amounts |
| `get_forecast_curve` | Server-computed running balance projection over a window — chart-ready time series |
| `simulate_forecast` | What-if: re-run the projection with hypothetical items merged in (read-only, never persisted) |

Plus five **admin (machine-to-machine)** tools — registered only when M2M credentials are configured (see [Admin tools](#admin-tools-machine-to-machine)):

| Tool | Scope required |
|---|---|
| `admin_get_user` | `users:read` |
| `admin_list_users` | `users:read` |
| `admin_get_user_activity` | `users:read` |
| `admin_get_brand_exposures` | `brand_exposures:read` |
| `admin_get_suppressed_suggestions` | `suppressed_suggestions:read` |

| Transport | Auth | Use when |
|---|---|---|
| **stdio** (default) | PAT (`PERCH_API_TOKEN` env) | Local install via Claude Desktop / Cursor / Zed / Claude Code |
| **HTTP** (`--http`) | Auth0 OAuth 2.1 (Bearer) | Hosting at `mcp.theperch.app` for ChatGPT and any remote-only MCP client |

## Install

### Claude Desktop

Add to your `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "perch": {
      "command": "npx",
      "args": ["-y", "@perch/mcp-server"],
      "env": {
        "PERCH_API_TOKEN": "pat_…",
        "PERCH_API_URL": "https://api.perch.app"
      }
    }
  }
}
```

Restart Claude Desktop. Ask "what are my Perch accounts?" to test.

### Claude Code, Cursor, Zed

Same configuration shape; consult your client's MCP setup docs for where to put it.

## Authentication

Generate a Personal Access Token from Perch's settings page (or via the `POST /api/v1/tokens` endpoint). Tokens are scoped — request `read` only for this integration. The plaintext token is shown once; paste it into `PERCH_API_TOKEN` above.

PATs cannot perform admin actions and cannot create or revoke other tokens.

## Admin tools (machine-to-machine)

> **Design + how to add a scope:** see the cross-repo handoff doc in perch-api —
> [`docs/api-handoff-m2m-mcp-admin-auth.md`](https://github.com/sprout-labs-ai/perch-api/blob/staging/docs/api-handoff-m2m-mcp-admin-auth.md)
> (As-built + "Adding a scope" recipe). That's the source of truth for the whole M2M system.

The five `admin_*` tools authenticate against perch-api with a **server-side
client credential**, not the calling user's identity. They are intended for a
dedicated operator instance (e.g. Claude Code on a maintainer's machine), never
the multi-tenant HTTP deployment.

They are **only registered when both `PERCH_MCP_CLIENT_ID` and
`PERCH_MCP_CLIENT_SECRET` are set in the environment.** With those unset (the
default, and how the hosted HTTP server runs) the admin tools don't exist —
there's no way to reach an admin endpoint with a regular user token.

Mint a client in the Perch admin portal under **System → MCP clients**, grant it
the narrowest scopes it needs (all read-only in v1), and copy the secret once.
Then configure a stdio instance:

```jsonc
{
  "mcpServers": {
    "perch-admin": {
      "command": "npx",
      "args": ["perch-mcp-server"],
      "env": {
        "PERCH_API_URL": "https://api.perch.app",
        "PERCH_MCP_CLIENT_ID": "mcp_…",
        "PERCH_MCP_CLIENT_SECRET": "…"
      }
    }
  }
}
```

Under the hood the server exchanges those credentials for a short-lived
(5-minute) bearer token via the OAuth `client_credentials` grant at
`POST /api/v1/oauth/token`, caches it in memory, refreshes ~30s before expiry,
and force-refreshes + retries once on a 401. A revoked client stops working
immediately — perch-api re-checks the client row on every request.

## Consumer Integrations (Settings → Integrations)

The Perch iOS app's **Integrations** area — connect/disconnect assistants like
ChatGPT and Claude, view their permissions, see an access activity log, and set
privacy controls — is driven by *this* OAuth 2.1 + resource-scope flow.
"Connect an assistant" is an Auth0 authorization-code grant for the
`mcp.theperch.app` resource; the granted scopes become the permissions a person
sees.

> **Design + cross-repo contract:** see
> [`docs/handoff-consumer-integrations.md`](docs/handoff-consumer-integrations.md)
> — connection identity (the `azp → integration` join), the connect handoff,
> the scope↔permission mapping, activity emission, and privacy enforcement,
> including what must be resolved jointly with perch-api.

What lives here:

| Concern | Module |
|---|---|
| Scope ↔ consumer-permission mapping | [`src/auth/permissions.ts`](src/auth/permissions.ts) |
| Per-tool access-activity emission | [`src/activity/`](src/activity) |
| Privacy-control error surfacing | [`src/api/client.ts`](src/api/client.ts) |

The mapping between the technical scopes and the calm permission keys the UI
shows:

| Consumer permission | MCP scope | Status |
|---|---|---|
| `current_balance` | `read:accounts` | live |
| `upcoming_items` | `read:schedule` | live |
| `activity_history` | `read:series` | live |
| `forecast` | `read:forecast` | live |
| `suggestions` | — | not yet available |
| `changes` | — | not yet available (write) |

Every successful tool call from a connected assistant emits one calm, PII-free
activity entry (a fixed summary + permission key — never arguments, amounts,
dates, IDs, or transport detail) to perch-api, which surfaces it in the app's
activity log. Account-wide privacy controls (`allow_integrations`,
`require_approval_for_changes`) are enforced by perch-api; this server
translates their refusals into calm, consumer-safe guidance.

## Privacy

This server reads from Perch's API on your behalf. It does not:

- Write or modify any data (strictly read-only — both user and admin tools)
- Send data anywhere other than your AI client

The user-scoped tools use your own token and can only see your own data. The
`admin_*` tools are gated behind a separately-provisioned M2M credential and are
absent unless you explicitly configure one (see [Admin tools](#admin-tools-machine-to-machine)).

The AI client (Claude/ChatGPT/etc.) processes the responses according to its own data policy.

## HTTP transport (Hydra OAuth)

For remote hosting (e.g., `https://mcp.theperch.app` for ChatGPT
compatibility) the server runs in HTTP mode and accepts Hydra-issued
access tokens audience'd to the MCP server.

```bash
HYDRA_ISSUER=https://mcp-auth.theperch.app \
MCP_AUDIENCE=https://mcp.theperch.app \
PERCH_MCP_PUBLIC_URL=https://mcp.theperch.app \
PERCH_API_URL=https://api.perch.app \
PORT=3001 \
node dist/index.js --http
```

Endpoints exposed:

| Path | Auth | What |
|---|---|---|
| `GET /health` | none | Liveness probe |
| `GET /.well-known/oauth-protected-resource` | none | RFC 9728 metadata pointing MCP clients at the Hydra issuer |
| `POST /mcp` | Bearer (Hydra JWT for the MCP audience) | MCP JSON-RPC endpoint, stateless |

When a request arrives without a valid token, the server emits the
spec-compliant `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"`
header so MCP clients can discover the auth server and start the OAuth
flow.

Inbound JWTs are forwarded verbatim to perch-api as the `Authorization`
header — perch-api accepts the same audience via its `MCP_AUDIENCE`
configuration. No token exchange round-trip per request.

## Local development

```bash
git clone https://github.com/sprout-labs-ai/perch-mcp-server.git
cd perch-mcp-server
npm install

# stdio mode (default), against a local perch-api
PERCH_API_URL=http://localhost:3000 PERCH_API_TOKEN=pat_… npm run dev

# HTTP mode, also against a local perch-api
HYDRA_ISSUER=… MCP_AUDIENCE=https://mcp.theperch.app \
  PORT=3401 PERCH_API_URL=http://localhost:3000 \
  npm run dev -- --http
```

Point Claude Desktop at the dev build (stdio mode) by replacing the
`command`/`args` above with:

```json
"command": "node",
"args": ["/absolute/path/to/perch-mcp-server/dist/index.js"]
```

## License

MIT.
