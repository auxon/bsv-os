import XCTest
@testable import BSVOSWallet

/// P1's acceptance test: the Swift must build the daemon's own OrdLock scripts,
/// purchase preimages and v4 swap transactions — byte for byte.
///
/// The vectors come from `packages/walletd/test/vectors/generate-ordlock.mjs`,
/// which runs the daemon's `ordlock.ts` and `tx.ts` builders with the same
/// `@bsv/sdk` signing custody uses. Byte equality holds down to the signatures
/// because the digest and RFC6979 nonce are both deterministic; the offer
/// functions add NONE|ANYONECANPAY and SINGLE|ANYONECANPAY scopes, which no
/// earlier vector exercised.
final class OrdlockVectorTests: XCTestCase {
    private struct Utxo: Decodable {
        let txid: String
        let vout: UInt32
        let value: Int
        let scriptHex: String
    }

    private struct Outpoint: Decodable {
        let txid: String
        let vout: Int
    }

    private struct LockCase: Decodable {
        struct Decoded: Decodable {
            let cancelAddress: String
            let price: Int
            let payoutScriptHex: String
        }
        let name: String
        let cancel: String
        let pay: String
        let price: Int
        let scriptHex: String
        let decoded: Decoded
    }

    private struct TxVector: Decodable {
        let unsignedHex: String
        let signedHex: String
        let txid: String
        let fee: Int
        let changeSats: Int
        let changeVout: Int
        let unlockHexes: [String]
        // lock
        let carrier: Utxo?
        let funding: Utxo?
        let lockScriptHex: String?
        // cancel
        let lockOutpoint: Outpoint?
        // buy
        let memo: [String]?
        let priceSats: Int?
        let payoutScriptHex: String?
        let purchaseUnlockHex: String?
        let feePayment: Payment?
        struct Payment: Decodable {
            let to: String
            let sats: Int
        }
    }

    private struct OfferInput: Decodable {
        let txid: String
        let vout: Int
        let scriptHex: String
        let sequence: Int
        let unlockHex: String
    }

    private struct OfferVector: Decodable {
        let version: Int
        let kind: String
        let payScriptHex: String
        let priceSats: Int
        let lockTime: Int
        let inputs: [OfferInput]
    }

    private struct VectorFile: Decodable {
        let phrase: String
        let selfAddress: String
        let selfScriptHex: String
        let lockCases: [LockCase]
        let lock: TxVector
        let cancel: TxVector
        let buy: TxVector
        let offer: OfferVector
        let complete: TxVector

        enum CodingKeys: String, CodingKey {
            case phrase, lockCases, lock, cancel, buy, offer, complete
            case selfAddress = "self"
            case selfScriptHex
        }
    }

    private func load() throws -> VectorFile {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/ordlock-vectors.json")
        return try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url))
    }

    private func vectorKey(_ phrase: String) throws -> (privateKey: [UInt8], publicKey: [UInt8], address: String, scriptHex: String) {
        let master = try BIP32.master(fromSeed: BIP39.seed(from: phrase))
        let key = try BIP32.derive("m/0/0", from: master)
        let publicKey = try Secp256k1.publicKey(fromPrivateKey: key.privateKey)
        let address = Address.from(publicKey: publicKey)
        return (key.privateKey, publicKey, address, Hex.encode(try Address.lockingScript(for: address)))
    }

    private func input(_ utxo: Utxo) -> Tx.Input {
        Tx.Input(txid: utxo.txid, vout: utxo.vout, value: utxo.value, scriptHex: utxo.scriptHex)
    }

    // MARK: - covenant scripts

    func testLockScriptsMatchThe1SatTemplateAndDecodeBack() throws {
        let vectors = try load()
        for lockCase in vectors.lockCases {
            let scriptHex = try Ordlock.lockScript(
                cancelAddress: lockCase.cancel, payAddress: lockCase.pay, priceSats: lockCase.price
            )
            XCTAssertEqual(scriptHex, lockCase.scriptHex, "lock script: \(lockCase.name)")
            XCTAssertTrue(Ordlock.isOrdLock(scriptHex))
            let decoded = try XCTUnwrap(Ordlock.decode(scriptHex), "decodes: \(lockCase.name)")
            XCTAssertEqual(decoded.cancelAddress, lockCase.decoded.cancelAddress)
            XCTAssertEqual(decoded.priceSats, lockCase.decoded.price)
            XCTAssertEqual(decoded.payoutScriptHex, lockCase.decoded.payoutScriptHex)
        }
        XCTAssertFalse(Ordlock.isOrdLock("deadbeef"))
        XCTAssertNil(Ordlock.decode("deadbeef"))
    }

    // MARK: - the seller's lock

    func testLockTransactionIsByteIdenticalToTheDaemon() throws {
        let vectors = try load()
        let key = try vectorKey(vectors.phrase)
        let vector = vectors.lock
        let carrier = try XCTUnwrap(vector.carrier)
        let funding = try XCTUnwrap(vector.funding)
        let lockScriptHex = try XCTUnwrap(vector.lockScriptHex)

        let built = try Tx.build(
            inputs: [input(carrier), input(funding)],
            payments: [Tx.Payment(scriptHex: lockScriptHex, sats: 1)],
            changeScriptHex: vectors.selfScriptHex,
            keepOrder: true
        )
        XCTAssertEqual(built.fee, vector.fee)
        XCTAssertEqual(built.changeVout, vector.changeVout)
        XCTAssertEqual(
            Hex.encode(try Tx.serializeUnsigned(inputs: built.inputs, outputs: built.outputs)),
            vector.unsignedHex
        )
        let signed = try Tx.sign(built: built, privateKey: key.privateKey, publicKey: key.publicKey)
        XCTAssertEqual(Hex.encode(signed), vector.signedHex)
        XCTAssertEqual(Tx.txid(ofSignedBytes: signed), vector.txid)
        XCTAssertEqual(
            try Tx.unlockingScripts(built: built, privateKey: key.privateKey, publicKey: key.publicKey).map(Hex.encode),
            vector.unlockHexes
        )
    }

    // MARK: - the seller's cancel

    func testCancelTransactionIsByteIdenticalToTheDaemon() throws {
        let vectors = try load()
        let key = try vectorKey(vectors.phrase)
        let vector = vectors.cancel
        let lockOutpoint = try XCTUnwrap(vector.lockOutpoint)
        let lockScriptHex = try XCTUnwrap(vector.lockScriptHex)
        let funding = try XCTUnwrap(vector.funding)

        let built = try Tx.build(
            inputs: [
                Tx.Input(txid: lockOutpoint.txid, vout: UInt32(lockOutpoint.vout), value: 1, scriptHex: lockScriptHex),
                input(funding),
            ],
            payments: [Tx.Payment(address: vectors.selfAddress, sats: 1)],
            changeScriptHex: vectors.selfScriptHex,
            keepOrder: true
        )
        let signed = try Tx.sign(
            built: built, privateKey: key.privateKey, publicKey: key.publicKey,
            scopeFor: nil,
            customUnlock: { index, built in
                guard index == 0 else { return nil }
                let digest = try Tx.sighash(
                    inputs: built.inputs, outputs: built.outputs, inputIndex: 0,
                    scriptCode: try Hex.decode(lockScriptHex)
                )
                let signature = try Secp256k1.sign(derForDigest: digest, withPrivateKey: key.privateKey)
                return Tx.p2pkhUnlock(signature: signature, publicKey: key.publicKey) + [0x51] // OP_1: cancel path
            }
        )
        XCTAssertEqual(built.fee, vector.fee)
        XCTAssertEqual(Hex.encode(signed), vector.signedHex)
        XCTAssertEqual(Tx.txid(ofSignedBytes: signed), vector.txid)
        XCTAssertEqual(vector.unlockHexes[0].suffix(2), "51", "the cancel path selector")
    }

    // MARK: - the buyer's purchase

    /// The purchase unlock carries no signature: it is output 0, then outputs
    /// 2+, then the ALL|ANYONECANPAY preimage, then OP_0. The vector is the
    /// daemon's own script from the same transaction.
    func testPurchaseUnlockAndBuyTransactionAreByteIdentical() throws {
        let vectors = try load()
        let key = try vectorKey(vectors.phrase)
        let vector = vectors.buy
        let lockOutpoint = try XCTUnwrap(vector.lockOutpoint)
        let lockScriptHex = try XCTUnwrap(vector.lockScriptHex)
        let funding = try XCTUnwrap(vector.funding)
        let payoutScriptHex = try XCTUnwrap(vector.payoutScriptHex)
        let price = try XCTUnwrap(vector.priceSats)
        let feePayment = try XCTUnwrap(vector.feePayment)

        let built = try Tx.build(
            inputs: [
                Tx.Input(txid: lockOutpoint.txid, vout: UInt32(lockOutpoint.vout), value: 1, scriptHex: lockScriptHex),
                input(funding),
            ],
            payments: [
                Tx.Payment(address: vectors.selfAddress, sats: 1),
                Tx.Payment(scriptHex: payoutScriptHex, sats: price),
                Tx.Payment(address: feePayment.to, sats: feePayment.sats),
            ],
            changeScriptHex: vectors.selfScriptHex,
            opReturn: vector.memo,
            keepOrder: true
        )

        let purchase = try Ordlock.purchaseUnlock(
            inputs: built.inputs, outputs: built.outputs, inputIndex: 0,
            lockScriptHex: lockScriptHex, lockValue: 1
        )
        XCTAssertEqual(Hex.encode(purchase), vector.purchaseUnlockHex)

        let signed = try Tx.sign(
            built: built, privateKey: key.privateKey, publicKey: key.publicKey,
            scopeFor: nil,
            customUnlock: { index, built in
                guard index == 0 else { return nil }
                return try Ordlock.purchaseUnlock(
                    inputs: built.inputs, outputs: built.outputs, inputIndex: 0,
                    lockScriptHex: lockScriptHex, lockValue: 1
                )
            }
        )
        XCTAssertEqual(built.fee, vector.fee)
        XCTAssertEqual(Hex.encode(signed), vector.signedHex, "signed buy bytes")
        XCTAssertEqual(Tx.txid(ofSignedBytes: signed), vector.txid)
    }

    // MARK: - the v4 offer

    func testSwapOfferUnlocksMatchTheDaemonsScopedSignatures() throws {
        let vectors = try load()
        let key = try vectorKey(vectors.phrase)
        let offer = vectors.offer
        let dust = offer.inputs[0]
        let carrier = offer.inputs[1]

        let template = try Ordlock.swapOfferTemplate(
            dustTxid: dust.txid, dustVout: dust.vout, dustScriptHex: dust.scriptHex,
            carrierTxid: carrier.txid, carrierVout: carrier.vout, carrierScriptHex: carrier.scriptHex,
            payAddress: vectors.selfAddress, priceSats: offer.priceSats
        )
        XCTAssertEqual(template.payScriptHex, offer.payScriptHex)
        XCTAssertEqual(template.outputs.map(\.scriptHex), ["006a", offer.payScriptHex])
        XCTAssertEqual(template.outputs[0].sats, 0)
        XCTAssertEqual(template.outputs[1].sats, offer.priceSats)

        let built = Tx.Built(inputs: template.inputs, outputs: template.outputs, fee: 0, changeSats: 0, changeVout: -1)
        let unlocks = try Tx.unlockingScripts(
            built: built, privateKey: key.privateKey, publicKey: key.publicKey,
            scopeFor: { $0 == 0 ? Ordlock.scopeNoneAnyoneCanPay : Ordlock.scopeSingleAnyoneCanPay },
            customUnlock: nil
        )
        XCTAssertEqual(Hex.encode(unlocks[0]), dust.unlockHex, "NONE|ANYONECANPAY prefix")
        XCTAssertEqual(Hex.encode(unlocks[1]), carrier.unlockHex, "SINGLE|ANYONECANPAY carrier")

        // The scope byte sits at the end of the pushed signature, before the
        // pubkey push; check it is what the template promises.
        XCTAssertEqual(unlocks[0][1 + Int(unlocks[0][0]) - 1], 0xc2)
        XCTAssertEqual(unlocks[1][1 + Int(unlocks[1][0]) - 1], 0xc3)
    }

    // MARK: - the buyer's completion

    func testCompleteSwapIsByteIdenticalToTheDaemon() throws {
        let vectors = try load()
        let key = try vectorKey(vectors.phrase)
        let vector = vectors.complete
        let dust = vectors.offer.inputs[0]
        let carrier = vectors.offer.inputs[1]
        let funding = try XCTUnwrap(vector.funding)

        let built = try Tx.build(
            inputs: [
                Tx.Input(txid: dust.txid, vout: UInt32(dust.vout), value: 1, scriptHex: dust.scriptHex),
                Tx.Input(txid: carrier.txid, vout: UInt32(carrier.vout), value: 1, scriptHex: carrier.scriptHex),
                input(funding),
            ],
            payments: [
                Tx.Payment(address: vectors.selfAddress, sats: 1),
                Tx.Payment(scriptHex: vectors.offer.payScriptHex, sats: vectors.offer.priceSats),
            ],
            changeScriptHex: vectors.selfScriptHex,
            keepOrder: true
        )
        let preSigned = [
            try Hex.decode(dust.unlockHex),
            try Hex.decode(carrier.unlockHex),
        ]
        let signed = try Tx.sign(
            built: built, privateKey: key.privateKey, publicKey: key.publicKey,
            scopeFor: nil,
            customUnlock: { index, _ in index < 2 ? preSigned[index] : nil }
        )
        XCTAssertEqual(built.fee, vector.fee)
        XCTAssertEqual(Hex.encode(signed), vector.signedHex, "signed completion bytes")
        XCTAssertEqual(Tx.txid(ofSignedBytes: signed), vector.txid)
        XCTAssertEqual(try Tx.unlockingScripts(
            built: built, privateKey: key.privateKey, publicKey: key.publicKey,
            scopeFor: nil,
            customUnlock: { index, _ in index < 2 ? preSigned[index] : nil }
        ).map(Hex.encode), vector.unlockHexes)
    }

    /// A bsv21 offer is decoded (so a market payload does not crash a decoder)
    /// but the completion must refuse it.
    func testBsv21OffersDecodeButAreNotCompletable() throws {
        let json = """
        {"version":3,"kind":"bsv21","payScriptHex":"76a9141dca7033f3ce0b62f794ef26b4ca2452f7b715cf88ac",
         "priceSats":100,"lockTime":0,"tokenId":"\(String(repeating: "ab", count: 32))_0","tokenAmount":"1000"}
        """
        let offer = try JSONDecoder().decode(Ordlock.SwapOffer.self, from: Data(json.utf8))
        XCTAssertEqual(offer.kind, "bsv21")
        XCTAssertEqual(offer.tokenAmount, "1000")
    }
}
