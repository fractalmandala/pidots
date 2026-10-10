import Foundation
import Network

/// A minimal HTTP/1.1 server on 127.0.0.1 for the Pidots server, the only
/// client. Requests are small JSON bodies; every response closes the connection.
final class HTTPServer: @unchecked Sendable {
    struct Request {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }
    struct Response {
        var status: Int
        var json: Any

        static func ok(_ json: Any) -> Response { Response(status: 200, json: json) }
        static func error(_ status: Int, _ message: String) -> Response {
            Response(status: status, json: ["error": message])
        }
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "pidots.http")
    private let handler: @Sendable (Request) async -> Response
    private static let maxBody = 1_000_000

    init(handler: @escaping @Sendable (Request) async -> Response) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        self.handler = handler
    }

    /// Starts listening and returns the chosen port.
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
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.start(queue: queue)
        }
    }

    private func accept(_ connection: NWConnection) {
        // Refuse anything that is not a loopback peer.
        if case let .hostPort(host, _) = connection.endpoint,
            !["127.0.0.1", "::1"].contains("\(host)".split(separator: "%").first.map(String.init) ?? "")
        {
            connection.cancel()
            return
        }
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if buffer.count > Self.maxBody + 16384 {
                self.send(connection, .error(413, "Request is too large."))
                return
            }
            if let request = Self.parse(buffer) {
                Task {
                    let response = await self.handler(request)
                    self.send(connection, response)
                }
            } else if complete || error != nil {
                connection.cancel()
            } else {
                self.receive(connection, buffer: buffer)
            }
        }
    }

    /// Returns a request once its headers and full body have arrived.
    static func parse(_ buffer: Data) -> Request? {
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let head = String(data: buffer[..<end.lowerBound], encoding: .utf8) else { return nil }
        var lines = head.components(separatedBy: "\r\n")
        let parts = lines.removeFirst().split(separator: " ")
        guard parts.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let body = buffer[end.upperBound...]
        guard body.count >= length else { return nil }
        let path = String(parts[1]).split(separator: "?").first.map(String.init) ?? "/"
        return Request(method: String(parts[0]), path: path, headers: headers, body: Data(body.prefix(length)))
    }

    private func send(_ connection: NWConnection, _ response: Response) {
        let body = (try? JSONSerialization.data(withJSONObject: response.json)) ?? Data("{}".utf8)
        let reason = response.status == 200 ? "OK" : "Error"
        var head = "HTTP/1.1 \(response.status) \(reason)\r\n"
        head += "Content-Type: application/json\r\nCache-Control: no-store\r\n"
        head += "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    func stop() { listener.cancel() }
}

/// A thread-safe flag, for resuming a continuation once.
final class Box<T>: @unchecked Sendable {
    private var value: T
    private let lock = NSLock()
    init(_ value: T) { self.value = value }
    func swap(_ next: T) -> T {
        lock.lock(); defer { lock.unlock() }
        let previous = value
        value = next
        return previous
    }
}
