import { Type, type TSchema } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { z } from 'zod';

/** What a tool call knows about where it runs. */
export interface ToolCall {
  /** The Pidots thread (not the pi-durable conversation id). */
  threadId: string;
  dotId: string;
  callId: string;
  signal: AbortSignal;
}

/**
 * A Pidots tool. Arguments are described with zod (or, for MCP tools, a
 * JSON Schema) and re-validated before `execute`; results are returned to the
 * model as JSON text.
 */
export interface DotTool {
  name: string;
  description: string;
  parameters: z.ZodType | { jsonSchema: Record<string, unknown> };
  /**
   * Safe to run again after a crash: reads, and interactive waits. Anything
   * with side effects stays unsafe, so an interrupted call is reported to the
   * model instead of repeated.
   */
  replaySafe?: boolean;
  execute(args: unknown, call: ToolCall): Promise<unknown>;
}

export const dotTool = <T extends z.ZodType>(tool: {
  name: string;
  description: string;
  parameters: T;
  replaySafe?: boolean;
  execute(args: z.infer<T>, call: ToolCall): Promise<unknown>;
}): DotTool => tool as DotTool;

function schemaOf(parameters: DotTool['parameters']): TSchema {
  const json =
    'jsonSchema' in parameters
      ? parameters.jsonSchema
      : (z.toJSONSchema(parameters) as Record<string, unknown>);
  const schema = { ...json };
  delete schema.$schema;
  return Type.Unsafe(schema);
}

export function toolText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/** Resolves the Pidots thread for a pi-durable conversation. */
export type ThreadResolver = (conversationId: string) => {
  threadId: string;
  dotId: string;
};

/** Wraps a Pidots tool as a pi-durable tool registration. */
export function registration(
  tool: DotTool,
  resolve: ThreadResolver,
): ToolRegistration {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: schemaOf(tool.parameters),
    replay: tool.replaySafe ? 'safe' : 'unsafe',
    execute: async (args, api, context) => {
      const { threadId, dotId } = resolve(String(api.conversationId));
      const signal = context.abortSignal ?? new AbortController().signal;
      const input =
        'jsonSchema' in tool.parameters
          ? (args ?? {})
          : tool.parameters.parse(args);
      const result = await tool.execute(input, {
        threadId,
        dotId,
        callId: api.callId,
        signal,
      });
      return { content: [{ type: 'text', text: toolText(result) }] };
    },
  }) as ToolRegistration;
}
