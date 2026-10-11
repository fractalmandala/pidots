// swift-tools-version: 6.2
// The Pidots speech helper: Apple's speech recognition and text-to-speech for
// voice calls. Bundled inside Pidots.app and started by the Node server.
import PackageDescription

let package = Package(
    name: "PidotsSpeech",
    platforms: [.macOS("15.0")],
    products: [
        .executable(name: "pidots-speech", targets: ["PidotsSpeech"])
    ],
    targets: [
        .executableTarget(
            name: "PidotsSpeech",
            swiftSettings: [.swiftLanguageMode(.v5)],
            // A bare executable has no app bundle, so its privacy strings are embedded
            // in a __info_plist section. Without them, TCC aborts the first microphone use.
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "\(Context.packageDirectory)/Info.plist",
                ])
            ]
        ),
        .testTarget(
            name: "PidotsSpeechTests",
            dependencies: ["PidotsSpeech"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
