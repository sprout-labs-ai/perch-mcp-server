/**
 * Central activity instrumentation for the MCP server.
 *
 * Rather than thread an emit call through every tool file, we wrap
 * `server.registerTool` once: any tool whose name is in
 * `TOOL_ACTIVITY_SUMMARIES` (the five read-only user tools) gets its handler
 * decorated so that, *after a successful result*, it fire-and-forgets one
 * access-activity entry to perch-api. Every other tool — admin/M2M tools,
 * anything not in the map — is registered untouched.
 *
 * Emission is non-blocking and best-effort (see `recordToolActivity`); it
 * never changes the tool's result and never throws. A thrown tool handler is
 * re-thrown as-is and logs nothing (we only record successful access).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isActivityTrackedTool } from './summaries.js';
import { recordToolActivity, type ToolInvocationContext } from './emit.js';

/**
 * Patch `server.registerTool` in place so tracked user tools emit activity
 * after they succeed. Call once, before any tool is registered.
 */
export function instrumentToolActivity(server: McpServer): void {
  // `registerTool` is heavily overloaded in the SDK; treat it loosely here so
  // we can wrap arbitrary handlers without fighting overload resolution.
  type RegisterTool = (name: string, config: unknown, handler: Function) => unknown;
  const original = (server.registerTool as unknown as RegisterTool).bind(server) as RegisterTool;

  (server as unknown as { registerTool: RegisterTool }).registerTool = (
    name: string,
    config: unknown,
    handler: Function,
  ) => {
    if (!isActivityTrackedTool(name)) {
      return original(name, config, handler);
    }

    const wrapped = async (args: unknown, extra: ToolInvocationContext) => {
      const result = await handler(args, extra);
      // Fire-and-forget AFTER success: logging latency never delays the answer
      // and a logging failure never fails the answer.
      void recordToolActivity(extra, name);
      return result;
    };

    return original(name, config, wrapped);
  };
}
