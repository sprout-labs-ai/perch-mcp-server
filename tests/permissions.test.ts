/**
 * Scope ↔ consumer-permission mapping.
 *
 * Locks the correspondence that perch-api mirrors to build the
 * `permissions:[{key,enabled}]` list, and the invariants that keep the three
 * vocabularies (this server, perch-api, perch-apple) in lockstep.
 */

import { describe, it, expect } from 'vitest';
import { MCP_RESOURCE_SCOPES } from '../src/auth/scopes.js';
import {
  PERMISSION_KEYS,
  CANONICAL_PERMISSION_ORDER,
  SCOPE_TO_PERMISSION,
  PERMISSION_TO_SCOPE,
  UNAVAILABLE_PERMISSIONS,
  permissionsFromGrantedScopes,
} from '../src/auth/permissions.js';

describe('scope ↔ permission mapping', () => {
  it('canonical order matches perch-apple / perch-api', () => {
    // IntegrationPermissionLabel.canonicalOrder and perch-api's
    // KNOWN_PERMISSION_KEYS both use exactly this order.
    expect(CANONICAL_PERMISSION_ORDER).toEqual([
      'current_balance',
      'upcoming_items',
      'forecast',
      'activity_history',
      'suggestions',
      'changes',
    ]);
  });

  it('every live MCP scope maps to exactly one permission', () => {
    for (const scope of MCP_RESOURCE_SCOPES) {
      expect(SCOPE_TO_PERMISSION[scope]).toBeTruthy();
    }
    // No two scopes collide on the same permission (1:1).
    const targets = Object.values(SCOPE_TO_PERMISSION);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('SCOPE_TO_PERMISSION and PERMISSION_TO_SCOPE are inverses for live scopes', () => {
    for (const [scope, permission] of Object.entries(SCOPE_TO_PERMISSION)) {
      expect(PERMISSION_TO_SCOPE[permission]).toBe(scope);
    }
  });

  it('exactly suggestions and changes are not-yet-available (null scope)', () => {
    const nullBacked = PERMISSION_KEYS.filter((k) => PERMISSION_TO_SCOPE[k] === null);
    expect(nullBacked).toEqual([...UNAVAILABLE_PERMISSIONS]);
    expect(UNAVAILABLE_PERMISSIONS).toEqual(['suggestions', 'changes']);
  });

  it('read:series backs activity_history (the chosen non-obvious pairing)', () => {
    expect(SCOPE_TO_PERMISSION['read:series']).toBe('activity_history');
  });
});

describe('permissionsFromGrantedScopes', () => {
  it('returns the full vocabulary in canonical order', () => {
    const perms = permissionsFromGrantedScopes([]);
    expect(perms.map((p) => p.key)).toEqual([...CANONICAL_PERMISSION_ORDER]);
  });

  it('enables only the permissions whose scope was granted', () => {
    const perms = permissionsFromGrantedScopes(['read:accounts', 'read:forecast']);
    const enabled = perms.filter((p) => p.enabled).map((p) => p.key);
    expect(enabled).toEqual(['current_balance', 'forecast']);
  });

  it('a full grant enables all four scope-backed permissions but never the unavailable ones', () => {
    const perms = permissionsFromGrantedScopes([...MCP_RESOURCE_SCOPES]);
    const enabled = perms.filter((p) => p.enabled).map((p) => p.key);
    expect(enabled).toEqual(['current_balance', 'upcoming_items', 'forecast', 'activity_history']);
    expect(perms.find((p) => p.key === 'suggestions')!.enabled).toBe(false);
    expect(perms.find((p) => p.key === 'changes')!.enabled).toBe(false);
  });

  it('ignores unknown/irrelevant scopes', () => {
    const perms = permissionsFromGrantedScopes(['read', 'openid', 'read:accounts']);
    const enabled = perms.filter((p) => p.enabled).map((p) => p.key);
    expect(enabled).toEqual(['current_balance']);
  });
});
