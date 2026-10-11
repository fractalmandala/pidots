import Foundation

/// A request from the Node server: one JSON object per stdin line.
/// `listen` and `pause` switch the microphone, `speak` says `text` in `voice`
/// (an AVSpeechSynthesisVoice identifier), `stop` cancels speech, and
/// `voices` lists the installed voices.
struct Command: Decodable, Equatable {
    let cmd: String
    var text: String?
    var voice: String?
}

/// A report to the Node server: one JSON object per stdout line.
struct Event: Encodable, Equatable {
    let type: String
    var text: String?
    var message: String?
    var list: [VoiceInfo]?

    static let ready = Event(type: "ready")
    static let listening = Event(type: "listening")
    static let speakingDone = Event(type: "speaking_done")
    static func partial(_ text: String) -> Event { Event(type: "partial", text: text) }
    static func final(_ text: String) -> Event { Event(type: "final", text: text) }
    static func error(_ message: String) -> Event { Event(type: "error", message: message) }
    static func voices(_ list: [VoiceInfo]) -> Event { Event(type: "voices", list: list) }
}

struct VoiceInfo: Codable, Equatable {
    let id: String
    let name: String
    let language: String
    /// "default", "enhanced" or "premium", as Apple reports the voice's quality.
    let quality: String
}

enum Wire {
    static func decode(_ line: String) -> Command? {
        try? JSONDecoder().decode(Command.self, from: Data(line.utf8))
    }

    static func encode(_ event: Event) -> Data? {
        guard var data = try? JSONEncoder().encode(event) else { return nil }
        data.append(0x0A)
        return data
    }
}
