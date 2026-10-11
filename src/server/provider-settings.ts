import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WebSearchProvider } from './parallel.js';
import type { PlatformConfig } from './platform-config.js';
import type {
  ProviderPreset,
  ProviderSettingsView,
  SecretView,
} from '../shared/types.js';

// API keys and service secrets live in the local database and are edited in
// the Providers dialog. They are never read from the environment or a `.env`
// file, and the API only ever returns masked hints.

export const providerApis = [
  'openai-compatible',
  'openai',
  'anthropic',
  'google',
] as const;
/** The wire protocol a provider speaks. */
export type ProviderApi = (typeof providerApis)[number];
export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** Absent on providers saved before API types existed. */
  api?: ProviderApi;
  apiKey?: string;
  keyUrl?: string;
}
export interface ProviderSettings {
  providers: ModelProvider[];
  chat: { providerId?: string; model?: string };
  /** The Apple voice that speaks replies on calls (an AVSpeechSynthesisVoice id). */
  voice: { voice?: string };
  web: {
    provider: WebSearchProvider;
    parallelApiKey?: string;
    browserUrl?: string;
    browserSecret?: string;
  };
  computers: {
    /** `builtin` uses the app's own computers; `custom` a service you run. */
    mode?: 'builtin' | 'custom';
    supervisorUrl?: string;
    supervisorToken?: string;
    computerToken?: string;
    namespace?: string;
  };
}

export const emptyProviderSettings = (): ProviderSettings => ({
  providers: [],
  chat: {},
  voice: {},
  web: { provider: 'parallel' },
  computers: {},
});

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    name: 'OpenAI',
    api: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    model: 'gpt-5-mini',
  },
  {
    name: 'Anthropic',
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    model: 'claude-sonnet-5-5',
  },
  {
    name: 'OpenRouter',
    api: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    name: 'Groq',
    api: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    name: 'Google Gemini',
    api: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    name: 'Mistral',
    api: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    name: 'Together AI',
    api: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    keyUrl: 'https://api.together.ai/settings/api-keys',
  },
  {
    name: 'Ollama (local)',
    api: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
  },
  {
    name: 'LM Studio (local)',
    api: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
  },
];

const trimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || undefined);
const httpUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    if (!value) return true;
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Enter an http(s) URL.')
  .transform((value) => value.replace(/\/+$/, '') || undefined);
// A secret field: a string sets it, null clears it, absent keeps it.
const secret = z.string().trim().max(4000).nullable().optional();

export const providerInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    baseUrl: httpUrl.refine(Boolean, 'Enter the provider base URL.'),
    api: z.enum(providerApis).optional(),
    apiKey: secret,
    keyUrl: httpUrl.optional(),
  })
  .strict();
export const providerPatch = providerInput.partial().strict();

export const servicesPatch = z
  .object({
    chat: z
      .object({
        providerId: trimmed(80).optional(),
        model: trimmed(200).optional(),
      })
      .strict()
      .optional(),
    voice: z
      .object({
        voice: trimmed(200).optional(),
      })
      .strict()
      .optional(),
    web: z
      .object({
        provider: z.enum(['parallel', 'browser', 'disabled']).optional(),
        parallelApiKey: secret,
        browserUrl: httpUrl.optional(),
        browserSecret: secret,
      })
      .strict()
      .optional(),
    computers: z
      .object({
        mode: z.enum(['builtin', 'custom']).optional(),
        supervisorUrl: httpUrl.optional(),
        supervisorToken: secret,
        computerToken: secret,
        namespace: trimmed(60).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function applySecret(
  current: string | undefined,
  next: string | null | undefined,
): string | undefined {
  if (next === undefined) return current;
  return next || undefined;
}

function applyFields<T extends object>(
  current: T,
  patch: Record<string, unknown> | undefined,
  secrets: readonly string[] = [],
): T {
  if (!patch) return current;
  const result = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (secrets.includes(key))
      result[key] = applySecret(
        result[key] as string | undefined,
        value as string | null | undefined,
      );
    else result[key] = value;
  }
  return result as T;
}

export function addProvider(
  settings: ProviderSettings,
  input: z.infer<typeof providerInput>,
): { settings: ProviderSettings; provider: ModelProvider } {
  const provider: ModelProvider = {
    id: randomUUID(),
    name: input.name,
    baseUrl: input.baseUrl!,
    api: input.api ?? 'openai-compatible',
    apiKey: input.apiKey || undefined,
    keyUrl: input.keyUrl,
  };
  const next = { ...settings, providers: [...settings.providers, provider] };
  // The first provider becomes the chat provider so setup is one step.
  if (!next.chat.providerId)
    next.chat = { ...next.chat, providerId: provider.id };
  return { settings: next, provider };
}

export function updateProvider(
  settings: ProviderSettings,
  id: string,
  patch: z.infer<typeof providerPatch>,
): ProviderSettings | undefined {
  const index = settings.providers.findIndex((item) => item.id === id);
  if (index < 0) return undefined;
  const providers = [...settings.providers];
  providers[index] = applyFields(providers[index], patch, ['apiKey']);
  return { ...settings, providers };
}

export function removeProvider(
  settings: ProviderSettings,
  id: string,
): ProviderSettings | undefined {
  if (!settings.providers.some((item) => item.id === id)) return undefined;
  const unset = <T extends { providerId?: string }>(role: T): T =>
    role.providerId === id ? { ...role, providerId: undefined } : role;
  return {
    ...settings,
    providers: settings.providers.filter((item) => item.id !== id),
    chat: unset(settings.chat),
  };
}

export function updateServices(
  settings: ProviderSettings,
  patch: z.infer<typeof servicesPatch>,
): ProviderSettings {
  for (const role of [patch.chat?.providerId])
    if (role && !settings.providers.some((item) => item.id === role))
      throw new Error('Choose a provider that exists.');
  return {
    ...settings,
    chat: applyFields(settings.chat, patch.chat),
    voice: applyFields(settings.voice, patch.voice),
    web: applyFields(settings.web, patch.web, [
      'parallelApiKey',
      'browserSecret',
    ]),
    computers: applyFields(settings.computers, patch.computers, [
      'supervisorToken',
      'computerToken',
    ]),
  };
}

export function secretView(value?: string): SecretView {
  return value
    ? { set: true, hint: value.length > 8 ? `…${value.slice(-4)}` : '…' }
    : { set: false };
}

/** The app's own computer service, when Pidots runs as the macOS app. */
export interface BuiltinComputers {
  url: string;
  supervisorToken: string;
  computerToken: string;
}

export function providerSettingsView(
  settings: ProviderSettings,
  builtinAvailable = false,
): ProviderSettingsView {
  return {
    providers: settings.providers.map(({ apiKey, ...provider }) => ({
      ...provider,
      api: provider.api ?? 'openai-compatible',
      apiKey: secretView(apiKey),
    })),
    chat: settings.chat,
    voice: settings.voice,
    web: {
      provider: settings.web.provider,
      parallelApiKey: secretView(settings.web.parallelApiKey),
      browserUrl: settings.web.browserUrl,
      browserSecret: secretView(settings.web.browserSecret),
    },
    computers: {
      mode: settings.computers.mode ?? 'builtin',
      builtinAvailable,
      supervisorUrl: settings.computers.supervisorUrl,
      supervisorToken: secretView(settings.computers.supervisorToken),
      computerToken: secretView(settings.computers.computerToken),
      namespace: settings.computers.namespace,
    },
    presets: PROVIDER_PRESETS,
  };
}

export function platformConfigFrom(
  settings: ProviderSettings,
  runtime: {
    ownerToken?: string;
    builtinComputers?: BuiltinComputers;
    speechHelper?: string;
  },
): PlatformConfig {
  const builtin =
    (settings.computers.mode ?? 'builtin') === 'builtin'
      ? runtime.builtinComputers
      : undefined;
  const provider = (id?: string) =>
    settings.providers.find((item) => item.id === id);
  const chat = provider(settings.chat.providerId);
  return {
    chatProvider: chat,
    model: chat ? settings.chat.model : undefined,
    webSearchProvider: settings.web.provider,
    parallelApiKey: settings.web.parallelApiKey,
    browserUrl: settings.web.browserUrl,
    browserSecret: settings.web.browserSecret,
    ...(builtin
      ? {
          computerSupervisorUrl: builtin.url,
          computerSupervisorToken: builtin.supervisorToken,
          computerToken: builtin.computerToken,
          computerNamespace: 'pidots',
        }
      : {
          computerSupervisorUrl: settings.computers.supervisorUrl,
          computerSupervisorToken: settings.computers.supervisorToken,
          computerToken: settings.computers.computerToken,
          computerNamespace: settings.computers.namespace,
        }),
    speechHelper: runtime.speechHelper,
    voiceId: settings.voice.voice,
    ownerToken: runtime.ownerToken,
  };
}

/** Lists model ids from the provider's `GET {baseUrl}/models`. */
export async function listProviderModels(
  provider: ModelProvider,
  signal?: AbortSignal,
): Promise<string[]> {
  const api = provider.api ?? 'openai-compatible';
  const base = provider.baseUrl.replace(/\/+$/, '');
  const url =
    api === 'anthropic'
      ? `${base.replace(/\/v1$/, '')}/v1/models`
      : `${base}/models`;
  const key = provider.apiKey;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(key
        ? api === 'anthropic'
          ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
          : api === 'google'
            ? { 'x-goog-api-key': key }
            : { Authorization: `Bearer ${key}` }
        : {}),
    },
    signal: AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'The provider rejected this API key.'
        : `The provider returned ${response.status} for /models.`,
    );
  const body = z
    .union([
      z.object({ data: z.array(z.object({ id: z.string() })).max(5000) }),
      // Gemini lists `models: [{ name: "models/<id>" }]`.
      z.object({ models: z.array(z.object({ name: z.string() })).max(5000) }),
    ])
    .safeParse(await response.json().catch(() => null));
  if (!body.success)
    throw new Error('The provider did not return a model list.');
  const ids =
    'data' in body.data
      ? body.data.data.map((item) => item.id)
      : body.data.models.map((item) => item.name.replace(/^models\//, ''));
  return [...new Set(ids)].sort();
}
