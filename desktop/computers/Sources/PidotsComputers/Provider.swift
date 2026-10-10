import Containerization
import ContainerizationExtras
import ContainerizationOCI
import Foundation
import Synchronization

/// Runs one Linux micro-VM per Dot. It does what the broker (the Pidots
/// server) asks and never decides access itself: the broker checks each
/// Dot's permissions on every call, and the VM's own service checks the token.
actor Provider {
    struct Config {
        let paths: Paths
        let kernel: URL
        /// Host folder with the bundled computer service, shared read-only.
        let agent: URL
        let computerSecret: String
    }

    enum Status: String { case stopped, preparing, running, failed }

    private struct Running {
        let container: LinuxContainer
        let service: LinuxProcess
        let relay: Relay
        let port: UInt16
        let socket: URL
    }

    /// Bump when the install script changes; computers made from an older
    /// template keep working on their own disks.
    static let templateVersion = "base-v1"
    static let initImage = "ghcr.io/apple/containerization/vminit:0.49.0"
    static let baseImage =
        "docker.io/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
    static let dotUser = (uid: UInt32(1001), gid: UInt32(1001))
    static let installScript = """
        set -eu
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates curl git python3 procps
        apt-get clean
        rm -rf /var/lib/apt/lists/*
        groupadd --gid 1001 dot
        useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash dot
        mkdir -p /home/dot/workspace
        chown -R dot:dot /home/dot
        """

    private let config: Config
    private var manager: ContainerManager?
    private var network: VmnetNetwork?
    private var state: ProviderState
    private var running: [String: Running] = [:]
    private var progress: [String: String] = [:]
    private var failures: [String: String] = [:]
    private var templateTask: Task<Void, Error>?
    private var bootTasks: [String: Task<Void, Never>] = [:]
    private let socketFolder: URL

    init(config: Config) throws {
        self.config = config
        for folder in [config.paths.root, config.paths.store, config.paths.templates, config.paths.dots] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        self.state = try ProviderState.load(from: config.paths.stateFile)
        self.socketFolder = try Paths.socketFolder()
        // Folders left by a crashed run would make the next boot fail.
        try? FileManager.default.removeItem(at: config.paths.store.appendingPathComponent("containers"))
        try? FileManager.default.removeItem(at: config.paths.templates.appendingPathComponent("building.ext4"))
    }

    // MARK: Supervisor API

    func list() -> [[String: Any]] {
        let known = Set(state.computers.keys).union(running.keys).union(bootTasks.keys)
        return known.sorted().map { describe($0) }
    }

    func describe(_ id: String) -> [String: Any] {
        var entry: [String: Any] = ["botId": id, "container": containerName(id)]
        if let run = running[id] {
            entry["status"] = Status.running.rawValue
            entry["port"] = Int(run.port)
        } else if bootTasks[id] != nil {
            entry["status"] = Status.preparing.rawValue
            entry["message"] = progress[id] ?? "Starting the computer…"
        } else if let failure = failures[id] {
            entry["status"] = Status.failed.rawValue
            entry["message"] = failure
        } else {
            entry["status"] = Status.stopped.rawValue
        }
        return entry
    }

    /// Starts the Dot's computer, creating it first if needed. Answers at once;
    /// first-time setup continues in the background and reports progress.
    func ensure(_ id: String) -> [String: Any] {
        if running[id] == nil, bootTasks[id] == nil {
            failures[id] = nil
            progress[id] = "Starting the computer…"
            bootTasks[id] = Task { await self.boot(id) }
        }
        return describe(id)
    }

    func stop(_ id: String) async -> [String: Any] {
        bootTasks[id]?.cancel()
        await shutdown(id)
        return describe(id)
    }

    func delete(_ id: String) async throws -> [String: Any] {
        bootTasks[id]?.cancel()
        await shutdown(id)
        try? FileManager.default.removeItem(at: config.paths.dotDirectory(id))
        state.computers[id] = nil
        failures[id] = nil
        try state.save(to: config.paths.stateFile)
        return describe(id)
    }

    func stopAll() async {
        for id in Array(running.keys) { await shutdown(id) }
    }

    // MARK: Lifecycle

    private func boot(_ id: String) async {
        defer { bootTasks[id] = nil; progress[id] = nil }
        do {
            try await prepareManager(id)
            try await ensureTemplate(id)
            let disk = config.paths.disk(id)
            if !FileManager.default.fileExists(atPath: disk.path) {
                progress[id] = "Creating this Dot’s disk…"
                try FileManager.default.createDirectory(at: config.paths.dotDirectory(id), withIntermediateDirectories: true)
                // Copy-on-write: the clone only grows with this Dot's changes.
                guard clonefile(config.paths.template(Self.templateVersion).path, disk.path, 0) == 0 else {
                    throw ProviderError("Could not create the computer's disk (clonefile failed: \(errno)).")
                }
                state.computers[id] = .init(createdAt: Date(), template: Self.templateVersion)
                try state.save(to: config.paths.stateFile)
            }
            try Task.checkCancellation()
            progress[id] = "Starting the computer…"
            running[id] = try await start(id, disk: disk)
        } catch is CancellationError {
            await shutdown(id)
        } catch {
            failures[id] = "The computer could not start: \(error)"
            log("boot \(id) failed: \(error)")
            await shutdown(id)
        }
    }

    private func prepareManager(_ id: String) async throws {
        if manager != nil { return }
        progress[id] = "Downloading the computer system (first time only)…"
        network = try VmnetNetwork()
        manager = try await ContainerManager(
            kernel: Kernel(path: config.kernel, platform: .linuxArm),
            initfsReference: Self.initImage,
            root: config.paths.store
        )
    }

    /// Builds the shared template disk once: base image plus Chromium and the
    /// unprivileged `dot` user. Concurrent first boots share one build.
    private func ensureTemplate(_ id: String) async throws {
        let template = config.paths.template(Self.templateVersion)
        if FileManager.default.fileExists(atPath: template.path) { return }
        if templateTask == nil {
            templateTask = Task { try await self.buildTemplate(id, to: template) }
        }
        do {
            try await templateTask!.value
        } catch {
            templateTask = nil
            throw error
        }
    }

    private func buildTemplate(_ id: String, to template: URL) async throws {
        guard var manager else { throw ProviderError("The computer system is not ready.") }
        progress[id] = "Downloading Linux (first time only)…"
        let image = try await manager.imageStore.get(reference: Self.baseImage, pull: true)
        let building = config.paths.templates.appendingPathComponent("building.ext4")
        try? FileManager.default.removeItem(at: building)
        progress[id] = "Preparing the disk (first time only)…"
        let rootfs = try await EXT4Unpacker(capacityInBytes: 32.gib(), journal: .default)
            .unpack(image, for: .current, at: building, progress: nil)
        let builder = "pidots-template-build"
        try FileManager.default.createDirectory(at: config.paths.containerRoot(builder), withIntermediateDirectories: true)
        let iface = try network?.createInterface(builder, mtu: 1400)
        let gateway = network?.ipv4Gateway.description
        let container = try await manager.create(builder, image: image, rootfs: rootfs, networking: false) { config in
            config.cpus = 4
            config.memoryInBytes = 2048.mib()
            config.process.arguments = ["/bin/sleep", "infinity"]
            config.useInit = true
            if let iface, let gateway {
                config.interfaces = [iface]
                config.dns = .init(nameservers: [gateway])
            }
        }
        defer {
            try? manager.delete(builder)
            try? network?.releaseInterface(builder)
            self.manager = manager
        }
        try await container.create()
        try await container.start()
        progress[id] = "Installing the browser (first time only, a few minutes)…"
        let output = Capture(limit: 20_000)
        let install = try await container.exec("install") { config in
            config.arguments = ["/bin/sh", "-c", Self.installScript]
            config.environmentVariables = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root"]
            config.stdout = output
            config.stderr = output
        }
        try await install.start()
        let status = try await install.wait()
        try await install.delete()
        try await container.stop()
        guard status.exitCode == 0 else {
            try? FileManager.default.removeItem(at: building)
            log("template install failed:\n\(output.text)")
            throw ProviderError("Installing the browser failed (exit \(status.exitCode)). Check your internet connection and try again.")
        }
        try FileManager.default.moveItem(at: building, to: template)
        state.template = Self.templateVersion
        try state.save(to: config.paths.stateFile)
    }

    private func start(_ id: String, disk: URL) async throws -> Running {
        guard var manager else { throw ProviderError("The computer system is not ready.") }
        defer { self.manager = manager }
        let name = containerName(id)
        try? FileManager.default.removeItem(at: config.paths.containerRoot(name))
        try FileManager.default.createDirectory(at: config.paths.containerRoot(name), withIntermediateDirectories: true)
        let socket = Paths.socket(in: socketFolder, for: id)
        try? FileManager.default.removeItem(at: socket)
        let image = try await manager.imageStore.get(reference: Self.baseImage, pull: true)
        let iface = try network?.createInterface(name, mtu: 1400)
        let gateway = network?.ipv4Gateway.description
        let rootfs = Mount.block(
            format: "ext4", source: disk.path, destination: "/",
            runtimeOptions: ["vzDiskImageSynchronizationMode=fsync"]
        )
        let agent = config.agent.path
        let container = try await manager.create(name, image: image, rootfs: rootfs, networking: false) { config in
            config.cpus = 2
            config.memoryInBytes = 2048.mib()
            config.process.arguments = ["/bin/sleep", "infinity"]
            config.useInit = true
            if let iface, let gateway {
                config.interfaces = [iface]
                config.dns = .init(nameservers: [gateway])
            }
            config.mounts.append(.share(source: agent, destination: "/opt/pidots", options: ["ro"]))
            config.sockets = [UnixSocketConfiguration(
                source: URL(fileURLWithPath: "/run/pidots/agent.sock"),
                destination: socket,
                direction: .outOf
            )]
        }
        do {
            try await container.create()
            try await container.start()
            // The socket folder belongs to `dot`, which runs the service.
            let setup = try await container.exec("setup") { config in
                config.arguments = ["/bin/sh", "-c", "mkdir -p /run/pidots && chown dot:dot /run/pidots && chmod 700 /run/pidots"]
            }
            try await setup.start()
            _ = try await setup.wait()
            try await setup.delete()
            let logs = Capture(limit: 20_000)
            let token = dotToken(secret: config.computerSecret, dotId: id)
            let service = try await container.exec("service") { config in
                config.arguments = ["/usr/local/bin/node", "/opt/pidots/agent.mjs"]
                config.workingDirectory = "/home/dot"
                config.user = User(uid: Self.dotUser.uid, gid: Self.dotUser.gid, username: "dot")
                config.environmentVariables = [
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "HOME=/home/dot",
                    "PIDOTS_DOT_ID=\(id)",
                    "PIDOTS_TOKEN=\(token)",
                    "PIDOTS_SOCKET=/run/pidots/agent.sock",
                    "PIDOTS_CHROMIUM=/usr/bin/chromium",
                ]
                config.stdout = logs
                config.stderr = logs
            }
            try await service.start()
            try await waitForService(socket, token: token, dotId: id, logs: logs)
            let relay = try Relay(socketPath: socket.path)
            let port = try await relay.start()
            log("computer \(id) running on 127.0.0.1:\(port)")
            return Running(container: container, service: service, relay: relay, port: port, socket: socket)
        } catch {
            try? await container.stop()
            try? manager.delete(name)
            try? network?.releaseInterface(name)
            throw error
        }
    }

    /// Ready means the service answered an authenticated request, not just
    /// that the relayed socket exists (the host side appears at VM start).
    private func waitForService(_ socket: URL, token: String, dotId: String, logs: Capture) async throws {
        for _ in 0..<200 {
            if serviceAnswers(socket.path, token: token, dotId: dotId) { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw ProviderError("The computer service did not start. \(logs.text.suffix(500))")
    }

    private func shutdown(_ id: String) async {
        guard let run = running.removeValue(forKey: id) else { return }
        run.relay.stop()
        try? await run.service.kill(.term)
        try? await run.container.stop()
        if var manager {
            try? manager.delete(containerName(id))
            self.manager = manager
        }
        try? network?.releaseInterface(containerName(id))
        try? FileManager.default.removeItem(at: run.socket)
        log("computer \(id) stopped")
    }
}

/// Collects a process's output, keeping only the most recent bytes.
final class Capture: Writer, Sendable {
    private let storage = Mutex(Data())
    private let limit: Int
    init(limit: Int) { self.limit = limit }
    var text: String { String(decoding: storage.withLock { $0 }, as: UTF8.self) }
    func write(_ data: Data) throws {
        storage.withLock {
            $0.append(data)
            if $0.count > limit { $0 = $0.suffix(limit) }
        }
    }
    func close() throws {}
}

/// Sends `GET /control` over the socket and checks for HTTP 200.
func serviceAnswers(_ path: String, token: String, dotId: String) -> Bool {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var timeout = timeval(tv_sec: 1, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return false }
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
        }
    }
    guard connected else { return false }
    let request = "GET /control HTTP/1.1\r\nHost: computer\r\nAuthorization: Bearer \(token)\r\nx-pidots-dot-id: \(dotId)\r\nConnection: close\r\n\r\n"
    guard request.withCString({ write(fd, $0, strlen($0)) }) > 0 else { return false }
    var buffer = [UInt8](repeating: 0, count: 64)
    let count = read(fd, &buffer, buffer.count)
    guard count > 12 else { return false }
    return String(decoding: buffer[0..<count], as: UTF8.self).hasPrefix("HTTP/1.1 200")
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n".utf8))
}
