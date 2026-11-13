/**
 * Shared test harness: a real MCP client talking to `buildServer()` over the
 * SDK's in-memory transport, plus a tiny fetch router that stands in for
 * perch-api.
 *
 * Going through a real `Client` (instead of poking handlers directly) means
 * tests exercise the SDK's input validation, tool dispatch, error wrapping
 * and our activity instrumentation exactly as an MCP host would.
 */

import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (req: RecordedRequest) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Replace global fetch with a router keyed by `"METHOD /path"`. Unmatched
 * requests return 404 so a typo in a tool's path fails loudly. Every request
 * is recorded for assertions.
 */
export function mockPerchApi(routes: Record<string, RouteHandler>) {
  const requests: RecordedRequest[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = init?.body;
    const req: RecordedRequest = {
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
    };
    requests.push(req);
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return json({ error: `no mock for ${method} ${url.pathname}` }, 404);
    return handler(req);
  });
  return { requests, spy };
}

/**
 * Connect an MCP client to `buildServer()`. When `authInfo` is given, every
 * client → server message carries it, which is exactly what the HTTP
 * transport does after bearer auth (it lands on the handler's
 * `extra.authInfo`). Without it, tools take the stdio/PAT path.
 */
export async function connectClient(opts: { authInfo?: AuthInfo } = {}) {
  const { buildServer } = await import('../../src/server.js');
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  if (opts.authInfo) {
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: JSONRPCMessage, options?: { relatedRequestId?: string | number }) =>
      send(message, { ...options, authInfo: opts.authInfo });
  }

  await server.connect(serverTransport);
  const client = new Client({ name: 'perch-test-client', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Parse the single JSON text block every Perch tool returns. */
export function parseToolText(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.find((c) => c.type === 'text')?.text;
  if (text === undefined) throw new Error(`tool result has no text content: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

export const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
export const USER_ID = '22222222-2222-4222-8222-222222222222';
