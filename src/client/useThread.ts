import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, LiveRun, ThreadEvent } from '../shared/thread-types';
import { api, authHeaders } from './api';

const idle: LiveRun = { running: false, toolCalls: [] };

/** Reads server-sent events from a fetch response (keeps the auth header). */
async function readEvents(
  response: Response,
  onEvent: (event: ThreadEvent) => void,
) {
  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (/^event: ping$/m.test(frame)) continue;
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(JSON.parse(data) as ThreadEvent);
    }
  }
}

/**
 * One conversation: its transcript, the live run, and the actions the chat
 * takes on it. Reconnects automatically; the server keeps the turn running
 * while the page is closed or reloading.
 */
export function useThread(threadId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<LiveRun>(idle);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const runningSeen = useRef(false);
  const sentAt = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    setConnected(false);
    setMessages([]);
    setLive(idle);
    void (async () => {
      try {
        const response = await fetch(`/api/threads/${threadId}/events`, {
          headers: authHeaders(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body)
          throw new Error(
            ((await response.json().catch(() => null)) as { error?: string })
              ?.error ?? 'Conversation could not connect.',
          );
        setConnected(true);
        await readEvents(response, (event) => {
          if (event.type === 'messages') setMessages(event.messages);
          else if (event.type === 'live') setLive(event.live);
          else setError(event.message);
        });
        throw new Error('Conversation connection closed.');
      } catch (cause) {
        if (controller.signal.aborted) return;
        setConnected(false);
        setError(
          cause instanceof Error
            ? cause.message
            : 'Conversation could not connect.',
        );
        retry = setTimeout(() => setAttempt((value) => value + 1), 2000);
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [threadId, attempt]);

  // A send counts as running until the server reports the run, then until it ends.
  // A run that ends before its start was observed is caught by its answer.
  useEffect(() => {
    if (live.running) runningSeen.current = true;
    if (!starting) return;
    if (live.running || runningSeen.current) setStarting(false);
    else if (
      messages.length > sentAt.current + 1 &&
      messages.at(-1)?.role === 'assistant'
    )
      setStarting(false);
  }, [live.running, starting, messages]);

  const send = useCallback(
    async (text: string) => {
      setError('');
      runningSeen.current = false;
      sentAt.current = messages.length;
      setStarting(true);
      try {
        await api(`/threads/${threadId}/messages`, 'POST', {
          text,
          requestId: crypto.randomUUID(),
        });
      } catch (cause) {
        setStarting(false);
        throw cause;
      }
    },
    [threadId, messages.length],
  );
  const stop = useCallback(async () => {
    setStarting(false);
    await api(`/threads/${threadId}/stop`, 'POST', {});
  }, [threadId]);
  const respond = useCallback(
    async (toolCallId: string, result: unknown) => {
      await api(`/threads/${threadId}/tool-results`, 'POST', {
        toolCallId,
        result,
      });
    },
    [threadId],
  );
  return {
    messages,
    live,
    running: starting || live.running,
    connected,
    error,
    clearError: () => setError(''),
    reconnect: () => setAttempt((value) => value + 1),
    send,
    stop,
    respond,
  };
}
