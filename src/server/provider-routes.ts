import { Hono } from 'hono';
import type { Store } from './store.js';
import {
  addProvider,
  listProviderModels,
  providerInput,
  providerPatch,
  providerSettingsView,
  removeProvider,
  servicesPatch,
  updateProvider,
  updateServices,
  type ProviderSettings,
} from './provider-settings.js';

class SettingsRejected extends Error {}

/**
 * Provider and service keys, edited from the Providers dialog.
 * `apply` rebuilds the runtime with the saved settings before responding, so
 * the next `/api/workspace` read reflects the new setup state.
 */
export function providerRoutes(
  store: Store,
  apply: () => Promise<void>,
  builtinComputers = false,
) {
  const app = new Hono();
  const save = async (settings: ProviderSettings) => {
    const previous = store.providerSettings();
    store.saveProviderSettings(settings);
    try {
      await apply();
    } catch (error) {
      store.saveProviderSettings(previous);
      throw new SettingsRejected(
        error instanceof Error ? error.message : 'Settings were rejected.',
      );
    }
    return providerSettingsView(store.providerSettings(), builtinComputers);
  };
  const issue = (error: { issues: { message: string }[] }) =>
    error.issues[0]?.message ?? 'Invalid provider settings.';

  app.onError((error, c) =>
    error instanceof SettingsRejected
      ? c.json({ error: error.message }, 400)
      : c.json({ error: 'Could not save provider settings.' }, 500),
  );
  app.get('/providers', (c) =>
    c.json(providerSettingsView(store.providerSettings(), builtinComputers)),
  );
  app.post('/providers', async (c) => {
    const parsed = providerInput.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: issue(parsed.error) }, 400);
    const { settings } = addProvider(store.providerSettings(), parsed.data);
    return c.json(await save(settings), 201);
  });
  app.put('/providers/:id', async (c) => {
    const parsed = providerPatch.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: issue(parsed.error) }, 400);
    const settings = updateProvider(
      store.providerSettings(),
      c.req.param('id'),
      parsed.data,
    );
    if (!settings) return c.json({ error: 'Provider not found.' }, 404);
    return c.json(await save(settings));
  });
  app.delete('/providers/:id', async (c) => {
    const settings = removeProvider(
      store.providerSettings(),
      c.req.param('id'),
    );
    if (!settings) return c.json({ error: 'Provider not found.' }, 404);
    return c.json(await save(settings));
  });
  app.get('/providers/:id/models', async (c) => {
    const provider = store
      .providerSettings()
      .providers.find((item) => item.id === c.req.param('id'));
    if (!provider) return c.json({ error: 'Provider not found.' }, 404);
    try {
      return c.json({ models: await listProviderModels(provider) });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error && !error.name.includes('Abort')
              ? error.message
              : 'The provider did not respond.',
        },
        502,
      );
    }
  });
  app.put('/services', async (c) => {
    const parsed = servicesPatch.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: issue(parsed.error) }, 400);
    let settings: ProviderSettings;
    try {
      settings = updateServices(store.providerSettings(), parsed.data);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Invalid settings.' },
        400,
      );
    }
    return c.json(await save(settings));
  });
  return app;
}
