import Foundation
import CryptoKit

/// Transaction building and signing, ported from the daemon's `tx.ts`.
///
/// The rules, which the vectors pin:
///
/// - **Fee**: `max(100, ceil(size / 1000 * 1000))` — effectively 1 sat per byte
///   at the daemon's `FEE_SATS_PER_KB = 1000`, with a 100-sat floor. The size
///   estimate always includes a change output even when none is emitted, which
///   is why folding dust into the fee makes the fee larger rather than smaller.
/// - **Dust**: change below 20 sats is folded into the fee instead of becoming
///   an output. A port that missed this would strand a few sats per spend.
/// - **Order**: inputs sorted by value descending, unless the caller pins an
///   ordered prefix (ordinal transfers depend on FIFO sat flow).
/// - **Sighash**: **BIP143**, which is what the daemon's SDK computes whenever
///   SIGHASH_FORKID is set (see `sighashPreimage`; the earlier OTDA reading of
///   that file was wrong and the vectors caught it). The default scope is
///   `0x41` — ALL | FORKID — and the ordlock/swap flows add ANYONECANPAY,
///   SINGLE and NONE, whose rules are documented with the preimage.
public enum Tx {
    public static let version: UInt32 = 2
    public static let feeSatsPerKb: Int = 1000
    public static let minMinerFee: Int = 100
    public static let dust: Int = 20

    public enum Error: Swift.Error, Equatable {
        case insufficientFunds(have: Int, need: Int)
        case shortForFee(short: Int)
        case badPayment
        case badRequiredInputs
        case emptyInputs
    }

    public struct Input: Equatable {
        public var txid: String          // big-endian hex, as it appears in a block explorer
        public var vout: UInt32
        public var value: Int
        public var scriptHex: String     // the output's locking script
        /// Defaults to 108, the measured P2PKH unlocking script length.
        public var unlockingScriptLength: Int?
        public var sequence: UInt32 = 0xffff_ffff

        public init(txid: String, vout: UInt32, value: Int, scriptHex: String, unlockingScriptLength: Int? = nil) {
            self.txid = txid
            self.vout = vout
            self.value = value
            self.scriptHex = scriptHex
            self.unlockingScriptLength = unlockingScriptLength
        }
    }

    public struct Output: Equatable {
        public var scriptHex: String
        public var sats: Int
        public init(scriptHex: String, sats: Int) {
            self.scriptHex = scriptHex
            self.sats = sats
        }
    }

    public struct Payment {
        public var address: String?
        public var scriptHex: String?
        public var sats: Int
        public init(address: String? = nil, scriptHex: String? = nil, sats: Int) {
            self.address = address
            self.scriptHex = scriptHex
            self.sats = sats
        }
    }

    public struct Built {
        public var inputs: [Input]
        public var outputs: [Output]
        public var fee: Int
        public var changeSats: Int
        /// Index of the change output, or -1 when there is none.
        public var changeVout: Int
    }

    // MARK: - serialization

    public static func varInt(_ value: UInt64) -> [UInt8] {
        if value < 253 { return [UInt8(value)] }
        if value <= 0xffff { return [0xfd, UInt8(value & 0xff), UInt8((value >> 8) & 0xff)] }
        if value <= 0xffff_ffff {
            return [0xfe, UInt8(value & 0xff), UInt8((value >> 8) & 0xff), UInt8((value >> 16) & 0xff), UInt8((value >> 24) & 0xff)]
        }
        var out: [UInt8] = [0xff]
        for shift in stride(from: 0, through: 56, by: 8) { out.append(UInt8((value >> UInt64(shift)) & 0xff)) }
        return out
    }

    private static func varIntSize(_ value: Int) -> Int {
        value < 253 ? 1 : value <= 0xffff ? 3 : value <= 0xffff_ffff ? 5 : 9
    }

    /// Outputs are serialized with the value as a little-endian 64-bit integer
    /// and the script prefixed by its length.
    static func serializeOutputs(_ outputs: [Output]) throws -> [UInt8] {
        var out = varInt(UInt64(outputs.count))
        for output in outputs {
            let script = try Hex.decode(output.scriptHex)
            out.append(contentsOf: littleEndian64(UInt64(max(0, output.sats))))
            out.append(contentsOf: varInt(UInt64(script.count)))
            out.append(contentsOf: script)
        }
        return out
    }

    static func littleEndian64(_ value: UInt64) -> [UInt8] {
        (0..<8).map { UInt8((value >> UInt64($0 * 8)) & 0xff) }
    }

    /// The output set as BIP143 hashes it: no count prefix.
    ///
    /// The full transaction serialization starts with `varint(output count)`,
    /// and it is tempting to reuse it here. But the BIP143 `hashOutputs` is a
    /// hash of the concatenated outputs only. Reusing the counted form changes
    /// 32 bytes of the preimage, and the signature verifies against nothing —
    /// which is how this was caught, at byte 142 of the preimage.
    static func serializeOutputsForHash(_ outputs: [Output]) throws -> [UInt8] {
        var out: [UInt8] = []
        for output in outputs {
            let script = try Hex.decode(output.scriptHex)
            out.append(contentsOf: littleEndian64(UInt64(max(0, output.sats))))
            out.append(contentsOf: varInt(UInt64(script.count)))
            out.append(contentsOf: script)
        }
        return out
    }

    static func littleEndian32(_ value: UInt32) -> [UInt8] {
        (0..<4).map { UInt8((value >> UInt32($0 * 8)) & 0xff) }
    }

    /// The unsigned serialization: what the daemon's SDK produces with empty
    /// unlocking scripts, and what the vectors compare against byte for byte.
    public static func serializeUnsigned(inputs: [Input], outputs: [Output], lockTime: UInt32 = 0) throws -> [UInt8] {
        var out = littleEndian32(version)
        out.append(contentsOf: varInt(UInt64(inputs.count)))
        for input in inputs {
            out.append(contentsOf: try Hex.decode(input.txid).reversed())  // txids are little-endian on the wire
            out.append(contentsOf: littleEndian32(input.vout))
            out.append(0)                                                  // empty unlocking script
            out.append(contentsOf: littleEndian32(input.sequence))
        }
        out.append(contentsOf: try serializeOutputs(outputs))
        out.append(contentsOf: littleEndian32(lockTime))
        return out
    }

    // MARK: - building

    /// Build a transaction by the daemon's rules.
    ///
    /// `keepOrder` with `requiredInputs` pins an ordered prefix — ordinal
    /// transfers depend on it, because FIFO sat flow decides which sat lands
    /// where.
    public static func build(
        inputs utxos: [Input],
        payments: [Payment],
        changeScriptHex: String,
        opReturn: [String]? = nil,
        keepOrder: Bool = false,
        requiredInputs: Int = 0
    ) throws -> Built {
        guard !utxos.isEmpty else { throw Error.emptyInputs }
        let required = requiredInputs
        guard required >= 0, required <= min(30, utxos.count), required == 0 || keepOrder else {
            throw Error.badRequiredInputs
        }

        var paymentScripts: [String] = []
        var need = 0
        for payment in payments {
            let script: String
            if let hex = payment.scriptHex, !hex.isEmpty {
                script = hex
            } else if let address = payment.address, !address.isEmpty {
                script = Hex.encode(try Address.lockingScript(for: address))
            } else {
                throw Error.badPayment
            }
            try _ = Hex.decode(script)
            paymentScripts.append(script)
            need += payment.sats
        }

        // Size estimate, exactly as tx.ts computes it: every output, the
        // OP_RETURN if any, and a change output whether or not one is emitted.
        var outLens: [Int] = try paymentScripts.map { script in
            let length = try Hex.decode(script).count
            return 8 + varIntSize(length) + length
        }
        if let opReturn, !opReturn.isEmpty {
            let length = try Tx.opReturnScript(opReturn).count
            outLens.append(8 + varIntSize(length) + length)
        }
        let changeLen = try Hex.decode(changeScriptHex).count
        let baseSize = 8 + varIntSize(outLens.count + 1) + outLens.reduce(0, +)
            + 8 + varIntSize(changeLen) + changeLen

        let ordered = keepOrder ? utxos : utxos.sorted { $0.value > $1.value }
        let candidates = Array(ordered.prefix(30))
        var picked: [Input] = []
        var total = 0
        var inputSize = 0
        var fee = minMinerFee
        for utxo in candidates {
            picked.append(utxo)
            total += utxo.value
            let length = utxo.unlockingScriptLength ?? 108
            inputSize += 40 + varIntSize(length) + length
            fee = max(minMinerFee, Int(ceil(Double(baseSize + varIntSize(picked.count) + inputSize) / 1000.0 * Double(feeSatsPerKb))))
            if picked.count >= required && total >= need + fee { break }
        }

        guard total >= need else { throw Error.insufficientFunds(have: total, need: need + fee) }
        var change = total - need - fee
        guard change >= 0 else { throw Error.shortForFee(short: -change) }
        let useChange = change >= dust
        if !useChange { fee += change; change = 0 }

        var outputs = zip(paymentScripts, payments).map { Output(scriptHex: $0, sats: $1.sats) }
        if let opReturn, !opReturn.isEmpty {
            outputs.append(Output(scriptHex: Hex.encode(try opReturnScript(opReturn)), sats: 0))
        }
        let changeVout = useChange ? outputs.count : -1
        if useChange { outputs.append(Output(scriptHex: changeScriptHex, sats: change)) }

        return Built(inputs: picked, outputs: outputs, fee: fee, changeSats: change, changeVout: changeVout)
    }

    // MARK: - scripts

    /// `OP_0 OP_RETURN` followed by each part as a push.
    public static func opReturnScript(_ parts: [String]) throws -> [UInt8] {
        var out: [UInt8] = [0x00, 0x6a]
        for part in parts {
            out.append(contentsOf: push(Array(part.utf8)))
        }
        return out
    }

    /// Bitcoin's push rules: the length itself is pushed in a wider form past 75.
    public static func push(_ data: [UInt8]) -> [UInt8] {
        if data.count <= 75 { return [UInt8(data.count)] + data }
        if data.count <= 255 { return [0x4c, UInt8(data.count)] + data }
        return [0x4d, UInt8(data.count & 0xff), UInt8((data.count >> 8) & 0xff)] + data
    }

    // MARK: - signing

    /// The FORKID sighash: **BIP143**, which is what the daemon's SDK computes.
    ///
    /// I first implemented this as OTDA (the original digest algorithm) after
    /// reading `formatOTDA` in the SDK and concluding that BSV had reverted
    /// BIP143. That was wrong, and the vector test is what proved it: the
    /// daemon's own signature failed to verify under my digest while mine
    /// verified under it. `formatBytes` in that same file picks BIP143 whenever
    /// SIGHASH_FORKID is set, which it is for every signature this wallet makes
    /// (`0x41` = ALL | FORKID).
    ///
    /// The preimage, in order:
    ///
    ///     version (4 LE)
    ///     hashPrevouts (32)   double SHA-256 of every input's outpoint
    ///     hashSequence (32)   double SHA-256 of every input's sequence
    ///     outpoint (36)       this input's txid (reversed) and vout
    ///     varint(len) + scriptCode
    ///     sourceSatoshis (8 LE)   ← the *spent* output's value
    ///     sequence (4 LE)
    ///     hashOutputs (32)    double SHA-256 of the concatenated outputs,
    ///                         with no count prefix (see below)
    ///     locktime (4 LE)
    ///     scope (4 LE)
    ///
    /// The value being spent is part of the digest, which is why signing needs
    /// the UTXO's amount and not only its script. Getting this wrong produces
    /// signatures that look fine and are rejected on chain — no funds lost, but
    /// nothing spends either.
    /// The digest that is signed.
    ///
    /// **Single** SHA-256 of the preimage, not the double hash you would expect
    /// from BIP143 as specified. That is not a guess: the daemon's own signature
    /// was checked against both candidates, and it verifies under
    /// `sha256(preimage)` and fails under `sha256(sha256(preimage))`. The SDK's
    /// P2PKH template computes `sha256(preimage)` and signs that value directly.
    /// A port that used the conventional double hash would produce signatures
    /// nothing else accepts.
    public static func sighash(
        inputs: [Input],
        outputs: [Output],
        inputIndex: Int,
        scriptCode: [UInt8],
        scope: UInt32 = 0x41,          // SIGHASH_ALL | SIGHASH_FORKID
        lockTime: UInt32 = 0
    ) throws -> [UInt8] {
        singleSHA256(try sighashPreimage(inputs: inputs, outputs: outputs, inputIndex: inputIndex,
                                         scriptCode: scriptCode, scope: scope, lockTime: lockTime))
    }

    /// The BIP143 preimage, before hashing.
    ///
    /// **Scope flags.** The low five bits are what the signature commits to —
    /// ALL (`1`), NONE (`2`), SINGLE (`3`) — `0x40` is FORKID and `0x80` is
    /// ANYONECANPAY. OrdLock and the atomic swaps need more than the default
    /// `0x41`: the OrdLock purchase preimage is ALL|ANYONECANPAY (`0xc1`), the
    /// v4 swap carrier is SINGLE|ANYONECANPAY (`0xc3`) and its 1-sat prefix is
    /// NONE|ANYONECANPAY (`0xc2`). The denser flags change the preimage exactly
    /// as the daemon's SDK (`TransactionSignature.formatBip143`) does:
    ///
    /// - ANYONECANPAY replaces hashPrevouts and hashSequence with 32 zero bytes;
    /// - NONE replaces hashSequence and hashOutputs with 32 zero bytes;
    /// - SINGLE replaces hashSequence with zeros and hashes only
    ///   `outputs[inputIndex]` (zeros when that output does not exist).
    ///
    /// A port that ignored the flags would sign over a full-transaction digest
    /// with a flag byte that says otherwise: a signature that never validates,
    /// which is the safe way to be wrong.
    public static func sighashPreimage(
        inputs: [Input],
        outputs: [Output],
        inputIndex: Int,
        scriptCode: [UInt8],
        scope: UInt32 = 0x41,          // SIGHASH_ALL | SIGHASH_FORKID
        lockTime: UInt32 = 0
    ) throws -> [UInt8] {
        guard inputIndex >= 0, inputIndex < inputs.count else { throw Error.badRequiredInputs }

        let base = scope & 0x1f
        let anyoneCanPay = scope & 0x80 != 0
        let zeroHash = [UInt8](repeating: 0, count: 32)

        var hashPrevouts = zeroHash
        var hashSequences = zeroHash
        if !anyoneCanPay {
            var prevouts = [UInt8]()
            var sequences = [UInt8]()
            for input in inputs {
                prevouts.append(contentsOf: try Hex.decode(input.txid).reversed())
                prevouts.append(contentsOf: littleEndian32(input.vout))
                sequences.append(contentsOf: littleEndian32(input.sequence))
            }
            hashPrevouts = doubleSHA256(prevouts)
            if base != 2 && base != 3 {
                hashSequences = doubleSHA256(sequences)
            }
        }

        var hashOutputs = zeroHash
        if base == 3 {
            if inputIndex < outputs.count {
                hashOutputs = doubleSHA256(try serializeOutputsForHash([outputs[inputIndex]]))
            }
        } else if base != 2 {
            hashOutputs = doubleSHA256(try serializeOutputsForHash(outputs))
        }

        let current = inputs[inputIndex]
        var preimage = littleEndian32(version)
        preimage.append(contentsOf: hashPrevouts)
        preimage.append(contentsOf: hashSequences)
        preimage.append(contentsOf: try Hex.decode(current.txid).reversed())
        preimage.append(contentsOf: littleEndian32(current.vout))
        preimage.append(contentsOf: varInt(UInt64(scriptCode.count)))
        preimage.append(contentsOf: scriptCode)
        preimage.append(contentsOf: littleEndian64(UInt64(max(0, current.value))))
        preimage.append(contentsOf: littleEndian32(current.sequence))
        preimage.append(contentsOf: hashOutputs)
        preimage.append(contentsOf: littleEndian32(lockTime))
        preimage.append(contentsOf: littleEndian32(scope))
        return preimage
    }

    public static func singleSHA256(_ bytes: [UInt8]) -> [UInt8] {
        Array(SHA256.hash(data: Data(bytes)))
    }

    public static func doubleSHA256(_ bytes: [UInt8]) -> [UInt8] {
        let once = SHA256.hash(data: Data(bytes))
        return Array(SHA256.hash(data: Data(once)))
    }

    /// A P2PKH unlocking script: the DER signature with the sighash byte
    /// appended, then the compressed public key, each as a push.
    public static func p2pkhUnlock(signature: [UInt8], publicKey: [UInt8], scope: UInt32 = 0x41) -> [UInt8] {
        let withScope = signature + [UInt8(scope & 0xff)]
        return push(withScope) + push(publicKey)
    }

    /// Sign every input of a built transaction with one key.
    ///
    /// One key because that is what the daemon's wallet is: every UTXO belongs
    /// to `m/0/0`. A future multi-key wallet signs per input.
    public static func sign(built: Built, privateKey: [UInt8], publicKey: [UInt8]) throws -> [UInt8] {
        try sign(built: built, privateKey: privateKey, publicKey: publicKey, scopeFor: nil, customUnlock: nil)
    }

    /// The same, with per-input scopes and inputs that are not plain P2PKH.
    ///
    /// `scopeFor` selects the sighash flags per input (default `0x41`).
    /// `customUnlock`, when it returns a script, takes over that input
    /// entirely: a pre-signed swap input is attached verbatim, an OrdLock
    /// purchase input carries the covenant preimage instead of a signature,
    /// and a cancel input is a plain signature followed by `OP_1`. Returning
    /// nil falls back to the standard P2PKH script with the input's scope.
    public static func sign(
        built: Built,
        privateKey: [UInt8],
        publicKey: [UInt8],
        scopeFor: ((Int) -> UInt32)?,
        customUnlock: ((Int, Built) throws -> [UInt8]?)?
    ) throws -> [UInt8] {
        try serialize(
            inputs: built.inputs,
            unlockingScripts: try unlockingScripts(
                built: built, privateKey: privateKey, publicKey: publicKey,
                scopeFor: scopeFor, customUnlock: customUnlock
            ),
            outputs: built.outputs
        )
    }

    /// The unlocking scripts alone, in input order — what a swap offer hands
    /// the buyer before there is a transaction to serialize.
    public static func unlockingScripts(
        built: Built,
        privateKey: [UInt8],
        publicKey: [UInt8],
        scopeFor: ((Int) -> UInt32)? = nil,
        customUnlock: ((Int, Built) throws -> [UInt8]?)? = nil
    ) throws -> [[UInt8]] {
        var unlockingScripts: [[UInt8]] = []
        for (index, input) in built.inputs.enumerated() {
            if let custom = try customUnlock?(index, built) {
                unlockingScripts.append(custom)
                continue
            }
            let scope = scopeFor?(index) ?? 0x41
            let scriptCode = try Hex.decode(input.scriptHex)
            let digest = try sighash(inputs: built.inputs, outputs: built.outputs, inputIndex: index,
                                     scriptCode: scriptCode, scope: scope)
            let signature = try Secp256k1.sign(derForDigest: digest, withPrivateKey: privateKey)
            unlockingScripts.append(p2pkhUnlock(signature: signature, publicKey: publicKey, scope: scope))
        }
        return unlockingScripts
    }

    /// The signed serialization.
    public static func serialize(inputs: [Input], unlockingScripts: [[UInt8]], outputs: [Output], lockTime: UInt32 = 0) throws -> [UInt8] {
        var out = littleEndian32(version)
        out.append(contentsOf: varInt(UInt64(inputs.count)))
        for (index, input) in inputs.enumerated() {
            out.append(contentsOf: try Hex.decode(input.txid).reversed())
            out.append(contentsOf: littleEndian32(input.vout))
            let script = index < unlockingScripts.count ? unlockingScripts[index] : []
            out.append(contentsOf: varInt(UInt64(script.count)))
            out.append(contentsOf: script)
            out.append(contentsOf: littleEndian32(input.sequence))
        }
        out.append(contentsOf: try serializeOutputs(outputs))
        out.append(contentsOf: littleEndian32(lockTime))
        return out
    }

    // MARK: - parsing

    /// Just enough of a parser to compare transactions and to feed the monitor.
    ///
    /// Deliberately shallow: inputs keep their txid/vout/sequence and the
    /// unlocking script as bytes, outputs keep their value and script. No script
    /// interpretation — that belongs to a script engine, and this wallet only
    /// needs to recognise its own transactions.
    public struct Parsed: Equatable {
        public var version: UInt32
        public var inputs: [(txid: String, vout: UInt32, unlockingScript: [UInt8], sequence: UInt32)]
        public var outputs: [(sats: Int, script: [UInt8])]
        public var lockTime: UInt32

        public static func == (lhs: Parsed, rhs: Parsed) -> Bool {
            lhs.version == rhs.version
                && lhs.lockTime == rhs.lockTime
                && lhs.inputs.count == rhs.inputs.count
                && lhs.outputs.count == rhs.outputs.count
                && zip(lhs.inputs, rhs.inputs).allSatisfy { $0.txid == $1.txid && $0.vout == $1.vout && $0.sequence == $1.sequence && $0.unlockingScript == $1.unlockingScript }
                && zip(lhs.outputs, rhs.outputs).allSatisfy { $0.sats == $1.sats && $0.script == $1.script }
        }

        /// The same transaction with every signature blanked, so two signatures
        /// of the same transaction can be compared for everything else.
        public var ignoringUnlockingScripts: Parsed {
            var copy = self
            copy.inputs = inputs.map { ($0.txid, $0.vout, [], $0.sequence) }
            return copy
        }
    }

    public static func parse(_ bytes: [UInt8]) throws -> Parsed {
        var cursor = 0
        func readBytes(_ count: Int) throws -> [UInt8] {
            guard cursor + count <= bytes.count else { throw ParseError.truncated }
            let slice = Array(bytes[cursor..<(cursor + count)])
            cursor += count
            return slice
        }
        func readUInt32() throws -> UInt32 {
            let raw = try readBytes(4)
            return UInt32(raw[0]) | UInt32(raw[1]) << 8 | UInt32(raw[2]) << 16 | UInt32(raw[3]) << 24
        }
        func readUInt64() throws -> UInt64 {
            var value: UInt64 = 0
            for (index, byte) in try readBytes(8).enumerated() { value |= UInt64(byte) << UInt64(index * 8) }
            return value
        }
        func readVarInt() throws -> UInt64 {
            let first = try readBytes(1)[0]
            switch first {
            case 0xfd: return UInt64(try readBytes(2).withUnsafeBufferPointer { UInt16($0[0]) | UInt16($0[1]) << 8 })
            case 0xfe: return UInt64(try readUInt32())
            case 0xff: return try readUInt64()
            default: return UInt64(first)
            }
        }

        let version = try readUInt32()
        let inputCount = try readVarInt()
        var inputs: [(txid: String, vout: UInt32, unlockingScript: [UInt8], sequence: UInt32)] = []
        for _ in 0..<inputCount {
            let txidBytes = try readBytes(32).reversed()
            let vout = try readUInt32()
            let scriptLength = Int(try readVarInt())
            let script = try readBytes(scriptLength)
            let sequence = try readUInt32()
            inputs.append((Hex.encode(Array(txidBytes)), vout, script, sequence))
        }
        let outputCount = try readVarInt()
        var outputs: [(sats: Int, script: [UInt8])] = []
        for _ in 0..<outputCount {
            let sats = Int(try readUInt64())
            let scriptLength = Int(try readVarInt())
            outputs.append((sats, try readBytes(scriptLength)))
        }
        let lockTime = try readUInt32()
        return Parsed(version: version, inputs: inputs, outputs: outputs, lockTime: lockTime)
    }

    public enum ParseError: Swift.Error, Equatable {
        case truncated
    }

    /// A txid is the double SHA-256 of the signed serialization, reversed.
    public static func txid(ofSignedBytes bytes: [UInt8]) -> String {
        Hex.encode(doubleSHA256(bytes).reversed())
    }
}
