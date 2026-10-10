import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type MutableModels,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { withOpenCodeSessionHeader } from '@earendil-works/pi-ai/providers/opencode-headers';
import { OPENCODE_GO_MODELS } from '@earendil-works/pi-ai/providers/opencode-go.models';
import { OPENCODE_MODELS } from '@earendil-works/pi-ai/providers/opencode.models';
import type { ModelProvider, ProviderApi } from '../provider-settings.js';

export interface ModelChoice {
  provider: ModelProvider;
  modelId: string;
}

const wire: Record<ProviderApi, Api> = {
  'openai-compatible': 'openai-completions',
  openai: 'openai-responses',
  anthropic: 'anthropic-messages',
  google: 'google-generative-ai',
};
const streams = {
  'openai-compatible': openAICompletionsApi,
  openai: openAIResponsesApi,
  anthropic: anthropicMessagesApi,
  google: googleGenerativeAIApi,
} satisfies Record<ProviderApi, () => unknown>;

/** Sent to every provider so services can identify the client. */
export const USER_AGENT = 'pidots/0.1';

/** OpenCode Zen and Go route by a stable per-conversation session header. */
function isOpenCode(provider: ModelProvider) {
  try {
    const host = new URL(provider.baseUrl).hostname;
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

/**
 * OpenCode serves several wire protocols behind one base URL, so a model's
 * own catalog entry (API, endpoint, limits) wins over the provider's API type.
 */
function openCodeModel(modelId: string): Model<Api> | undefined {
  const catalogs = [OPENCODE_GO_MODELS, OPENCODE_MODELS] as unknown as Record<
    string,
    Model<Api>
  >[];
  for (const catalog of catalogs) {
    const model = Object.values(catalog).find((item) => item.id === modelId);
    if (model) return model;
  }
  return undefined;
}

/** pi-ai provider id for a Providers & keys entry. */
export const piProviderId = (provider: ModelProvider) => `p-${provider.id}`;

function baseUrlFor(provider: ModelProvider) {
  const url = provider.baseUrl.replace(/\/+$/, '');
  // The Anthropic SDK appends /v1 itself.
  return provider.api === 'anthropic' ? url.replace(/\/v1$/, '') : url;
}

/**
 * Builds the model registry from Providers & keys. Every provider is a custom
 * pi-ai provider whose key comes only from saved settings: pi-ai's built-in
 * providers are never registered, so it never reads keys from the environment
 * and never fetches a remote catalog.
 */
export function buildModels(choices: ModelChoice[]): MutableModels {
  const models = createModels();
  registerProviders(models, choices);
  return models;
}

/** Adds or replaces (by id) the providers for these choices. */
export function registerProviders(
  models: MutableModels,
  choices: ModelChoice[],
) {
  const byProvider = new Map<string, ModelChoice[]>();
  for (const choice of choices) {
    const list = byProvider.get(choice.provider.id) ?? [];
    if (!list.some((item) => item.modelId === choice.modelId))
      list.push(choice);
    byProvider.set(choice.provider.id, list);
  }
  for (const list of byProvider.values()) {
    const provider = list[0].provider;
    const api = provider.api ?? 'openai-compatible';
    const id = piProviderId(provider);
    const baseUrl = baseUrlFor(provider);
    const key = provider.apiKey;
    const openCode = isOpenCode(provider);
    const definitions = list.map(({ modelId }): Model<Api> => {
      const known = openCode ? openCodeModel(modelId) : undefined;
      if (known)
        return {
          ...known,
          provider: id,
          headers: { ...known.headers, 'User-Agent': USER_AGENT },
        };
      return {
        headers: { 'User-Agent': USER_AGENT },
        id: modelId,
        name: modelId,
        api: wire[api],
        provider: id,
        baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      };
    });
    const apis = Object.fromEntries(
      [...new Set(definitions.map((model) => model.api))].map((wireApi) => {
        const entry = (Object.keys(wire) as ProviderApi[]).find(
          (name) => wire[name] === wireApi,
        );
        const implementation = (
          entry ? streams[entry] : streams['openai-compatible']
        )();
        return [
          wireApi,
          openCode ? withOpenCodeSessionHeader(implementation) : implementation,
        ];
      }),
    );
    models.setProvider(
      createProvider({
        id,
        name: provider.name,
        baseUrl,
        auth: {
          apiKey: {
            name: `${provider.name} API key`,
            // Keyless local servers (Ollama, LM Studio) ignore the key, but
            // the request path requires one, so send a placeholder.
            resolve: async () => ({
              auth: { apiKey: key || 'local' },
              source: 'Providers & keys',
            }),
          },
        },
        models: definitions,
        api: apis,
      }),
    );
  }
}
