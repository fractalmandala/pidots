import { PageReviewCard } from './PageReviewCard';
import { pageReviewTool } from '../shared/page-review';
import { connectionActionTool } from '../shared/connection-types';
import { ConnectionActionCard } from './ConnectionActionCard';
import { contextualMessage, type PageContext } from './page-context';
import { api } from './api';
import type { Page } from '../server/pages';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ToolCallView } from '../shared/thread-types';
import { useThread } from './useThread';
import {
  FilePlus,
  ArrowUp,
  Clock3,
  Link2,
  Phone,
  PhoneOff,
  Square,
  X,
} from 'lucide-react';
import { ComputerToolCard } from './ComputerToolCard';
import { ChatTranscript, isInternalVoiceReceipt } from './ChatTranscript';
import type { CallReceipt, Conversation, Dot } from '../shared/types';
import { Mascot } from './Mascot';
import { useVoice } from './useVoice';
import { CallView } from './CallView';
import { shouldSubmitComposerOnKeyDown } from './chat-composer';

export function Chat({
  thread,
  dot,
  initialPrompt,
  onConsumed,
  voiceReady,
  calls,
  paused,
  onSaved,
  onSchedule,
  onComputer,
}: {
  thread: Conversation;
  dot: Dot;
  initialPrompt?: string;
  onConsumed: () => void;
  voiceReady: boolean;
  calls: CallReceipt[];
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  onComputer?: () => void;
}) {
  const conversation = useThread(thread.id);
  const { messages, live, running, connected: loaded } = conversation;
  const [pageContext, setPageContext] = useState<PageContext | null>();
  const [contextError, setContextError] = useState('');
  const [contextAttempt, setContextAttempt] = useState(0);
  const contextReady = pageContext !== undefined;
  useEffect(() => {
    let active = true;
    setPageContext(undefined);
    setContextError('');
    void api<PageContext | null>(
      `/conversations/${thread.id}/page-context`,
      'GET',
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((page) => {
        if (active) setPageContext(page);
      })
      .catch(() => {
        if (active)
          setContextError(
            'Conversation context could not load. Retry before sending your message.',
          );
      });
    return () => {
      active = false;
    };
  }, [thread.id, contextAttempt]);
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sendError, setSendError] = useState('');
  const error = sendError || conversation.error;
  const setError = (value: string) => {
    setSendError(value);
    if (!value) conversation.clearError();
  };
  const voice = useVoice(thread.id, onSaved, messages.at(-1)?.id);
  const sent = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  // Refresh workspace state (titles, captures) when a run finishes.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) onSaved();
    wasRunning.current = running;
  }, [running]);
  const send = async (text: string) => {
    if (!text.trim() || running || !loaded || !contextReady || paused) return;
    setError('');
    setDraft('');
    setSource('');
    setSourceOpen(false);
    try {
      await conversation.send(contextualMessage(text, pageContext));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The turn failed. Your conversation remains saved.',
      );
    }
  };
  useEffect(() => {
    if (loaded && contextReady && !paused && initialPrompt && !sent.current) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, contextReady, paused, initialPrompt]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [messages.length, live.message?.text, running]);
  useEffect(() => {
    if (paused && voice.status !== 'idle') void voice.end();
  }, [paused]);
  // Live status (running, waiting for the owner) overlays the transcript.
  const withLive = (call: ToolCallView): ToolCallView => {
    const current = live.toolCalls.find((item) => item.id === call.id);
    return current
      ? {
          ...call,
          status: call.status === 'complete' ? 'complete' : current.status,
          awaitingResponse: current.awaitingResponse,
        }
      : call;
  };
  const latestBrowserCall = messages
    .flatMap((message) => message.toolCalls)
    .findLast((call) =>
      [
        'navigate',
        'snapshot',
        'read',
        'screenshot',
        'click',
        'type',
        'key',
        'scroll',
      ].some((action) => call.name === `computer_${action}`),
    );
  const renderTools = (message: ChatMessage) =>
    message.toolCalls.map((raw) => {
      const call = withLive(raw);
      const respond =
        call.status === 'executing'
          ? (result: unknown) => conversation.respond(call.id, result)
          : undefined;
      if (call.name === pageReviewTool.name)
        return (
          <PageReviewCard
            key={call.id}
            args={call.args}
            status={call.status}
            result={call.result}
            respond={respond}
            toolCallId={call.id}
            threadId={thread.id}
            onSaved={onSaved}
          />
        );
      if (call.name === connectionActionTool.name)
        return (
          <ConnectionActionCard
            key={call.id}
            args={call.args}
            status={call.status}
            result={call.result}
            respond={respond}
            toolCallId={call.id}
            threadId={thread.id}
          />
        );
      if (call.name.startsWith('computer_'))
        return (
          <ComputerToolCard
            key={call.id}
            name={call.name}
            toolCallId={call.id}
            status={call.status}
            args={call.args}
            result={call.result}
            dotId={dot.id}
            dotName={dot.name}
            running={running}
            showScreen={call.id === latestBrowserCall?.id}
            onExpand={onComputer}
          />
        );
      return null;
    });
  const shown = (message: ChatMessage) =>
    !isInternalVoiceReceipt(message) &&
    (!!message.text.trim() ||
      !!message.error ||
      message.toolCalls.some(
        (call) =>
          call.name.startsWith('computer_') ||
          call.name === pageReviewTool.name ||
          call.name === connectionActionTool.name,
      ));
  const visible = [
    ...messages.filter(shown),
    ...(live.message && shown(live.message) ? [live.message] : []),
  ];
  return (
    <div className="live-chat">
      <header className="chat-persona">
        <Mascot
          identity={dot.id}
          name={dot.name}
          small
          state={running ? 'working' : paused ? 'paused' : 'idle'}
        />
        <div>
          <strong>{dot.name}</strong>
          <span>
            {paused
              ? 'Paused'
              : running
                ? 'Thinking…'
                : loaded && contextReady
                  ? 'Here with you'
                  : 'Connecting to your conversation…'}
          </span>
        </div>
        <div className="chat-persona-actions">
          <button
            className="icon-button"
            aria-label="Save conversation as page"
            disabled={running}
            onClick={async () => {
              const title = window.prompt('Page title', thread.title);
              if (!title) return;
              try {
                const page = await api<Page>(
                  `/conversations/${thread.id}/page`,
                  'POST',
                  { title },
                );
                location.hash = `/spaces/${page.spaceId}/pages/${page.id}`;
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Could not save conversation.',
                );
              }
            }}
          >
            <FilePlus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Schedule a task in this conversation"
            onClick={onSchedule}
          >
            <Clock3 size={18} />
          </button>
          <button
            className={`icon-button ${voice.status === 'active' ? 'on-call' : ''}`}
            aria-label={
              voice.status === 'idle' ? 'Start voice call' : 'End voice call'
            }
            title={
              voiceReady
                ? 'Talk with your Dot'
                : 'Voice setup requires a voice provider and model in Providers'
            }
            disabled={!voiceReady || paused || !loaded || !contextReady}
            onClick={() =>
              voice.status === 'idle' ? void voice.start() : void voice.end()
            }
          >
            {voice.status === 'idle' ? (
              <Phone size={18} />
            ) : (
              <PhoneOff size={18} />
            )}
          </button>
        </div>
      </header>
      {pageContext && (
        <div className="page-chat-context">
          Working on{' '}
          <a href={`/#/spaces/${pageContext.spaceId}/pages/${pageContext.id}`}>
            {pageContext.title}
          </a>
        </div>
      )}
      <div className="chat-transcript">
        {!visible.length && (
          <div className="chat-welcome">
            <span className="eyebrow">A LITTLE SPACE TO THINK</span>
            <h1>What’s on your mind?</h1>
            <p>{dot.instructions}</p>
            <p className="muted">
              Your conversation stays with this Dot, across text and calls.
            </p>
          </div>
        )}
        <ChatTranscript
          messages={visible}
          calls={calls}
          renderTools={renderTools}
        />
        {running && !live.message?.text && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <span>{dot.name} is thinking</span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {contextError && (
        <div className="chat-error" role="alert">
          {contextError}
          <button onClick={() => setContextAttempt((value) => value + 1)}>
            Retry context
          </button>
        </div>
      )}
      {(error || voice.error) && (
        <div className="chat-error" role="alert">
          {error || voice.error}
          {error && (
            <button
              onClick={() => {
                setError('');
                conversation.reconnect();
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      <CallView
        key={voice.status === 'idle' ? 'idle' : 'call'}
        dot={dot}
        voice={voice}
      />
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(`${source ? `From ${source}:\n\n` : ''}${draft}`);
        }}
      >
        {sourceOpen && (
          <div className="source-input">
            <Link2 size={15} />
            <input
              aria-label="Source page URL"
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://example.com/page"
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Remove source"
              onClick={() => {
                setSourceOpen(false);
                setSource('');
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="chat-compose-row">
          <button
            type="button"
            className="icon-button"
            aria-label="Add source page link"
            onClick={() => setSourceOpen(!sourceOpen)}
          >
            <Link2 size={19} />
          </button>
          <textarea
            aria-label="Message your Dot"
            placeholder={`Message ${dot.name}…`}
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (shouldSubmitComposerOnKeyDown(e)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {running ? (
            <button
              type="button"
              className="send-button"
              aria-label="Stop response"
              onClick={() => void conversation.stop()}
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="Send message"
              disabled={!draft.trim() || !loaded || !contextReady || paused}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
        <div className="chat-compose-note">
          {voiceReady
            ? 'Text and voice, one conversation.'
            : 'Text is ready. Voice needs separate server configuration.'}
        </div>
      </form>
    </div>
  );
}
