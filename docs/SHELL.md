# The macOS shell (GPUI Kit + WebView)

The shell is the native app that holds Pidots together. It:

- draws the window and toolbar with **GPUI Kit**;
- embeds the web UI in a **WebView**, Apple's WebKit through Wry;
- installs the macOS **menu bar**;
- starts and stops the two child processes: the Node server and the computer helper.

Everything the user sees inside the window below the toolbar is the React app served by the Node server.

Code: `desktop/` (Rust crate `pidots-desktop`, binary `pidots`).

| File                      | Responsibility                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `src/main.rs`             | `Shell` view: window, toolbar, WebView, status, failure screen, app lifecycle          |
| `src/menus.rs`            | Menu bar and keyboard shortcuts                                                        |
| `src/server.rs`           | Finds and runs the Node server; WebView navigation policy; data folder; external links |
| `src/computers.rs`        | Finds and runs the computer helper (see [COMPUTERS.md](COMPUTERS.md))                  |
| `Cargo.toml`              | Dependencies, the `inspector` feature, release profile                                 |
| `macos/Info.plist`        | Bundle metadata (version filled in at build), microphone text, local-network allowance |
| `macos/*.entitlements`    | Signing entitlements for the app, the bundled Node and the computer helper             |
| `scripts/bundle-macos.sh` | Builds and assembles `Pidots.app` and the DMG                                          |

## Stack and versions

| Crate               | Version                   | Role                                                                                                                                        |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `gpui-kit`          | 0.7.1                     | One dependency for GPUI (Zed's GPU UI framework, as `gpui-pre` 0.3.8), GPUI Component widgets (`TitleBar`, `Button`, theme) and icon assets |
| `gpui-wry`          | 0.7.1                     | `WebView` entity: a GPUI element that positions a native Wry WebView inside the GPUI layout                                                 |
| `wry`               | 0.53.3 (package `lb-wry`) | WebView library; on macOS it's a `WKWebView`                                                                                                |
| `raw-window-handle` | 0.6                       | Gives Wry the window's native view to attach to                                                                                             |

Docs: <https://gpui-kit.com/docs/installation/>, <https://gpui-kit.com/docs/webview/>. **Requirements:** macOS 15+, Apple silicon, Rust 1.92+, Xcode Command Line Tools.

## Window anatomy

```text
┌───────────────────────────────────────────────────────────────────────┐
│ ● ● ●  Pidots v0.1.3 ● Running        ‹  ›  ⟳  📁  [🔑 Providers]      │  GPUI TitleBar (native, transparent titlebar)
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│              WKWebView (native NSView, child of the window)           │  gpui-wry WebView element:
│              loads http://127.0.0.1:<server port>/                    │  GPUI lays it out; Wry draws it
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

- **The window** is opened by `gpui_kit::open_window()` with `TitleBar::title_bar_options()`: a transparent titlebar, so the traffic lights sit inside GPUI's toolbar. Size 1280×840, minimum 720×480, app id `com.pidots.desktop`.
- **The toolbar** is a GPUI `TitleBar` row:
  - app name, version (`CARGO_PKG_VERSION`) and a status dot (Starting, Running or Stopped);
  - Back, Forward, Reload (which restarts the server when it isn't running), data folder, and **Providers**.
  - Buttons other than Reload and the data folder are disabled until the server is ready.
- **The body** is either the WebView (while starting or running) or a **failure screen** with the error and **Try again**.
- **Theme:** `Theme::sync_system_appearance` runs at startup and whenever macOS switches light or dark (`observe_window_appearance`), so the toolbar follows the system. The web UI has its own setting (System, Light, Dark, stored in the page).

## The WebView

Created once in `Shell::new` (gpui-kit's rule: **one `Entity<WebView>` per native view; never create one per render**):

```rust
let handle = window.window_handle()?;                 // raw-window-handle
let native = wry::WebViewBuilder::new()
    .with_html(LOADING_HTML)                           // animated "Starting Pidots…" page
    .with_navigation_handler(server::allow_navigation)
    .with_new_window_req_handler(|url, _| { server::open_external(&url); wry::NewWindowResponse::Deny })
    .with_devtools(true)                               // debug builds or the `inspector` feature
    .build_as_child(&handle)?;                         // a child NSView of the GPUI window
WebView::new(native, window, cx)
```

- **Layout:** the shell renders `div().flex_1().child(self.webview.clone())`. During GPUI's prepaint, gpui-wry sends the element's bounds to Wry in logical points, so the WebView follows window resizes automatically.
- **Loading:** it shows `LOADING_HTML` until the server answers, then `view.load_url("http://127.0.0.1:<port>/")`.
- **Navigation policy** (`server::allow_navigation`): only `http://127.0.0.1:<port>` (the current server), `about:` and `data:` load in the WebView. Any other URL is refused and opened in the default browser with `/usr/bin/open` (http and https only).
- **New windows:** `target="_blank"` and `window.open` never create WebView windows; they open in the default browser.
- **Visibility:** the WebView is a native view drawn **above** all GPUI content. `set_status()` hides it while the failure screen is shown and shows it otherwise.
- **Developer tools:** enabled in debug builds. For release builds, build with `--features inspector` (this enables Wry's `devtools`). Then right-click → Inspect Element.

### Talking to the page

The only shell-to-page channel is JavaScript evaluation: `Shell::eval(script)` calls `webview.raw().evaluate_script(script)`, fire-and-forget.

| Shell action         | Script                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Back / Forward       | `history.back()` / `history.forward()`                                                                                  |
| Providers button, ⌘, | `location.hash = '#providers'`. `App.tsx` watches for this hash, opens the Providers & keys dialog and clears the hash. |
| Undo / Redo          | `document.execCommand('undo' \| 'redo')`                                                                                |
| Reload               | `webview.raw().reload()` (a native call, not a script)                                                                  |

**There is no page-to-shell channel (no IPC handler).** If you add one with `WebViewBuilder::with_ipc_handler`:

- treat every message as **untrusted**, because page content includes model output;
- validate its type and size;
- never expose actions that touch files, processes or accounts without the owner's confirmation in native UI.

Prefer a convention like the `#providers` hash, or an HTTP endpoint on the server, over IPC.

### Web content security

The server sets a strict Content-Security-Policy:

- scripts only from the same origin;
- connections only to itself;
- no framing.

It also refuses cross-site requests (`app.ts` middleware). The page is served over plain HTTP on loopback, which App Transport Security allows through `NSAllowsLocalNetworking` in `Info.plist`. `NSMicrophoneUsageDescription` and the `audio-input` entitlement exist so voice calls can use the microphone from the WebView.

## Menu bar and shortcuts (`menus.rs`)

macOS routes ⌘-shortcuts through the **app's menu bar**. Without one, ⌘Q, ⌘C and ⌘V do nothing, and clicking the app name in the menu bar shows nothing. `menus::install` sets:

| Menu   | Items                                                                 |
| ------ | --------------------------------------------------------------------- |
| Pidots | Providers & Keys… ⌘, · Hide ⌘H · Hide Others ⌥⌘H · Show All · Quit ⌘Q |
| Edit   | Undo ⌘Z · Redo ⇧⌘Z · Cut ⌘X · Copy ⌘C · Paste ⌘V · Select All ⌘A      |
| View   | Reload ⌘R · Back ⌘[ · Forward ⌘]                                      |
| Window | Minimize ⌘M · Zoom · Close ⌘W                                         |

How it works, and why it's built this way:

- **Cut, Copy, Paste and Select All** are `MenuItem::os_action(…, OsAction::…)`. GPUI turns these into native menu items with the selectors `cut:`, `copy:`, `paste:` and `selectAll:`, which AppKit sends to the **first responder**. When the user is typing in the page, that's the `WKWebView`, so copy and paste work natively, including text fields in the page.
- **Undo and Redo** have no native target here (GPUI maps them to its own handler), so they run `document.execCommand` in the page.
- **Shortcuts are bound in a key context nothing uses** (`KeyBinding::new("cmd-c", Copy, Some("PidotsMenuOnly"))`). GPUI still shows the shortcut in the menu, because it takes key equivalents from the keymap, but GPUI's own key dispatch never matches the keystroke. The window therefore doesn't swallow it, and AppKit sends it through the menu bar like any Mac app. **If you bind a menu shortcut without a context, GPUI may handle it first and the WebView never sees it.**
- The other actions (Quit, Hide, Minimize, Reload, Providers and so on) are global `cx.on_action` handlers.

**To add a menu item:**

1. add an action to `actions!(pidots, [...])`;
2. bind its shortcut with `MENU_ONLY`;
3. register `cx.on_action`;
4. add `MenuItem::action(...)` in `cx.set_menus`.

## Child processes and lifecycle

```text
main()
 └─ open_window → Shell::new → start_server()
      ├─ Computers::spawn()   (computers.rs; optional; skipped if not bundled or it fails)
      ├─ Server::spawn()      (server.rs; Node on a free 127.0.0.1 port)
      └─ poll every 250 ms up to 60 s: exited? → failure screen · listening? → load the UI
```

**Starting the server** (`server.rs`):

- `ServerConfig::discover()` uses `Resources/node` with `Resources/app/server.mjs` when running from the app bundle. Otherwise, from a checkout, it uses `node` from Homebrew or `/usr/local` with `dist/server/server/index.js` (requires `npm run build`).
- `free_port()` asks the OS for a free loopback port. That port is also the one `allow_navigation` accepts.
- **Environment:** `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT`, `DATABASE_PATH=<data>/pidots.sqlite`, `PIDOTS_DESKTOP=1`, and `PIDOTS_COMPUTERS_FILE` when computers are available. **No API keys are ever passed.**
- **Output** goes to `<data>/server.log`, where `<data>` is `~/Library/Application Support/Pidots` (`server::data_dir()`). The toolbar's folder button opens it in Finder.

**Readiness:** the poll checks whether the child exited (failure screen with its exit status and the log location) and whether the port accepts TCP (load the UI). After 60 s without either, the failure screen says the server didn't start.

**Shutting down:** every child process is started with **stdin piped and held by the shell**.

- The server (with `PIDOTS_DESKTOP=1`) and the helper both exit when their stdin closes. So they stop even if the shell crashes or is killed, because the OS closes the pipe.
- **Normal quit** (⌘Q, menu, or closing the last window): `cx.on_app_quit` calls `Shell::stop_server()`. It closes the server's stdin and waits up to 3 s, then kills it; then it closes the helper's stdin and waits up to 15 s for its VMs to stop, then kills it.
- Closing the last window quits the app (`on_window_closed`).
- **Restart:** Reload while stopped (or Try again) calls `start_server()` again, which stops the old server first. The computer helper keeps running across server restarts.

## Building and running

```bash
npm run desktop                                   # npm build, Swift helper build + sign, cargo run (debug)
cargo run --manifest-path desktop/Cargo.toml      # shell only (needs a prior `npm run build`)
cargo build --release --manifest-path desktop/Cargo.toml --features inspector   # release with Web Inspector
npm run desktop:dmg                               # full app + DMG (bumps the version)
```

The first `cargo build` compiles GPUI (minutes). `Cargo.toml` raises `opt-level` for GPUI crates in debug so the dev build stays responsive.

**App bundle layout** (assembled by `bundle-macos.sh`):

```text
Pidots.app/Contents/
  Info.plist                 from desktop/macos/Info.plist (__VERSION__ replaced)
  MacOS/pidots               this shell (release, LTO, stripped)
  Resources/AppIcon.icns     made from public/dots/blue.png
  Resources/node             Node.js 24 (official build, checksum-verified)
  Resources/app/             server.mjs (bundled server) + dist/client
  Resources/computers/       pidots-computers, vmlinux, agent/  (see COMPUTERS.md)
```

**Signing** goes inside-out, with hardened runtime:

1. `node`, with `node.entitlements` (JIT);
2. `pidots-computers`, with `computers.entitlements` (virtualization);
3. the app, with `app.entitlements` (audio input).

The default identity `-` is ad-hoc, which is fine on the machine that built it. For distribution, set `SIGN_IDENTITY` and notarize (see `desktop/README.md`).

## Gotchas

- **The WebView covers GPUI.** Popovers, dropdown menus, dialogs and tooltips drawn by GPUI inside the WebView's rectangle are hidden behind it. Keep shell UI in the toolbar, and hide the WebView when replacing it (`set_status`).
- **Menu shortcuts must use the `MENU_ONLY` context**, or ⌘C and ⌘V stop reaching the page.
- **`evaluate_script` is fire-and-forget.** Use `evaluate_script_with_callback` if you need a result. Never interpolate untrusted text into a script.
- **Every child process must exit on stdin EOF**, otherwise it outlives a crashed shell.
- **Two themes:** the toolbar follows macOS; the page follows its own setting. If a user picks Light in the page while macOS is dark, the toolbar and page differ.
- **Port race:** the server port is chosen by binding and releasing a socket, so another process could take it in between. That's extremely unlikely on loopback, but a "server exited" failure with an address-in-use error in `server.log` means this happened; Try again picks a new port.
- **Debugging the page:** use a debug build or `--features inspector`, then Inspect Element. Server errors are in `server.log`, helper errors in `computers/computers.log`.

## How to…

- **Add a toolbar button:** add a `Button` in `Shell::render`'s right-hand `h_flex`, with an `on_click(cx.listener(Self::…))` handler. If it acts on the page, use `self.eval(…)` or a URL hash the web app handles.
- **Open something in the web app from native UI:** set a hash (as `#providers` does) and handle it in `App.tsx`. That keeps the shell free of web-app internals.
- **Add a child process:** follow `server.rs` and `computers.rs`:
  - discover the binary in `Resources/` or the checkout;
  - pipe its stdin and make it exit on EOF;
  - log to a file in the data folder;
  - stop it in `stop_server()`;
  - add it to `bundle-macos.sh` and sign it.
- **Change window defaults:** edit the `WindowOptions` in `main()`.
