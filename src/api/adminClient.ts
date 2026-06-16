/**
 * Admin HTTP client for perch-api's M2M-gated endpoints.
 *
 * Unlike `PerchClient` (which carries a static per-request user token),
 * this client pulls a server-side M2M token from `M2MTokenProvider` on
 * every call and transparently refreshes + retries once on a 401 — the
 * 5-minute token may have lapsed or been invalidated between calls.
 *
 * Only the read-only admin endpoints are reachable; the granted scopes
 * are fixed at client-mint time in the Perch admin portal, so a tool
 * calling an endpoint outside its scope surfaces a 403 the LLM can relay.
 */

import { PerchApiError } from './client.js';
import { getM2MProvider, M2MTokenProvider } from '../auth/m2mToken.js';

const DEFAULT_BASE_URL = 'https://api.perch.app';
const USER_AGENT = 'perch-mcp-server/0.3.0';

function resolveBaseUrl(): string {
  return (process.env.PERCH_API_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export class AdminClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: M2MTokenProvider,
  ) {}

  async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    // First attempt with the cached token; on 401, force a refresh and
    // retry exactly once. A second 401 is a real auth failure (revoked
    // client, rotated secret) — surface it.
    let res = await this.fetchWith(url, await this.tokens.getToken());
    if (res.status === 401) {
      res = await this.fetchWith(url, await this.tokens.refresh());
    }

    if (!res.ok) {
      const text = await res.text();
      let parsed: { error?: string; code?: string; message?: string; required?: string } | null = null;
      try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }

      if (res.status === 401) {
        throw new PerchApiError(401, parsed?.code, 'perch-api rejected the MCP client token even after refresh. The client may be revoked — check System → MCP clients in the Perch admin portal.');
      }
      if (res.status === 403 && parsed?.code === 'INSUFFICIENT_SCOPE') {
        throw new PerchApiError(403, parsed.code, `This MCP client is missing the "${parsed.required ?? '?'}" scope required for ${url.pathname}. Grant it in the Perch admin portal or mint a new client.`);
      }
      throw new PerchApiError(
        res.status,
        parsed?.code,
        parsed?.message || parsed?.error || `Perch API ${res.status} on ${url.pathname}`,
      );
    }

    return (await res.json()) as T;
  }

  private fetchWith(url: URL, token: string): Promise<Response> {
    return fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'X-Forwarded-By': USER_AGENT,
      },
    });
  }
}

let adminClientCache: AdminClient | null = null;

/**
 * Process-wide admin client. Gated on M2M credentials being configured
 * (the admin tools are only registered when they are), so this is safe to
 * call from a registered admin tool handler.
 */
export function getAdminClient(): AdminClient {
  if (adminClientCache) return adminClientCache;
  adminClientCache = new AdminClient(resolveBaseUrl(), getM2MProvider());
  return adminClientCache;
}

/** Test seam — drop the cached client so a fresh env/provider is picked up. */
export function __resetAdminClientForTests(): void {
  adminClientCache = null;
}
