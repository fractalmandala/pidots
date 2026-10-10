import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type { EntryRecord, LiveState } from '@earendil-works/pi-durable';
import type {
  ChatMessage,
  LiveRun,
  MessageSource,
  ToolCallView,
} from '../../shared/thread-types.js';

function textOf(
  content: UserMessage['content'] | ToolResultMessage['content'],
) {
  if (typeof content === 'string') return content;
  return content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assistantView(id: string, message: AssistantMessage): ChatMessage {
  return {
    id,
    role: 'assistant',
    text: message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join(''),
    toolCalls: message.content.flatMap((block) =>
      block.type === 'toolCall'
        ? [
            {
              id: block.id,
              name: block.name,
              args: block.arguments,
              status: 'executing' as const,
            },
          ]
        : [],
    ),
    ...(message.stopReason === 'error' || message.stopReason === 'aborted'
      ? {
          error:
            message.errorMessage ??
            (message.stopReason === 'aborted'
              ? 'This answer was stopped.'
              : 'The model returned an error.'),
        }
      : {}),
  };
}

/** Maps transcript entries to chat messages, attaching tool results to their calls. */
export function chatMessages(
  entries: readonly EntryRecord[],
  sources: Map<string, string>,
  running: boolean,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const calls = new Map<string, ToolCallView>();
  for (const entry of entries) {
    const model = entry.model?.[0] as Message | undefined;
    if (!model) continue;
    if (entry.kind === 'pi.user' && model.role === 'user') {
      const source = sources.get(String(entry.id)) as MessageSource | undefined;
      messages.push({
        id: String(entry.id),
        role: 'user',
        text: textOf(model.content),
        toolCalls: [],
        ...(source ? { source } : {}),
      });
    } else if (entry.kind === 'pi.assistant' && model.role === 'assistant') {
      const view = assistantView(String(entry.id), model);
      for (const call of view.toolCalls) calls.set(call.id, call);
      messages.push(view);
    } else if (entry.kind === 'pi.tool-result' && model.role === 'toolResult') {
      const call = calls.get(model.toolCallId);
      if (!call) continue;
      call.status = 'complete';
      call.result = parsed(textOf(model.content));
      if (model.isError) call.isError = true;
    }
  }
  // A call left without a result outside a run was interrupted.
  if (!running) for (const call of calls.values()) call.status = 'complete';
  return messages.filter(
    (message) =>
      message.text.trim() || message.toolCalls.length || message.error,
  );
}

export function liveRun(
  live: LiveState | undefined,
  awaiting: (callId: string) => boolean,
): LiveRun {
  const partial = live?.generation?.message as AssistantMessage | undefined;
  return {
    running: !!live?.run,
    ...(partial?.content ? { message: assistantView('live', partial) } : {}),
    toolCalls: (live?.tools ?? []).map((slot) => ({
      id: slot.callId,
      name: slot.name,
      args: undefined,
      status: slot.status === 'done' ? 'complete' : 'executing',
      ...(awaiting(slot.callId) ? { awaitingResponse: true } : {}),
    })),
    ...(live?.generation?.retry ? { retry: live.generation.retry.error } : {}),
  };
}

/** Plain text of the newest assistant answer, for server-side turns. */
export function answerText(entry: EntryRecord | undefined): string {
  const model = entry?.model?.[0] as Message | undefined;
  if (!model || model.role !== 'assistant')
    throw new Error('The turn returned no assistant response.');
  const view = assistantView(String(entry!.id), model);
  if (view.error) throw new Error(view.error);
  if (!view.text.trim())
    throw new Error('The turn returned no assistant response.');
  return view.text;
}
