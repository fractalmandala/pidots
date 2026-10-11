import { Hono } from 'hono';
import { z } from 'zod';
import type { ComputerService } from './computer-service.js';
import type { ComputerAction } from '../shared/computer-types.js';
import { pickPaths } from './folder-picker.js';
export function computerRoutes(
  computers: ComputerService,
  pick: typeof pickPaths = pickPaths,
) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? 'Invalid computer request.'
            : error.message,
      },
      400,
    ),
  );
  app.get('/dots/:id/computer', async (c) =>
    c.json(await computers.status(c.req.param('id'))),
  );
  app.patch('/dots/:id/computer/permissions', async (c) =>
    c.json(await computers.permissions(c.req.param('id'), await c.req.json())),
  );
  // Shared folders: the owner picks them in the macOS open panel, or names a path.
  app.post('/dots/:id/computer/folders/pick', async (c) => {
    const { kind } = z
      .object({ kind: z.enum(['directory', 'file']).default('directory') })
      .strict()
      .parse(await c.req.json().catch(() => ({})));
    const id = c.req.param('id');
    const paths = await pick(
      kind,
      kind === 'file'
        ? 'Choose files this Dot can read and change'
        : 'Choose folders this Dot can read and change',
    );
    return c.json(
      paths.length
        ? await computers.addFolders(id, paths)
        : await computers.status(id),
    );
  });
  app.post('/dots/:id/computer/folders', async (c) => {
    const { path } = z
      .object({ path: z.string().min(1).max(1024) })
      .strict()
      .parse(await c.req.json());
    return c.json(await computers.addFolders(c.req.param('id'), [path]));
  });
  app.post('/dots/:id/computer/folders/remove', async (c) => {
    const { path } = z
      .object({ path: z.string().min(1).max(1024) })
      .strict()
      .parse(await c.req.json());
    return c.json(await computers.removeFolder(c.req.param('id'), path));
  });
  app.post('/dots/:id/computer/start', async (c) =>
    c.json(await computers.start(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/stop', async (c) =>
    c.json(await computers.stop(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/delete', async (c) =>
    c.json(await computers.delete(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/take', async (c) =>
    c.json(await computers.control(c.req.param('id'), 'take')),
  );
  app.post('/dots/:id/computer/release', async (c) =>
    c.json(await computers.control(c.req.param('id'), 'release')),
  );
  app.post('/dots/:id/computer/actions', async (c) => {
    const body = z
      .object({ action: z.string(), input: z.unknown() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await computers.action(
        c.req.param('id'),
        body.action as ComputerAction,
        body.input,
        'owner',
        c.req.raw.signal,
      ),
    );
  });
  return app;
}
