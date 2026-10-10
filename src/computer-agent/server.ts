import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { computerInputs } from '../shared/computer-types.js';
import { Browser, BrowserError } from './browser.js';
import { Control, ControlError } from './control.js';
import { FileError, Workspace } from './files.js';
import { runCommand } from './exec.js';

export interface AgentOptions {
  /** This computer's Dot; requests for any other Dot are refused. */
  dotId: string;
  token: string;
  workspace: string;
  browser: Browser;
  control: Control;
}

const BODY_LIMIT = 1_100_000;
const requestSchema = z
  .object({ reason: z.string().max(500).optional() })
  .strict();
const decisionSchema = z
  .object({ requestId: z.string().min(1).max(100) })
  .strict();

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError('Request is too large.', 413);
    chunks.push(chunk);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError('Send JSON.', 400);
  }
}

function authorized(request: IncomingMessage, options: AgentOptions) {
  const supplied = Buffer.from(
    request.headers.authorization?.replace(/^Bearer /, '') ?? '',
  );
  const expected = Buffer.from(options.token);
  return (
    supplied.length === expected.length &&
    timingSafeEqual(supplied, expected) &&
    request.headers['x-pidots-dot-id'] === options.dotId
  );
}

/** The computer service each Dot's VM runs; the broker is its only caller. */
export function createAgentServer(options: AgentOptions): Server {
  const files = new Workspace(options.workspace);
  const { browser, control } = options;
  const parse = <K extends keyof typeof computerInputs>(
    action: K,
    input: unknown,
  ) =>
    computerInputs[action].parse(input ?? {}) as z.infer<
      (typeof computerInputs)[K]
    >;

  const routes: Record<
    string,
    (input: unknown, signal: AbortSignal) => Promise<unknown>
  > = {
    'GET /control': async () => control.value,
    'POST /control/request': async (input) => {
      requestSchema.parse(input ?? {});
      return control.request();
    },
    'POST /control/take': async (input) =>
      control.take(decisionSchema.parse(input).requestId),
    'POST /control/release': async (input) =>
      control.release(decisionSchema.parse(input).requestId),
    'POST /navigate': async (input) =>
      browser.navigate(parse('navigate', input).url),
    'GET /read': async () => browser.read(),
    'POST /read': async () => browser.read(),
    'POST /snapshot': async () => browser.snapshot(),
    'GET /screenshot': async () => browser.screenshot(),
    'POST /screenshot': async () => browser.screenshot(),
    'POST /click': async (input) => {
      const { ref, snapshotId } = parse('click', input);
      return browser.click(ref, snapshotId);
    },
    'POST /type': async (input) => {
      const { ref, snapshotId, text, submit } = parse('type', input);
      return browser.type(ref, snapshotId, text, submit);
    },
    'POST /key': async (input) => browser.key(parse('key', input).key),
    'POST /scroll': async (input) =>
      browser.scroll(parse('scroll', input).deltaY),
    'POST /files/list': async (input) =>
      files.list(parse('files_list', input).path),
    'POST /files/read': async (input) =>
      files.read(parse('files_read', input).path),
    'POST /files/write': async (input) => {
      const { path, contents, append } = parse('files_write', input);
      return files.write(path, contents, append);
    },
    'POST /exec': async (input, signal) => {
      const { command, timeoutMs } = parse('exec', input);
      return runCommand(command, { cwd: options.workspace, timeoutMs, signal });
    },
    'POST /human/click': async (input) => {
      const { x, y } = parse('human_click', input);
      return browser.humanClick(x, y);
    },
    'POST /human/type': async (input) =>
      browser.humanType(parse('human_type', input).text),
    'POST /human/key': async (input) =>
      browser.key(parse('human_key', input).key, 'owner'),
    'POST /human/scroll': async (input) =>
      browser.scroll(parse('human_scroll', input).deltaY, 'owner'),
  };

  return createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(value));
    };
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    try {
      if (!authorized(request, options))
        throw new HttpError('Not authorized for this computer.', 401);
      const path = new URL(request.url ?? '/', 'http://computer').pathname;
      const route = routes[`${request.method} ${path}`];
      if (!route) throw new HttpError('Unknown computer action.', 404);
      reply(200, await route(await body(request), controller.signal));
    } catch (error) {
      const status =
        error instanceof HttpError ||
        error instanceof FileError ||
        error instanceof BrowserError ||
        error instanceof ControlError
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : 500;
      reply(status, {
        error:
          status === 500
            ? 'The computer could not complete this action. It may have partly happened.'
            : error instanceof z.ZodError
              ? 'Invalid computer request.'
              : (error as Error).message,
      });
    }
  });
}
