import { connectionActionTool } from '../shared/connection-types.js';
import type { ConnectionService } from './connections.js';
import type { DotTool, ToolCall } from './engine/tools.js';
// Connected MCP tools for one Dot. Tools that need approval never execute
// here: the model is told to request owner approval, and only the owner's
// approval route runs them.
export function connectionTools(
  connections: ConnectionService,
  dotId: string,
  check: (call: ToolCall) => void,
  approvals: (call: ToolCall) => boolean,
): DotTool[] {
  return connections.tools(dotId).map((exposed) => ({
    name: exposed.name,
    description:
      `[${exposed.connection.name}${exposed.tool.requiresApproval ? ', needs owner approval' : ''}] ${exposed.tool.title}: ${exposed.tool.description}`.slice(
        0,
        1024,
      ),
    parameters: { jsonSchema: exposed.tool.inputSchema },
    execute: async (args: unknown, call: ToolCall) => {
      check(call);
      // Re-resolve so a tool the owner just disabled or gated is honored.
      const current = connections.resolve(dotId, exposed.name);
      const input = (args ?? {}) as Record<string, unknown>;
      if (current.tool.requiresApproval)
        return approvals(call)
          ? {
              status: 'approval_required',
              approvalId: connections.store.createApproval({
                threadId: call.threadId,
                dotId,
                connectionId: current.connection.id,
                tool: current.tool.name,
                arguments: input,
              }),
              instruction: `Call ${connectionActionTool.name} with this approvalId and a one-sentence summary of what it will do. Then wait for the owner.`,
            }
          : {
              status: 'unavailable',
              message:
                'This action needs owner approval in the Pidots app. Ask the owner to continue there.',
            };
      const result = await connections.call(current, input, call.signal);
      check(call);
      return result;
    },
  }));
}
