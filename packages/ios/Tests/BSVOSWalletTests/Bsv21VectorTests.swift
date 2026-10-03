import XCTest
@testable import BSVOSWallet

/// BSV21 swap acceptance: transfer envelopes, the parse and validation gates,
/// and the v3 offer/completion transactions — all byte-for-byte from vectors
/// generated with the daemon's own `tokens.ts`, `buildTx` and SDK signing.
final class Bsv21VectorTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Utxo: Decodable {
            let txid: String
            let vout: UInt32
            let value: Int
            let scriptHex: String
        }
        struct Envelope: Decodable {
            let proto: String
            let op: String
            let id: String
            let amt: String
            let contentType: String

            enum CodingKeys: String, CodingKey {
                case proto = "protocol"
                case op, id, amt, contentType
            }
        }
        struct Transfer: Decodable {
            let name: String
            let owner: String
            let tokenId: String
            let amt: String
            let scriptHex: String
            let envelope: Envelope
        }
        struct Malformed: Decodable {
            let name: String
            let scriptHex: String
        }
        struct TokenIdCase: Decodable {
            let raw: String
            let normalized: String?
        }
        struct AmountCase: Decodable {
            let raw: String
            let canonical: String?
        }
        struct Offer: Decodable {
            struct Input: Decodable {
                let txid: String
                let vout: UInt32
                let scriptHex: String
                let sequence: Int
            }
            let version: Int
            let kind: String
            let payScriptHex: String
            let priceSats: Int
            let lockTime: Int
            let input: Input
            let unlockHex: String
            let tokenId: String
            let tokenAmount: String
        }
        struct Complete: Decodable {
            let funding: Utxo
            let tokenOutput: String
            let unsignedHex: String
            let signedHex: String
            let txid: String
            let fee: Int
            let changeSats: Int
            let changeVout: Int
            let unlockHexes: [String]
        }
        let phrase: String
        let selfAddress: String
        let selfScriptHex: String
        let transfers: [Transfer]
        let malformed: [Malformed]
        let tokenIds: [TokenIdCase]
        let amounts: [AmountCase]
        let offer: Offer
        let complete: Complete

        enum CodingKeys: String, CodingKey {
            case phrase, transfers, malformed, tokenIds, amounts, offer, complete
            case selfAddress = "self"
            case selfScriptHex
        }
    }

    private func load() throws -> Vectors {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/bsv21-vectors.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func vectorKey(_ phrase: String) throws -> (privateKey: [UInt8], publicKey: [UInt8], address: String) {
        let master = try BIP32.master(fromSeed: BIP39.seed(from: phrase))
        let key = try BIP32.derive("m/0/0", from: master)
        let publicKey = try Secp256k1.publicKey(fromPrivateKey: key.privateKey)
        return (key.privateKey, publicKey, Address.from(publicKey: publicKey))
    }

    // MARK: - envelopes and gates

    func testTransferScriptsAndEnvelopesMatchTheDaemon() throws {
        let vectors = try load()
        XCTAssertEqual(vectors.transfers.count, 2)
        for transfer in vectors.transfers {
            let script = try Bsv21.transferScript(
                ownerAddress: transfer.owner, tokenId: transfer.tokenId, amount: transfer.amt
            )
            XCTAssertEqual(script, transfer.scriptHex, transfer.name)

            let envelope = try XCTUnwrap(Bsv21.parseEnvelope(script), transfer.name)
            XCTAssertEqual(envelope.protocolId, transfer.envelope.proto)
            XCTAssertEqual(envelope.op, transfer.envelope.op)
            XCTAssertEqual(envelope.id, transfer.envelope.id)
            XCTAssertEqual(envelope.amt, transfer.envelope.amt)
            XCTAssertEqual(envelope.contentType, transfer.envelope.contentType)

            // A token carrier is an inscription carrier too: the funding
            // selector must keep its hands off it.
            XCTAssertTrue(Inscription.hasOrdEnvelope(script), transfer.name)
            let meta = try XCTUnwrap(Inscription.envelopeMetadata(script), transfer.name)
            XCTAssertEqual(meta.contentType, "application/bsv-20")
            XCTAssertGreaterThan(meta.contentLength, 0)
        }
    }

    func testMalformedScriptsAreNotTokenEnvelopes() throws {
        for testCase in try load().malformed {
            XCTAssertNil(Bsv21.parseEnvelope(testCase.scriptHex), testCase.name)
        }
    }

    func testTokenIdAndAmountGatesMatchTheDaemon() throws {
        let vectors = try load()
        for testCase in vectors.tokenIds {
            XCTAssertEqual(Bsv21.normalizeTokenId(testCase.raw), testCase.normalized, testCase.raw)
        }
        for testCase in vectors.amounts {
            XCTAssertEqual(Bsv21.parseTokenAmount(testCase.raw), testCase.canonical, testCase.raw)
        }
    }

    // MARK: - the v3 offer and its completion

    func testV3OfferMatchesTheDaemonsPreSignature() throws {
        let vectors = try load()
        let key = try vectorKey(vectors.phrase)
        let offer = vectors.offer
        XCTAssertEqual(offer.version, Ordlock.swapVersionToken)

        let built = Tx.Built(
            inputs: [Tx.Input(
                txid: offer.input.txid, vout: offer.input.vout,
                value: 1, scriptHex: offer.input.scriptHex
            )],
            outputs: [Tx.Output(scriptHex: offer.payScriptHex, sats: offer.priceSats)],
            fee: 0, changeSats: 0, changeVout: -1
        )
        let unlocks = try Tx.unlockingScripts(
            built: built, privateKey: key.privateKey, publicKey: key.publicKey,
            scopeFor: { _ in Ordlock.scopeSingleAnyoneCanPay }
        )
        XCTAssertEqual(Hex.encode(unlocks[0]), offer.unlockHex, "SINGLE|ANYONECANPAY pre-signature")
    }

    func testV3CompletionIsByteIdenticalToTheDaemon() throws {
        let vectors = try load()
        let key = try vectorKey(vectors.phrase)
        let offer = vectors.offer
        let complete = vectors.complete

        let built = try Tx.build(
            inputs: [
                Tx.Input(txid: offer.input.txid, vout: offer.input.vout, value: 1, scriptHex: offer.input.scriptHex),
                Tx.Input(
                    txid: complete.funding.txid, vout: complete.funding.vout,
                    value: complete.funding.value, scriptHex: complete.funding.scriptHex
                ),
            ],
            payments: [
                // Payment first, the fresh transfer envelope second — the
                // opposite order from the ordinal swaps.
                Tx.Payment(scriptHex: offer.payScriptHex, sats: offer.priceSats),
                Tx.Payment(scriptHex: complete.tokenOutput, sats: 1),
            ],
            changeScriptHex: vectors.selfScriptHex,
            keepOrder: true
        )
        XCTAssertEqual(built.fee, complete.fee)
        XCTAssertEqual(built.changeSats, complete.changeSats)
        XCTAssertEqual(
            Hex.encode(try Tx.serializeUnsigned(inputs: built.inputs, outputs: built.outputs)),
            complete.unsignedHex
        )

        let preSigned = try Hex.decode(offer.unlockHex)
        let signed = try Tx.sign(
            built: built, privateKey: key.privateKey, publicKey: key.publicKey,
            scopeFor: nil,
            customUnlock: { index, _ in index == 0 ? preSigned : nil }
        )
        XCTAssertEqual(Hex.encode(signed), complete.signedHex, "signed completion bytes")
        XCTAssertEqual(Tx.txid(ofSignedBytes: signed), complete.txid)

        // The token output the buyer writes is the canonical transfer script.
        let tokenScript = try Bsv21.transferScript(
            ownerAddress: vectors.selfAddress, tokenId: offer.tokenId, amount: offer.tokenAmount
        )
        XCTAssertEqual(tokenScript, complete.tokenOutput)
    }
}
