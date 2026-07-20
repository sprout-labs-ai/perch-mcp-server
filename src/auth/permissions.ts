/**
 * Consumer permission vocabulary ↔ MCP resource scope mapping.
 *
 * Two vocabularies describe the same thing from two altitudes:
 *
 *   - **MCP resource scopes** (`read:accounts`, `read:series`, `read:schedule`,
 *     `read:forecast`) are the technical, per-tool scopes the Hydra MCP
 *     resource server issues and perch-api enforces (`requireResourceScope`).
 *     They are what an assistant's access token actually carries. See
 *     `scopes.ts`.
 *
 *   - **Consumer permission keys** (`current_balance`, `upcoming_items`,
 *     `forecast`, `activity_history`, `suggestions`, `changes`) are the calm,
 *     human-facing capabilities the iOS Integrations screen renders
 *     (`IntegrationPermissionLabel` in perch-apple). They are what a person
 *     sees and reasons about — never a raw scope string.
 *
 * This module is the single source of truth for the correspondence between the
 * two. perch-api mirrors it to turn a connection's *granted token scopes* into
 * the `permissions: [{ key, enabled }]` list returned by
 * `GET /api/v1/integrations/:id` (see the consumer integrations handoff doc).
 *
 * ── Mapping ──────────────────────────────────────────────────────────────────
 *   current_balance   ←→ read:accounts   (list_accounts)
 *   upcoming_items    ←→ read:schedule   (list_scheduled_items)
 *   activity_history  ←→ read:series     (list_recurring_series — the recurring
 *                                         payments/income that make up the
 *                                         account's ongoing financial activity)
 *   forecast          ←→ read:forecast   (get_forecast_curve, simulate_forecast)
 *   suggestions       ←→ (none yet)      — implies a recommendations tool that
 *                                         does not exist; advertised as a
 *                                         "coming soon" capability, never granted.
 *   changes           ←→ (none yet)      — implies WRITE tools that do not exist;
 *                                         gated forward by the
 *                                         require_approval_for_changes privacy
 *                                         control once they land.
 *
 * The `read:series ↔ activity_history` correspondence is the one non-obvious
 * pairing; it is the chosen mapping (all four live scopes pair 1:1 with a
 * consumer permission, leaving exactly `suggestions` and `changes` as the
 * not-yet-available pair). Confirm jointly with perch-api before GA.
 */

import type { McpResourceScope } from './scopes.js';

/** The consumer-facing permission keys the iOS app understands. */
export const PERMISSION_KEYS = [
  'current_balance',
  'upcoming_items',
  'forecast',
  'activity_history',
  'suggestions',
  'changes',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * Canonical display order — matches perch-apple's
 * `IntegrationPermissionLabel.canonicalOrder` and perch-api's
 * `KNOWN_PERMISSION_KEYS`, so the three stay in lockstep.
 */
export const CANONICAL_PERMISSION_ORDER: readonly PermissionKey[] = PERMISSION_KEYS;

/**
 * MCP resource scope → the consumer permission it backs. Only the four live
 * scopes appear; `suggestions` and `changes` have no backing scope yet.
 */
export const SCOPE_TO_PERMISSION: Record<McpResourceScope, PermissionKey> = {
  'read:accounts': 'current_balance',
  'read:schedule': 'upcoming_items',
  'read:series': 'activity_history',
  'read:forecast': 'forecast',
};

/**
 * Consumer permission → the MCP scope that backs it, or `null` when no scope
 * (and no tool) exists yet. A `null` permission can never be "granted"; it is
 * forward-looking only.
 */
export const PERMISSION_TO_SCOPE: Record<PermissionKey, McpResourceScope | null> = {
  current_balance: 'read:accounts',
  upcoming_items: 'read:schedule',
  activity_history: 'read:series',
  forecast: 'read:forecast',
  suggestions: null,
  changes: null,
};

/**
 * Permissions with no backing scope/tool today. perch-api may still surface
 * them in the UI as "coming soon"; this server never issues a scope for them.
 *   - `suggestions`: a recommendations capability (read) — not built.
 *   - `changes`: write/mutation capability — not built; will be gated by the
 *     `require_approval_for_changes` privacy control.
 */
export const UNAVAILABLE_PERMISSIONS: readonly PermissionKey[] = ['suggestions', 'changes'];

export interface IntegrationPermission {
  key: PermissionKey;
  enabled: boolean;
}

/**
 * Turn the set of resource scopes a connection's token was granted into the
 * full, canonically-ordered consumer permission list — exactly the shape
 * `GET /api/v1/integrations/:id` returns under `permissions`.
 *
 * A scope-backed permission is `enabled` iff its scope is present in the grant.
 * Permissions with no backing scope (`suggestions`, `changes`) are always
 * `enabled: false` here — they cannot be granted today. (perch-api is free to
 * OR-in its own registry "coming soon" defaults for those two before sending
 * them to the client; this function reports only what scopes can prove.)
 */
export function permissionsFromGrantedScopes(
  grantedScopes: Iterable<string>,
): IntegrationPermission[] {
  const granted = new Set(grantedScopes);
  return CANONICAL_PERMISSION_ORDER.map((key) => {
    const scope = PERMISSION_TO_SCOPE[key];
    return { key, enabled: scope !== null && granted.has(scope) };
  });
}
