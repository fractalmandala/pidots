import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceEvent } from '../shared/types';
import { api, authHeaders } from './api';
import { readEvents } from './sse';

type Status = 'idle' | 'connecting' | 'active' | 'ending';
type Phase = 'listening' | 'speaking' | 'thinking';
interface Session {
  id: string;
  controller: AbortController;
}

/**
 * One voice call on a conversation. The server listens with Apple's speech
 * recognizer and speaks replies with Apple's voices. This hook shows the
 * call's state from its event stream and sends the mute controls back.
 */
export function useVoice(
  threadId: string,
  onSaved: () => void,
  anchorMessageId?: string,
) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [phase, setPhase] = useState<Phase>('listening');
  const [caption, setCaption] = useState('');
  const [userCaption, setUserCaption] = useState('');
  const session = useRef<Session | undefined>(undefined);
  const starting = useRef(false);
  const anchor = useRef(anchorMessageId);
  anchor.current = anchorMessageId;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // Ends a session once, whether the caller, the server, or a lost stream ended it.
  const close = useCallback((current: Session, failure?: string) => {
    if (session.current !== current) return;
    session.current = undefined;
    current.controller.abort();
    setStatus('idle');
    if (failure) setError(failure);
    onSavedRef.current();
  }, []);

  const handle = (current: Session, event: VoiceEvent) => {
    if (session.current !== current) return;
    switch (event.type) {
      case 'call': {
        const { call } = event;
        if (call.error) setError(call.error);
        if (call.status === 'active') {
          setStatus((value) => (value === 'ending' ? value : 'active'));
          setStartedAt((value) => value ?? call.startedAt);
        }
        if (call.status === 'ended' || call.status === 'failed') close(current);
        break;
      }
      case 'phase':
        setPhase(event.phase);
        break;
      case 'user':
        setCaption('');
        setUserCaption(event.text);
        break;
      case 'dot':
        setCaption(event.text);
        break;
      case 'error':
        setError(event.message);
        break;
    }
  };

  const watch = async (current: Session) => {
    try {
      const response = await fetch(`/api/voice/calls/${current.id}/events`, {
        headers: authHeaders(),
        signal: current.controller.signal,
      });
      if (!response.ok || !response.body)
        throw new Error('Call events could not connect.');
      await readEvents<VoiceEvent>(response, (event) => handle(current, event));
      // The server keeps this stream open for the whole call, so a clean end is a loss too.
      close(current, 'Call control connection was lost.');
    } catch (e) {
      if (current.controller.signal.aborted) return;
      close(
        current,
        e instanceof Error ? e.message : 'Call control connection was lost.',
      );
    }
  };

  const start = async () => {
    if (session.current || starting.current) return;
    starting.current = true;
    setStatus('connecting');
    setError('');
    setMuted(false);
    setSpeakerMuted(false);
    setStartedAt(undefined);
    setPhase('listening');
    setCaption('');
    setUserCaption('');
    try {
      const call = await api<{ id: string }>('/voice/calls', 'POST', {
        threadId,
      });
      const current: Session = {
        id: call.id,
        controller: new AbortController(),
      };
      session.current = current;
      void watch(current);
    } catch (e) {
      setStatus('idle');
      setError(e instanceof Error ? e.message : 'Could not start the call.');
    } finally {
      starting.current = false;
    }
  };

  const end = useCallback(async () => {
    const current = session.current;
    if (!current) return;
    setStatus('ending');
    try {
      await api(`/voice/calls/${current.id}/end`, 'POST', {
        anchorMessageId: anchor.current,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The call could not be saved.');
    }
    close(current);
  }, [close]);

  // Leaving the page ends the call, saving what it has so far.
  useEffect(
    () => () => {
      const current = session.current;
      if (!current) return;
      session.current = undefined;
      current.controller.abort();
      void fetch(`/api/voice/calls/${current.id}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ anchorMessageId: anchor.current }),
        keepalive: true,
      }).catch(() => {});
    },
    [],
  );

  const sendControls = (patch: { muted?: boolean; speakerMuted?: boolean }) => {
    const current = session.current;
    if (!current) return;
    api(`/voice/calls/${current.id}/controls`, 'POST', patch).catch((e) =>
      setError(e instanceof Error ? e.message : 'The call did not update.'),
    );
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    sendControls({ muted: next });
  };

  const toggleSpeaker = () => {
    const next = !speakerMuted;
    setSpeakerMuted(next);
    sendControls({ speakerMuted: next });
  };

  return {
    status,
    error,
    start,
    end,
    muted,
    speakerMuted,
    startedAt,
    phase,
    caption,
    userCaption,
    toggleMute,
    toggleSpeaker,
  };
}
