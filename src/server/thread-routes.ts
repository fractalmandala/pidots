import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Engine } from './engine/engine.js';
import type { WorkspaceStore } from './workspace.js';

const message = z
  .object({
    text: z.string().trim().min(1).max(40_000),
    requestId: z.string().min(1).max(100).optional(),
  })
  .strict();
const toolResult = z
  .object({ toolCallId: z.string().min(1).max(200), result: z.unknown() })
  .strict();

const failure = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** Chat threads: transcript, live event stream, sending, answers and stop. */
export function threadRoutes(workspace: WorkspaceStore, engine: Engine) {
  const app = new Hono();
  app.use('/threads/:id/*', async (c, next) => {
    try {
      workspace.requireThread(c.req.param('id'));
    } catch {
      return c.json({ error: 'Conversation not found.' }, 404);
    }
    await next();
  });
  app.get('/threads/:id/messages', async (c) =>
    c.json(await engine.messages(c.req.param('id'))),
  );
  app.get('/threads/:id/events', (c) =>
    streamSSE(c, async (stream) => {
      let stop: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      try {
        stop = await engine.watch(c.req.param('id'), (event) => {
          void stream.writeSSE({ data: JSON.stringify(event) });
        });
      } catch (error) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'error',
            message: failure(error, 'Conversation could not connect.'),
          }),
        });
        return;
      }
      const ping = setInterval(
        () => void stream.writeSSE({ event: 'ping', data: '' }),
        15_000,
      );
      await closed;
      clearInterval(ping);
      stop();
    }),
  );
  app.post('/threads/:id/messages', async (c) => {
    const parsed = message.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Enter a message up to 40,000 characters.' }, 400);
    try {
      const submission = await engine.send(
        c.req.param('id'),
        parsed.data.text,
        {
          requestId: parsed.data.requestId,
        },
      );
      return c.json({ submissionId: submission.id }, 202);
    } catch (error) {
      return c.json(
        { error: failure(error, 'Could not send this message.') },
        409,
      );
    }
  });
  app.post('/threads/:id/tool-results', async (c) => {
    const parsed = toolResult.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid tool result.' }, 400);
    return engine.respond(
      c.req.param('id'),
      parsed.data.toolCallId,
      parsed.data.result,
    )
      ? c.json({ ok: true })
      : c.json(
          { error: 'This request is no longer waiting for an answer.' },
          409,
        );
  });
  app.post('/threads/:id/stop', async (c) => {
    await engine.stop(c.req.param('id'));
    return c.json({ ok: true });
  });
  return app;
}
