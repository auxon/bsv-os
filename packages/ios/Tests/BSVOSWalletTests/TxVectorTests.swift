import XCTest
@testable import BSVOSWallet

/// S2's acceptance test: the Swift must build the same transaction bytes the
/// daemon builds, from the same inputs.
///
/// The vectors come from `packages/walletd/test/vectors/generate-tx.mjs`, which
/// runs the daemon's own `buildTx` and `@bsv/sdk` signing. The unsigned form is
/// compared **byte for byte**, which is the strict test of fee arithmetic, input
/// ordering, output layout and varint encoding. The signed form is compared too,
/// and if the two libraries' ECDSA nonces differ the test says so rather than
/// pretending — a signature that verifies is not the same claim as a signature
/// that is identical.
final class TxVectorTests: XCTestCase {
    private struct Vector: Decodable {
        struct Utxo: Decodable {
            let txid: String
            let vout: UInt32
            let value: Int
            let scriptHex: String
        }
        struct Payment: Decodable {
            let address: String?
            let sats: Int
        }
        let name: String
        let selfScriptHex: String
        let utxos: [Utxo]
        let payments: [Payment]
        let opReturn: [String]?
        let fee: Int
        let changeSats: Int
        let changeVout: Int
        let unsignedHex: String
        let signedHex: String
        let txid: String
    }

    private func loadVectors() throws -> [Vector] {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/tx-vectors.json")
        return try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
    }

    /// The key the vectors were signed with: `m/0/0` of the BIP39 test phrase.
    private func vectorKey() throws -> (privateKey: [UInt8], publicKey: [UInt8], address: String) {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        let master = try BIP32.master(fromSeed: BIP39.seed(from: phrase))
        let key = try BIP32.derive("m/0/0", from: master)
        let publicKey = try Secp256k1.publicKey(fromPrivateKey: key.privateKey)
        return (key.privateKey, publicKey, Address.from(publicKey: publicKey))
    }

    private func build(_ vector: Vector) throws -> Tx.Built {
        try Tx.build(
            inputs: vector.utxos.map { Tx.Input(txid: $0.txid, vout: $0.vout, value: $0.value, scriptHex: $0.scriptHex) },
            payments: vector.payments.map { Tx.Payment(address: $0.address, sats: $0.sats) },
            changeScriptHex: vector.selfScriptHex,
            opReturn: vector.opReturn
        )
    }

    func testTheVectorsCoverTheInterestingBranches() throws {
        let vectors = try loadVectors()
        XCTAssertEqual(vectors.count, 5, "five cases")
        XCTAssertTrue(vectors.contains { $0.changeVout == -1 }, "one folds dust into the fee")
        XCTAssertTrue(vectors.contains { $0.utxos.count > 5 }, "one exercises a growing input count")
        XCTAssertTrue(vectors.contains { $0.opReturn != nil }, "one has an OP_RETURN")
    }

    func testUnsignedSerializationIsByteIdentical() throws {
        for vector in try loadVectors() {
            let built = try build(vector)
            let serialized = try Tx.serializeUnsigned(inputs: built.inputs, outputs: built.outputs)
            XCTAssertEqual(Hex.encode(serialized), vector.unsignedHex, "unsigned bytes: \(vector.name)")
        }
    }

    func testFeeChangeAndLayoutMatch() throws {
        for vector in try loadVectors() {
            let built = try build(vector)
            XCTAssertEqual(built.fee, vector.fee, "fee: \(vector.name)")
            XCTAssertEqual(built.changeSats, vector.changeSats, "change: \(vector.name)")
            XCTAssertEqual(built.changeVout, vector.changeVout, "change vout: \(vector.name)")
            // The builder may pick a subset of the candidate UTXOs (the 12-input
            // case picks 7), so compare with what the daemon actually spent, not
            // with the candidate list.
            let theirs = try Tx.parse(try Hex.decode(vector.signedHex))
            XCTAssertEqual(built.inputs.count, theirs.inputs.count, "input count, picked subset: \(vector.name)")
        }
    }

    /// The dust branch, named because it is the one a port silently gets wrong:
    /// the fee grows by the folded remainder rather than the change becoming an
    /// output.
    func testDustIsFoldedIntoTheFee() throws {
        let vector = try XCTUnwrap(try loadVectors().first { $0.changeVout == -1 })
        let built = try build(vector)
        XCTAssertEqual(built.changeSats, 0)
        XCTAssertEqual(built.changeVout, -1, "no change output")
        // The fee is the formula's value *plus* the folded remainder.
        XCTAssertGreaterThan(built.fee, Tx.minMinerFee)
        XCTAssertEqual(built.fee, vector.fee)
        // And no output carries the remainder.
        XCTAssertFalse(built.outputs.contains { $0.sats > 0 && $0.sats < Tx.dust })
    }

    /// Sign the same transaction and check the signature is one the network
    /// would accept: the key that signs is the key derived here, over the right
    /// digest.
    func testSignaturesVerifyAgainstTheDerivedKey() throws {
        let key = try vectorKey()
        for vector in try loadVectors() {
            let built = try build(vector)
            let signed = try Tx.sign(built: built, privateKey: key.privateKey, publicKey: key.publicKey)

            // Parse back the first input's unlocking script: push(sig+sighash),
            // push(pubkey).
            let script = try firstUnlockingScript(ofSigned: signed, tx: built)
            let decoded = try decodeTwoPushes(script)
            XCTAssertEqual(decoded.publicKey, key.publicKey, "the pubkey pushed is the derived one")
            XCTAssertEqual(decoded.signature.last, 0x41, "SIGHASH_ALL|FORKID")

            let digest = try Tx.sighash(inputs: built.inputs, outputs: built.outputs, inputIndex: 0,
                                        scriptCode: try Hex.decode(built.inputs[0].scriptHex))
            XCTAssertTrue(try Secp256k1.verify(derSignature: Array(decoded.signature.dropLast()),
                                               digest: digest, publicKey: key.publicKey),
                          "the signature verifies over the BIP143 digest: \(vector.name)")
        }
    }

    /// Byte equality with the daemon's signed transaction — the strongest check
    /// available, and it holds.
    ///
    /// This assertion started as its opposite, and the path to equality is the
    /// useful part of it. Three things were wrong in the first implementation,
    /// each found by comparing against these vectors rather than by reading:
    ///
    ///   1. the digest algorithm: the SDK contains both `formatOTDA` and
    ///      `formatBip143`, and `formatBytes` picks BIP143 whenever SIGHASH_FORKID
    ///      is set. Reading alone had suggested the opposite;
    ///   2. `hashOutputs`: it hashes the concatenated outputs with **no count
    ///      prefix**, unlike the full transaction serialization;
    ///   3. the digest is a **single** SHA-256 of the preimage, not the double
    ///      hash BIP143 specifies elsewhere. The daemon's signature verified
    ///      under `sha256(preimage)` and failed under `sha256(sha256(preimage))`.
    ///
    /// With those right, both sides use RFC6979 deterministically over the same
    /// digest and the transactions are identical down to the signature bytes.
    func testSignedTransactionIsByteIdenticalToTheDaemon() throws {
        let key = try vectorKey()
        for vector in try loadVectors() {
            let built = try build(vector)
            let signed = try Tx.sign(built: built, privateKey: key.privateKey, publicKey: key.publicKey)
            XCTAssertEqual(Hex.encode(signed), vector.signedHex, "signed bytes: \(vector.name)")
            XCTAssertEqual(Tx.txid(ofSignedBytes: signed), vector.txid, "txid: \(vector.name)")
        }
    }

    /// A txid must be the double SHA-256 of the signed serialization, reversed.
    /// Checked against the daemon's own bytes, which is a fixed value.
    func testTxidIsTheReversedDoubleHashOfTheSignedBytes() throws {
        let vector = try XCTUnwrap(try loadVectors().first)
        let theirBytes = try Hex.decode(vector.signedHex)
        XCTAssertEqual(Tx.txid(ofSignedBytes: theirBytes), vector.txid)
    }

    // MARK: - helpers

    private func firstUnlockingScript(ofSigned signed: [UInt8], tx: Tx.Built) throws -> [UInt8] {
        // Walk the serialization: version(4), varint inputs, then input 0.
        var cursor = 4
        let inputCount = Int(signed[cursor]); cursor += 1     // all vectors are < 253 inputs
        XCTAssertEqual(inputCount, tx.inputs.count)
        cursor += 32 + 4                                       // txid + vout
        let scriptLength = Int(signed[cursor]); cursor += 1
        return Array(signed[cursor..<(cursor + scriptLength)])
    }

    private func decodeTwoPushes(_ script: [UInt8]) throws -> (signature: [UInt8], publicKey: [UInt8]) {
        var cursor = 0
        let sigLength = Int(script[cursor]); cursor += 1
        let signature = Array(script[cursor..<(cursor + sigLength)])
        cursor += sigLength
        let keyLength = Int(script[cursor]); cursor += 1
        let publicKey = Array(script[cursor..<(cursor + keyLength)])
        return (signature, publicKey)
    }
}
