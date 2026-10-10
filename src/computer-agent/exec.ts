import { spawn } from 'node:child_process';

export const OUTPUT_LIMIT = 200_000;

/** Runs a shell command in the workspace with a deadline and capped output. */
export function runCommand(
  command: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? options.cwd,
        LANG: 'C.UTF-8',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (size >= OUTPUT_LIMIT) {
        truncated = true;
        return;
      }
      const room = OUTPUT_LIMIT - size;
      if (chunk.length > room) truncated = true;
      target.push(chunk.subarray(0, room));
      size += Math.min(chunk.length, room);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    // Kill the whole process group so background children stop too.
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', kill);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        timedOut,
      });
    });
  });
}
