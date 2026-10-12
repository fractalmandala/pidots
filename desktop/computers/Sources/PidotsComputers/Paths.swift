import CryptoKit
import Foundation

/// Where the provider keeps things, and the identity rules it enforces.
struct Paths {
    let root: URL

    var store: URL { root.appendingPathComponent("store") }
    var templates: URL { root.appendingPathComponent("templates") }
    /// The one shared computer: a single sparse disk every Dot lives on.
    var computer: URL { root.appendingPathComponent("computer") }
    var disk: URL { computer.appendingPathComponent("rootfs.ext4") }
    /// Version 2 metadata. The old per-Dot `state.json` and `dots/` are ignored.
    var stateFile: URL { root.appendingPathComponent("computer-state.json") }

    func template(_ version: String) -> URL { templates.appendingPathComponent("\(version).ext4") }
    /// The framework's working folder for a container, by its exact name.
    func containerRoot(_ name: String) -> URL {
        store.appendingPathComponent("containers").appendingPathComponent(name)
    }

    /// Unix socket paths are limited to 104 bytes, so sockets live in a short,
    /// private per-user folder instead of the long data path.
    static func socketFolder() throws -> URL {
        let folder = URL(fileURLWithPath: "/tmp/pidots-\(getuid())")
        var info = stat()
        if lstat(folder.path, &info) == 0 {
            guard (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid() else {
                throw ProviderError("Refusing to use \(folder.path): it is not a private folder owned by this user.")
            }
            chmod(folder.path, 0o700)
        } else {
            guard mkdir(folder.path, 0o700) == 0 else {
                throw ProviderError("Could not create \(folder.path).")
            }
        }
        return folder
    }

    static func socket(in folder: URL, for id: String) -> URL {
        let digest = SHA256.hash(data: Data(id.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        return folder.appendingPathComponent("\(digest).sock")
    }
}

/// The identity the Pidots broker expects for a Dot's computer. Every Dot now
/// lives in the one shared VM (`sharedVMName`); this stays per Dot so the
/// broker's endpoint binding is unchanged.
func containerName(_ dotId: String) -> String { "pidots-computer-\(dotId)" }

/// The single VM all Dots share.
let sharedVMName = "pidots-computer"

/// Linux user names are capped at 32 characters and Dot ids are UUIDs, so the
/// user is `dot-` plus a stable 16-hex digest of the id.
func linuxUser(_ dotId: String) -> String {
    "dot-" + SHA256.hash(data: Data(dotId.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
}

/// Each Dot's private home (0700) inside the shared VM.
func guestHome(_ dotId: String) -> String { "/home/dot-\(dotId)" }

/// The Dot's own service socket inside its home; only root's router reaches it.
func guestSocket(_ dotId: String) -> String { "\(guestHome(dotId))/.pidots/agent.sock" }

/// Root-run script that creates (idempotently) a Dot's user, home, workspace
/// and socket folder. `id` must already be validated.
func ensureUserScript(_ dotId: String) -> String {
    let user = linuxUser(dotId), home = guestHome(dotId)
    return """
        set -eu
        id -u \(user) >/dev/null 2>&1 || useradd --home-dir \(home) --no-create-home --user-group --shell /bin/bash \(user)
        mkdir -p \(home)/workspace \(home)/.pidots
        chown -R \(user):\(user) \(home)
        chmod 700 \(home) \(home)/.pidots
        printf '%s %s\\n' "$(id -u \(user))" "$(id -g \(user))"
        """
}

/// Root-run script that removes a Dot's user and everything in its home.
func deleteUserScript(_ dotId: String) -> String {
    let user = linuxUser(dotId)
    return "pkill -KILL -u \(user) 2>/dev/null || true; id -u \(user) >/dev/null 2>&1 && userdel --remove \(user) 2>/dev/null || true; rm -rf \(guestHome(dotId))"
}

/// The shared folders the VM mounts at boot: every Dot's, deduplicated and
/// parents first so a nested share mounts on top of its parent.
func mountUnion(_ perDot: [String: [Provider.SharedMount]]) -> [Provider.SharedMount] {
    var seen = Set<String>()
    return perDot.values.flatMap { $0 }
        .filter { seen.insert($0.destination).inserted }
        .sorted { ($0.destination.count, $0.destination) < ($1.destination.count, $1.destination) }
}

/// True when every requested share is already mounted in the running VM.
func mounted(_ requested: [Provider.SharedMount], in current: [Provider.SharedMount]) -> Bool {
    requested.allSatisfy { current.contains($0) }
}

/// Dot ids are UUID-like; anything else is refused before touching disk.
func validDotId(_ id: String) -> Bool {
    id.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", options: .regularExpression) != nil
}

/// The token a Dot's computer accepts: HMAC-SHA256 of the Dot id under the
/// shared computer secret, exactly as the broker derives it.
func dotToken(secret: String, dotId: String) -> String {
    let mac = HMAC<SHA256>.authenticationCode(
        for: Data("pidots-computer:\(dotId)".utf8),
        using: SymmetricKey(data: Data(secret.utf8))
    )
    return mac.map { String(format: "%02x", $0) }.joined()
}

struct ProviderError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
