// swift-tools-version: 6.2
// The Pidots computer provider: runs one Linux micro-VM per Dot with Apple's
// Containerization framework. Bundled inside Pidots.app and started by the shell.
import PackageDescription

let package = Package(
    name: "PidotsComputers",
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "pidots-computers", targets: ["PidotsComputers"])
    ],
    dependencies: [
        // Pinned exactly: the framework's API changes between minor releases.
        .package(url: "https://github.com/apple/containerization.git", exact: "0.49.0")
    ],
    targets: [
        .executableTarget(
            name: "PidotsComputers",
            dependencies: [
                .product(name: "Containerization", package: "containerization"),
                .product(name: "ContainerizationExtras", package: "containerization"),
                .product(name: "ContainerizationOS", package: "containerization"),
                .product(name: "ContainerizationOCI", package: "containerization"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "PidotsComputersTests",
            dependencies: ["PidotsComputers"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
