# Personal computers

Every Dot can have its own computer: a private **Linux user inside one shared Linux micro-VM** (`pidots-computer`) on the user's Mac, with a terminal, files and a Chromium browser. The Dot drives it through `computer_*` tools; the owner watches it, takes control of the browser, and starts, stops or deletes it in the **Computer panel**.

This page explains the design, every component, the protocols between them, and how to build, test and extend it.

## Design in one picture

```text
                 Pidots server (Node)                       pidots-computers (Swift helper)                 VM (Linux 6.18.5)
 Dot tool ──▶ ComputerService ("broker")  ──HTTP 127.0.0.1──▶  Supervisor API (start/stop/list/delete)
   or panel     • per-Dot permissions                          Provider (Containerization framework)
                • audit log, deadlines                         Relay 127.0.0.1:<port>  ──Unix socket──▶  node /opt/pidots/agent.mjs (user dot)
                • per-Dot token (HMAC)    ──HTTP 127.0.0.1:<port>──────────────────────────────────────▶  terminal · files · Chromium
```

The design follows a strict split (from the design guide this was built against):

| Part          | Here                                                                    | Trusted?            | Decides access?                |
| ------------- | ----------------------------------------------------------------------- | ------------------- | ------------------------------ |
| Runtime       | Apple's Containerization framework (Virtualization.framework micro-VMs) | yes                 | no                             |
| **Provider**  | `desktop/computers/` Swift helper `pidots-computers`                    | yes                 | **no**: does what it is told   |
| **Broker**    | `src/server/computer-service.ts`                                        | yes                 | **yes**: the only policy point |
| Agent surface | `computer_*` tools (`src/server/computer-tools.ts`)                     | caller is untrusted | no                             |
| Human surface | `src/client/ComputerPanel.tsx`, Providers & keys                        | the owner           | grants permissions             |

Inside the VM, the computer service (`src/computer-agent/`) also checks a per-Dot token, as defence in depth: even a mistake in the relay can't let one Dot reach another's computer.

## Isolation and guarantees

- **One VM for all Dots:** a single sparse disk (`computers/computer/rootfs.ext4`, a copy-on-write clone of the template), 2 vCPUs and 2 GiB by default. It boots on the first computer request, and stops after 15 idle minutes. `computers/settings.json` (`{"cpus": 2, "memoryMiB": 2048, "idleMinutes": 15}`) changes these; the desktop shell passes them to the helper at launch.
- **Isolation between Dots is Unix users, not kernels:** each Dot is user `dot-<16 hex>` with home `/home/dot-<id>` (0700), its own workspace, Chromium profile, service process, socket and token. A root router in the VM (`router.mjs`) forwards each request to the Dot named in `x-pidots-dot-id`; that Dot's service still checks its own token. Nothing on the Mac is shared except a **read-only** folder with the service code (`/opt/pidots`) and the **shared folders** (below).
- **Shared folders:** the owner can share any number of folders or files from their Mac with a Dot (Computer panel → **Folders**). Each is mounted **read-write** into the shared VM, at the **same absolute path** (so `/Users/me/project` is `/Users/me/project` inside), and changes are the owner's real files. Paths that would cover system folders in the VM (`/`, `/usr`, `/opt`, `/home`, `/etc`, …; see `reservedComputerPaths`) are refused. The VM mounts the union of every Dot's shared folders at boot; each Dot's service only allows its own (`files.ts`). Adding a folder restarts the VM if no other Dot is using it, otherwise it applies at the next restart and the status says so. **Limit:** shell commands of other Dots can technically read a mounted folder (virtiofs keeps the Mac's ownership), so the per-Dot folder rule is enforced for the file tools, not for `exec`.
- **Unprivileged:** the Dot's commands and browser run as its own user (no sudo, `/etc/shadow` unreadable). Its workspace is `/home/dot-<id>/workspace`.
- **Private per Dot:** each Dot has its own home, relay port and token. Other Dots get "Permission denied" on its home.
- **Network:** the VM has full internet access (vmnet shared NAT) so Dots can browse. **There is no allow-list yet** (see Future work).
- **Persistence:** stopping keeps the Dot's home (files, browser profile and sign-ins). Delete removes the Dot's user and home. Software installed system-wide is shared by all Dots.
- **Screenshots:** a Dot's screenshots are written to `screenshots/<dot>/` beside the database; the transcript keeps only the path. The owner's live view still gets the image inline and never stores it.

## Components

### 1. Provider: `desktop/computers/` (Swift)

A SwiftPM package (`Package.swift`, Swift 5 language mode, macOS 26) that depends on `apple/containerization` **pinned to exactly 0.49.0**; its API changes between minor releases. It builds `pidots-computers`, which ships in `Pidots.app/Contents/Resources/computers/` and must be signed with `com.apple.security.virtualization` (`desktop/macos/computers.entitlements`).

| File                          | Responsibility                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `Main.swift`                  | Arguments, secrets, supervisor API routing, and shutdown when stdin closes                  |
| `Provider.swift`              | The actor that owns the shared VM: template build, shared disk, Dot users, boot, stop, delete, readiness probe |
| `HTTPServer.swift`            | Minimal HTTP/1.1 server on 127.0.0.1 (Network.framework); refuses non-loopback peers        |
| `Relay.swift`                 | Per-computer TCP listener on 127.0.0.1 that forwards to the VM's relayed Unix socket        |
| `Paths.swift`                 | Data layout, socket folder, Dot-id validation, per-Dot token derivation                     |
| `State.swift`                 | Versioned `state.json` (refuses unknown versions; atomic writes)                            |
| `Tests/…/ProviderTests.swift` | Token parity with the broker, id validation, socket length, state versioning, HTTP parsing  |

**Command line** (the shell runs this):

```bash
pidots-computers --root <data>/computers --kernel <vmlinux> --agent <agent dir> --secrets <secrets.json>
```

It prints `PIDOTS_COMPUTERS_PORT=<port>` once listening, logs to stderr (the shell redirects to `computers.log`), and on stdin EOF stops the VM and exits.

**Supervisor API** (loopback only; every request needs `Authorization: Bearer <supervisorToken>`; Dot ids must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`):

| Request                      | Response                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /computers`             | `{ computers: [entry…] }`                                                                                                                                                                      |
| `GET /computers/:id`         | entry                                                                                                                                                                                          |
| `POST /computers/:id/ensure` | entry. Body `{ mounts?: [{ source, destination }] }` (shared folders for this boot). Starts the computer, creating it first if needed. **Answers at once**; setup continues in the background. |
| `POST /computers/:id/stop`   | entry (disk kept)                                                                                                                                                                              |
| `POST /computers/:id/delete` | entry (that Dot's service stopped and its Linux user and home removed; queued if the VM is off)                                                                                                                                                  |

An entry is `{ botId, container: "pidots-computer-<id>", status, port?, message? }`, where `status` is `stopped`, `preparing` (with a `message` describing progress), `running` (with the relay `port`) or `failed` (with a `message`).

**Lifecycle in `Provider`:**

1. **Manager** (first use): create `VmnetNetwork()` and a `ContainerManager` with the bundled kernel and the init image `ghcr.io/apple/containerization/vminit:0.49.0` (pulled into `store/`).
2. **Template** (once per `templateVersion`, currently `base-v2`):
   - pull the base image `node:24-bookworm-slim` **by digest**;
   - unpack it into a journaled 4 GiB sparse ext4 (`EXT4Unpacker(journal: .default)`);
   - boot a builder VM and run `installScript`: Chromium, fonts, CA certificates, curl, git, python3, procps, and the user `dot` with its workspace;
   - move the result to `templates/base-v2.ext4`.

   The template is never modified afterwards. Concurrent first boots share one build (`templateTask`).

3. **Disk** (once per Dot): `clonefile()` the template to `dots/<id>/rootfs.ext4`. This is an APFS copy-on-write clone, so a new Dot costs a few MB until it changes things.
4. **Boot** (`start`):
   - create the framework's container folder (it must exist before `create(rootfs:)`);
   - create the VM: 2 vCPUs, 2 GiB, vmnet interface with the gateway as DNS, a read-only virtio-fs share of the agent folder at `/opt/pidots`, a read-write virtio-fs share for each shared folder (parents first), and a Unix socket relayed **out of** the guest (`/run/pidots/agent.sock`) to `/tmp/pidots-<uid>/<hash>.sock`;
   - start it; as root, create `/run/pidots` owned by `dot`;
   - start the service as uid 1001: `node /opt/pidots/agent.mjs` with `PIDOTS_DOT_ID`, `PIDOTS_TOKEN` (the derived per-Dot token), `PIDOTS_SOCKET`, `PIDOTS_CHROMIUM` and `PIDOTS_SHARED` (the shared folder paths, one per line);
   - wait until the service **answers an authenticated `GET /control` with 200** (`serviceAnswers`). The host socket file appears as soon as the VM starts, so its existence proves nothing;
   - start a `Relay` on 127.0.0.1 and report `running` with its port.
5. **Shutdown**: stop the relay, send SIGTERM to the service, stop the VM, delete the framework container, release the network interface, and remove the socket.

**On startup** the provider deletes `store/containers/` and any half-built `templates/building.ext4` left by a crash; a stale folder makes the next boot fail.

### 2. Computer service: `src/computer-agent/` (TypeScript, inside the shared VM, one process per Dot user)

Bundled by `desktop/scripts/bundle-agent.mjs` into `dist/computer-agent/agent.mjs`, with `node_modules/playwright-core` copied beside it (playwright-core reads its own files at runtime, so it can't be inlined). The folder is about 14 MB and is shared read-only into the VM, so updating Pidots updates the service without touching Dots' disks.

| File         | Responsibility                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `main.ts`    | Entry point; reads `PIDOTS_*`, listens on the Unix socket (mode 0600), then removes the token from the environment |
| `server.ts`  | HTTP routes, token check, body limit (1.1 MB), error mapping                                                       |
| `files.ts`   | `Workspace`: list, read and write confined to the workspace and shared folders                                     |
| `exec.ts`    | `runCommand`: `/bin/sh -c` in the workspace, with timeout and output cap                                           |
| `browser.ts` | `Browser`: Playwright driving `/usr/bin/chromium` with a persistent profile in `~/.pidots/browser`                 |
| `control.ts` | `Control`: owner takeover state machine                                                                            |

**Authentication:** `Authorization: Bearer <token>` must equal the per-Dot token (constant-time compare), **and** `x-pidots-dot-id` must equal the Dot this service process belongs to. Otherwise the response is 401.

**Routes** (inputs are validated with the shared schemas in `src/shared/computer-types.ts`, the same ones the broker uses):

| Route                                                     | Does                                                                | Returns                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /control`                                            | Control state                                                       | `{ holder, requested, transitioning, resumeSnapshotRequired, request? }` |
| `POST /control/request` `{ reason? }`                     | Owner asks for control                                              | control                                                                  |
| `POST /control/take` / `/control/release` `{ requestId }` | Owner takes or hands back                                           | control; `409` if the request is stale                                   |
| `POST /navigate` `{ url }`                                | Opens an http(s) URL (30 s timeout)                                 | `{ url, title, status }`                                                 |
| `GET\|POST /read`                                         | Page text, up to 40 000 characters                                  | `{ url, title, text, truncated }`                                        |
| `POST /snapshot`                                          | Tags visible interactive elements                                   | `{ snapshotId, url, title, elements: [{ ref, role, name, value? }] }`    |
| `GET\|POST /screenshot`                                   | PNG of the 1280×800 viewport                                        | `{ base64, width, height, url, capturedAt }`                             |
| `POST /click` `{ ref, snapshotId }`                       | Clicks a tagged element                                             | `{ clicked, url }`                                                       |
| `POST /type` `{ ref, snapshotId, text, submit? }`         | Fills a field, optionally presses Enter                             | `{ typed, submitted, url }`                                              |
| `POST /key` `{ key }`, `POST /scroll` `{ deltaY }`        | Keyboard and wheel                                                  | echo                                                                     |
| `POST /files/list` `{ path }`                             | Up to 1 000 entries                                                 | `{ path, entries: [{ name, type, size, modifiedAt }] }`                  |
| `POST /files/read` `{ path }`                             | Up to 1 MB                                                          | `{ path, text, size, truncated }`                                        |
| `POST /files/write` `{ path, contents, append? }`         | Up to 100 KB per write; creates parent folders                      | `{ path, bytes, size, appended }`                                        |
| `POST /exec` `{ command, timeoutMs }`                     | 1–60 s; 200 KB output cap; kills the whole process group on timeout | `{ exitCode, signal, stdout, stderr, truncated, timedOut }`              |
| `POST /human/click\|type\|key\|scroll`                    | Owner input while holding control                                   | echo                                                                     |

**Snapshot refs:** `snapshot` tags elements in the page with `data-pidots-ref="eN"` and `data-pidots-snapshot="<id>"`. `click` and `type` only accept a ref from the **current** snapshot; after a navigation, click, type or key press the snapshot is stale and the service answers **409 "This snapshot is stale…"**. The broker turns 409s into the instruction to take `computer_snapshot` first. Refs come from the service's own tagging, not Playwright internals, so they are stable across Playwright upgrades.

**Owner control:** while the owner holds control, the Dot's browser actions get **409**. After the owner releases, `resumeSnapshotRequired` is set, and the Dot must snapshot again before acting.

**File safety (`files.ts`):**

- paths are relative to the workspace, or absolute inside a shared folder (`403` otherwise), with no `..`;
- every component is checked with `lstat` and **symlinks are refused**;
- files are opened with `O_NOFOLLOW`;
- writes `fsync` and verify the final size.

**Errors** map to `400` (bad input), `401`, `404`, `409` (control or stale snapshot), `413`, and `500` "…It may have partly happened."

### 3. Broker: `src/server/computer-service.ts`

The single policy point. All Dot tools and panel actions go through it.

- **Configured** when a supervisor URL, a supervisor token and a computer token are present.
- **Per-Dot token:** `HMAC-SHA256(computerToken, "pidots-computer:<dotId>")`, hex. The Swift helper derives the same value (`dotToken`), which `tests/…/ProviderTests.swift` verifies against Node.
- **Permissions** per Dot (`computer_permissions` table): `enabled`, `browser`, `files`, `shell`, all **off by default**.
  - `allowed()` maps the action to a kind (`exec` → shell, `files_*` → files, everything else → browser) and checks before the call, **every 50 ms during it** (aborting if revoked), and after it.
  - Human actions are owner-only. Agents are refused while the workspace is paused.
- **Shared folders** (`computer_folders` table): `addFolders` resolves each path with `realpath`, refuses missing paths and ones covering reserved guest paths, records `share_folder` / `unshare_folder` in the audit, and restarts a running computer. `start` sends the folders that still exist as `mounts`. File actions with an absolute path must be inside a shared folder (`inSharedFolder`), otherwise they are refused before reaching the VM. The prompt lists the shared paths so the Dot knows where to look.
- **Audit:** every action is recorded as `begin` / `finish(succeeded|failed)`, and the last 50 are shown in the panel. Storage is bounded to 1 000 finished entries per Dot.
- **Endpoint check:** a running computer must report container `pidots-computer-<id>` and a `127.0.0.1` URL on its own port, while the supervisor itself is on `127.0.0.1`. Anything else gives "Computer endpoint is not bound to this Dot."
- **Responses:** capped at 4 MB, redirects refused, a 70 s deadline, and any echo of a token is redacted.
- **Lifecycle:** `start` (accepts `preparing`), `stop`, `delete`, `control(take|release)`. `status()` maps provider states to `ComputerStatus.state`: `not_configured`, `stopped`, `preparing` (with `progress`), `running`, `unavailable`.

Routes (`computer-routes.ts`): `GET /api/dots/:id/computer`; `PATCH …/permissions`; `POST …/start|stop|delete|take|release`; `POST …/actions { action, input }`; `POST …/folders/pick { kind: 'directory' | 'file' }` (shows the macOS open panel via `osascript`, see `folder-picker.ts`; cancelling adds nothing); `POST …/folders { path }`; `POST …/folders/remove { path }`.

### 4. Shell wiring: `desktop/src/computers.rs`

- `ComputersConfig::discover()` uses the bundle's `Resources/computers/{pidots-computers, vmlinux, agent/}`, or in a checkout `desktop/computers/.build/release/pidots-computers`, `desktop/target/kernel-cache/vmlinux` and `dist/computer-agent/`. If any is missing, computers are simply unavailable.
- `Computers::spawn()`:
  - **generates fresh tokens on every launch** (the VM never outlives the helper, so nothing needs to persist);
  - writes `computers/secrets.json` (0600) for the helper and starts it with stdin piped;
  - reads the port line (15 s timeout);
  - writes `computers/server.json` (0600) `{ url, supervisorToken, computerToken }`.
- The server starts with `PIDOTS_COMPUTERS_FILE=<server.json>`. `index.ts` reads it on every runtime build (`builtinComputers()`), and `platformConfigFrom()` uses it when Providers & keys → Computers is **Built-in** (the default), with namespace `pidots`. **Custom** keeps the manual supervisor fields for running your own service.
- `stop()` closes the helper's stdin and waits up to 15 s for the VM to stop before killing it.

### 5. UI

- **`ComputerPanel.tsx`:**
  - status, setup progress while `preparing` (polling every 4 s while running or preparing);
  - the live screen (screenshot) with take-over;
  - Folders (shared folders from the Mac: list, **Add folder…**, **Add file…**, Browse, remove), Files, Terminal and Activity tabs;
  - permissions;
  - Start, Stop and **Delete** (confirmation dialog).
- **`ProvidersDialog.tsx` → Computers:** "Where computers run": Built-in or a custom service (only offered when the app provides built-in computers).

## Data layout (`~/Library/Application Support/Pidots/computers/`)

| Path                          | What                                                                                        | Size                          |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| `store/`                      | Image store (vminit, base image blobs) and `initfs.ext4`                                    | ≈ 1 GB                        |
| `templates/base-v2.ext4`      | Shared template (sparse)                                                                    | ≈ 1.4 GB used                 |
| `dots/<id>/rootfs.ext4`       | Each Dot's disk (copy-on-write clone)                                                       | grows with that Dot's changes |
| `state.json`                  | `{ version: 1, template, computers: { id: { createdAt, template } } }`                      | —                             |
| `secrets.json`, `server.json` | Per-launch tokens (0600)                                                                    | —                             |
| `computers.log`               | Helper log                                                                                  | —                             |
| `/tmp/pidots-<uid>/*.sock`    | Relayed sockets (folder 0700, owner-checked); names are 16 hex characters of SHA-256(dotId) | —                             |

`du` reports each clone at full size; to see real use, compare `df` before and after.

## Build and packaging

- `npm run build` creates `dist/computer-agent`.
- `npm run desktop` also runs `swift build -c release --package-path desktop/computers`, signs the helper ad-hoc with the virtualization entitlement, and runs the shell.
- `npm run desktop:dmg` (`bundle-macos.sh`):
  - builds the helper;
  - fetches the **Kata Containers 3.26.0** arm64 release, verifies its SHA-256, and extracts `vmlinux-6.18.5-177` (needs `zstd`). Both SHA-256s are pinned in the script; the result is cached in `desktop/target/kernel-cache/`;
  - copies helper, kernel and agent into `Resources/computers/`;
  - signs node, then the helper (virtualization entitlement and hardened runtime), then the app.
- **Requirements:** Apple silicon, **macOS 26** (Containerization), Xcode 26 / Swift 6.2. The first `swift build` compiles the framework and its gRPC and NIO dependencies (several minutes).
- The VM image and first-time setup download about 400 MB from Docker Hub, GHCR and Debian mirrors, so **the first computer needs internet**.

## Testing

| Test                                          | Covers                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/computer-agent.test.ts`                | Service on a TCP port with a temp workspace: auth (wrong token or Dot), files, symlink escapes, size caps, exec timeout and truncation, owner control → 409, stale snapshot, schema rejection |
| `tests/computer.test.ts`                      | Broker: permissions before, during and after; audit bounds; endpoint binding; token and header; 409 guidance; namespace                                                                       |
| `swift test --package-path desktop/computers` | Token parity with Node, Dot-id validation, socket path length, state versioning, HTTP parsing                                                                                                 |

**Manual integration** (boots real VMs; run outside CI):

```bash
cd desktop/computers && swift build -c release
codesign --force --sign - --entitlements ../macos/computers.entitlements .build/release/pidots-computers
node ../scripts/bundle-agent.mjs /tmp/pd-agent
node -e "const c=require('crypto');require('fs').writeFileSync('/tmp/pd-secrets.json',JSON.stringify({supervisorToken:c.randomBytes(32).toString('hex'),computerToken:c.randomBytes(32).toString('hex')}),{mode:0o600})"
mkfifo /tmp/pd-in; sleep 100000 > /tmp/pd-in &       # keep stdin open; kill it to shut down
.build/release/pidots-computers --root /tmp/pd-root --kernel ../target/kernel-cache/vmlinux \
  --agent /tmp/pd-agent --secrets /tmp/pd-secrets.json < /tmp/pd-in
# then: curl -H "Authorization: Bearer <supervisorToken>" -X POST http://127.0.0.1:<port>/computers/test/ensure
# poll GET /computers/test until running; call the VM on its port with the HMAC token and x-pidots-dot-id.
```

Measured on an M-series Mac:

- first setup (Linux + Chromium) ≈ 1.5–2 min;
- later start 1–2 s; cold VM boot ≈ 1.5 s; warm ≈ 0.5 s;
- a second Dot's disk ≈ 4 MB until used.

## How to…

- **Change what's installed:** edit `Provider.installScript` and **bump `templateVersion`** (for example `base-v2`). The shared disk is cloned from the template only when it doesn't exist, so there is no migration yet: remove `computers/computer/rootfs.ext4` (with the VM stopped) to pick it up.
- **Add an action:**
  1. add its schema to `computerInputs` (`src/shared/computer-types.ts`);
  2. add a route in `src/computer-agent/server.ts`;
  3. it's exposed automatically as `computer_<name>` (non-`human_`). Decide whether it's replay-safe in `computer-tools.ts`, and which permission kind it needs in the broker's `action()`;
  4. add tests.
- **Change VM size:** set `cpus`, `memoryMiB`, `idleMinutes` in `computers/settings.json` (defaults in `Provider.swift` config).
- **Upgrade the framework:** change `exact: "0.49.0"` **and** `Provider.initImage` to the matching `vminit` tag (they are released together), rebuild, and run the manual integration.
- **Upgrade the kernel:** update the URL, both SHA-256 values and the extracted file name in `bundle-macos.sh`. The kernel must have VIRTIO drivers built in, 6.14.9 or newer.

## Gotchas learned building this

- macOS limits Unix socket paths to **104 bytes**, which is why sockets live in `/tmp/pidots-<uid>/`, not the data folder.
- The framework **deletes the container folder** on delete, so disks must live outside `store/containers/`. Unpack with `EXT4Unpacker` to a path you own.
- `create(…, rootfs:)` needs the container folder to **exist first**.
- A **crashed run leaves stale folders**, which make the next create fail; the provider cleans them at startup.
- Swift 6 strict concurrency rejects the framework's configuration closures, so the package uses **Swift 5 language mode** (as Apple's examples do).
- `.outOf` socket relays create the host socket at VM start, so readiness must be an **authenticated request**, not a file check.
- Only `com.apple.security.virtualization` is needed, including for vmnet networking on macOS 26. Ad-hoc signing works locally.

## Known gaps and future work

- **Network policy:** the VM has unrestricted internet. Apple's `sandboxy` example shows an allow-list proxy on a host-only network.
- **Disk usage** isn't shown in the panel yet. There's also no app-wide list of all computers, and no per-app access screen for outside apps.
- **Template upgrades** don't migrate the existing shared disk.
- **Transport:** the server talks to the helper over loopback TCP with a per-launch token. The design guide recommends a Unix socket authenticated by audit token and code-signing requirement; that would need a Node client that can do that.
- **App Sandbox** isn't enabled for the app or the helper.
- The helper binary isn't stripped (≈ 50 MB).
- **Stale connection file:** `server.json` can be left after a hard kill. It's harmless, because tokens rotate each launch.
- **Shared kernel:** Dots are isolated by Unix users in one VM, not by separate kernels. Isolated per-Dot VMs are a possible future (B2B) layer.
- **Apple silicon only.**
