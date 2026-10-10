import Foundation
import Network

/// Forwards 127.0.0.1:<port> to one computer's service socket on the host.
/// Each running computer gets its own relay, so a port only ever reaches
/// that Dot's VM (whose service still checks the Dot's own token).
final class Relay: @unchecked Sendable {
    private let listener: NWListener
    private let socketPath: String
    private let queue = DispatchQueue(label: "pidots.relay")

    init(socketPath: String) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        self.socketPath = socketPath
    }

    func start() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, Error>) in
            let resumed = Box(false)
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready:
                    if !resumed.swap(true) { continuation.resume(returning: listener.port?.rawValue ?? 0) }
                case .failed(let error):
                    if !resumed.swap(true) { continuation.resume(throwing: error) }
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] inbound in self?.bridge(inbound) }
            listener.start(queue: queue)
        }
    }

    private func bridge(_ inbound: NWConnection) {
        let outbound = NWConnection(to: .unix(path: socketPath), using: .tcp)
        inbound.start(queue: queue)
        outbound.start(queue: queue)
        pump(from: inbound, to: outbound)
        pump(from: outbound, to: inbound)
    }

    private func pump(from source: NWConnection, to sink: NWConnection) {
        source.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            if let data, !data.isEmpty {
                sink.send(content: data, completion: .contentProcessed { _ in })
            }
            if complete || error != nil {
                sink.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
                    sink.cancel()
                })
                source.cancel()
                return
            }
            self?.pump(from: source, to: sink)
        }
    }

    func stop() { listener.cancel() }
}
