# Pidots architecture

Pidots is a native macOS app that gives you persistent AI agents ("Dots"). Each Dot can chat, read and edit pages, call connected services, and use its own Linux computer. This page is the map. Three subsystems have their own deep dives:

- [SHELL.md](SHELL.md): the native macOS shell (GPUI Kit window, WebView, menu bar, child processes).
- [ENGINE.md](ENGINE.md): how Pi (pi-durable and pi-ai) runs every conversation turn.
- [COMPUTERS.md](COMPUTERS.md): how each Dot's Linux micro-VM works.

## Processes

The app is three processes, started and stopped together by the shell:

```text
Pidots.app/Contents/MacOS/pidots                    GPUI Kit shell (Rust)
├── Resources/node server.mjs                       Node server: API, engine, broker
│      └── WebView loads http://127.0.0.1:<port>/   React UI (served by the same server)
└── Resources/computers/pidots-computers            Swift helper: one Linux micro-VM per Dot
         └── VM: node /opt/pidots/agent.mjs         computer service inside each VM
```

| Process          | Source                | Role                                                                                                           |
| ---------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| Shell            | `desktop/src/`        | Window, native toolbar and menu bar, WebView. Starts and stops the other two processes.                        |
| Server           | `src/server/`         | HTTP API, the Pi engine, provider settings, pages, connections, voice, and the computer broker. Serves the UI. |
| UI               | `src/client/`         | React app shown in the WebView.                                                                                |
| Computer helper  | `desktop/computers/`  | Runs VMs with Apple's Containerization framework. Decides nothing about access.                                |
| Computer service | `src/computer-agent/` | Runs inside each VM: terminal, files, browser.                                                                 |

**Lifetime rule.** The shell holds each child's **stdin** open. When the shell exits for any reason, including a crash or kill, the pipe closes and both children shut down: the server stops, and the helper stops every VM. Never add a long-lived child process without the same rule.

## Where things live

| Path                                                 | What                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `~/Library/Application Support/Pidots/pidots.sqlite` | Workspace: Spaces, pages, Dots, settings, provider keys, thread bindings, audit log (`Store` and `WorkspaceStore`) |
| `…/Pidots/pidots-durable.sqlite`                     | Conversations: every message, model turn, tool call, live state (pi-durable)                                       |
| `…/Pidots/server.log`                                | Server output                                                                                                      |
| `…/Pidots/computers/`                                | Computer helper data: images, template disk, per-Dot disks, `computers.log`                                        |
| `/tmp/pidots-<uid>/`                                 | Short-path Unix sockets for VM relays (macOS limits socket paths to 104 bytes)                                     |

The workspace database filename comes from `DATABASE_PATH`, which the shell sets. A plain `npm start` defaults to `data/pidots.sqlite` (a legacy name kept so old checkouts keep their data). The durable store always sits next to it as `pidots-durable.sqlite`.

## Configuration rules

- **No `.env` and no API keys in the environment.** Model providers, keys and service secrets are entered in **Providers & keys** and stored in the `provider_settings` table (`src/server/provider-settings.ts`). The API returns only masked hints (`…1234`). Saving rebuilds the runtime without a restart (`reload()` in `src/server/index.ts`).
- Optional deployment variables configure the server itself only: `HOST`, `PORT`, `DATABASE_PATH`, `OWNER_ID`, `OWNER_TOKEN`, `APP_ORIGIN`.
- Internal variables the shell passes: `PIDOTS_DESKTOP=1` (exit when stdin closes) and `PIDOTS_COMPUTERS_FILE` (path to the helper's address and per-launch tokens, mode 0600).

## Request flow: a chat message

```text
UI (useThread) ──POST /api/threads/:id/messages──▶ thread-routes ──▶ Engine.send()
     ▲                                                                   │
     └──── SSE /api/threads/:id/events ◀── Engine.watch() ◀── pi-durable commits
                                                                         │
                                       pi-ai ──▶ model provider    tools ──▶ pages / web / MCP / computer broker
```

Details are in [ENGINE.md](ENGINE.md).

## Request flow: a computer action

```text
Engine tool computer_exec ──▶ ComputerService (broker: permissions, audit, deadline)
   ──HTTP 127.0.0.1:<relay port>, per-Dot token──▶ helper relay ──Unix socket──▶ VM service ──▶ /bin/sh as `dot`
```

Details are in [COMPUTERS.md](COMPUTERS.md).

## Source layout

```text
src/server/            Node server
  index.ts             entry: stores, engine, runtime rebuild, HTTP server, shutdown
  app.ts               Hono app: security middleware, settings, tasks, memories, route mounting
  engine/              Pi engine (models, tools, transcript mapping, Engine)
  thread-routes.ts     chat API + SSE
  provider-*.ts        Providers & keys settings and routes
  platform*.ts         holder of engine/pages/computers/connections; setup status
  computer-*.ts        computer broker, routes, tools, audit store
  connection*.ts       MCP connections and approvals
  page*.ts, pages.ts   pages and page tools
  voice.ts             realtime voice calls (OpenAI realtime API)
  runner.ts, store.ts  scheduled tasks, settings, memories
src/client/            React UI (useThread.ts, Chat.tsx, ProvidersDialog.tsx, ComputerPanel.tsx, …)
src/shared/            types shared by server, client and the computer service
src/computer-agent/    computer service that runs inside each VM
desktop/               macOS app: Rust shell, Swift computer helper, packaging scripts
tests/                 vitest suites (server, client rendering, engine, computer service)
```

## Building and running

```bash
npm ci
npm run dev            # server (watch) + Vite UI on http://127.0.0.1:5173; no computers
npm test               # vitest
npx tsc --noEmit && npx eslint src tests vite.config.ts && npm run check-format
npm run desktop        # build web+server+agent, build and sign the helper, run the shell
npm run desktop:dmg    # full release build; bumps the patch version every time
```

`npm run build` produces `dist/client` (UI), `dist/server` (server, type-checked JS) and `dist/computer-agent` (the in-VM service). The DMG script (`desktop/scripts/bundle-macos.sh`) also bundles the server into one file (`desktop/scripts/bundle-server.mjs`), downloads and checksum-verifies Node.js 24 and the Linux kernel, builds the Swift helper and Rust shell, signs everything inside-out, and makes the DMG.

Requirements: macOS 15+ for the app (26+ for computers), Apple silicon, Xcode 26 / Swift 6.2+, Rust 1.92+, Node.js 24+, `zstd`.

## Versioning

Every `npm run desktop:dmg` bumps the patch version in `package.json`, `package-lock.json` and `desktop/Cargo.toml` (`BUMP=minor|major|none` to override). The version appears in the DMG name, Info.plist, the toolbar (`CARGO_PKG_VERSION`) and the sidebar (`__APP_VERSION__`, a Vite define). Never hand over two different builds under the same version.
