import Foundation

// pidots-speech: reads commands from stdin and reports to stdout, one JSON
// object per line (see Protocol.swift). It exits when stdin closes, so it never
// outlives the Node server that started it.

let output = Output()
let speaker = Speaker(output: output)
let listener = Listener(output: output)

func handle(_ command: Command) {
    switch command.cmd {
    case "listen":
        listener.start()
    case "pause":
        listener.pause()
    case "speak":
        // The caller's microphone must stay off while the Dot talks, or the
        // Dot would hear itself. The server sends `listen` once it is done.
        listener.pause()
        speaker.speak(command.text ?? "", voiceId: command.voice)
    case "stop":
        speaker.stop()
        listener.pause()
    case "voices":
        output.emit(.voices(speechVoices()))
    default:
        output.emit(.error("Unknown command: \(command.cmd)"))
    }
}

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        guard let command = Wire.decode(line) else { continue }
        DispatchQueue.main.async { handle(command) }
    }
    DispatchQueue.main.async {
        listener.pause()
        speaker.stop()
        exit(0)
    }
}

output.emit(.ready)
dispatchMain()
