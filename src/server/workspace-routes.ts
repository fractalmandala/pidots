import { pageRoutes } from './page-routes.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { Platform } from './platform.js';
import { VoiceService } from './voice.js';
const dotSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    instructions: z.string().trim().min(3).max(2000),
    researchAllowed: z.boolean(),
    memoryAllowed: z.boolean(),
    spaceIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict();
export function workspaceRoutes(platform: Platform, voice: VoiceService) {
  const app = new Hono();
  app.route('/', pageRoutes(platform));
  app.get('/workspace', (c) =>
    c.json({
      spaces: platform.workspace.spaces(),
      dots: platform.workspace.dots(),
      conversations: platform.workspace.conversations(),
      setup: platform.setup(),
      calls: platform.workspace.calls(),
    }),
  );
  app.post('/spaces', async (c) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(60),
        description: z.string().max(500).default(''),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Enter a Space name (up to 60 characters).' },
        400,
      );
    return c.json(
      platform.workspace.createSpace(data.data.name, data.data.description),
      201,
    );
  });
  app.post('/dots', async (c) => {
    const data = dotSchema
      .extend({ spaceId: z.string() })
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        {
          error:
            'Provide a name, role instructions, and explicit tool permissions.',
        },
        400,
      );
    return c.json(
      platform.workspace.createDot(
        data.data.spaceId,
        data.data.name,
        data.data.instructions,
        data.data.researchAllowed,
        data.data.memoryAllowed,
        data.data.spaceIds,
      ),
      201,
    );
  });
  app.put('/dots/:id', async (c) => {
    const data = dotSchema.safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Invalid specialist settings.' }, 400);
    if (!platform.workspace.dot(c.req.param('id')))
      return c.json({ error: 'Dot not found.' }, 404);
    return c.json(platform.workspace.updateDot(c.req.param('id'), data.data));
  });
  app.post('/conversations', async (c) => {
    const data = z
      .object({
        dotId: z.string(),
        title: z.string().trim().min(1).max(120).default('A new thought'),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Select a Dot and a conversation title.' }, 400);
    if (platform.setup().missing.length)
      return c.json(
        { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
        503,
      );
    return c.json(
      await platform.createConversation(data.data.dotId, data.data.title),
      201,
    );
  });
  app.get('/conversations/:id/capture', (c) =>
    c.json(platform.workspace.capture(c.req.param('id'))),
  );
  app.get('/voice/voices', async (c) =>
    c.json({ voices: await voice.voices() }),
  );
  app.post('/voice/preview', async (c) => {
    const data = z
      .object({ voice: z.string().max(200).optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: 'Invalid voice.' }, 400);
    await voice.preview(data.data.voice);
    return c.json({ ok: true });
  });
  app.post('/voice/calls', async (c) => {
    const data = z
      .object({ threadId: z.string() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'A conversation is required.' }, 400);
    return c.json(voice.begin(data.data.threadId), 201);
  });
  app.get('/voice/calls/:id', (c) =>
    c.json(platform.workspace.call(c.req.param('id'))),
  );
  app.get('/voice/calls/:id/events', (c) =>
    streamSSE(c, async (stream) => {
      const id = c.req.param('id');
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      const send = (data: unknown) =>
        void stream.writeSSE({ data: JSON.stringify(data) });
      // Subscribe first, then send the current state, so no change is missed.
      const stop = voice.subscribe(id, send);
      send({ type: 'call', call: platform.workspace.call(id) });
      const ping = setInterval(
        () => void stream.writeSSE({ event: 'ping', data: '' }),
        15_000,
      );
      await closed;
      clearInterval(ping);
      stop();
    }),
  );
  app.post('/voice/calls/:id/controls', async (c) => {
    const data = z
      .object({
        muted: z.boolean().optional(),
        speakerMuted: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Mute settings must be true or false.' }, 400);
    return c.json(voice.controls(c.req.param('id'), data.data));
  });
  app.post('/voice/calls/:id/end', async (c) => {
    const data = z
      .object({ anchorMessageId: z.string().max(200).optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: 'Invalid call request.' }, 400);
    platform.workspace.anchorCall(c.req.param('id'), data.data.anchorMessageId);
    return c.json(await voice.end(c.req.param('id')));
  });
  app.onError((error, c) => {
    const text = error.message;
    if (text.startsWith('Space access must include'))
      return c.json({ error: text }, 400);
    const known =
      /^(Setup|Voice setup|Voice calls|Dot |Space |Specialist |Conversation |Call |This call|End the current|Voice provider|Agents are paused)/.test(
        text,
      );
    // A conversation, call or Dot the caller named that does not exist is a missing resource, not a
    // server fault.
    if (
      /^(Dot not found|Call not found|Conversation does not belong)/.test(text)
    )
      return c.json({ error: text }, 404);
    return c.json(
      {
        error: known
          ? text
          : 'The service request failed. Check the server configuration and try again.',
      },
      503,
    );
  });
  return app;
}
