/**
 * Best-effort emission of access-activity entries to perch-api.
 *
 * After a connected assistant successfully runs a user tool, we POST a calm,
 * PII-free summary to perch-api's internal activity sink:
 *
 *     POST /api/v1/integrations/activity   { summary, permissionKey }
 *
 * perch-api authenticates the SAME forwarded Hydra token (so it derives the
 * user from `sub`), maps the token's `azp` client id to an integration, writes
 * one `user_integration_activity` row, and bumps the connection's
 * `last_used_at`. See the consumer integrations handoff doc for the perch-api
 * contract (the endpoint + the `azp → integration` resolver are the joint
 * deliverables on that side).
 *
 * Design rules:
 *   - **Never affect the tool result.** Emission is fire-and-forget; any error
 *     (endpoint missing, network blip, the assistant isn't a known integration)
 *     is swallowed. A user's answer must never fail because logging failed.
 *   - **HTTP transport only.** stdio/PAT and admin/M2M callers have no `azp`
 *     and are not consumer assistant connections; they skip emission entirely.
 */

import { clientFor } from '../api/client.js';
import { TOOL_ACTIVITY_SUMMARIES } from './summaries.js';

/** Minimal shape of the tool handler's `extra.authInfo` we rely on. */
interface AuthInfoLike {
  token?: string;
  clientId?: string;
}

export interface ToolInvocationContext {
  authInfo?: AuthInfoLike;
}

/**
 * Record one access-activity entry for a completed tool invocation. Returns a
 * promise that always resolves (errors are swallowed) so callers may either
 * `await` it (tests) or fire-and-forget it (the dispatch wrapper).
 */
export async function recordToolActivity(
  extra: ToolInvocationContext | undefined,
  toolName: string,
): Promise<void> {
  const authInfo = extra?.authInfo;
  // HTTP transport only: a forwarded token AND an `azp` client id are what tie
  // this call to a consumer assistant connection. stdio/PAT and admin/M2M have
  // neither → not a consumer connection → nothing to log.
  if (!authInfo?.token || !authInfo.clientId) return;

  const entry = TOOL_ACTIVITY_SUMMARIES[toolName];
  if (!entry) return;

  try {
    await clientFor(extra).post('/api/v1/integrations/activity', {
      summary: entry.summary,
      permissionKey: entry.permissionKey,
    });
  } catch {
    // Best-effort: the tool already succeeded. Swallow everything — a missing
    // endpoint (perch-api not yet shipped), a 4xx, or a network error must not
    // surface to the assistant or the user.
  }
}
