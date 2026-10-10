import Foundation

/// Persistent metadata, versioned. An unknown version is never overwritten.
struct ProviderState: Codable, Equatable {
    static let currentVersion = 1

    struct Computer: Codable, Equatable {
        var createdAt: Date
        var template: String
    }

    var version = ProviderState.currentVersion
    var template: String?
    var computers: [String: Computer] = [:]

    static func load(from url: URL) throws -> ProviderState {
        guard FileManager.default.fileExists(atPath: url.path) else { return ProviderState() }
        let data = try Data(contentsOf: url)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let probe = try decoder.decode(Versioned.self, from: data)
        guard probe.version == currentVersion else {
            throw ProviderError(
                "Computer metadata has version \(probe.version), which this Pidots does not understand. Update Pidots; your computers were left untouched."
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
