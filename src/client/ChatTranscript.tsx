import { openPageLink } from './page-navigation';
import { Fragment, type ReactNode } from 'react';
import { PhoneOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { CallReceipt } from '../shared/types';
import type { ChatMessage } from '../shared/thread-types';
// These markers only control rendering; they do not confer trust or permissions.
export const isInternalVoiceReceipt = (message: ChatMessage) =>
  message.role === 'user' && message.source === 'voice_receipt';
const isScheduledTaskMessage = (message: ChatMessage) =>
  message.role === 'user' && message.source === 'scheduled_task';
function Receipt({ call }: { call: CallReceipt }) {
  return (
    <div className="call-receipt">
      <PhoneOff size={13} />
      <span>
        {call.status === 'failed'
          ? 'Call failed'
          : call.endedAt
            ? `${Math.round((call.endedAt - call.startedAt) / 1000)}s · Call ended`
            : 'Call in progress'}
      </span>
      {call.error && <small>{call.error}</small>}
    </div>
  );
}
export function ChatTranscript({
  messages,
  calls,
  renderTools,
}: {
  messages: ChatMessage[];
  calls: CallReceipt[];
  renderTools?: (message: ChatMessage) => ReactNode;
}) {
  const ids = new Set(messages.map((message) => message.id));
  return (
    <>
      {calls
        .filter(
          (call) => !call.anchorMessageId || !ids.has(call.anchorMessageId),
        )
        .map((call) => (
          <Receipt key={call.id} call={call} />
        ))}
      {messages.map((message) => (
        <Fragment key={message.id}>
          {message.text.trim() && (
            <div
              className={`chat-bubble ${message.role}${isScheduledTaskMessage(message) ? ' scheduled' : ''}`}
            >
              {isScheduledTaskMessage(message) && (
                <span className="scheduled-message-label">Scheduled</span>
              )}
              <ReactMarkdown
                components={{
                  img: ({ alt }) => <span>{alt}</span>,
                  a: ({ href, children }) => (
                    <a
                      onClick={(event) => {
                        if (href?.startsWith('/#/spaces/')) {
                          event.preventDefault();
                          openPageLink(href);
                        }
                      }}
                      href={href}
                      target={
                        href?.startsWith('/#/spaces/') ? undefined : '_blank'
                      }
                      rel="noreferrer"
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {message.text}
              </ReactMarkdown>
            </div>
          )}
          {message.role === 'assistant' && renderTools?.(message)}
          {message.error && (
            <div className="chat-error inline" role="alert">
              {message.error}
            </div>
          )}
          {calls
            .filter((call) => call.anchorMessageId === message.id)
            .map((call) => (
              <Receipt key={call.id} call={call} />
            ))}
        </Fragment>
      ))}
    </>
  );
}
