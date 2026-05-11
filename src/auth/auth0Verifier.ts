/**
 * OAuth token verifier backed by Auth0's JWKS.
 *
 * Implements the MCP SDK's `OAuthTokenVerifier` interface. The SDK's
 * `requireBearerAuth` middleware calls `verifyAccessToken(token)` on
 * every incoming request; on success the resulting `AuthInfo` lands at
 * `req.auth` (and propagates to tool handlers via `extra.authInfo`).
 *
 * We deliberately accept ONLY tokens audience'd to the MCP server
 * (`https://mcp.theperch.app`). Tokens for the main API audience are
 * rejected here even though they share the same Auth0 tenant — the MCP
 * server is a distinct resource server per OAuth.
 */

import jwt, { type JwtHeader, type SigningKeyCallback } from 'jsonwebtoken';
import jwksClient, { type JwksClient } from 'jwks-rsa';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export interface Auth0VerifierOptions {
  /** Auth0 tenant domain, e.g. `perch.us.auth0.com`. */
  domain: string;
  /** API identifier registered in Auth0 for the MCP server. */
  audience: string;
}

export class Auth0Verifier implements OAuthTokenVerifier {
  private readonly jwks: JwksClient;
  private readonly issuer: string;

  constructor(private readonly options: Auth0VerifierOptions) {
    if (!options.domain) throw new Error('Auth0Verifier: domain is required');
    if (!options.audience) throw new Error('Auth0Verifier: audience is required');
    this.issuer = `https://${options.domain}/`;
    this.jwks = jwksClient({
      jwksUri: `https://${options.domain}/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 10 * 60 * 1000, // 10 min — JWKS rotation is rare
      rateLimit: true,
      jwksRequestsPerMinute: 5,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let decoded: jwt.JwtPayload;
    try {
      decoded = await new Promise<jwt.JwtPayload>((resolve, reject) => {
        jwt.verify(
          token,
          (header: JwtHeader, callback: SigningKeyCallback) => {
            if (!header.kid) {
              callback(new Error('JWT missing `kid` header'));
              return;
            }
            this.jwks.getSigningKey(header.kid, (err, key) => {
              if (err || !key) {
                callback(err ?? new Error('signing key not found'));
                return;
              }
              callback(null, key.getPublicKey());
            });
          },
          {
            audience: this.options.audience,
            issuer: this.issuer,
            algorithms: ['RS256'],
          },
          (err, payload) => {
            if (err) reject(err);
            else if (!payload || typeof payload === 'string') reject(new Error('JWT payload missing'));
            else resolve(payload);
          },
        );
      });
    } catch (err) {
      // Map any verification failure (bad signature, wrong audience,
      // expired, malformed, missing key, etc.) to InvalidTokenError so
      // the SDK middleware emits a spec-compliant 401 with the
      // WWW-Authenticate header pointing at our PRM URL. Without this
      // wrapping, errors bubble up as 500.
      const reason = err instanceof Error ? err.message : 'token verification failed';
      throw new InvalidTokenError(reason);
    }

    // Standard OAuth `scope` claim: space-separated string. Auth0 puts
    // permissions there when the API is configured with permissions
    // (which we did: `read`, `write`).
    const scopes = typeof decoded.scope === 'string'
      ? decoded.scope.split(' ').filter(Boolean)
      : [];

    return {
      token,
      // `azp` (authorized party) is the OAuth client_id that requested
      // this token. Falls back to `client_id` for compatibility.
      clientId: (decoded.azp as string | undefined)
        ?? (decoded.client_id as string | undefined)
        ?? '',
      scopes,
      expiresAt: decoded.exp,
      // RFC 8707 — encode the audience as the resource URL so the SDK
      // can confirm the token is for THIS server.
      resource: new URL(this.options.audience),
    };
  }
}
