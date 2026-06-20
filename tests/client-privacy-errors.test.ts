/**
 * Privacy-control error surfacing in the API client.
 *
 * When perch-api refuses an MCP request because of an account-wide privacy
 * control, the client must translate the technical 403 code into calm,
 * consumer-safe guidance (and leak no MCP/transport detail).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { clientFor, PerchApiError } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

function mock403(code: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ error: 'Forbidden', code }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const extra = { authInfo: { token: 'jwt-abc', clientId: 'azp' } };

describe('privacy-control 403 mapping', () => {
  it('INTEGRATIONS_DISABLED → calm allow_integrations guidance', async () => {
    mock403('INTEGRATIONS_DISABLED');
    const err = await clientFor(extra).get('/api/v1/accounts').catch((e) => e);
    expect(err).toBeInstanceOf(PerchApiError);
    expect((err as PerchApiError).status).toBe(403);
    expect((err as PerchApiError).code).toBe('INTEGRATIONS_DISABLED');
    expect((err as PerchApiError).message).toContain('Integrations are turned off');
    // No MCP/transport detail leaks into the consumer-facing message.
    expect((err as PerchApiError).message).not.toMatch(/mcp|bearer|token|scope/i);
  });

  it('APPROVAL_REQUIRED → calm require_approval_for_changes guidance', async () => {
    mock403('APPROVAL_REQUIRED');
    const err = await clientFor(extra).post('/api/v1/some/write', {}).catch((e) => e);
    expect(err).toBeInstanceOf(PerchApiError);
    expect((err as PerchApiError).code).toBe('APPROVAL_REQUIRED');
    expect((err as PerchApiError).message).toContain('needs approval');
  });

  it('still maps INSUFFICIENT_SCOPE distinctly', async () => {
    mock403('INSUFFICIENT_SCOPE');
    const err = await clientFor(extra).get('/api/v1/accounts').catch((e) => e);
    expect((err as PerchApiError).code).toBe('INSUFFICIENT_SCOPE');
    expect((err as PerchApiError).message).toContain('missing the scope');
  });
});
