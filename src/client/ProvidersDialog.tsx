import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUpRight, KeyRound, Pencil, Plus, Trash2, X } from 'lucide-react';
import type {
  ProviderApi,
  ProviderSettingsView,
  ProviderView,
  SecretView,
  SpeechVoice,
  WorkspaceState,
} from '../shared/types';
import { api } from './api';

type Save = (
  path: string,
  method: string,
  body?: unknown,
) => Promise<string | undefined>;

const apiLabels: Record<ProviderApi, string> = {
  'openai-compatible': 'OpenAI-compatible',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
};

/** Model providers, API keys and service links. Replaces the old `.env` setup. */
export function ProvidersDialog({
  workspace,
  onClose,
  onChanged,
}: {
  workspace: WorkspaceState;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const [view, setView] = useState<ProviderSettingsView>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    api<ProviderSettingsView>('/providers')
      .then(setView)
      .catch((error: unknown) =>
        setLoadError(
          error instanceof Error ? error.message : 'Could not load providers.',
        ),
      );
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  const save: Save = async (path, method, body) => {
    try {
      setView(await api<ProviderSettingsView>(path, method, body));
      await onChanged();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not save.';
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal providers-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="providers-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">PROVIDERS & KEYS</span>
        <h2 id="providers-title">Bring your own models.</h2>
        <p className="muted">
          Keys are stored only in this workspace’s local database and are never
          shown again after saving. Changes apply immediately — no{' '}
          <code>.env</code> file or restart needed.
        </p>
        <SetupSummary workspace={workspace} />
        {loadError && (
          <p className="chat-error" role="alert">
            {loadError}
          </p>
        )}
        {!view && !loadError && <p className="muted">Loading…</p>}
        {view && (
          <div className="providers-grid">
            <div className="providers-column">
              <ProviderList view={view} save={save} />
              <ChatSection
                key={sectionKey(
                  view.chat,
                  view.providers.map((p) => p.id),
                )}
                view={view}
                save={save}
              />
            </div>
            <div className="providers-column">
              <VoiceSection
                key={sectionKey(view.voice)}
                view={view}
                save={save}
              />
            </div>
            <div className="providers-column">
              <WebSection key={sectionKey(view.web)} view={view} save={save} />
              <details className="providers-advanced">
                <summary>Advanced: computers</summary>
                <ComputersSection view={view} save={save} />
              </details>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// Remount a section's form when its saved values change, so local field
// state starts from what the server now holds.
function sectionKey(...values: unknown[]) {
  return JSON.stringify(values);
}

function SetupSummary({ workspace }: { workspace: WorkspaceState }) {
  const missing = workspace.setup.missing;
  return (
    <div className={`providers-status ${missing.length ? 'pending' : 'ready'}`}>
      <span className="status-dot" />
      {missing.length
        ? `Still needed: ${missing.join(', ')}.`
        : 'Ready to chat. A successful conversation confirms connectivity.'}
    </div>
  );
}

function ProviderList({
  view,
  save,
}: {
  view: ProviderSettingsView;
  save: Save;
}) {
  const [editing, setEditing] = useState<string | 'new' | undefined>(
    view.providers.length ? undefined : 'new',
  );
  return (
    <fieldset className="providers-section">
      <legend>Model providers</legend>
      <p className="muted">
        Paste a provider’s base URL (link) and API key. Most services speak the
        OpenAI-compatible API; local servers such as Ollama need no key.
      </p>
      <ul className="provider-list">
        {view.providers.map((provider) =>
          editing === provider.id ? (
            <li key={provider.id}>
              <ProviderForm
                view={view}
                provider={provider}
                save={save}
                onDone={() => setEditing(undefined)}
              />
            </li>
          ) : (
            <li key={provider.id} className="provider-row">
              <KeyRound size={15} />
              <span className="provider-meta">
                <strong>{provider.name}</strong>
                <small>
                  {apiLabels[provider.api]} · {provider.baseUrl}
                </small>
                <small>
                  {provider.apiKey.set
                    ? `Key saved ${provider.apiKey.hint}`
                    : 'No key'}
                  {view.chat.providerId === provider.id && ' · Chat'}
                </small>
              </span>
              {provider.keyUrl && (
                <a
                  className="text-button"
                  href={provider.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Keys <ArrowUpRight size={11} />
                </a>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={`Edit ${provider.name}`}
                onClick={() => setEditing(provider.id)}
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${provider.name}`}
                onClick={() => {
                  if (window.confirm(`Remove ${provider.name} and its key?`))
                    void save(`/providers/${provider.id}`, 'DELETE');
                }}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <ProviderForm
          view={view}
          save={save}
          onDone={() => setEditing(undefined)}
        />
      ) : (
        <button
          type="button"
          className="secondary-button"
          onClick={() => setEditing('new')}
        >
          <Plus size={14} /> Add provider
        </button>
      )}
    </fieldset>
  );
}

function ProviderForm({
  view,
  provider,
  save,
  onDone,
}: {
  view: ProviderSettingsView;
  provider?: ProviderView;
  save: Save;
  onDone: () => void;
}) {
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [keyUrl, setKeyUrl] = useState(provider?.keyUrl ?? '');
  const [api, setApi] = useState<ProviderApi>(
    provider?.api ?? 'openai-compatible',
  );
  const [apiKey, setApiKey] = useState('');
  const preset = view.presets.find((item) => item.baseUrl === baseUrl);
  return (
    <SectionForm
      className="provider-form"
      submitLabel={provider ? 'Save provider' : 'Add provider'}
      onCancel={view.providers.length || provider ? onDone : undefined}
      onSubmit={async () => {
        const body = {
          name,
          baseUrl,
          api,
          keyUrl,
          ...(apiKey.trim() ? { apiKey } : {}),
        };
        const error = provider
          ? await save(`/providers/${provider.id}`, 'PUT', body)
          : await save('/providers', 'POST', body);
        if (!error) onDone();
        return error;
      }}
    >
      {!provider && (
        <>
          <label className="field-label" htmlFor="provider-preset">
            Start from
          </label>
          <select
            id="provider-preset"
            value={preset?.name ?? ''}
            onChange={(event) => {
              const next = view.presets.find(
                (item) => item.name === event.target.value,
              );
              if (!next) return;
              setName(next.name);
              setBaseUrl(next.baseUrl);
              setApi(next.api);
              setKeyUrl(next.keyUrl ?? '');
            }}
          >
            <option value="">Custom provider</option>
            {view.presets.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </>
      )}
      <label className="field-label" htmlFor="provider-name">
        Name
      </label>
      <input
        id="provider-name"
        value={name}
        maxLength={60}
        required
        onChange={(e) => setName(e.target.value)}
      />
      <label className="field-label" htmlFor="provider-url">
        Base URL (link)
      </label>
      <input
        id="provider-url"
        type="url"
        value={baseUrl}
        required
        placeholder="https://api.example.com/v1"
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <label className="field-label" htmlFor="provider-api">
        API type
      </label>
      <select
        id="provider-api"
        value={api}
        onChange={(e) => setApi(e.target.value as ProviderApi)}
      >
        {Object.entries(apiLabels).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <label className="field-label" htmlFor="provider-key">
        API key
      </label>
      <input
        id="provider-key"
        type="password"
        autoComplete="off"
        value={apiKey}
        placeholder={secretPlaceholder(provider?.apiKey, 'sk-…')}
        onChange={(e) => setApiKey(e.target.value)}
      />
      {keyUrl && (
        <a
          className="text-button key-link"
          href={keyUrl}
          target="_blank"
          rel="noreferrer"
        >
          Get an API key <ArrowUpRight size={11} />
        </a>
      )}
      {provider?.apiKey.set && (
        <button
          type="button"
          className="text-button"
          onClick={() =>
            void save(`/providers/${provider.id}`, 'PUT', { apiKey: null })
          }
        >
          Remove saved key
        </button>
      )}
    </SectionForm>
  );
}

function ChatSection({
  view,
  save,
}: {
  view: ProviderSettingsView;
  save: Save;
}) {
  const [providerId, setProviderId] = useState(
    view.chat.providerId ?? view.providers[0]?.id ?? '',
  );
  const [model, setModel] = useState(
    view.chat.model ??
      view.presets.find(
        (preset) =>
          preset.baseUrl ===
          view.providers.find((item) => item.id === providerId)?.baseUrl,
      )?.model ??
      '',
  );
  return (
    <Section title="Chat model" description="Used by every Dot for text turns.">
      <SectionForm
        onSubmit={() =>
          save('/services', 'PUT', { chat: { providerId, model } })
        }
      >
        <ProviderModelFields
          id="chat"
          view={view}
          providerId={providerId}
          setProviderId={setProviderId}
          model={model}
          setModel={setModel}
          required
        />
      </SectionForm>
    </Section>
  );
}

function VoiceSection({
  view,
  save,
}: {
  view: ProviderSettingsView;
  save: Save;
}) {
  const [voice, setVoice] = useState(view.voice.voice ?? '');
  const [voices, setVoices] = useState<SpeechVoice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let active = true;
    api<{ voices: SpeechVoice[] }>('/voice/voices')
      .then((result) => {
        if (!active) return;
        setVoices(result.voices);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setLoadError(e instanceof Error ? e.message : 'Voices could not load.');
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const preview = async () => {
    setPreviewing(true);
    setPreviewError('');
    try {
      // Sends the highlighted voice, or the system default when none is picked.
      await api('/voice/preview', 'POST', { voice: voice || undefined });
    } catch (e) {
      setPreviewError(
        e instanceof Error ? e.message : 'The voice did not play.',
      );
    } finally {
      setPreviewing(false);
    }
  };
  const languages = [...new Set(voices.map((item) => item.language))];
  return (
    <Section
      title="Voice calls"
      description="Replies are spoken with Apple's built-in voices, and you are heard with Apple's speech recognition. No key is needed."
    >
      <SectionForm
        onSubmit={() => save('/services', 'PUT', { voice: { voice } })}
      >
        <label className="field-label" htmlFor="voice-name">
          Voice
        </label>
        <select
          id="voice-name"
          value={voices.some((item) => item.id === voice) ? voice : ''}
          disabled={!voices.length}
          onChange={(e) => setVoice(e.target.value)}
        >
          <option value="">System default</option>
          {languages.map((language) => (
            <optgroup key={language} label={language}>
              {voices
                .filter((item) => item.language === language)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.quality === 'default'
                      ? item.name
                      : `${item.name} (${item.quality})`}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        {!loaded ? (
          <small>Loading voices…</small>
        ) : (
          (loadError || !voices.length) && (
            <small>
              {loadError || 'Voice calls run in the Pidots Mac app.'}
            </small>
          )
        )}
        <button
          type="button"
          className="text-button"
          disabled={!voices.length || previewing}
          onClick={() => void preview()}
        >
          {previewing ? 'Playing…' : 'Preview voice'}
        </button>
        {previewError && <small>{previewError}</small>}
      </SectionForm>
    </Section>
  );
}

function ProviderModelFields({
  id,
  view,
  providerId,
  setProviderId,
  model,
  setModel,
  required,
  allowNone,
}: {
  id: string;
  view: ProviderSettingsView;
  providerId: string;
  setProviderId: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  required?: boolean;
  allowNone?: boolean;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  return (
    <>
      <label className="field-label" htmlFor={`${id}-provider`}>
        Provider
      </label>
      <select
        id={`${id}-provider`}
        value={providerId}
        required={required}
        onChange={(e) => {
          setProviderId(e.target.value);
          setModels([]);
          setStatus('');
        }}
      >
        {(allowNone || !providerId) && (
          <option value="" disabled={!allowNone}>
            {allowNone ? 'Off' : 'Choose a provider'}
          </option>
        )}
        {view.providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.name}
          </option>
        ))}
      </select>
      <label className="field-label" htmlFor={`${id}-model`}>
        Model
      </label>
      <div className="input-with-button">
        <input
          id={`${id}-model`}
          value={model}
          list={`${id}-models`}
          maxLength={200}
          required={required || !!providerId}
          placeholder="Model id, e.g. gpt-5-mini"
          onChange={(e) => setModel(e.target.value)}
        />
        <button
          type="button"
          className="secondary-button"
          disabled={!providerId}
          onClick={async () => {
            setStatus('Loading models…');
            try {
              const result = await api<{ models: string[] }>(
                `/providers/${providerId}/models`,
              );
              setModels(result.models);
              setStatus(
                result.models.length
                  ? `${result.models.length} models available — start typing to pick one.`
                  : 'The provider returned no models.',
              );
            } catch (error) {
              setStatus(
                error instanceof Error
                  ? error.message
                  : 'Could not load models.',
              );
            }
          }}
        >
          Load models
        </button>
      </div>
      <datalist id={`${id}-models`}>
        {models.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
      {status && <p className="muted">{status}</p>}
    </>
  );
}

function WebSection({
  view,
  save,
}: {
  view: ProviderSettingsView;
  save: Save;
}) {
  const [provider, setProvider] = useState(view.web.provider);
  const [parallelKey, setParallelKey] = useState('');
  const [browserUrl, setBrowserUrl] = useState(view.web.browserUrl ?? '');
  const [browserSecret, setBrowserSecret] = useState('');
  return (
    <Section
      title="Web research"
      description="Public-web search for Dots. Parallel works without a key for light use."
      link={{ href: 'https://platform.parallel.ai', label: 'Parallel keys' }}
    >
      <SectionForm
        onSubmit={() =>
          save('/services', 'PUT', {
            web: {
              provider,
              browserUrl,
              ...(parallelKey.trim() ? { parallelApiKey: parallelKey } : {}),
              ...(browserSecret.trim() ? { browserSecret } : {}),
            },
          })
        }
      >
        <label className="field-label" htmlFor="web-provider">
          Provider
        </label>
        <select
          id="web-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as typeof provider)}
        >
          <option value="parallel">Parallel search</option>
          <option value="browser">Isolated browser (URLs only)</option>
          <option value="disabled">Disabled</option>
        </select>
        {provider === 'parallel' && (
          <SecretInput
            id="parallel-key"
            label="Parallel API key (optional)"
            value={parallelKey}
            onChange={setParallelKey}
            secret={view.web.parallelApiKey}
            onClear={() =>
              save('/services', 'PUT', { web: { parallelApiKey: null } })
            }
          />
        )}
        {provider === 'browser' && (
          <>
            <label className="field-label" htmlFor="browser-url">
              Browser service URL
            </label>
            <input
              id="browser-url"
              type="url"
              value={browserUrl}
              placeholder="http://127.0.0.1:4311"
              onChange={(e) => setBrowserUrl(e.target.value)}
            />
            <SecretInput
              id="browser-secret"
              label="Browser shared secret"
              value={browserSecret}
              onChange={setBrowserSecret}
              secret={view.web.browserSecret}
              onClear={() =>
                save('/services', 'PUT', { web: { browserSecret: null } })
              }
            />
          </>
        )}
      </SectionForm>
    </Section>
  );
}

function ComputersSection({
  view,
  save,
}: {
  view: ProviderSettingsView;
  save: Save;
}) {
  const [url, setUrl] = useState(view.computers.supervisorUrl ?? '');
  const [supervisorToken, setSupervisorToken] = useState('');
  const [computerToken, setComputerToken] = useState('');
  const [namespace, setNamespace] = useState(view.computers.namespace ?? '');
  const [mode, setMode] = useState(
    view.computers.builtinAvailable ? view.computers.mode : 'custom',
  );
  return (
    <Section
      title="Computers"
      description="A private computer per Dot: terminal, files and a browser."
    >
      <SectionForm
        onSubmit={() =>
          save('/services', 'PUT', {
            computers: {
              mode,
              supervisorUrl: url,
              namespace,
              ...(supervisorToken.trim() ? { supervisorToken } : {}),
              ...(computerToken.trim() ? { computerToken } : {}),
            },
          })
        }
      >
        {view.computers.builtinAvailable && (
          <>
            <label className="field-label" htmlFor="computer-mode">
              Where computers run
            </label>
            <select
              id="computer-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="builtin">
                Built-in: Linux virtual machines on this Mac
              </option>
              <option value="custom">A computer service you run</option>
            </select>
          </>
        )}
        {mode === 'builtin' ? (
          <p className="muted">
            Each Dot gets its own small Linux virtual machine with a browser.
            Nothing to configure; start one from the Dot’s computer panel.
          </p>
        ) : (
          <>
            <label className="field-label" htmlFor="computer-url">
              Supervisor URL
            </label>
            <input
              id="computer-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <SecretInput
              id="supervisor-token"
              label="Supervisor token"
              value={supervisorToken}
              onChange={setSupervisorToken}
              secret={view.computers.supervisorToken}
              onClear={() =>
                save('/services', 'PUT', {
                  computers: { supervisorToken: null },
                })
              }
            />
            <SecretInput
              id="computer-token"
              label="Computer token"
              value={computerToken}
              onChange={setComputerToken}
              secret={view.computers.computerToken}
              onClear={() =>
                save('/services', 'PUT', { computers: { computerToken: null } })
              }
            />
            <label className="field-label" htmlFor="computer-namespace">
              Namespace (keep stable)
            </label>
            <input
              id="computer-namespace"
              value={namespace}
              placeholder="pidots"
              onChange={(e) => setNamespace(e.target.value)}
            />
          </>
        )}
      </SectionForm>
    </Section>
  );
}

function Section({
  title,
  description,
  link,
  children,
}: {
  title: string;
  description: string;
  link?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <fieldset className="providers-section">
      <legend>{title}</legend>
      <p className="muted">
        {description}{' '}
        {link && (
          <a href={link.href} target="_blank" rel="noreferrer">
            {link.label} ↗
          </a>
        )}
      </p>
      {children}
    </fieldset>
  );
}

function SectionForm({
  className,
  submitLabel = 'Save',
  onSubmit,
  onCancel,
  children,
}: {
  className?: string;
  submitLabel?: string;
  onSubmit: () => Promise<string | undefined>;
  onCancel?: () => void;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string }>();
  return (
    <form
      className={className}
      onSubmit={async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setMessage(undefined);
        const error = await onSubmit();
        setMessage(
          error
            ? { error: true, text: error }
            : { error: false, text: 'Saved.' },
        );
        setBusy(false);
      }}
    >
      {children}
      <div className="section-actions">
        {message && (
          <span
            className={message.error ? 'chat-error' : 'muted'}
            role={message.error ? 'alert' : 'status'}
          >
            {message.text}
          </span>
        )}
        {onCancel && (
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function SecretInput({
  id,
  label,
  value,
  onChange,
  secret,
  onClear,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret: SecretView;
  onClear: () => Promise<string | undefined>;
}) {
  return (
    <>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        value={value}
        placeholder={secretPlaceholder(secret)}
        onChange={(e) => onChange(e.target.value)}
      />
      {secret.set && (
        <button
          type="button"
          className="text-button"
          onClick={() => void onClear()}
        >
          Remove saved value
        </button>
      )}
    </>
  );
}

function secretPlaceholder(secret?: SecretView, fallback = 'Paste a key') {
  return secret?.set
    ? `Saved ${secret.hint ?? ''} — leave blank to keep`
    : fallback;
}
