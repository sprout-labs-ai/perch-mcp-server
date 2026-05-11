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

  // ── Protected Resource Metadata (RFC 9728) ───────────────────────────
  // MCP clients fetch this to discover the OAuth authorization server.
  // No auth required — by spec this endpoint must be publicly reachable.
  const prmPath = '/.well-known/oauth-protected-resource';
  app.get(prmPath, (_req, res) => {
    res.json({
      resource: opts.audience,
      authorization_servers: [`https://${opts.auth0Domain}/`],
      scopes_supported: ['read', 'write'],
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
