/**
 * Auth0Verifier — JWT validation against a mocked JWKS.
 *
 * Strategy: generate an RSA keypair in-process, mock jwks-rsa to
 * return our public key for any kid, and sign test JWTs with the
 * private key. This exercises the real verification path
 * (jsonwebtoken + audience + issuer + algorithm checks) without
 * hitting the network.
 *
 * The MCP SDK's bearer middleware maps our `InvalidTokenError`
 * throws to spec-compliant 401 responses; tests at the HTTP layer
 * cover that mapping. Here we just verify the verifier itself
 * throws the right class for each failure mode.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateKeyPairSync, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';

const KID = 'test-key-1';
const DOMAIN = 'test.us.auth0.com';
const ISSUER = `https://${DOMAIN}/`;
const AUDIENCE = 'https://mcp.theperch.app';

let privatePem: string;
let publicPem: string;
let privateKey: KeyObject;
let publicKey: KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

// Mock jwks-rsa BEFORE importing the verifier so the mock is in place.
vi.mock('jwks-rsa', () => {
  return {
    default: () => ({
      getSigningKey: (
        kid: string | undefined,
        cb: (err: Error | null, key?: { getPublicKey: () => string }) => void,
      ) => {
        if (!kid || kid !== KID) {
          cb(new Error(`unknown kid: ${kid}`));
          return;
        }
        cb(null, { getPublicKey: () => publicPem });
      },
    }),
  };
});

import { Auth0Verifier } from '../src/auth/auth0Verifier.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

function makeVerifier() {
  return new Auth0Verifier({ domain: DOMAIN, audience: AUDIENCE });
}

function signToken(claims: Record<string, unknown>, opts: jwt.SignOptions = {}): string {
  return jwt.sign(claims, privatePem, {
    algorithm: 'RS256',
    keyid: KID,
    ...opts,
  });
}

function basicClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'auth0|abc123',
    aud: AUDIENCE,
    iss: ISSUER,
    azp: 'cli-test-client',
    scope: 'read write',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    ...over,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Construction guards

describe('Auth0Verifier construction', () => {
  it('throws when domain is empty', () => {
    expect(() => new Auth0Verifier({ domain: '', audience: AUDIENCE })).toThrow(/domain/);
  });
  it('throws when audience is empty', () => {
    expect(() => new Auth0Verifier({ domain: DOMAIN, audience: '' })).toThrow(/audience/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Happy path

describe('Auth0Verifier.verifyAccessToken — valid token', () => {
  it('returns AuthInfo with token, clientId, scopes, expiresAt, resource', async () => {
    const token = signToken(basicClaims());
    const info = await makeVerifier().verifyAccessToken(token);
    expect(info.token).toBe(token);
    expect(info.clientId).toBe('cli-test-client');
    expect(info.scopes).toEqual(['read', 'write']);
    expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(info.resource?.toString()).toBe(AUDIENCE + '/');
  });

  it('parses single-scope tokens', async () => {
    const token = signToken(basicClaims({ scope: 'read' }));
    const info = await makeVerifier().verifyAccessToken(token);
    expect(info.scopes).toEqual(['read']);
  });

  it('returns empty scopes when scope claim is missing', async () => {
    const claims = basicClaims();
    delete claims.scope;
    const token = signToken(claims);
    const info = await makeVerifier().verifyAccessToken(token);
    expect(info.scopes).toEqual([]);
  });

  it('falls back to client_id when azp is absent', async () => {
    const claims = basicClaims({ client_id: 'fallback-client' });
    delete claims.azp;
    const token = signToken(claims);
    const info = await makeVerifier().verifyAccessToken(token);
    expect(info.clientId).toBe('fallback-client');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Failure modes — each should throw InvalidTokenError so the SDK
// middleware emits a spec-compliant 401, not a 500.

describe('Auth0Verifier.verifyAccessToken — rejection cases', () => {
  it('rejects a malformed (non-JWT) string', async () => {
    await expect(makeVerifier().verifyAccessToken('not-a-jwt'))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token with the wrong audience', async () => {
    const token = signToken(basicClaims({ aud: 'https://api.theperch.app' }));
    await expect(makeVerifier().verifyAccessToken(token))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token with the wrong issuer', async () => {
    const token = signToken(basicClaims({ iss: 'https://attacker.example/' }));
    await expect(makeVerifier().verifyAccessToken(token))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects an expired token', async () => {
    const token = signToken(basicClaims({
      exp: Math.floor(Date.now() / 1000) - 60,
      iat: Math.floor(Date.now() / 1000) - 3600,
    }));
    await expect(makeVerifier().verifyAccessToken(token))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token signed by a different key', async () => {
    const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherPem = otherPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const token = jwt.sign(basicClaims(), otherPem, {
      algorithm: 'RS256',
      keyid: KID, // same kid — JWKS returns our public key, signature mismatch
    });
    await expect(makeVerifier().verifyAccessToken(token))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token whose kid is unknown to the JWKS', async () => {
    const token = jwt.sign(basicClaims(), privatePem, {
      algorithm: 'RS256',
      keyid: 'unknown-kid',
    });
    await expect(makeVerifier().verifyAccessToken(token))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token without a kid header', async () => {
    const token = jwt.sign(basicClaims(), privatePem, { algorithm: 'RS256' });
    await expect(makeVerifier().verifyAccessToken(token))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects an unsigned (alg=none) token even if it parses', async () => {
    // jwt.sign with `alg: 'none'` requires opt-in; manually craft to be safe.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(basicClaims())).toString('base64url');
    const token = `${header}.${payload}.`;
    await expect(makeVerifier().verifyAccessToken(token))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });
});
