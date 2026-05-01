/**
 * Thin HTTP client for perch-api. Reads PERCH_API_URL and PERCH_API_TOKEN
 * once at startup; surfaces clear errors when either is missing or when
 * the API rejects the credential.
 */

const DEFAULT_BASE_URL = 'https://api.perch.app';

class PerchApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'PerchApiError';
  }
}

function readConfig(): { baseUrl: string; token: string } {
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
  const baseUrl = (process.env.PERCH_API_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return { baseUrl, token };
}

export class PerchClient {
  constructor(private readonly config = readConfig()) {}

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(this.config.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/json',
        'User-Agent': 'perch-mcp-server/0.1.0',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      let parsed: { error?: string; code?: string; message?: string } | null = null;
      try { parsed = JSON.parse(body); } catch { /* non-JSON body */ }

      // Translate the auth-layer error codes our middleware produces into
      // actionable messages — the LLM and the user benefit from specifics.
      if (res.status === 401) {
        const code = parsed?.code;
        if (code === 'TOKEN_REVOKED') {
          throw new PerchApiError(401, code, 'Your Perch token has been revoked. Issue a new one from Perch settings.');
        }
        if (code === 'TOKEN_EXPIRED') {
          throw new PerchApiError(401, code, 'Your Perch token has expired. Issue a new one from Perch settings.');
        }
        if (code === 'INVALID_TOKEN') {
          throw new PerchApiError(401, code, 'Your Perch token was rejected as invalid. Verify PERCH_API_TOKEN matches a real, active token.');
        }
      }
      if (res.status === 403 && parsed?.code === 'INSUFFICIENT_SCOPE') {
        throw new PerchApiError(403, parsed.code, `Token is missing the scope required for ${path}. Re-issue with broader scopes.`);
      }

      throw new PerchApiError(
        res.status,
        parsed?.code,
        parsed?.message || parsed?.error || `Perch API ${res.status} on ${path}`,
      );
    }

    return (await res.json()) as T;
  }
}

export const perchClient = new PerchClient();
export { PerchApiError };
