import { createShutdown } from './shutdown.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { resolveAppOrigins } from './app-origin.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import {
  platformConfigFrom,
  type BuiltinComputers,
} from './provider-settings.js';
import { Engine } from './engine/engine.js';
import { speechHelperPath } from './speech.js';
import type { Hono } from 'hono';

// No `.env` is needed: model providers, API keys and service secrets are added
// in the Providers dialog and stored in the local database. The variables below
// are optional deployment overrides only; none of them hold provider keys.
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const ownerToken = process.env.OWNER_TOKEN;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  (!ownerToken || ownerToken.length < 24)
)
  throw new Error(
    'External binding requires an OWNER_TOKEN of at least 24 characters.',
  );
const database = process.env.DATABASE_PATH ?? 'data/pidots.sqlite';
const store = new Store(database);
const workspace = new WorkspaceStore(
  database,
  process.env.OWNER_ID ?? 'pidots-owner',
);
const origin = resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV);
const report = (operation: string, error: unknown) =>
  console.error(
    `${operation}:`,
    error instanceof Error ? error.message : 'unknown error',
  );

// Conversations live in a durable store next to the workspace database.
const engine = new Engine({
  store,
  workspace,
  storage:
    database === ':memory:'
      ? ':memory:'
      : join(dirname(database), 'pidots-durable.sqlite'),
});

// The macOS app runs its own computer service and hands this server its
// address and tokens in a private file (never through API-key settings).
function builtinComputers(): BuiltinComputers | undefined {
  const file = process.env.PIDOTS_COMPUTERS_FILE;
  if (!file) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as BuiltinComputers;
    return value.url && value.supervisorToken && value.computerToken
      ? value
      : undefined;
  } catch {
    report('Built-in computers are unavailable', new Error('unreadable'));
    return undefined;
  }
}

interface Runtime {
  platform: Platform;
  runner: Runner;
  app: Hono;
}

function buildRuntime(): Runtime {
  const computers = builtinComputers();
  const config = platformConfigFrom(store.providerSettings(), {
    ownerToken,
    builtinComputers: computers,
    speechHelper: speechHelperPath(),
  });
  const platform = new Platform(store, workspace, config, engine);
  const researchConfig = {
    mode: 'live' as const,
    apiKey: config.chatProvider
      ? (config.chatProvider.apiKey ?? 'local')
      : undefined,
    model: config.model,
    baseUrl: config.chatProvider?.baseUrl ?? '',
    webSearchProvider: config.webSearchProvider,
    parallelApiKey: config.parallelApiKey,
    browserUrl: config.browserUrl,
    browserSecret: config.browserSecret,
  };
  const runner = new Runner(
    store,
    researchConfig,
    async (claim, _memories, signal, progress) => {
      const threadId = workspace.taskThread(claim.id);
      if (!threadId)
        throw new Error(
          'This task has no conversation. Create a new scheduled task from a conversation.',
        );
      progress('Running this task in its conversation.');
      const text = await platform.turn(
        threadId,
        claim.prompt,
        signal,
        'scheduled_task',
      );
      return { text, sources: [], sample: false };
    },
  );
  const app = createApp({
    store,
    runner,
    config: researchConfig,
    ownerToken,
    origin,
    platform,
    applyProviders: () => reload(),
    builtinComputers: !!computers,
  });
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    // Hashed assets can be cached; the HTML shell must revalidate after upgrades.
    if (!c.req.path.startsWith('/assets/'))
      c.header('Cache-Control', 'no-cache');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    await next();
  });
  app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
  app.use('/*', serveStatic({ root: './dist/client' }));
  app.get('*', serveStatic({ path: './dist/client/index.html' }));
  return { platform, runner, app };
}

// Provider changes take effect immediately: the engine keeps its durable
// storage open and receives the new settings; the API is rebuilt around it.
let reloading = Promise.resolve();
function reload(): Promise<void> {
  const next = reloading.then(() => {
    const replacement = buildRuntime();
    runtime.runner.stop();
    runtime = replacement;
    runtime.runner.start();
  });
  reloading = next.catch(() => undefined);
  return next;
}

await engine.open();
let runtime = buildRuntime();
const server = serve(
  {
    fetch: (request, env) => runtime.app.fetch(request, env),
    hostname: host,
    port,
  },
  (info) => {
    console.log(`Pidots listening on http://${host}:${info.port}`);
    runtime.runner.start();
  },
);
const shutdown = createShutdown({
  stopRunner: () => runtime.runner.stop(),
  stopPlatform: () => engine.close(),
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  exit: (code) => process.exit(code),
  report,
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// The desktop shell holds our stdin open; when it exits, so do we.
if (process.env.PIDOTS_DESKTOP === '1') {
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.resume();
}
