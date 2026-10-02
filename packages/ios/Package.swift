// swift-tools-version: 6.0
import PackageDescription

// The bsvOS iOS client. See ../../docs/ios.md for the design and threat model.
//
// Scope note: this package contains the *client* half of bsvOS on iOS — the
// BRC-100 call surface, the wire types, and the Phase 0 device transport. It
// deliberately contains no cryptography: custody stays in the daemon for now,
// and a test asserts the device surface cannot reach key-material methods.
let package = Package(
    name: "BSVOSWallet",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "BSVOSWallet", targets: ["BSVOSWallet"]),
    ],
    targets: [
        .target(name: "BSVOSWallet"),
        .testTarget(name: "BSVOSWalletTests", dependencies: ["BSVOSWallet"]),
    ]
)
