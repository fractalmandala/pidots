# The Pi engine

Every Dot conversation runs on **Pi**: [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) is the agent harness and [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) talks to model providers. This page explains how Pidots uses them, where each piece lives, and what to watch out for when changing it.

Code: `src/server/engine/` (`engine.ts`, `models.ts`, `tools.ts`, `transcript.ts`), the API in `src/server/thread-routes.ts`, the UI hook in `src/client/useThread.ts`, and tests in `tests/engine.test.ts` and `tests/provider-settings.test.ts`.

## Why pi-durable

pi-durable **commits every step to storage before showing it**: user input, each model response (including partial text every ~100 ms), each tool call's intent and result, and the live run state. If the app quits or crashes mid-turn, reopening the storage and calling `harness.resume()` continues the turn. Pidots gets durable conversations, streaming and crash recovery from one library, with no hosted service.

## Versions and upgrades

| Package                      | Version | Why pinned exactly                                                         |
| ---------------------------- | ------- | -------------------------------------------------------------------------- |
| `@earendil-works/pi-durable` | 1.1.0   | Marked **experimental**: "the API changes without notice between releases" |
| `@earendil-works/pi-ai`      | 1.1.0   | Must match pi-durable                                                      |
| `@earendil-works/chord`      | 1.1.0   | pi-durable's state and context library                                     |
| `typebox`                    | 1.3.27  | The version pi-ai uses for tool schemas                                    |

All four are pinned with no `^` in `package.json`, so a rebuild never pulls a newer Pi on its own. To upgrade:

1. Read the Pi changelogs (`node_modules/@earendil-works/*/CHANGELOG.md`).
2. Change all four versions together and run `npm install`.
3. Run `npx tsc --noEmit` and `npm test`. `tests/engine.test.ts` covers the engine contract end to end with Pi's fake model provider.
4. Rebuild the DMG and send a real message.

All Pi usage is inside `src/server/engine/`; nothing else should import Pi.

## Objects and their lifetimes

```text
index.ts
 └─ Engine (one per process, created at startup, closed at shutdown)
     ├─ Harness            pi-durable session over pidots-durable.sqlite
     ├─ MutableModels      pi-ai model registry; providers replaced on settings change
     ├─ Registry           pi-durable extensions:
     │    ├─ "pidots"               all static tools + the "dot" system-prompt section
     │    └─ "connections-<dotId>"  one per Dot, that Dot's MCP tools (re-installed each send)
     └─ in-memory: waiters (interactive tools), active runs, listeners, errors
```

- **Engine** (`engine.ts`) is long-lived. When Providers & keys change, `index.ts` rebuilds the API layer (`Platform`, runner, Hono app) but keeps the same Engine, calling `engine.setConfig(config)`. **Never close and reopen the harness to apply settings**: pi-durable expects exactly one process to own a storage.
- **Platform** (`platform.ts`) is a thin holder built per settings version: engine, pages, computers, connections, setup status, and `turn()` / `history()` used by voice and scheduled tasks.

## Threads and conversations

A Pidots **thread** (`thread_bindings` table, a UUID chosen by Pidots) maps to exactly one pi-durable **conversation**, whose id pi-durable chooses.

| Table (`pidots.sqlite`)                           | Purpose                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `thread_bindings`                                 | Thread id, Dot, title, owner. Ownership checks use `workspace.requireThread()`.                                           |
| `durable_conversations(threadId, conversationId)` | The thread-to-conversation map.                                                                                           |
| `message_sources(entryId, threadId, source)`      | Marks transcript entries written by scheduled tasks (`scheduled_task`) or call receipts (`voice_receipt`), for rendering. |

- **pi-durable ids are numbers**, not strings. They are stored as text and converted back with `Number()` on lookup (`findOrCreate`, `entry()`). Passing a string id to `harness.conversation()` silently returns nothing.
- `Engine.conversation(threadId)` creates the conversation on first use and **serialises creation per thread** (a `creating` promise map). Without that, two concurrent calls would each create one.
- Threads made before Pi (when history lived in a hosted service) get a fresh, empty conversation the first time they are opened.

## Models (`models.ts`)

Each Providers & keys entry becomes a **custom pi-ai provider** with id `p-<provider uuid>` (`piProviderId`):

- **API type:** `openai-compatible` (`openai-completions` wire format), `openai` (`openai-responses`), `anthropic` (`anthropic-messages`) or `google` (`google-generative-ai`).
- **Model definition:** only the configured chat model is registered. Defaults are `contextWindow` 128k, `maxTokens` 8192, cost 0, `reasoning` false.
- **Auth:** `resolve()` returns the saved key. A keyless local server gets the placeholder `"local"`, because pi-ai's request path requires some key.
- **Never** register pi-ai's built-in providers (`openaiProvider()` and so on): they read keys from environment variables. **Never** call `models.refresh()`: it fetches remote catalogs.
- **User agent:** every model sends `User-Agent: pidots/0.1` through `model.headers`. pi-ai's own default (`pi (darwin …)`) is overridden only by model headers, not provider headers.
- **OpenCode (opencode.ai):**
  - wraps each API with pi-ai's `withOpenCodeSessionHeader`, which adds `x-opencode-session: <sessionId>`. pi-durable passes a persistent per-conversation `sessionId` (its `pi.provider` document), so the header is stable per conversation, as OpenCode Go requires;
  - takes the model definition from pi-ai's `OPENCODE_GO_MODELS` / `OPENCODE_MODELS` catalogs when the id is known, because Go serves different models through different APIs (chat-completions, Anthropic messages, Responses) behind one base URL.
- `setConfig()` calls `models.clearProviders()` and registers the current chat provider again, so removed providers disappear.

To support per-Dot models later, register every needed `(provider, modelId)` pair in `registerProviders` and set `model` per conversation in `send()`.

## Tools (`tools.ts`, `engine.ts`)

Pidots tools are `DotTool`s: `name`, `description`, zod `parameters` (or `{ jsonSchema }` for MCP tools), `replaySafe`, and `execute(args, call)`, where `call = { threadId, dotId, callId, signal }`. `registration()` wraps one as a pi-durable `defineTool`:

- parameters become `Type.Unsafe(z.toJSONSchema(schema))`, and arguments are **re-validated with zod** before `execute`;
- `call.threadId` and `call.dotId` come from the conversation id (`resolve()`), never from model arguments;
- results are returned to the model as JSON text (`toolText`).

**Replay safety.** pi-durable records a tool call's intent before running it. After a crash, a call marked `replay: "safe"` runs again; any other call gets an `interrupted` error result, so a side effect is never repeated. Mark only reads and waits as `replaySafe`.

| Tool                                                                                                       | Source                                                                | Replay-safe                                        |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| `list_authorized_spaces`, `list_space_pages`, `read_space_page`                                            | `page-tools.ts`                                                       | yes                                                |
| `create_space_page`, `edit_space_page`                                                                     | `page-tools.ts`                                                       | no                                                 |
| `search_web`, `read_public_page`                                                                           | `engine.ts` (`research()`; Parallel, or the URL-only browser service) | yes                                                |
| `computer_*` (navigate, read, snapshot, screenshot, click, type, key, scroll, files_list/read/write, exec) | `computer-tools.ts`                                                   | read, snapshot, screenshot, files_list, files_read |
| `review_space_page`, `request_connection_action`                                                           | `engine.ts` (interactive)                                             | yes                                                |
| MCP tools (`<connection>__<tool>`)                                                                         | `connection-tools.ts`, per-Dot extension                              | no                                                 |

**Which tools a turn offers** (`toolsFor`): page tools always; research tools if both the workspace and the Dot allow research (by provider); computer tools if a computer service is configured; interactive tools only for owner chat turns; the Dot's MCP tools. `send()` applies this with `conversation.configure({ model, extensions: [pidots, connections-<dot>], tools })` before every submission. Selecting extensions explicitly keeps another Dot's MCP tools of the same name out.

**Permission checks happen at call time too.** `check(call)` refuses when the workspace is paused, the Dot is gone, or the turn was aborted. `checkResearch` additionally requires research permission. Computer tools go through the broker, which re-checks permissions on every call (see [COMPUTERS.md](COMPUTERS.md)).

### Interactive tools (owner answers in the chat)

`review_space_page` (a page draft for approval) and `request_connection_action` (approve an MCP write) pause the turn until you answer:

1. The tool's `execute` calls `waitForOwner(call)`, which registers a waiter keyed by `callId` and returns a promise.
2. The UI sees the tool call in the transcript with status `executing` and renders `PageReviewCard` or `ConnectionActionCard`.
3. The card's answer goes to `POST /api/threads/:id/tool-results`, then `engine.respond(threadId, callId, value)`, which resolves the waiter. The value becomes the tool result, and the model continues.

Waiters are in memory. Because these tools are replay-safe, after a restart the call re-executes and waits again, and the card reappears. Stopping the turn rejects its waiters. The 90-second limit does not run while a waiter is pending.

## System prompt

The `pidots` extension has one section, `dot`, rendered before each request by `Engine.prompt(conversationId)`. It includes:

- the Dot's name and role instructions;
- tool guidance (computer, connections, approvals, citations);
- saved memories, if allowed;
- the default Space and the current page (as untrusted data);
- the date and hour (UTC).

pi-durable sends only what changed, as positional `pi.system` entries. Anything that changes every request (such as seconds in the time) would add an entry each turn and defeat provider prompt caching; that's why the time is hour-granular.

## Turns

### `send(threadId, text, { requestId, source, interactive })`

1. Refuses if paused or no chat model is configured ("Setup required…").
2. Gets or creates the conversation, re-installs the Dot's MCP extension, records whether the turn is interactive, and calls `configure()`.
3. `conversation.submit({ type: "input", content, requestId })`. A repeated `requestId` returns the existing submission, so client retries are idempotent. The UI sends a fresh UUID per message.
4. Tracks the run in `active` for the watchdog, and, if `source` is set, marks the user entry once it is placed (`markWhenPlaced`).

### Server-side turns: `turn(threadId, prompt, signal, source)`

Used by scheduled tasks (`index.ts` runner, `scheduled_task`) and voice calls (`voice.ts`: each heard utterance, and `voice_receipt` summaries). It sends with `interactive: false`, waits for the submission, and returns the answer text (`answerText`). Aborting the signal stops the conversation.

### Watchdog (`patrol`, every 500 ms)

For each active run with no pending owner answer, the conversation is aborted (`conversation.abort()`) and the reason surfaced as an `error` event when:

- the workspace is paused;
- the Dot's permissions, Spaces, memory or research settings or connections changed (`fingerprint`);
- or the run exceeded `TURN_TIME_LIMIT_MS` (90 s).

### Stop

`POST /api/threads/:id/stop` calls `engine.stop()`: it rejects waiters and calls `conversation.abort()`, which withdraws queued input and aborts the run's tasks.

## Streaming to the UI

`GET /api/threads/:id/events` is server-sent events (`thread-routes.ts`, Hono `streamSSE`) with three event types (`src/shared/thread-types.ts`):

| Event      | When                                                                    | Payload                                                                                     |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `messages` | On connect, and whenever the transcript grows or the run starts or ends | The full `ChatMessage[]` (user and assistant messages with tool calls and results attached) |
| `live`     | On every commit                                                         | `LiveRun`: running flag, partial answer, current tool slots, provider retry                 |
| `error`    | Watchdog stops, etc.                                                    | Message                                                                                     |

`Engine.watch()` loads the full history once (`entries()` paged ascending), then subscribes to `conversation.viewState()`. New entries are appended and re-mapped; `docs["pi.live"]` gives the in-flight state. Mapping is in `transcript.ts`:

- `pi.user` becomes a user message;
- `pi.assistant` becomes an assistant message (text blocks plus tool calls; `stopReason` `error` or `aborted` becomes `error`);
- `pi.tool-result` sets the matching call's `result` (JSON-parsed when possible) and marks it `complete`;
- a call with no result outside a run is shown as complete (interrupted).

The client (`useThread.ts`) reads SSE with `fetch` (not `EventSource`, so the owner-token `Authorization` header works), reconnects after 2 s on failure, and exposes `messages`, `live`, `running`, `send`, `stop` and `respond`. Because state is committed before it is streamed, a reload or reconnect mid-turn loses nothing.

## HTTP API

| Method and path                                               | Purpose                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/threads/:id/messages`                               | Transcript                                              |
| `GET /api/threads/:id/events`                                 | SSE stream (above)                                      |
| `POST /api/threads/:id/messages` `{ text, requestId? }`       | Send; returns `202 { submissionId }`                    |
| `POST /api/threads/:id/tool-results` `{ toolCallId, result }` | Answer an interactive tool; `409` if nothing is waiting |
| `POST /api/threads/:id/stop`                                  | Stop the run                                            |
| `POST /api/conversations` `{ dotId, title }`                  | Create a thread (requires setup)                        |

Every route checks that the thread belongs to this workspace. The app-wide middleware in `app.ts` enforces the owner token (if set), allowed origins and JSON content type.

## pi-durable settings used

`Harness.open(storage, { models, registry, settings })` in `Engine.open()`:

- `stream.timeoutMs` 120 000;
- `retry.maxRetries` 2;
- `toolExecution: "sequential"`, so one tool call at a time per round. This keeps permission checks and computer actions ordered.

Compaction uses pi-durable's defaults: summarise when nearing `contextWindow − reserveTokens`.

## Testing

- `tests/engine.test.ts` uses pi-ai's `fauxProvider()` (scripted model responses) with in-memory and SQLite storage:
  - send and answer;
  - server turn with a source mark;
  - interactive pause and respond;
  - persistence across reopening;
  - setup-required refusal;
  - stop while waiting.
- `tests/provider-settings.test.ts` checks model registration per API type and that keys never come from the environment. It also stubs `fetch` to assert the OpenCode session header, user agent and per-model API routing.
- Manual: run the app with a provider, or point an `openai-compatible` provider at a local mock server, and send a message; stop mid-reply; quit mid-reply and relaunch (the turn finishes).

## Gotchas

- pi-durable ids are numbers; convert at the boundary.
- One process per durable storage. Don't open a second Engine on the same file, including in tests (use `':memory:'` or a temp file).
- Don't register built-in pi-ai providers, and don't call `models.refresh()`.
- Keep tools that change things non-replay-safe.
- The UI's `respond` only works while the server holds a waiter; a `409` means the turn moved on.
- `__APP_VERSION__` and the user agent are separate. The user agent is a constant in `models.ts`.
