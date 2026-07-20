/**
 * Privacy-safe activity summaries for each user-scoped tool.
 *
 * Every successful tool invocation made by a *connected assistant* (HTTP
 * transport, Hydra token carrying a client id) produces one access-log
 * entry that the consumer Integrations screen surfaces via
 * `GET /api/v1/integrations/activity`.
 *
 * What we emit is deliberately minimal and PII-free:
 *   - a calm, fixed, human sentence ("Checked your account balances") — NEVER
 *     interpolated with arguments, account names, amounts, dates, or any
 *     free-text the model passed in;
 *   - the consumer `permissionKey` the access exercised, for future filtering.
 *
 * The user identity and which assistant ran the tool are NOT carried in the
 * body — perch-api derives both from the forwarded Hydra token (the `sub` →
 * user, the `azp` → integration). So this map holds only the two opaque,
 * non-identifying tokens above. No raw queries, no IDs, no transport detail.
 *
 * Only the five read-only user tools appear here. Admin (M2M) tools and
 * stdio/PAT usage are intentionally absent — they are not consumer assistant
 * connections and never log to this surface.
 */

import type { PermissionKey } from '../auth/permissions.js';

export interface ToolActivitySummary {
  /** Calm, fixed, consumer-facing sentence. No interpolation, ever. */
  summary: string;
  /** The consumer permission this access exercised. */
  permissionKey: PermissionKey;
}

export const TOOL_ACTIVITY_SUMMARIES: Record<string, ToolActivitySummary> = {
  list_accounts: {
    summary: 'Checked your account balances',
    permissionKey: 'current_balance',
  },
  list_scheduled_items: {
    summary: 'Looked at your upcoming items',
    permissionKey: 'upcoming_items',
  },
  list_recurring_series: {
    summary: 'Reviewed your recurring payments and income',
    permissionKey: 'activity_history',
  },
  get_forecast_curve: {
    summary: 'Reviewed your balance forecast',
    permissionKey: 'forecast',
  },
  simulate_forecast: {
    summary: 'Explored a what-if balance scenario',
    permissionKey: 'forecast',
  },
};

/** Tool names that emit consumer activity (the five read-only user tools). */
export function isActivityTrackedTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_ACTIVITY_SUMMARIES, name);
}
