import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SpeechVoice } from '../shared/types.js';

export type { SpeechVoice };

/** A report from `pidots-speech`: one JSON object per stdout line. */
export type SpeechEvent =
  | { type: 'ready' | 'listening' | 'speaking_done' }
  | { type: 'partial' | 'final'; text: string }
  | { type: 'voices'; list: SpeechVoice[] }
  | { type: 'error'; message: string };

/** A request to `pidots-speech`: one JSON object per stdin line. */
export type SpeechCommand =
  | { cmd: 'listen' | 'pause' | 'stop' | 'voices' }
  | { cmd: 'speak'; text: string; voice?: string };

/** A running helper, as the voice service drives it. */
export interface SpeechProcess {
  send(command: SpeechCommand): void;
  /** Ends the helper. Closing its stdin makes it exit on its own. */
  close(): void;
}

export type StartSpeech = (
  onEvent: (event: SpeechEvent) => void,
  onExit: () => void,
) => SpeechProcess;

/**
 * The helper bundled in Pidots.app (Resources/speech, next to the Node binary
 * that runs this server), or PIDOTS_SPEECH_HELPER. Undefined when neither
 * exists, for example when running `npm run dev`; voice calls are then off.
 */
export function speechHelperPath(): string | undefined {
  return [
    process.env.PIDOTS_SPEECH_HELPER,
    join(dirname(process.execPath), 'speech', 'pidots-speech'),
  ].find((path): path is string => !!path && existsSync(path));
}

export function startSpeechHelper(
  path: string,
  onEvent: (event: SpeechEvent) => void,
  onExit: () => void,
): SpeechProcess {
  const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    onExit();
  };
  child.stdin.on('error', () => {});
  child.on('error', exit);
  child.on('exit', exit);
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      onEvent(JSON.parse(line) as SpeechEvent);
    } catch {
      // Ignore lines that are not events.
    }
  });
  return {
    send(command) {
      if (!exited) child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    close() {
      if (exited) return;
      child.stdin.end();
      setTimeout(() => {
        if (!exited) child.kill();
      }, 2000).unref();
    },
  };
}

/** Asks a helper for the installed voices, then stops it. */
export function listSpeechVoices(path: string): Promise<SpeechVoice[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      helper.close();
      reject(new Error('Voices did not load.'));
    }, 10_000);
    const helper = startSpeechHelper(
      path,
      (event) => {
        if (event.type === 'ready') helper.send({ cmd: 'voices' });
        if (event.type === 'voices') {
          clearTimeout(timer);
          helper.close();
          resolve(event.list);
        }
      },
      () => {
        clearTimeout(timer);
        reject(new Error('The speech helper stopped.'));
      },
    );
  });
}
