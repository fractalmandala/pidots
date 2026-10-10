// The chat protocol between the Pidots server and its UI. Threads stream as
// server-sent events: `messages` carries the committed transcript and `live`
// carries the in-flight answer and tool calls of the current run.

export type ToolCallStatus = 'executing' | 'complete';

export interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
  status: ToolCallStatus;
  /** Parsed JSON when the tool returned JSON, otherwise text. */
  result?: unknown;
  isError?: boolean;
  /** An interactive tool waiting for the owner's answer. */
  awaitingResponse?: boolean;
}

export type MessageSource = 'scheduled_task' | 'voice_receipt';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  source?: MessageSource;
  toolCalls: ToolCallView[];
  /** Set on assistant messages that ended with a provider error. */
  error?: string;
}

export interface LiveRun {
  running: boolean;
  /** The partial answer being generated. */
  message?: ChatMessage;
  /** Tool calls of the current round, with live status. */
  toolCalls: ToolCallView[];
  /** Provider retry in progress. */
  retry?: string;
}

export type ThreadEvent =
  | { type: 'messages'; messages: ChatMessage[] }
  | { type: 'live'; live: LiveRun }
  | { type: 'error'; message: string };

export const interactiveToolNames = [
  'review_space_page',
  'request_connection_action',
] as const;
