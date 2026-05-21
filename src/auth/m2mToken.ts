/**
 * Machine-to-machine token provider.
 *
 * The admin tools authenticate against perch-api with a server-side
 * credential pair (PERCH_MCP_CLIENT_ID / PERCH_MCP_CLIENT_SECRET), NOT
 * the per-request user identity used by the user-scoped tools. This
 * module exchanges those credentials for a short-lived bearer token via
 * the OAuth client_credentials grant and caches it in memory.
 *
 * perch-api issues HS256 JWTs with a 5-minute TTL (see
 * src/routes/oauth.ts there). We refresh 30s before expiry so a token is
 * never used right as it lapses, and we collapse concurrent refreshes
 * into a single in-flight request so a burst of tool calls doesn't fan
 * out into N token exchanges.
 */

const DEFAULT_BASE_URL = 'https://api.perch.app';
const USER_AGENT = 'perch-mcp-server/0.3.0';
const REFRESH_SKEW_MS = 30_000; // refresh this long before the token expires

export class M2MAuthError extends Error {
  constructor(
    public readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'M2MAuthError';
  }
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface CachedToken {
  token: string;
  /** epoch ms at which we should stop handing this token out */
  refreshAfter: number;
}

export class M2MTokenProvider {
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly config: {
      baseUrl: string;
      clientId: string;
      clientSecret: string;
    },
  ) {}

  /** Returns a valid bearer token, refreshing if the cache is empty or near expiry. */
  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && now < this.cached.refreshAfter) {
      return this.cached.token;
    }
    return this.refresh();
  }

  /**
   * Force a new token exchange regardless of cache state. Call this after
   * a 401 from perch-api — the token may have been invalidated early
   * (e.g. the client was revoked, or M2M_JWT_SECRET rotated).
   */
  async refresh(): Promise<string> {
    // Collapse concurrent refreshes into one network request.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.exchange()
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async exchange(): Promise<string> {
    const url = new URL(this.config.baseUrl + '/api/v1/oauth/token');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      });
    } catch (err) {
      throw new M2MAuthError(undefined, `Could not reach perch-api token endpoint: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const text = await res.text();
      let parsed: { error?: string; error_description?: string } | null = null;
      try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
      const detail = parsed?.error_description || parsed?.error || `HTTP ${res.status}`;
      if (res.status === 401) {
        throw new M2MAuthError(401, `perch-api rejected the MCP client credentials (${detail}). Check PERCH_MCP_CLIENT_ID / PERCH_MCP_CLIENT_SECRET, and that the client isn't revoked.`);
      }
      if (res.status === 503) {
        throw new M2MAuthError(503, `perch-api M2M auth is not configured (${detail}). The server is missing M2M_JWT_SECRET.`);
      }
      throw new M2MAuthError(res.status, `Token exchange failed: ${detail}`);
    }

    const data = (await res.json()) as TokenResponse;
    if (!data.access_token || typeof data.expires_in !== 'number') {
      throw new M2MAuthError(res.status, 'Token endpoint returned an unexpected response shape.');
    }

    const ttlMs = data.expires_in * 1000;
    // Guard against a TTL shorter than our skew — never compute a
    // refreshAfter in the past, which would force a refresh on every call.
    const refreshAfter = Date.now() + Math.max(ttlMs - REFRESH_SKEW_MS, ttlMs / 2);
    this.cached = { token: data.access_token, refreshAfter };
    return data.access_token;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Env-backed singleton

function resolveBaseUrl(): string {
  return (process.env.PERCH_API_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

let providerCache: M2MTokenProvider | null = null;

/** True when both M2M credentials are present in the environment. */
export function isM2MConfigured(): boolean {
  return Boolean(process.env.PERCH_MCP_CLIENT_ID?.trim() && process.env.PERCH_MCP_CLIENT_SECRET?.trim());
}

/**
 * The process-wide M2M provider. Throws if the credentials are not
 * configured — callers that might run without admin creds should gate on
 * `isM2MConfigured()` first (the admin tools are only registered when it
 * returns true, so in practice this never throws at tool-call time).
 */
export function getM2MProvider(): M2MTokenProvider {
  if (providerCache) return providerCache;
  const clientId = process.env.PERCH_MCP_CLIENT_ID?.trim();
  const clientSecret = process.env.PERCH_MCP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      'PERCH_MCP_CLIENT_ID and PERCH_MCP_CLIENT_SECRET must be set to use the admin (M2M) tools. ' +
        'Mint a client in the Perch admin portal under System → MCP clients.',
    );
  }
  providerCache = new M2MTokenProvider({ baseUrl: resolveBaseUrl(), clientId, clientSecret });
  return providerCache;
}

/** Test seam — drop the cached provider so a fresh env is picked up. */
export function __resetM2MProviderForTests(): void {
  providerCache = null;
}
