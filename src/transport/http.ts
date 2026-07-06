/**
 * HTTP transport — for hosting the MCP server at a URL like
 * https://mcp.theperch.app, accessible by ChatGPT and other remote-only
 * MCP clients.
 *
 * Wires together:
 *   - `createMcpExpressApp` (DNS-rebinding protection on localhost binds)
 *   - `requireBearerAuth(verifier=Auth0Verifier)` — validates inbound
 *     Auth0 access tokens and attaches AuthInfo to req.auth
 *   - `StreamableHTTPServerTransport` in stateless mode — each POST is
 *     a complete JSON-RPC exchange, no session bookkeeping
 *   - `/.well-known/oauth-protected-resource` (RFC 9728 PRM) — tells
 *     MCP clients where to authenticate (i.e., our Auth0 tenant)
 *
 * Stateless construction means a fresh McpServer + transport per POST.
 * That's fine — `buildServer` is cheap and tools are stateless. If we
 * later need streaming (long tool calls, prompts, etc.), revisit
 * stateful mode.
 */

import express, { type Request, type Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { Auth0Verifier } from '../auth/auth0Verifier.js';
import { buildServer } from '../server.js';
import { MCP_RESOURCE_SCOPES } from '../auth/scopes.js';

export interface StartHttpOptions {
  port: number;
  host: string;
  /** Public-facing URL of this MCP server, e.g. `https://mcp.theperch.app`. */
  publicUrl: string;
  /** Auth0 tenant domain, e.g. `perch.us.auth0.com`. */
  auth0Domain: string;
  /** API identifier registered in Auth0 for this MCP server. */
  audience: string;
  /** Allowed Host header values when binding non-loopback. */
  allowedHosts?: string[];
}

export async function startHttp(opts: StartHttpOptions): Promise<void> {
  const verifier = new Auth0Verifier({
    domain: opts.auth0Domain,
    audience: opts.audience,
  });

  const app = createMcpExpressApp({
    host: opts.host,
    allowedHosts: opts.allowedHosts,
  });
  app.use(express.json({ limit: '1mb' }));

  // ── Authorization Server Metadata (RFC 8414) — DCR discovery shim ─────
  // Ory Hydra (our OAuth AS) does NOT advertise `registration_endpoint` in
  // its discovery doc and serves no /.well-known/oauth-authorization-server,
  // so MCP clients (Claude) can't discover Dynamic Client Registration and
  // hang at "checking connection". We bridge that here: publish AS metadata
  // whose `issuer` is our own public URL (self-consistent per RFC 8414) but
  // whose endpoints — crucially including the DCR `registration_endpoint` —
  // point at Hydra. The PRM below therefore lists THIS server as the
  // authorization server, so the client fetches this patched metadata.
  //
  // Token verification is unchanged: the verifier still requires `iss` =
  // Hydra, and the resource server (this process) validates the token. The
  // client only *follows* the advertised endpoints; it never mints tokens.
  const issuer = opts.publicUrl.replace(/\/+$/, '');
  const hydra = `https://${opts.auth0Domain}`; // auth0Domain holds Hydra's domain post-cutover
  const asMetadata = {
    issuer,
    authorization_endpoint: `${hydra}/oauth2/auth`,
    token_endpoint: `${hydra}/oauth2/token`,
    registration_endpoint: `${hydra}/oauth2/register`,
    jwks_uri: `${hydra}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: ['openid', 'offline_access', ...MCP_RESOURCE_SCOPES],
  };
  // Served at both well-known paths so clients probing either RFC 8414
  // (oauth-authorization-server) or OIDC discovery (openid-configuration)
  // find the endpoints + registration_endpoint.
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(asMetadata));
  app.get('/.well-known/openid-configuration', (_req, res) => res.json(asMetadata));

  // ── Protected Resource Metadata (RFC 9728) ───────────────────────────
  // MCP clients fetch this to discover the OAuth authorization server.
  // No auth required — by spec this endpoint must be publicly reachable.
  // `authorization_servers` points at THIS server (see the shim above), not
  // Hydra directly, so the client gets metadata that advertises DCR.
  const prmPath = '/.well-known/oauth-protected-resource';
  app.get(prmPath, (_req, res) => {
    res.json({
      resource: opts.audience,
      authorization_servers: [issuer],
      // Granular, per-resource read scopes — these are the scopes enforced
      // per-tool by perch-api (requireResourceScope). Advertising them lets a
      // client request only the subset it needs (least privilege); a token
      // must carry the scope for a tool's resource or perch-api returns 403
      // INSUFFICIENT_SCOPE. The tools are read-only, so no `write` scope.
      scopes_supported: MCP_RESOURCE_SCOPES,
      bearer_methods_supported: ['header'],
    });
  });

  // ── Health probe ─────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── MCP endpoint ─────────────────────────────────────────────────────
  // Bearer auth runs first; on 401 the SDK middleware writes a
  // WWW-Authenticate header pointing at our PRM URL so MCP clients can
  // discover the auth server and start the OAuth flow.
  const resourceMetadataUrl = `${opts.publicUrl.replace(/\/+$/, '')}${prmPath}`;
  const bearer = requireBearerAuth({ verifier, resourceMetadataUrl });

  app.post('/mcp', bearer, async (req: Request, res: Response) => {
    try {
      // Stateless construction per request. The JSON-RPC body is on
      // req.body (express.json() parsed it). The transport handles
      // both single requests and batched.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close().catch(() => { /* swallow */ });
        server.close().catch(() => { /* swallow */ });
      });
    } catch (err) {
      console.error('[perch-mcp-server-http] /mcp handler error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET /mcp and DELETE /mcp are required by the MCP HTTP transport
  // spec — return Method Not Allowed in stateless mode where they have
  // no session to act on.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode' },
      id: null,
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  await new Promise<void>((resolve) => {
    app.listen(opts.port, opts.host, () => {
      console.error(
        `[perch-mcp-server-http] listening on http://${opts.host}:${opts.port}\n` +
        `  resource:        ${opts.audience}\n` +
        `  authz server:    https://${opts.auth0Domain}/\n` +
        `  PRM:             ${resourceMetadataUrl}\n` +
        `  MCP endpoint:    POST /mcp (Auth0 Bearer required)`,
      );
      resolve();
    });
  });
}
