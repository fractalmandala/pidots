import type { WebConfig } from './parallel.js';
import type { ModelProvider } from './provider-settings.js';
import type { SetupStatus } from '../shared/types.js';

export const CHAT_PROVIDER_MISSING_LABEL = 'Chat model provider';
export const CHAT_MODEL_MISSING_LABEL = 'Chat model';

export interface PlatformConfig extends WebConfig {
  /** The provider and model every Dot uses for text turns. */
  chatProvider?: ModelProvider;
  model?: string;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  /** The bundled `pidots-speech` helper. Voice calls are off without it. */
  speechHelper?: string;
  /** The Apple voice that speaks replies. The system default when unset. */
  voiceId?: string;
  ownerToken?: string;
}
export function setupStatus(config: PlatformConfig): SetupStatus {
  const missing = [
    !config.chatProvider && CHAT_PROVIDER_MISSING_LABEL,
    !config.model && CHAT_MODEL_MISSING_LABEL,
  ].filter((item): item is string => !!item);
  return {
    model: !missing.length,
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!config.speechHelper,
    missing,
  };
}
