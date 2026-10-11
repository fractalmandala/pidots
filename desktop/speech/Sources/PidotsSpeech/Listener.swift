import AVFoundation
import Speech

/// Turns the microphone into text with Apple's speech recognizer. Each final
/// result is reported as `final`, then a fresh recognition task starts, so the
/// caller can keep talking. The microphone is released whenever `pause` is sent.
final class Listener {
    private let output: Output
    private let engine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer()
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapInstalled = false
    /// True between `listen` and `pause`. Tasks from an older generation are ignored.
    private var wanted = false
    private var generation = 0
    /// Consecutive task errors with no result in between. Several in a row means
    /// recognition cannot work (for example, the on-device model is missing).
    private var failures = 0

    init(output: Output) {
        self.output = output
    }

    func start() {
        guard !wanted else { return }
        wanted = true
        authorize { [weak self] problem in
            guard let self, self.wanted else { return }
            if let problem {
                self.wanted = false
                self.output.emit(.error(problem))
                return
            }
            self.begin()
        }
    }

    func pause() {
        wanted = false
        stopTask()
        if engine.isRunning { engine.stop() }
    }

    private func authorize(_ done: @escaping (String?) -> Void) {
        AVCaptureDevice.requestAccess(for: .audio) { microphoneAllowed in
            SFSpeechRecognizer.requestAuthorization { status in
                let problem: String?
                if !microphoneAllowed {
                    problem = "Microphone access is off for Pidots. Allow it in System Settings > Privacy & Security > Microphone."
                } else if status != .authorized {
                    problem = "Speech recognition is off for Pidots. Allow it in System Settings > Privacy & Security > Speech Recognition."
                } else {
                    problem = nil
                }
                DispatchQueue.main.async { done(problem) }
            }
        }
    }

    private func begin() {
        guard let recognizer, recognizer.isAvailable else {
            wanted = false
            output.emit(.error("Speech recognition is unavailable right now."))
            return
        }
        if !tapInstalled {
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else {
                wanted = false
                output.emit(.error("No microphone input is available."))
                return
            }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.append(buffer)
            }
            tapInstalled = true
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            wanted = false
            output.emit(.error("The microphone could not start: \(error.localizedDescription)"))
            return
        }
        startTask()
        output.emit(.listening)
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let current = request
        lock.unlock()
        current?.append(buffer)
    }

    private func startTask() {
        guard wanted, let recognizer else { return }
        generation += 1
        let current = generation
        let next = SFSpeechAudioBufferRecognitionRequest()
        next.shouldReportPartialResults = true
        next.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        lock.lock()
        request = next
        lock.unlock()
        task = recognizer.recognitionTask(with: next) { [weak self] result, error in
            DispatchQueue.main.async { self?.handle(result, error, generation: current) }
        }
    }

    private func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?, generation current: Int) {
        guard current == generation, wanted else { return }
        if let result {
            failures = 0
            let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
            if result.isFinal {
                if !text.isEmpty { output.emit(.final(text)) }
                restart(after: 0)
            } else if !text.isEmpty {
                output.emit(.partial(text))
            }
            return
        }
        guard error != nil else { return }
        // Silence and task timeouts end a task with an error. Keep listening.
        failures += 1
        if failures >= 3 {
            pause()
            output.emit(.error("Speech recognition stopped working. Check the Speech Recognition settings and try again."))
            return
        }
        restart(after: 0.5)
    }

    private func restart(after delay: TimeInterval) {
        stopTask()
        guard wanted else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.wanted, self.task == nil else { return }
            self.startTask()
        }
    }

    private func stopTask() {
        generation += 1
        task?.cancel()
        task = nil
        lock.lock()
        request?.endAudio()
        request = nil
        lock.unlock()
    }
}
