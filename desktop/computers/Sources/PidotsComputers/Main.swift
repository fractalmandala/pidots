import Foundation

/// pidots-computers --root <dir> --kernel <vmlinux> --agent <dir> --secrets <file>
///                  [--cpus 2] [--memory-mib 2048] [--idle-minutes 15]
///
/// Runs the one shared VM every Dot uses (see Provider).
///
/// Prints `PIDOTS_COMPUTERS_PORT=<port>` once listening on 127.0.0.1, then
/// serves the supervisor API to the Pidots server. Exits, stopping every VM,
/// when its stdin closes (the app quit).
@main
struct PidotsComputers {
    struct Secrets: Decodable {
        let supervisorToken: String
        let computerToken: String
    }

    static func main() async throws {
        setvbuf(stdout, nil, _IONBF, 0)
        let args = try arguments()
        let secrets = try JSONDecoder().decode(Secrets.self, from: Data(contentsOf: URL(fileURLWithPath: args["secrets"]!)))
        guard secrets.supervisorToken.count >= 32, secrets.computerToken.count >= 32 else {
            throw ProviderError("The computer secrets are missing or too short.")
        }
        let provider = try Provider(config: .init(
            paths: Paths(root: URL(fileURLWithPath: args["root"]!)),
            kernel: URL(fileURLWithPath: args["kernel"]!),
            agent: URL(fileURLWithPath: args["agent"]!),
            computerSecret: secrets.computerToken,
            cpus: max(1, min(Int(args["cpus"] ?? "") ?? 2, ProcessInfo.processInfo.processorCount)),
            memoryMiB: max(1024, min(UInt64(args["memory-mib"] ?? "") ?? 2048, 16384)),
            idleSeconds: max(0, Double(args["idle-minutes"] ?? "") ?? 15) * 60
        ))
        let server = try HTTPServer { request in
            await route(request, provider: provider, token: secrets.supervisorToken)
        }
        let port = try await server.start()
        print("PIDOTS_COMPUTERS_PORT=\(port)")
        log("listening on 127.0.0.1:\(port)")

        // The shell holds our stdin open; when it closes, shut everything down.
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            Thread.detachNewThread {
                while FileHandle.standardInput.availableData.count > 0 {}
                done.resume()
            }
        }
        log("shutting down")
        server.stop()
        await provider.stopAll()
    }

    static func arguments() throws -> [String: String] {
        var values: [String: String] = [:]
        var iterator = CommandLine.arguments.dropFirst().makeIterator()
        while let key = iterator.next() {
            guard key.hasPrefix("--"), let value = iterator.next() else {
                throw ProviderError("Usage: pidots-computers --root <dir> --kernel <vmlinux> --agent <dir> --secrets <file>")
            }
            values[String(key.dropFirst(2))] = value
        }
        for key in ["root", "kernel", "agent", "secrets"] where values[key] == nil {
            throw ProviderError("Missing --\(key).")
        }
        return values
    }

    /// The supervisor API the Pidots broker calls. Every request needs the
    /// supervisor token; every Dot id is validated before use.
    static func route(_ request: HTTPServer.Request, provider: Provider, token: String) async -> HTTPServer.Response {
        let supplied = request.headers["authorization"]?.replacingOccurrences(of: "Bearer ", with: "") ?? ""
        guard constantTimeEqual(supplied, token) else {
            return .error(401, "Not authorized.")
        }
        let parts = request.path.split(separator: "/").map(String.init)
        if request.method == "GET", parts == ["computers"] {
            return .ok(["computers": await provider.list()])
        }
        guard parts.count >= 2, parts[0] == "computers", validDotId(parts[1]) else {
            return .error(404, "Unknown computer request.")
        }
        let id = parts[1]
        switch (request.method, parts.count == 3 ? parts[2] : "") {
        case ("POST", "ensure"):
            guard let mounts = sharedMounts(request.body) else {
                return .error(400, "Shared folders must be existing absolute paths outside system folders.")
            }
            return .ok(await provider.ensure(id, mounts: mounts))
        case ("POST", "stop"):
            return .ok(await provider.stop(id))
        case ("POST", "delete"):
            do {
                return .ok(try await provider.delete(id))
            } catch {
                return .error(500, "Deleting the computer failed: \(error). It may be partly removed.")
            }
        case ("GET", ""):
            return .ok(await provider.describe(id))
        default:
            return .error(404, "Unknown computer request.")
        }
    }
}

/// Guest paths a shared folder may never cover or replace.
let reservedGuestPaths = [
    "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/opt", "/proc",
    "/root", "/run", "/sbin", "/sys", "/tmp", "/usr", "/var",
]

/// Parses `{ mounts: [{ source, destination }] }` from an ensure request.
/// Sources must exist; destinations must be absolute, normalized and clear of
/// system paths, or the VM would not boot. Returns nil if any is invalid.
func sharedMounts(_ body: Data) -> [Provider.SharedMount]? {
    guard !body.isEmpty else { return [] }
    guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
    guard let list = json["mounts"] else { return [] }
    guard let items = list as? [[String: Any]], items.count <= 64 else { return nil }
    var result: [Provider.SharedMount] = []
    for item in items {
        guard let source = item["source"] as? String, let destination = item["destination"] as? String,
              source.hasPrefix("/"), FileManager.default.fileExists(atPath: source),
              destination.hasPrefix("/"), destination.count <= 1024,
              normalized(destination),
              !destination.contains(where: { $0.asciiValue.map { $0 < 0x20 } ?? false })
        else { return nil }
        let clashes = reservedGuestPaths.contains { reserved in
            inside(destination, reserved) || inside(reserved, destination)
        }
        if clashes { return nil }
        result.append(.init(source: source, destination: destination))
    }
    return result
}

/// True for an absolute path without empty, `.` or `..` components.
/// (`NSString.standardizingPath` can't be used: it rewrites `/private/tmp`.)
func normalized(_ path: String) -> Bool {
    path.hasPrefix("/") && path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
        .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
}

/// True when `path` is `root` or inside it.
func inside(_ path: String, _ root: String) -> Bool {
    path == root || path.hasPrefix(root == "/" ? "/" : root + "/")
}

func constantTimeEqual(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    guard x.count == y.count else { return false }
    return zip(x, y).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
}
