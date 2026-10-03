import Foundation

/// OrdLock and the v4 atomic-swap template, ported from the daemon's
/// `ordlock.ts` and `swaps.ts`.
///
/// OrdLock is the 1Sat ecosystem's trustless ordinal-sale covenant. The seller
/// moves the 1-sat carrier into a lock script embedding the cancel (seller)
/// hash, the payout (price + P2PKH) and an sCrypt contract. The buyer spends
/// the lock output at input 0 — so FIFO keeps the inscribed sat on output 0 —
/// with outputs `[0]` the 1-sat ordinal to the buyer, `[1]` the byte-exact
/// payout, `[2+]` fee/memo/change. The contract enforces the payment, so no
/// seller signature is needed at buy time; the seller can cancel back with a
/// plain signature followed by `OP_1`.
///
/// The v4 swap is the same idea without a covenant: the seller pre-signs the
/// carrier with SINGLE|ANYONECANPAY (committing only to the payment output at
/// the same index) plus a plain 1-sat prefix input signed NONE|ANYONECANPAY,
/// and the buyer attaches those unlocks to a transaction they fund and sign.
public enum Ordlock {
    public enum Error: Swift.Error, Equatable {
        case badPayment
        case badPayout
    }

    /// The 1Sat template prefix: `21 <push 33-byte key> 21 <33-byte key> 82 20 <32-byte script hash> 00 00`.
    public static let prefixHex =
        "2097dfd76851bf465e8f715593b217714858bbe9570ff3bd5e33840a34e20ff0262102ba79df5f8ae7604a9830f03c7933028186aede0675a16f025dc4f8be8eec0382201008ce7480da41702918d1ec8e6849ba32b4d65b1e40dc669c31a1e6306b266c0000"

    /// The covenant suffix, byte-for-byte the 1Sat template.
    public static let suffixHex =
        "615179547a75537a537a537a0079537a75527a527a7575615579008763567901c161517957795779210ac407f0e4bd44bfc207355a778b046225a7068fc59ee7eda43ad905aadbffc800206c266b30e6a1319c66dc401e5bd6b432ba49688eecd118297041da8074ce081059795679615679aa0079610079517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01007e81517a75615779567956795679567961537956795479577995939521414136d08c5ed2bf3ba048afe6dcaebafeffffffffffffffffffffffffffffff00517951796151795179970079009f63007952799367007968517a75517a75517a7561527a75517a517951795296a0630079527994527a75517a6853798277527982775379012080517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01205279947f7754537993527993013051797e527e54797e58797e527e53797e52797e57797e0079517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a756100795779ac517a75517a75517a75517a75517a75517a75517a75517a75517a7561517a75517a756169587951797e58797eaa577961007982775179517958947f7551790128947f77517a75517a75618777777777777777777767557951876351795779a9876957795779ac777777777777777767006868"

    static let prefixBytes: [UInt8] = (try? Hex.decode(prefixHex)) ?? []
    static let suffixBytes: [UInt8] = (try? Hex.decode(suffixHex)) ?? []

    // MARK: - scope flags

    /// SIGHASH_ALL | ANYONECANPAY | FORKID: the OrdLock purchase preimage.
    public static let scopeAllAnyoneCanPay: UInt32 = 0xc1
    /// SIGHASH_NONE | ANYONECANPAY | FORKID: the v4 swap's 1-sat prefix input.
    public static let scopeNoneAnyoneCanPay: UInt32 = 0xc2
    /// SIGHASH_SINGLE | ANYONECANPAY | FORKID: the v4 swap's carrier input.
    public static let scopeSingleAnyoneCanPay: UInt32 = 0xc3

    // MARK: - building

    /// Serialized transaction output: 8-byte LE satoshis + varint script length
    /// + script. The covenant hashes this exact form.
    public static func serializeOutput(sats: Int, scriptBytes: [UInt8]) -> [UInt8] {
        Tx.littleEndian64(UInt64(max(0, sats))) + Tx.varInt(UInt64(scriptBytes.count)) + scriptBytes
    }

    public static func serializeOutput(sats: Int, scriptHex: String) throws -> [UInt8] {
        try serializeOutput(sats: sats, scriptBytes: Hex.decode(scriptHex))
    }

    /// The lock script: template prefix, then `writeBin(cancelPkh)` and
    /// `writeBin(serializeOutput(price, payoutScript))`, then the suffix.
    ///
    /// `writeBin` and `Tx.push` are the same encoding for every length the
    /// template uses (direct up to 75, PUSHDATA1 to 255).
    public static func lockScript(cancelAddress: String, payAddress: String, priceSats: Int) throws -> String {
        let cancelPkh = try Address.scriptHash(from: cancelAddress)
        let payPkh = try Address.scriptHash(from: payAddress)
        let payoutScript = [0x76, 0xa9, 0x14] + payPkh + [0x88, 0xac]
        var out = prefixBytes
        out += Tx.push(cancelPkh)
        out += Tx.push(serializeOutput(sats: priceSats, scriptBytes: payoutScript))
        out += suffixBytes
        return Hex.encode(out)
    }

    /// True when both template halves appear in order.
    public static func isOrdLock(_ scriptHex: String) -> Bool {
        guard let bytes = try? Hex.decode(scriptHex) else { return false }
        guard let start = indexOf(bytes, prefixBytes) else { return false }
        return indexOf(bytes, suffixBytes, from: start + prefixBytes.count) != nil
    }

    /// What a lock script commits to.
    public struct LockData: Equatable, Sendable {
        public var cancelAddress: String
        public var priceSats: Int
        public var payoutScriptHex: String

        public init(cancelAddress: String, priceSats: Int, payoutScriptHex: String) {
            self.cancelAddress = cancelAddress
            self.priceSats = priceSats
            self.payoutScriptHex = payoutScriptHex
        }
    }

    /// Decode a lock script; nil when it is not one or is malformed — the
    /// daemon's `decodeOrdLock`, branch for branch.
    public static func decode(_ scriptHex: String, mainnet: Bool = true) -> LockData? {
        guard let bytes = try? Hex.decode(scriptHex) else { return nil }
        guard let start = indexOf(bytes, prefixBytes) else { return nil }
        guard let end = indexOf(bytes, suffixBytes, from: start + prefixBytes.count),
              end > start + prefixBytes.count else { return nil }
        let middle = Array(bytes[(start + prefixBytes.count)..<end])
        guard let cancel = Inscription.readPush(middle, at: 0), cancel.data.count == 20 else { return nil }
        guard let payoutPush = Inscription.readPush(middle, at: cancel.next),
              payoutPush.data.count >= 9 else { return nil }

        let payout = payoutPush.data
        var price = 0
        for index in 0..<8 { price |= Int(payout[index]) << (index * 8) }
        var offset = 8
        var scriptLen = Int(payout[offset])
        offset += 1
        if scriptLen >= 0xfd {
            let width = scriptLen == 0xfd ? 2 : scriptLen == 0xfe ? 4 : 8
            guard offset + width <= payout.count else { return nil }
            scriptLen = 0
            for index in 0..<width { scriptLen += Int(payout[offset + index]) << (8 * index) }
            offset += width
        }
        guard scriptLen > 0, offset + scriptLen <= payout.count else { return nil }
        let payoutScriptHex = Hex.encode(Array(payout[offset..<(offset + scriptLen)]))
        let prefix: UInt8 = mainnet ? 0x00 : 0x6f
        return LockData(
            cancelAddress: Base58.checkEncode([prefix] + cancel.data),
            priceSats: price,
            payoutScriptHex: payoutScriptHex
        )
    }

    /// Buyer unlock for a lock output: **no signature**. It serializes output 0,
    /// then outputs 2+, then the ALL|ANYONECANPAY preimage, so the covenant can
    /// verify the payment itself. The trailing `OP_0` is the contract's path
    /// selector.
    public static func purchaseUnlock(
        inputs: [Tx.Input],
        outputs: [Tx.Output],
        inputIndex: Int,
        lockScriptHex: String,
        lockValue: Int
    ) throws -> [UInt8] {
        guard outputs.count >= 2 else { throw Error.badPayment }
        var script: [UInt8] = []
        script += Tx.push(try serializeOutput(sats: outputs[0].sats, scriptHex: outputs[0].scriptHex))
        if outputs.count > 2 {
            var rest: [UInt8] = []
            for output in outputs[2...] {
                rest += try serializeOutput(sats: output.sats, scriptHex: output.scriptHex)
            }
            script += Tx.push(rest)
        } else {
            script.append(0x00)
        }
        // The daemon passes `sourceSatoshis: 1` explicitly; mirror it rather
        // than trusting whatever the built input carries.
        var sourcingInputs = inputs
        sourcingInputs[inputIndex].value = lockValue
        let preimage = try Tx.sighashPreimage(
            inputs: sourcingInputs, outputs: outputs, inputIndex: inputIndex,
            scriptCode: try Hex.decode(lockScriptHex), scope: scopeAllAnyoneCanPay
        )
        script += Tx.push(preimage)
        script.append(0x00)
        return script
    }

    // MARK: - v4 swap offer

    /// One side of a v4 offer: the outpoint, its chain script, and the seller's
    /// pre-signed unlock.
    public struct SwapOfferInput: Codable, Sendable, Equatable {
        public var txid: String
        public var vout: Int
        public var scriptHex: String
        public var sequence: Int
        public var unlockHex: String?

        public init(txid: String, vout: Int, scriptHex: String, sequence: Int, unlockHex: String? = nil) {
            self.txid = txid
            self.vout = vout
            self.scriptHex = scriptHex
            self.sequence = sequence
            self.unlockHex = unlockHex
        }
    }

    /// The seller's offer, exactly the daemon's `SwapOffer` in both kinds:
    /// v4 ordinal (`inputs`), v3 BSV21 (`input` + `unlockHex`).
    public struct SwapOffer: Codable, Sendable, Equatable {
        public var version: Int
        public var kind: String
        public var payScriptHex: String
        public var priceSats: Int
        public var lockTime: Int
        /// v4 ordinal: [1-sat plain prefix, inscribed carrier].
        public var inputs: [SwapOfferInput]?
        /// v3 BSV21: the single token carrier.
        public var input: SwapOfferInput?
        /// v3 BSV21: the seller's pre-signed unlock, beside `input`.
        public var unlockHex: String?
        public var tokenId: String?
        public var tokenAmount: String?

        public init(
            version: Int, kind: String, payScriptHex: String, priceSats: Int, lockTime: Int,
            inputs: [SwapOfferInput]? = nil, input: SwapOfferInput? = nil, unlockHex: String? = nil,
            tokenId: String? = nil, tokenAmount: String? = nil
        ) {
            self.version = version
            self.kind = kind
            self.payScriptHex = payScriptHex
            self.priceSats = priceSats
            self.lockTime = lockTime
            self.inputs = inputs
            self.input = input
            self.unlockHex = unlockHex
            self.tokenId = tokenId
            self.tokenAmount = tokenAmount
        }
    }

    /// v4 is the indexer-safe ordinal template: a plain 1-sat prefix at input 0
    /// shifts the carrier to input 1, so FIFO assigns the inscription to the
    /// 1-sat output 0 while the carrier's SINGLE signature commits to the
    /// payment at byte-exact output 1.
    public static let swapVersionOrdinal = 4
    /// v3 is the BSV21 template: the carrier's own envelope identifies its
    /// amount, so a single input and the payment output suffice.
    public static let swapVersionToken = 3
    public static let swapSequence: Int = 0xffff_ffff

    /// The unsigned skeleton both sides agree on. The seller signs input 0
    /// with NONE|ANYONECANPAY and input 1 with SINGLE|ANYONECANPAY; the buyer
    /// replaces output 0 (the placeholder) with the 1-sat NFT and keeps output
    /// 1 byte-exact.
    public static func swapOfferTemplate(
        dustTxid: String, dustVout: Int, dustScriptHex: String,
        carrierTxid: String, carrierVout: Int, carrierScriptHex: String,
        payAddress: String, priceSats: Int
    ) throws -> (inputs: [Tx.Input], outputs: [Tx.Output], payScriptHex: String) {
        let payScriptHex = Hex.encode(try Address.lockingScript(for: payAddress))
        let inputs = [
            Tx.Input(txid: dustTxid, vout: UInt32(dustVout), value: 1, scriptHex: dustScriptHex),
            Tx.Input(txid: carrierTxid, vout: UInt32(carrierVout), value: 1, scriptHex: carrierScriptHex),
        ]
        let outputs = [
            Tx.Output(scriptHex: "006a", sats: 0),
            Tx.Output(scriptHex: payScriptHex, sats: priceSats),
        ]
        return (inputs, outputs, payScriptHex)
    }

    /// The daemon's `isP2PKH` for an offer's payment output: exactly a 25-byte
    /// P2PKH script.
    public static func isP2PKHScript(_ hex: String) -> Bool {
        let lower = hex.lowercased()
        return lower.count == 50 && lower.hasPrefix("76a914") && lower.hasSuffix("88ac")
    }

    /// First index of `needle` at or after `from`, or nil.
    static func indexOf(_ haystack: [UInt8], _ needle: [UInt8], from: Int = 0) -> Int? {
        guard !needle.isEmpty, haystack.count >= needle.count else { return nil }
        var index = max(0, from)
        while index <= haystack.count - needle.count {
            if Array(haystack[index..<(index + needle.count)]) == needle { return index }
            index += 1
        }
        return nil
    }
}
