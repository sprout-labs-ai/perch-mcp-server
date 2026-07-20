/**
 * HTTP client for perch-api.
 *
 * Used by every tool to call the upstream API. Two construction paths:
 *
 *   - **stdio mode** — token comes from the `PERCH_API_TOKEN` env var
 *     and is read once at first use. Lazy + cached so tests can import
 *     this module without an env var present.
 *   - **HTTP mode** — token comes per-request from the validated Hydra
 *     access token (`extra.authInfo.token`). A fresh client is built
 *     for each tool invocation.
 *
 * Tool handlers should call `clientFor(extra)`; it picks the right path.
 */

const DEFAULT_BASE_URL = 'https://api.perch.app';
const USER_AGENT = 'perch-mcp-server/0.3.0';

export class PerchApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'PerchApiError';
  }
}

interface PerchClientConfig {
  baseUrl: string;
  token: string;
}

export class PerchClient {
  constructor(private readonly config: PerchClientConfig) {}

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(this.config.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return this.request<T>('GET', url, undefined);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(this.config.baseUrl + path);
    return this.request<T>('POST', url, body);
  }

  private async request<T>(method: 'GET' | 'POST', url: URL, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        // Attribution header — perch-api logs this so requests via the
        // MCP server are distinguishable from direct mobile/web app use.
        // Never used as an authorization signal by perch-api.
        'X-Forwarded-By': USER_AGENT,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      let parsed: { error?: string; code?: string; message?: string } | null = null;
      try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }

      // Translate perch-api's auth-layer error codes into actionable
      // messages — the LLM and the user benefit from specifics.
      if (res.status === 401) {
        const code = parsed?.code;
        if (code === 'TOKEN_REVOKED') {
          throw new PerchApiError(401, code, 'Your Perch token has been revoked. Issue a new one from Perch settings.');
        }
        if (code === 'TOKEN_EXPIRED') {
          throw new PerchApiError(401, code, 'Your Perch token has expired. Issue a new one from Perch settings.');
        }
        if (code === 'INVALID_TOKEN') {
          throw new PerchApiError(401, code, 'Your Perch token was rejected as invalid. Verify the token is real and active.');
        }
      }
      if (res.status === 403 && parsed?.code === 'INSUFFICIENT_SCOPE') {
        throw new PerchApiError(403, parsed.code, `Token is missing the scope required for ${url.pathname}.`);
      }
      // Privacy-control + per-connection enforcement (perch-api, MCP-audienced
      // requests — see perch-api middleware/integrationPermission.ts for the
      // precedence order):
      //   - INTEGRATIONS_DISABLED — the account's `allow_integrations` control
      //     is off (a PAUSE); perch-api refuses all assistant access until
      //     re-enabled, with connections and permissions kept intact.
      //   - INTEGRATION_NOT_CONNECTED — the user disconnected this assistant
      //     in Settings; perch-api refuses its requests until reconnected.
      //   - PERMISSION_DISABLED — the specific per-assistant permission backing
      //     this request is toggled off.
      //   - APPROVAL_REQUIRED — a write/"changes" tool is gated by the
      //     `require_approval_for_changes` control and needs in-app approval.
      // Surface calm, consumer-safe guidance (no MCP/transport detail).
      if (res.status === 403 && parsed?.code === 'INTEGRATIONS_DISABLED') {
        throw new PerchApiError(
          403,
          parsed.code,
          'Integrations are turned off for this Perch account. The account owner can turn them back on in the Perch app under Settings → Integrations → Privacy.',
        );
      }
      if (res.status === 403 && parsed?.code === 'INTEGRATION_NOT_CONNECTED') {
        throw new PerchApiError(
          403,
          parsed.code,
          'This assistant is disconnected from the Perch account. Reconnect it in the Perch app under Settings → Integrations, then try again.',
        );
      }
      if (res.status === 403 && parsed?.code === 'PERMISSION_DISABLED') {
        throw new PerchApiError(
          403,
          parsed.code,
          'That information is turned off for this assistant. The account owner can allow it in the Perch app under Settings → Integrations.',
        );
      }
      if (res.status === 403 && parsed?.code === 'APPROVAL_REQUIRED') {
        throw new PerchApiError(
          403,
          parsed.code,
          'This change needs approval in the Perch app before an assistant can make it. Approve it under Settings → Integrations, then try again.',
        );
      }

      throw new PerchApiError(
        res.status,
        parsed?.code,
        parsed?.message || parsed?.error || `Perch API ${res.status} on ${url.pathname}`,
      );
    }

    return (await res.json()) as T;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Token resolution: stdio (env, cached) vs HTTP (per-request via authInfo)

function resolveBaseUrl(): string {
  return (process.env.PERCH_API_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

let stdioClientCache: PerchClient | null = null;
function getStdioClient(): PerchClient {
  if (stdioClientCache) return stdioClientCache;
  const token = process.env.PERCH_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'PERCH_API_TOKEN is not set. Generate a Personal Access Token from Perch settings ' +
        'and put it in your MCP client config under env.PERCH_API_TOKEN.',
    );
  }
  if (!token.startsWith('pat_')) {
    throw new Error(
      'PERCH_API_TOKEN does not look like a Perch PAT (expected `pat_…` prefix). ' +
        'Re-issue the token from Perch settings.',
    );
  }
  stdioClientCache = new PerchClient({ baseUrl: resolveBaseUrl(), token });
  return stdioClientCache;
}

/**
 * Pick the right PerchClient for the current tool invocation.
 *   - HTTP mode: `extra.authInfo.token` is the validated Hydra JWT,
 *     which perch-api accepts (see middleware/auth.ts checkJwt).
 *   - stdio mode: env-cached PAT.
 *
 * The lazy cache means stdio-mode `import` of this module never throws
 * for missing env — only when `clientFor(...)` is actually called for a
 * stdio request.
 */
export function clientFor(extra?: { authInfo?: { token?: string } }): PerchClient {
  const token = extra?.authInfo?.token;
  if (token) {
    return new PerchClient({ baseUrl: resolveBaseUrl(), token });
  }
  return getStdioClient();
}
