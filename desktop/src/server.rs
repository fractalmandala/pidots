//! Runs the bundled Pidots Node server as a child process.
//!
//! Bundle layout (see `desktop/scripts/bundle-macos.sh`):
//!
//! ```text
//! Pidots.app/Contents/MacOS/pidots       this shell
//! Pidots.app/Contents/Resources/node       Node.js runtime
//! Pidots.app/Contents/Resources/app/       server.mjs (bundled server), dist/client/
//! ```
//!
//! In a `cargo run` checkout the repository root is used as the app directory
//! and `node` is looked up on the usual install paths.

use std::fs::{self, File};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use anyhow::{Context as _, Result, bail};

static PORT: AtomicU16 = AtomicU16::new(0);
static DEV_ORIGIN: OnceLock<String> = OnceLock::new();

/// Development only: `PIDOTS_DEV_URL` (set by `npm run desktop:dev`) points the
/// WebView at a running Vite dev server instead of spawning the bundled
/// server, so UI edits hot-reload in the window. Release builds ignore it.
pub fn dev_url() -> Option<(String, u16)> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let url = std::env::var("PIDOTS_DEV_URL").ok()?;
    let origin = url.trim_end_matches('/').to_string();
    let port = origin.rsplit(':').next()?.parse().ok()?;
    let _ = DEV_ORIGIN.set(origin.clone());
    Some((format!("{origin}/"), port))
}

pub struct ServerConfig {
    node: PathBuf,
    app_dir: PathBuf,
    entry: &'static str,
}

impl ServerConfig {
    pub fn discover() -> Result<Self> {
        let exe = std::env::current_exe().context("Could not locate the Pidots executable")?;
        let resources = exe
            .parent()
            .and_then(Path::parent)
            .map(|contents| contents.join("Resources"));
        if let Some(resources) = resources.filter(|dir| dir.join("app/server.mjs").is_file()) {
            return Ok(Self {
                node: resources.join("node"),
                app_dir: resources.join("app"),
                entry: "server.mjs",
            });
        }
        // Development: run against this checkout's `npm run build` output.
        let app_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .context("desktop/ has no parent directory")?
            .to_path_buf();
        if !app_dir.join("dist/server/server/index.js").is_file() {
            bail!(
                "No server build found in {}. Run `npm run build` first.",
                app_dir.display()
            );
        }
        let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())
            .unwrap_or_else(|| PathBuf::from("node"));
        Ok(Self {
            node,
            app_dir,
            entry: "dist/server/server/index.js",
        })
    }
}

/// The `pidots-speech` helper for voice calls: the bundled one, or this
/// checkout's build. `None` leaves voice calls off.
fn speech_helper() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundled = exe
        .parent()?
        .parent()?
        .join("Resources/speech/pidots-speech");
    let checkout =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("speech/.build/release/pidots-speech");
    [bundled, checkout].into_iter().find(|path| path.is_file())
}

pub struct Server {
    child: Child,
    port: u16,
}

impl Server {
    pub fn spawn(config: &ServerConfig, computers_file: Option<&Path>) -> Result<Self> {
        let data = data_dir();
        fs::create_dir_all(&data)
            .with_context(|| format!("Could not create {}", data.display()))?;
        let log = File::create(data.join("server.log")).context("Could not create server.log")?;
        let port = free_port()?;
        PORT.store(port, Ordering::SeqCst);
        let mut command = Command::new(&config.node);
        if let Some(file) = computers_file {
            command.env("PIDOTS_COMPUTERS_FILE", file);
        }
        if let Some(helper) = speech_helper() {
            command.env("PIDOTS_SPEECH_HELPER", helper);
        }
        let child = command
            .arg(config.entry)
            .current_dir(&config.app_dir)
            .env("NODE_ENV", "production")
            .env("HOST", "127.0.0.1")
            .env("PORT", port.to_string())
            .env("DATABASE_PATH", data.join("pidots.sqlite"))
            // The server exits when this pipe closes, so it never outlives the shell.
            .env("PIDOTS_DESKTOP", "1")
            .stdin(Stdio::piped())
            .stdout(log.try_clone()?)
            .stderr(log)
            .spawn()
            .with_context(|| format!("Could not start Node.js at {}", config.node.display()))?;
        Ok(Self { child, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }

    /// The exit code, if the process has already exited.
    pub fn exit_status(&mut self) -> Option<String> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            _ => None,
        }
    }

    pub fn stop(&mut self) {
        // Closing stdin asks the server to shut down gracefully; kill as a fallback.
        drop(self.child.stdin.take());
        for _ in 0..30 {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn data_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join("Library/Application Support/Pidots")
}

pub fn is_listening(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_millis(200),
    )
    .is_ok()
}

fn free_port() -> Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).context("No free local port")?;
    Ok(listener.local_addr()?.port())
}

/// Keep the WebView on the local Pidots origin; send everything else to the browser.
pub fn allow_navigation(url: String) -> bool {
    let origin = format!("http://127.0.0.1:{}", PORT.load(Ordering::SeqCst));
    let same_origin = |origin: &str| url == origin || url.starts_with(&format!("{origin}/"));
    if same_origin(&origin) || DEV_ORIGIN.get().is_some_and(|dev| same_origin(dev)) {
        return true;
    }
    if url.starts_with("about:") || url.starts_with("data:") {
        return true;
    }
    open_external(&url);
    false
}

pub fn open_external(url: &str) {
    if url.starts_with("https://") || url.starts_with("http://") {
        let _ = Command::new("/usr/bin/open").arg(url).spawn();
    }
}

pub fn reveal(path: &Path) {
    let _ = Command::new("/usr/bin/open").arg(path).spawn();
}
