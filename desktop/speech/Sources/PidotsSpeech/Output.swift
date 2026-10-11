import Foundation

/// Writes events to stdout in the order they were reported. Called from the
/// main queue and the recognizer's callbacks, so writes go through one queue.
final class Output {
    private let queue = DispatchQueue(label: "pidots-speech.output")

    func emit(_ event: Event) {
        guard let data = Wire.encode(event) else { return }
        queue.async { FileHandle.standardOutput.write(data) }
    }
}
