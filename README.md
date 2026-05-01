# Perch MCP Server

Model Context Protocol server for [Perch](https://perch.app). Connects Perch to any MCP-compatible AI client (Claude Desktop, Claude Code, Cursor, Zed, ChatGPT) so you can ask about your accounts, recurring payments, and forecast in natural language.

## Status

**Phase 1.7 (current):** local stdio transport, PAT authentication, two read-only tools.

| Tool | Description |
|---|---|
| `list_accounts` | Your Perch accounts with current balances |
| `list_recurring_series` | The recurring payments and income on a given account |

More tools (`list_scheduled_items`, `get_forecast_curve`, `simulate_forecast`) ship in Phase 2.0 once the supporting perch-api endpoints land.

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

## Privacy

This server reads from Perch's API on your behalf. It does not:

- Write or modify any data (Phase 1.7 is strictly read-only)
- Access admin endpoints (server-side guard prevents this regardless of token)
- Send data anywhere other than your AI client

The AI client (Claude/ChatGPT/etc.) processes the responses according to its own data policy.

## Local development

```bash
git clone https://github.com/sprout-labs-ai/perch-mcp-server.git
cd perch-mcp-server
npm install
PERCH_API_URL=http://localhost:3000 PERCH_API_TOKEN=pat_… npm run dev
```

Point Claude Desktop at the dev server by replacing the `command`/`args` above with:

```json
"command": "node",
"args": ["/absolute/path/to/perch-mcp-server/dist/index.js"]
```

## License

MIT.
