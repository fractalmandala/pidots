# Working on Pidots

Pidots is a native macOS app (GPUI Kit shell + WebView) whose Dots run on **Pi** (pi-durable + pi-ai) and can each use a private **Linux micro-VM**. Read these before changing anything:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): processes, data locations, source layout, build.
- [docs/SHELL.md](docs/SHELL.md): the macOS shell (GPUI Kit window, WebView, menus, child processes).
- [docs/ENGINE.md](docs/ENGINE.md): the Pi engine (conversations, models, tools, streaming).
- [docs/COMPUTERS.md](docs/COMPUTERS.md): personal computers (Swift helper, in-VM service, broker).
- [docs/CONNECTIONS.md](docs/CONNECTIONS.md): MCP connections and approvals.

## Rules

1. **No `.env` and no API keys in the environment.** Provider keys live in Providers & keys (`provider_settings` table) and are only ever returned masked. Don't register pi-ai built-in providers (unless you're okay with env keys), and don't call `models.refresh()`.
2. **Pin Pi exactly.** `@earendil-works/pi-durable`, `pi-ai` and `chord` stay at the same exact version (no `^`); pi-durable is experimental. Pi imports belong only in `src/server/engine/`.
3. **Pin the computer stack exactly.** `apple/containerization` is pinned with `exact:` in `desktop/computers/Package.swift`, with the matching `vminit` tag in `Provider.swift`. The kernel and base image are pinned by checksum or digest.
4. **The broker decides access.** `src/server/computer-service.ts` checks Dot permissions on every computer call. The Swift helper and the in-VM service must never make policy decisions.
5. **Side-effecting tools are not replay-safe.** Only reads and owner-waits may set `replaySafe`.
6. **Every DMG build gets a new version.** `npm run desktop:dmg` bumps the patch version; don't pass `BUMP=none` for a build you hand to the user, and state the version when reporting a build.
7. **Child processes exit when the shell does.** The shell holds each child's stdin; any new child process must shut down on stdin EOF.

## Commands

```bash
npm test                                   # vitest
npx tsc --noEmit && npx eslint src tests vite.config.ts && npm run check-format
swift test --package-path desktop/computers   # computer helper tests
npm run dev                                # web dev server (no computers)
npm run desktop                            # run the macOS shell from this checkout
npm run desktop:dmg                        # release build -> desktop/target/dist/Pidots-<version>-arm64.dmg
```

## Where to look

| Task                                        | Files                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| Chat turn behaviour, prompt, tool selection | `src/server/engine/engine.ts`                                                   |
| Model providers, OpenCode, API types        | `src/server/engine/models.ts`, `src/server/provider-settings.ts`                |
| Chat API and streaming                      | `src/server/thread-routes.ts`, `src/client/useThread.ts`, `src/client/Chat.tsx` |
| Computer permissions and audit              | `src/server/computer-service.ts`, `src/server/computer-store.ts`                |
| What runs inside a VM                       | `src/computer-agent/`                                                           |
| VM lifecycle                                | `desktop/computers/Sources/PidotsComputers/Provider.swift`                      |
| Shell, menus, child processes               | `desktop/src/main.rs`, `menus.rs`, `server.rs`, `computers.rs`                  |
| Packaging                                   | `desktop/scripts/bundle-macos.sh`                                               |
