import Foundation

/// Persistent metadata, versioned. An unknown version is never overwritten.
struct ProviderState: Codable, Equatable {
    static let currentVersion = 2

    /// A Dot that has a user inside the shared computer.
    struct Dot: Codable, Equatable {
        var createdAt: Date
        var user: String
    }

    var version = ProviderState.currentVersion
    var template: String?
    var dots: [String: Dot] = [:]
    /// Dots deleted while the VM was off; their users are removed at next boot.
    var pendingDeletes: [String] = []

    static func load(from url: URL) throws -> ProviderState {
        guard FileManager.default.fileExists(atPath: url.path) else { return ProviderState() }
        let data = try Data(contentsOf: url)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let probe = try decoder.decode(Versioned.self, from: data)
        guard probe.version == currentVersion else {
            throw ProviderError(
                "Computer metadata has version \(probe.version), which this Pidots does not understand. Update Pidots; your computer was left untouched."
            )
        }
        return try decoder.decode(ProviderState.self, from: data)
    }

    /// Atomic write: a crash leaves either the old or the new file.
    func save(to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: url, options: .atomic)
    }

    private struct Versioned: Decodable { let version: Int }
}
