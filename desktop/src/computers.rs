//! Runs `pidots-computers`, the helper that runs the one Linux micro-VM all
//! Dots share (each Dot is its own Linux user inside it).
//!
//! Bundle layout:
//!
//! ```text
//! Pidots.app/Contents/Resources/computers/pidots-computers   the helper (virtualization entitlement)
//! Pidots.app/Contents/Resources/computers/vmlinux            pinned Linux kernel
//! Pidots.app/Contents/Resources/computers/agent/             service + router shared into the VM
//! ```
//!
//! Fresh tokens are made on every launch: VMs stop with the helper, so nothing
//! has to outlive the app. The server gets the helper's address and tokens in
//! a private file, not through settings or the environment.
//!
//! VM size and idle timeout come from `<data>/computers/settings.json`, e.g.
//! `{"cpus": 2, "memoryMiB": 2048, "idleMinutes": 15}` (these are the defaults).

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};

use crate::server::data_dir;

pub struct ComputersConfig {
    helper: PathBuf,
    kernel: PathBuf,
    agent: PathBuf,
}

impl ComputersConfig {
    /// The bundled helper, or this checkout's build. `None` when unavailable:
    /// the app still works, just without built-in computers.
    pub fn discover() -> Option<Self> {
        let exe = std::env::current_exe().ok()?;
        let bundled = exe.parent()?.parent()?.join("Resources/computers");
        let candidates = [
            Self {
                helper: bundled.join("pidots-computers"),
                kernel: bundled.join("vmlinux"),
                agent: bundled.join("agent"),
            },
            {
                let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()?
                    .to_path_buf();
                Self {
                    helper: Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("computers/.build/release/pidots-computers"),
                    kernel: Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("target/kernel-cache/vmlinux"),
                    agent: repo.join("dist/computer-agent"),
                }
            },
        ];
        candidates.into_iter().find(|config| {
            config.helper.is_file()
                && config.kernel.is_file()
                && config.agent.join("agent.mjs").is_file()
                && config.agent.join("router.mjs").is_file()
        })
    }
}

pub struct Computers {
    child: Child,
    /// Address and tokens for the Pidots server (mode 0600).
    pub server_file: PathBuf,
}

impl Computers {
    pub fn spawn(config: &ComputersConfig) -> Result<Self> {
        let folder = data_dir().join("computers");
        fs::create_dir_all(&folder)
            .with_context(|| format!("Could not create {}", folder.display()))?;
        let supervisor_token = random_hex()?;
        let computer_token = random_hex()?;
        let secrets = folder.join("secrets.json");
        write_private(
            &secrets,
            &format!(
                r#"{{"supervisorToken":"{supervisor_token}","computerToken":"{computer_token}"}}"#
            ),
        )?;
        let log =
            File::create(folder.join("computers.log")).context("Could not create computers.log")?;
        let vm = VmSettings::load(&folder.join("settings.json"));
        let mut child = Command::new(&config.helper)
            .args(["--root".as_ref(), folder.as_os_str()])
            .args(["--kernel".as_ref(), config.kernel.as_os_str()])
            .args(["--agent".as_ref(), config.agent.as_os_str()])
            .args(["--secrets".as_ref(), secrets.as_os_str()])
            .args(vm.args())
            // The helper stops every VM and exits when this pipe closes.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .spawn()
            .with_context(|| format!("Could not start {}", config.helper.display()))?;

        // The helper prints its port first; wait briefly for it.
        let stdout = child.stdout.take().context("No helper output")?;
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            let _ = sender.send(line);
            // Keep draining so the helper never blocks on a full pipe.
            let mut sink = Vec::new();
            let _ = reader.read_to_end(&mut sink);
        });
        let line = receiver
            .recv_timeout(Duration::from_secs(15))
            .unwrap_or_default();
        let Some(port) = line
            .trim()
            .strip_prefix("PIDOTS_COMPUTERS_PORT=")
            .and_then(|p| p.parse::<u16>().ok())
        else {
            let _ = child.kill();
            bail!("The computer helper did not start; see computers.log.");
        };
        let server_file = folder.join("server.json");
        write_private(
            &server_file,
            &format!(
                r#"{{"url":"http://127.0.0.1:{port}","supervisorToken":"{supervisor_token}","computerToken":"{computer_token}"}}"#
            ),
        )?;
        Ok(Self { child, server_file })
    }

    /// Asks the helper to stop its VMs, then waits; kills it as a last resort.
    pub fn stop(&mut self) {
        drop(self.child.stdin.take());
        for _ in 0..150 {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.server_file);
    }
}

impl Drop for Computers {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Size and idle timeout of the shared VM. Missing or invalid values fall
/// back to the defaults (2 vCPUs, 2 GiB, 15 minutes); the helper clamps them.
#[derive(Debug, PartialEq)]
pub struct VmSettings {
    pub cpus: u32,
    pub memory_mib: u64,
    pub idle_minutes: u64,
}

impl Default for VmSettings {
    fn default() -> Self {
        Self { cpus: 2, memory_mib: 2048, idle_minutes: 15 }
    }
}

impl VmSettings {
    pub fn load(path: &Path) -> Self {
        fs::read_to_string(path).map(|text| Self::parse(&text)).unwrap_or_default()
    }

    pub fn parse(text: &str) -> Self {
        let mut settings = Self::default();
        // A flat object of small integers; no JSON crate needed.
        let get = |key: &str| -> Option<u64> {
            let rest = &text[text.find(&format!("\"{key}\""))? + key.len() + 2..];
            let rest = rest.trim_start().strip_prefix(':')?.trim_start();
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        };
        if let Some(cpus) = get("cpus").filter(|n| (1..=64).contains(n)) {
            settings.cpus = cpus as u32;
        }
        if let Some(mib) = get("memoryMiB").filter(|n| (1024..=65536).contains(n)) {
            settings.memory_mib = mib;
        }
        if let Some(minutes) = get("idleMinutes").filter(|n| *n <= 24 * 60) {
            settings.idle_minutes = minutes;
        }
        settings
    }

    fn args(&self) -> Vec<String> {
        vec![
            "--cpus".into(),
            self.cpus.to_string(),
            "--memory-mib".into(),
            self.memory_mib.to_string(),
            "--idle-minutes".into(),
            self.idle_minutes.to_string(),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::VmSettings;

    #[test]
    fn vm_settings_default_and_override() {
        assert_eq!(VmSettings::parse(""), VmSettings::default());
        assert_eq!(
            VmSettings::parse(r#"{"cpus":4,"memoryMiB":3072,"idleMinutes":5}"#),
            VmSettings { cpus: 4, memory_mib: 3072, idle_minutes: 5 }
        );
        assert_eq!(VmSettings::parse(r#"{"cpus":0,"memoryMiB":10}"#), VmSettings::default());
    }
}

fn random_hex() -> Result<String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Writes a file only this user can read.
fn write_private(path: &Path, contents: &str) -> Result<()> {
    let _ = fs::remove_file(path);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("Could not write {}", path.display()))?;
    file.write_all(contents.as_bytes())?;
    Ok(())
}
