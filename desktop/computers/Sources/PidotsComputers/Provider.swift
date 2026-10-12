import Containerization
import ContainerizationExtras
import ContainerizationOCI
import Foundation
import Synchronization

/// Runs ONE Linux micro-VM (`pidots-computer`) shared by every Dot. Each Dot
/// is a Linux user inside it with a private home, workspace, browser profile,
/// service process and token. A root router in the VM forwards each request to
/// the Dot named in `x-pidots-dot-id`, whose own service checks its token.
/// The VM starts on the first request, and stops after it has been idle.
/// The provider does what the broker (the Pidots server) asks and never
/// decides access itself.
actor Provider {
    struct Config {
        let paths: Paths
        let kernel: URL
        /// Host folder with the bundled computer service, shared read-only.
        let agent: URL
        let computerSecret: String
        var cpus: Int = 2
        var memoryMiB: UInt64 = 2048
        var idleSeconds: Double = 15 * 60
    }

    enum Status: String { case stopped, preparing, running, failed }

    /// A host folder or file shared read-write into the VM. The broker
    /// chooses them; the provider only refuses ones that would break the VM.
    struct SharedMount: Equatable, Hashable {
        let source: String
        let destination: String
    }

    private struct VM {
        let container: LinuxContainer
        let router: LinuxProcess
        let socket: URL
        let mounts: [SharedMount]
    }

    private struct Agent {
        let service: LinuxProcess
        let relay: Relay
        let port: UInt16
        let mounts: [SharedMount]
    }

    static let templateVersion = "base-v2"
    static let initImage = "ghcr.io/apple/containerization/vminit:0.49.0"
    static let baseImage =
        "docker.io/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
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
    private var vm: VM?
    private var vmTask: Task<VM, Error>?
    private var agents: [String: Agent] = [:]
    private var progress: [String: String] = [:]
    private var notes: [String: String] = [:]
    private var failures: [String: String] = [:]
    private var templateTask: Task<Void, Error>?
    private var bootTasks: [String: Task<Void, Never>] = [:]
    /// Each Dot's requested shared folders; the VM mounts their union at boot.
    private var mounts: [String: [SharedMount]] = [:]
    private var lastActivity = Date()
    private var execCounter = 0
    private let socketFolder: URL

    init(config: Config) throws {
        self.config = config
        for folder in [config.paths.root, config.paths.store, config.paths.templates, config.paths.computer] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        self.state = try ProviderState.load(from: config.paths.stateFile)
        self.socketFolder = try Paths.socketFolder()
        // Folders left by a crashed run would make the next boot fail.
        try? FileManager.default.removeItem(at: config.paths.store.appendingPathComponent("containers"))
        try? FileManager.default.removeItem(at: config.paths.templates.appendingPathComponent("building.ext4"))
        Task { await self.idleLoop() }
    }

    // MARK: Supervisor API

    func list() -> [[String: Any]] {
        let known = Set(state.dots.keys).union(agents.keys).union(bootTasks.keys)
        return known.sorted().map { describe($0) }
    }

    func describe(_ id: String) -> [String: Any] {
        var entry: [String: Any] = ["botId": id, "container": containerName(id), "vm": sharedVMName]
        if let agent = agents[id] {
            entry["status"] = Status.running.rawValue
            entry["port"] = Int(agent.port)
            entry["mounts"] = agent.mounts.map(\.destination)
            if let note = notes[id] { entry["message"] = note }
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

    /// Starts the Dot's service in the shared computer, booting the VM and
    /// creating the Dot's user first if needed. Answers at once; setup
    /// continues in the background and reports progress.
    func ensure(_ id: String, mounts requested: [SharedMount] = []) -> [String: Any] {
        touch()
        if agents[id] == nil, bootTasks[id] == nil {
            mounts[id] = requested
            failures[id] = nil
            progress[id] = "Starting the computer…"
            bootTasks[id] = Task { await self.bringUp(id) }
        }
        return describe(id)
    }

    /// Stops only this Dot's service; the VM idles down when nobody uses it.
    func stop(_ id: String) async -> [String: Any] {
        bootTasks[id]?.cancel()
        await stopAgent(id)
        return describe(id)
    }

    /// Removes the Dot's user and home (its workspace and browser profile).
    func delete(_ id: String) async throws -> [String: Any] {
        bootTasks[id]?.cancel()
        await stopAgent(id)
        mounts[id] = nil
        failures[id] = nil
        if let vm {
            _ = try await run(vm.container, deleteUserScript(id))
        } else if state.dots[id] != nil, !state.pendingDeletes.contains(id) {
            state.pendingDeletes.append(id)
        }
        state.dots[id] = nil
        try state.save(to: config.paths.stateFile)
        return describe(id)
    }

    func stopAll() async {
        await shutdownVM()
    }

    func touch() { lastActivity = Date() }

    // MARK: Lifecycle

    private func bringUp(_ id: String) async {
        defer { bootTasks[id] = nil; progress[id] = nil }
        do {
            var current = try await ensureVM(id)
            let wanted = mounts[id] ?? []
            if !mounted(wanted, in: current.mounts) {
                // Shares are fixed at boot. Restart only if no other Dot is using
                // the computer; otherwise start with what is mounted and say so.
                if agents.keys.allSatisfy({ $0 == id }) {
                    progress[id] = "Restarting the computer to add shared folders…"
                    await shutdownVM()
                    current = try await ensureVM(id)
                }
            }
            try Task.checkCancellation()
            progress[id] = "Preparing this Dot…"
            let available = wanted.filter { current.mounts.contains($0) }
            notes[id] = available.count < wanted.count
                ? "Some shared folders apply after the computer restarts (when no other Dot is using it)."
                : nil
            agents[id] = try await startAgent(id, in: current, mounts: available)
        } catch is CancellationError {
            await stopAgent(id)
        } catch {
            failures[id] = "The computer could not start: \(error)"
            log("bring-up \(id) failed: \(error)")
            await stopAgent(id)
        }
    }

    /// The running VM, booting it once if needed; concurrent callers share a boot.
    private func ensureVM(_ id: String) async throws -> VM {
        if let vm { return vm }
        if vmTask == nil {
            vmTask = Task { try await self.bootVM(id) }
        }
        do {
            let booted = try await vmTask!.value
            vmTask = nil
            vm = booted
            return booted
        } catch {
            vmTask = nil
            throw error
        }
    }

    private func bootVM(_ id: String) async throws -> VM {
        try await prepareManager(id)
        try await ensureTemplate(id)
        let disk = config.paths.disk
        if !FileManager.default.fileExists(atPath: disk.path) {
            progress[id] = "Creating the computer’s disk…"
            // Copy-on-write clone: the one disk only grows with real changes.
            guard clonefile(config.paths.template(Self.templateVersion).path, disk.path, 0) == 0 else {
                throw ProviderError("Could not create the computer's disk (clonefile failed: \(errno)).")
            }
        }
        progress[id] = "Starting the computer…"
        let vm = try await startVM(mounts: mountUnion(mounts))
        for pending in state.pendingDeletes {
            _ = try? await run(vm.container, deleteUserScript(pending))
        }
        if !state.pendingDeletes.isEmpty {
            state.pendingDeletes = []
            try state.save(to: config.paths.stateFile)
        }
        touch()
        return vm
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

    /// Builds the template disk once: base image plus Chromium.
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
        let rootfs = try await EXT4Unpacker(capacityInBytes: 4.gib(), journal: .default)
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

    private func startVM(mounts shared: [SharedMount]) async throws -> VM {
        guard var manager else { throw ProviderError("The computer system is not ready.") }
        defer { self.manager = manager }
        let name = sharedVMName
        try? FileManager.default.removeItem(at: config.paths.containerRoot(name))
        try FileManager.default.createDirectory(at: config.paths.containerRoot(name), withIntermediateDirectories: true)
        let socket = socketFolder.appendingPathComponent("computer.sock")
        try? FileManager.default.removeItem(at: socket)
        let image = try await manager.imageStore.get(reference: Self.baseImage, pull: true)
        let iface = try network?.createInterface(name, mtu: 1400)
        let gateway = network?.ipv4Gateway.description
        let rootfs = Mount.block(
            format: "ext4", source: config.paths.disk.path, destination: "/",
            runtimeOptions: ["vzDiskImageSynchronizationMode=fsync"]
        )
        let agent = config.agent.path
        let cpus = config.cpus, memory = config.memoryMiB
        // The VM's own size; the container limits below only cap processes in it.
        let size = VMResources(cpus: cpus, memoryInBytes: memory.mib())
        let container = try await manager.create(
            name, image: image, rootfs: rootfs, networking: false, vm: size
        ) { config in
            config.cpus = cpus
            config.memoryInBytes = memory.mib()
            config.process.arguments = ["/bin/sleep", "infinity"]
            config.useInit = true
            if let iface, let gateway {
                config.interfaces = [iface]
                config.dns = .init(nameservers: [gateway])
            }
            config.mounts.append(.share(source: agent, destination: "/opt/pidots", options: ["ro"]))
            for mount in shared {
                config.mounts.append(.share(source: mount.source, destination: mount.destination))
            }
            config.sockets = [UnixSocketConfiguration(
                source: URL(fileURLWithPath: "/run/pidots/router.sock"),
                destination: socket,
                direction: .outOf
            )]
        }
        do {
            try await container.create()
            try await container.start()
            _ = try await run(container, "mkdir -p /run/pidots && chmod 700 /run/pidots")
            let logs = Capture(limit: 20_000)
            let router = try await container.exec("router") { config in
                config.arguments = ["/usr/local/bin/node", "/opt/pidots/router.mjs"]
                config.environmentVariables = [
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "PIDOTS_ROUTER_SOCKET=/run/pidots/router.sock",
                ]
                config.stdout = logs
                config.stderr = logs
            }
            try await router.start()
            for _ in 0..<100 where !FileManager.default.fileExists(atPath: socket.path) {
                try await Task.sleep(for: .milliseconds(100))
            }
            log("computer \(name) running (\(cpus) vCPU, \(memory) MiB, \(shared.count) shared)")
            return VM(container: container, router: router, socket: socket, mounts: shared)
        } catch {
            try? await container.stop()
            try? manager.delete(name)
            try? network?.releaseInterface(name)
            throw error
        }
    }

    private func startAgent(_ id: String, in vm: VM, mounts shared: [SharedMount]) async throws -> Agent {
        let ids = try await run(vm.container, ensureUserScript(id))
            .split(whereSeparator: \.isWhitespace).compactMap { UInt32($0) }
        guard ids.count >= 2 else { throw ProviderError("Could not create this Dot's user.") }
        if state.dots[id] == nil {
            state.dots[id] = .init(createdAt: Date(), user: linuxUser(id))
            try state.save(to: config.paths.stateFile)
        }
        let home = guestHome(id), user = linuxUser(id)
        let logs = Capture(limit: 20_000)
        let token = dotToken(secret: config.computerSecret, dotId: id)
        execCounter += 1
        let service = try await vm.container.exec("agent-\(execCounter)") { config in
            config.arguments = ["/usr/local/bin/node", "/opt/pidots/agent.mjs"]
            config.workingDirectory = home
            config.user = User(uid: ids[0], gid: ids[1], username: user)
            config.environmentVariables = [
                "PATH=/usr/local/bin:/usr/bin:/bin",
                "HOME=\(home)",
                "PIDOTS_DOT_ID=\(id)",
                "PIDOTS_TOKEN=\(token)",
                "PIDOTS_SOCKET=\(guestSocket(id))",
                "PIDOTS_CHROMIUM=/usr/bin/chromium",
                "PIDOTS_SHARED=\(shared.map(\.destination).joined(separator: "\n"))",
            ]
            config.stdout = logs
            config.stderr = logs
        }
        try await service.start()
        do {
            try await waitForService(vm.socket, token: token, dotId: id, logs: logs)
            let relay = try Relay(socketPath: vm.socket.path) { [weak self] in
                Task { await self?.touch() }
            }
            let port = try await relay.start()
            log("computer for \(id) on 127.0.0.1:\(port)")
            return Agent(service: service, relay: relay, port: port, mounts: shared)
        } catch {
            try? await service.kill(.kill)
            throw error
        }
    }

    /// Ready means the Dot's service answered an authenticated request
    /// through the router, not just that the socket exists.
    private func waitForService(_ socket: URL, token: String, dotId: String, logs: Capture) async throws {
        for _ in 0..<200 {
            if serviceAnswers(socket.path, token: token, dotId: dotId) { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw ProviderError("The computer service did not start. \(logs.text.suffix(500))")
    }

    /// Runs a root shell script in the VM and returns its output.
    @discardableResult
    private func run(_ container: LinuxContainer, _ script: String) async throws -> String {
        execCounter += 1
        let output = Capture(limit: 20_000)
        let process = try await container.exec("setup-\(execCounter)") { config in
            config.arguments = ["/bin/sh", "-c", script]
            config.environmentVariables = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]
            config.stdout = output
            config.stderr = output
        }
        try await process.start()
        let status = try await process.wait()
        try? await process.delete()
        guard status.exitCode == 0 else {
            throw ProviderError("Setup failed (exit \(status.exitCode)): \(output.text.suffix(300))")
        }
        return output.text
    }

    private func stopAgent(_ id: String) async {
        notes[id] = nil
        guard let agent = agents.removeValue(forKey: id) else { return }
        agent.relay.stop()
        try? await agent.service.kill(.term)
        log("computer for \(id) stopped")
    }

    private func shutdownVM() async {
        vmTask?.cancel()
        for id in Array(agents.keys) { await stopAgent(id) }
        guard let current = vm else { return }
        vm = nil
        try? await current.router.kill(.term)
        try? await current.container.stop()
        if var manager {
            try? manager.delete(sharedVMName)
            self.manager = manager
        }
        try? network?.releaseInterface(sharedVMName)
        try? FileManager.default.removeItem(at: current.socket)
        log("computer \(sharedVMName) stopped")
    }

    /// Stops the whole VM after `idleSeconds` without any request or boot.
    private func idleLoop() async {
        while true {
            try? await Task.sleep(for: .seconds(30))
            if vm != nil, bootTasks.isEmpty,
               shouldIdleStop(lastActivity: lastActivity, now: Date(), idleSeconds: config.idleSeconds) {
                log("computer idle for \(Int(config.idleSeconds))s; stopping")
                await shutdownVM()
            }
        }
    }
}

/// True once the computer has gone `idleSeconds` without activity.
func shouldIdleStop(lastActivity: Date, now: Date, idleSeconds: Double) -> Bool {
    idleSeconds > 0 && now.timeIntervalSince(lastActivity) >= idleSeconds
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
