import AVFoundation

/// Says replies with Apple's built-in voices (AVSpeechSynthesizer). Reports
/// `speaking_done` once every queued utterance has finished or been cancelled.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private let output: Output
    private var pending = 0

    init(output: Output) {
        self.output = output
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String, voiceId: String?) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            output.emit(.speakingDone)
            return
        }
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = usableVoice(voiceId)
        pending += 1
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        finished()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        finished()
    }

    private func finished() {
        pending = max(0, pending - 1)
        if pending == 0 { output.emit(.speakingDone) }
    }
}

/// The chosen voice when it reads the Mac's language, else the system voice. A
/// saved voice from another language would garble the text.
func usableVoice(_ identifier: String?) -> AVSpeechSynthesisVoice? {
    let language = Locale.current.language.languageCode?.identifier ?? "en"
    if let voice = identifier.flatMap(AVSpeechSynthesisVoice.init(identifier:)),
       voice.language.hasPrefix(language + "-") || voice.language == language {
        return voice
    }
    return AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
}

/// The installed voices in the Mac's own language, sorted by name. A voice
/// reads text in its own language only, so other languages would come out as
/// gibberish when the Dot speaks English.
func speechVoices() -> [VoiceInfo] {
    let language = Locale.current.language.languageCode?.identifier ?? "en"
    return AVSpeechSynthesisVoice.speechVoices()
        .filter { $0.language.hasPrefix(language + "-") || $0.language == language }
        .map { voice in
            let quality: String
            switch voice.quality {
            case .enhanced: quality = "enhanced"
            case .premium: quality = "premium"
            default: quality = "default"
            }
            return VoiceInfo(id: voice.identifier, name: voice.name, language: voice.language, quality: quality)
        }
        .sorted { ($0.language, $0.name) < ($1.language, $1.name) }
}
