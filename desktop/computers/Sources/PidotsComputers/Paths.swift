import CryptoKit
import Foundation

/// Where the provider keeps things, and the identity rules it enforces.
struct Paths {
    let root: URL

    var store: URL { root.appendingPathComponent("store") }
    var templates: URL { root.appendingPathComponent("templates") }
    var dots: URL { root.appendingPathComponent("dots") }
    var stateFile: URL { root.appendingPathComponent("state.json") }

    func template(_ version: String) -> URL { templates.appendingPathComponent("\(version).ext4") }
    func dotDirectory(_ id: String) -> URL { dots.appendingPathComponent(id) }
    func disk(_ id: String) -> URL { dotDirectory(id).appendingPathComponent("rootfs.ext4") }
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

/// The container name the Pidots broker expects for a Dot.
func containerName(_ dotId: String) -> String { "pidots-computer-\(dotId)" }

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
