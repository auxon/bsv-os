import Foundation

/// The standalone backend: custody, chain and policy all on the phone.
///
/// It implements the same `WalletBackend` the device client does, so every
/// Phase 1 screen works against it unchanged. What is different is who is
/// authoritative:
///
/// - **Custody** is the Keychain phrase from `SeedVault`, derived to the same
///   `m/0/0` key the daemon derives (S1's vectors), signed by the Swift signer
///   (S2), and spent through the same policy engine (S3).
/// - **Confirmations** are checked while the app is open. A phone cannot run the
///   daemon's monitor, so `refreshPendingTransactions()` is the whole monitor,
///   and the ledger hints say so rather than promising a rebroadcast that is not
///   happening.
/// - **Locking** is a session flag. The real protection is the device lock plus
///   `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; the biometric gate stays
///   where it was, in `WalletSession`, in front of spends and approvals.
public actor LocalWalletBackend: WalletBackend {
    private let vault: any SeedVault
    private let chain: any ChainProvider
    private let policy: PolicyEngine
    private let ledger: any LedgerStore
    private let inscriptions: any InscriptionMetadata
    private let tokens: any TokenIndex
    private let cast: any CastStore
    private let now: @Sendable () -> Int
    private var locked = true

    public init(
        vault: any SeedVault,
        chain: any ChainProvider,
        policy: PolicyEngine,
        ledger: any LedgerStore,
        inscriptions: any InscriptionMetadata = OnesatInscriptionMetadata(),
        tokens: any TokenIndex = OnesatTokenIndex(),
        cast: any CastStore = InMemoryCastStore(),
        now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.vault = vault
        self.chain = chain
        self.policy = policy
        self.ledger = ledger
        self.inscriptions = inscriptions
        self.tokens = tokens
        self.cast = cast
        self.now = now
    }

    // MARK: - wallet lifecycle (beyond the protocol, for the setup screen)

    /// Create a wallet and return the phrase, once, for the human to write
    /// down. It is not retrievable from anywhere else.
    @discardableResult
    public func createWallet(wordCount: Int = 12) throws -> String {
        let phrase = try BIP39.generate(wordCount: wordCount)
        try vault.importPhrase(phrase)
        return phrase
    }

    /// Import an existing phrase. Throws before touching the Keychain if the
    /// words (or their checksum) do not validate.
    public func importWallet(phrase: String) throws {
        try vault.importPhrase(phrase)
    }

    public func hasWallet() -> Bool {
        vault.hasPhrase
    }

    /// The daemon's identity key: the *master* public key of the same phrase
    /// (`custody.identityOf`), not a derived path — so a hosted app sees one
    /// identity across the phone and the desktop.
    public func identityKey() throws -> String? {
        guard let phrase = try vault.loadPhrase() else { return nil }
        let master = try BIP32.master(fromSeed: BIP39.seed(fromValidated: phrase))
        return Hex.encode(try Secp256k1.publicKey(fromPrivateKey: master.privateKey))
    }

    // MARK: - WalletBackend

    public func isAuthenticated() async throws -> WalletStatus {
        let hasWallet = vault.hasPhrase
        return WalletStatus(authenticated: hasWallet, locked: locked || !hasWallet, hasWallet: hasWallet)
    }

    public func unlock() async throws {
        guard vault.hasPhrase else {
            throw WalletError(code: "NO_WALLET", message: "No wallet on this device yet.")
        }
        locked = false
    }

    public func lock() async throws {
        locked = true
    }

    public func balance() async throws -> BalanceResponse {
        try requireUnlocked()
        let key = try keyMaterial()
        let addressUtxos = try await chain.utxos(address: key.address)
        return BalanceResponse(
            address: key.address,
            confirmed: addressUtxos.confirmed,
            unconfirmed: addressUtxos.unconfirmed,
            utxos: addressUtxos.utxos.count
        )
    }

    public func addressQr() async throws -> AddressQrResponse {
        try requireUnlocked()
        let key = try keyMaterial()
        guard let png = QRCode.image(from: key.address) else {
            throw WalletError(code: "QR_FAILED", message: "Could not render the address as a QR code.")
        }
        return AddressQrResponse(address: key.address, dataUrl: "data:image/png;base64," + png.base64EncodedString())
    }

    public func send(to address: String, sats: Int) async throws -> SendResponse {
        try requireUnlocked()
        return try await spend(payments: [Tx.Payment(address: address, sats: sats)], label: "send \(sats) sats")
    }

    /// One payment to an app intent's list.
    public struct AppPayment: Sendable, Equatable {
        public let to: String
        public let sats: Int

        public init(to: String, sats: Int) {
            self.to = to
            self.sats = sats
        }
    }

    /// An app-originated spend. Same builder and signer as `send`; the
    /// difference is the gate: the app's own origin must pass policy first,
    /// with the memo's first entry as the action, exactly as the daemon's
    /// `spendTo` does. A refusal is POLICY_DENY carrying the pending reason, so
    /// the page can show the human what to approve.
    public func appSpend(
        origin: String,
        payments: [AppPayment],
        memo: [String]? = nil,
        label: String? = nil
    ) async throws -> SendResponse {
        try requireUnlocked()
        guard !payments.isEmpty else {
            throw WalletError(code: "BAD_PARAM", message: "payments required")
        }
        let action = (label?.isEmpty == false ? label : nil) ?? memo?.first ?? "spend"
        let total = payments.reduce(0) { $0 + max(0, $1.sats) }
        let decision = try await policy.check(origin: origin, amountSats: total, action: action)
        guard decision.verdict == .allow else {
            throw WalletError(code: "POLICY_DENY", message: decision.reason)
        }
        return try await spend(
            payments: payments.map { Tx.Payment(address: $0.to, sats: $0.sats) },
            label: action
        )
    }

    public struct AppInscription: Sendable {
        public let txid: String
        public let fee: Int
        public let hex: String
    }

    /// An app-originated inscription, shaped like the daemon's `inscribeMint`:
    /// a 1-sat output whose script is the recipient's P2PKH plus the ord
    /// envelope, funded from plain UTXOs only, with the policy gate charged
    /// `1 + fee + minerFee` under the app's origin and the action
    /// `app-inscribe`. A refusal is POLICY_DENY with `denied: <reason>`.
    public func appInscribe(
        origin: String,
        to recipient: String,
        contentType: String,
        dataHex: String,
        fee: AppPayment? = nil,
        memo: [String]? = nil,
        label: String? = nil
    ) async throws -> AppInscription {
        try requireUnlocked()
        let key = try keyMaterial()
        let to = recipient.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? key.address : recipient
        _ = try Address.lockingScript(for: to)                     // valid P2PKH or BAD_PARAM
        let script: String
        do {
            script = try Inscription.script(ownerAddress: to, contentType: contentType, dataHex: dataHex)
        } catch Inscription.Error.badContentType {
            throw WalletError(code: "BAD_PARAM", message: "contentType must be 1-128 printable ASCII chars without spaces")
        } catch {
            throw WalletError(code: "BAD_PARAM", message: "dataHex must be hex, 1B-256KB")
        }

        // Funding: plain outputs only. The daemon fetches each candidate's
        // script and skips carriers; so does this.
        let indexed = try await chain.utxos(address: key.address)
        let candidates = indexed.utxos
            .filter { $0.value > 1 }
            .sorted { $0.value > $1.value }
            .prefix(12)
        let unavailable = await unavailableOutpoints()
        var funding: [Tx.Input] = []
        for candidate in candidates where funding.count < 6 {
            guard !unavailable.contains("\(candidate.txid):\(candidate.vout)") else { continue }
            guard let parent = try? await chain.tx(txid: candidate.txid),
                  candidate.vout >= 0, candidate.vout < parent.vout.count,
                  let fundingScript = parent.vout[candidate.vout].scriptHex,
                  !Inscription.hasOrdEnvelope(fundingScript) else { continue }
            funding.append(Tx.Input(
                txid: candidate.txid, vout: UInt32(candidate.vout),
                value: candidate.value, scriptHex: fundingScript
            ))
        }
        guard !funding.isEmpty else {
            throw WalletError(code: "INSUFFICIENT", message: "no plain funding UTXOs (everything is inscribed?)")
        }

        var payments = [Tx.Payment(scriptHex: script, sats: 1)]
        var feeSats = 0
        if let fee {
            guard fee.sats > 0 else { throw WalletError(code: "BAD_PARAM", message: "fee.sats must be positive") }
            _ = try Address.lockingScript(for: fee.to)
            feeSats = fee.sats
            payments.append(Tx.Payment(address: fee.to, sats: feeSats))
        }

        let built: Tx.Built
        do {
            built = try Tx.build(
                inputs: funding,
                payments: payments,
                changeScriptHex: key.scriptHex,
                opReturn: memo?.isEmpty == false ? memo : nil
            )
        } catch {
            throw WalletError(code: "INSUFFICIENT", message: "not enough to fund the inscription and its fee")
        }

        let gate = try await policy.check(
            origin: origin,
            amountSats: 1 + feeSats + built.fee,
            action: "app-inscribe"
        )
        guard gate.verdict == .allow else {
            throw WalletError(code: "POLICY_DENY", message: "denied: \(gate.reason)")
        }

        let signed = try Tx.sign(built: built, privateKey: key.privateKey, publicKey: key.publicKey)
        let hex = Hex.encode(signed)
        let broadcast = try await broadcast(hex: hex)
        try await ledger.record(LocalTx(
            txid: broadcast.txid,
            label: label ?? "inscribe \(contentType) to \(to.prefix(8))",
            status: broadcast.status == .mined ? "mined" : "seen",
            detail: broadcast.detail,
            createdAt: now(),
            lastCheck: now(),
            spentOutpoints: spentOutpoints(of: built)
        ))
        return AppInscription(txid: broadcast.txid, fee: built.fee, hex: hex)
    }

    /// An app-originated ordinal transfer, shaped like the daemon's
    /// `sendOrdinal`: the carrier is exactly 1 sat, it is spent first
    /// (`keepOrder`, so FIFO leaves the sat in output 0), the recipient gets a
    /// 1-sat output, and plain UTXOs fund the miner fee. The policy gate is
    /// charged the fee under the action `ordinal-send`.
    public func appSendOrdinal(
        origin: String,
        txid: String,
        vout: Int,
        to: String,
        memo: [String]? = nil
    ) async throws -> SendResponse {
        try requireUnlocked()
        let key = try keyMaterial()
        guard txid.count == 64, txid.allSatisfy({ $0.isHexDigit }) else {
            throw WalletError(code: "BAD_PARAM", message: "outpoint must be 64-hex txid + vout")
        }
        do {
            _ = try Address.lockingScript(for: to)
        } catch {
            throw WalletError(code: "BAD_PARAM", message: "recipient must be a valid P2PKH address")
        }

        let indexed = try await chain.utxos(address: key.address)
        let unavailable = await unavailableOutpoints()
        guard let ordinal = indexed.utxos.first(where: { $0.txid == txid && $0.vout == vout }),
              !unavailable.contains("\(txid):\(vout)") else {
            throw WalletError(code: "NOT_FOUND", message: "ordinal not in wallet (unknown or already spent)")
        }
        guard ordinal.value == 1 else {
            throw WalletError(code: "BAD_PARAM", message: "ordinal carrier must be exactly 1 sat (found \(ordinal.value))")
        }
        let funding = indexed.utxos
            .filter { !($0.txid == txid && $0.vout == vout) && $0.value > 1 }
            .filter { !unavailable.contains("\($0.txid):\($0.vout)") }
            .map { Tx.Input(txid: $0.txid, vout: UInt32($0.vout), value: $0.value, scriptHex: key.scriptHex) }
        let carrier = Tx.Input(txid: ordinal.txid, vout: UInt32(ordinal.vout), value: ordinal.value, scriptHex: key.scriptHex)

        let built: Tx.Built
        do {
            built = try Tx.build(
                inputs: [carrier] + funding,
                payments: [Tx.Payment(address: to, sats: 1)],
                changeScriptHex: key.scriptHex,
                opReturn: memo?.isEmpty == false ? memo : nil,
                keepOrder: true
            )
        } catch {
            throw WalletError(code: "INSUFFICIENT", message: "not enough plain sats to fund the transfer fee")
        }

        let gate = try await policy.check(
            origin: origin,
            amountSats: built.fee,
            action: "ordinal-send"
        )
        guard gate.verdict == .allow else {
            throw WalletError(code: "POLICY_DENY", message: "denied: \(gate.reason)")
        }

        let signed = try Tx.sign(built: built, privateKey: key.privateKey, publicKey: key.publicKey)
        let broadcast = try await broadcast(hex: Hex.encode(signed))
        try await ledger.record(LocalTx(
            txid: broadcast.txid,
            label: "send \(txid.prefix(8)) to \(to.prefix(8))",
            status: broadcast.status == .mined ? "mined" : "seen",
            detail: broadcast.detail,
            createdAt: now(),
            lastCheck: now(),
            spentOutpoints: spentOutpoints(of: built)
        ))
        return SendResponse(txid: broadcast.txid, fee: built.fee)
    }

    // MARK: - OrdLock and the v4 swaps (P1)
    //
    // Ported from the daemon's `ordlock.ts` and the ordinal half of `swaps.ts`.
    // The scripts and every signed transaction are vector-pinned byte for byte
    // (`OrdlockVectorTests`), so what is left here is the surrounding custody:
    // validating the chain state before signing, gating through policy under
    // the app's origin, and recording the inputs against double spends.
    //
    // Both swap kinds are here: the v4 ordinal template (prefix + inscribed
    // carrier) and the v3 bsv21 template (one exact-UTXO token carrier). The
    // token path also asks the 1Sat indexer for spend state, because a token
    // output's amount is only authoritative there.

    public struct OrdlockLockResult: Sendable, Equatable {
        public let txid: String
        public let lockOutpoint: String
        public let fee: Int
    }

    public struct OrdlockBuyResult: Sendable, Equatable {
        public let txid: String
        public let fee: Int
        public let priceSats: Int
    }

    /// Seller: move a 1-sat carrier into the OrdLock covenant. On-chain, miner
    /// fee only; the resulting `txid.0` is what a market lists.
    public func ordlockLock(origin: String, txid: String, vout: Int, priceSats: Int) async throws -> OrdlockLockResult {
        try requireUnlocked()
        let key = try keyMaterial()
        guard priceSats >= 1 else {
            throw WalletError(code: "BAD_PARAM", message: "priceSats must be a positive sat number")
        }
        let (value, carrierScript) = try await outputData(txid: txid, vout: vout)
        try requireOurs(carrierScript, key: key, code: "NOT_OURS", message: "carrier is not ours")
        guard value == 1 else {
            throw WalletError(code: "BAD_PARAM", message: "carrier must be exactly 1 sat (found \(value))")
        }
        if await unavailableOutpoints().contains("\(txid):\(vout)") {
            throw WalletError(
                code: "BAD_PARAM",
                message: "carrier already spent by an in-flight transaction (indexers may not show it yet)"
            )
        }
        try await requireInscribed(
            carrierScript, txid: txid, vout: vout,
            refusal: "carrier is not inscribed — refusing to lock plain dust"
        )

        let funding = try await plainFunding()
        let lockScript = try Ordlock.lockScript(cancelAddress: key.address, payAddress: key.address, priceSats: priceSats)
        let built: Tx.Built
        do {
            built = try Tx.build(
                inputs: [Tx.Input(txid: txid, vout: UInt32(vout), value: 1, scriptHex: carrierScript)] + funding,
                payments: [Tx.Payment(scriptHex: lockScript, sats: 1)],
                changeScriptHex: key.scriptHex,
                keepOrder: true
            )
        } catch {
            throw WalletError(code: "INSUFFICIENT", message: "not enough plain sats to fund the lock fee")
        }
        let gate = try await policy.check(
            origin: origin, amountSats: built.fee, action: "ordlock-lock",
            context: SpendContext(
                origin: origin, action: "ordlock-lock", amountSats: built.fee,
                label: "ordlock \(priceSats) sats", to: "ordlock"
            )
        )
        guard gate.verdict == .allow else {
            throw WalletError(code: "POLICY_DENY", message: "denied: \(gate.reason)")
        }
        let signed = try Tx.sign(built: built, privateKey: key.privateKey, publicKey: key.publicKey)
        let broadcast = try await broadcast(hex: Hex.encode(signed))
        try await ledger.record(LocalTx(
            txid: broadcast.txid,
            label: "ordlock lock \(priceSats) sats",
            status: broadcast.status == .mined ? "mined" : "seen",
            detail: broadcast.detail,
            createdAt: now(),
            lastCheck: now(),
            spentOutpoints: spentOutpoints(of: built)
        ))
        return OrdlockLockResult(txid: broadcast.txid, lockOutpoint: "\(broadcast.txid).0", fee: built.fee)
    }

    /// Buyer: spend the lock output. The covenant enforces the payout and the
    /// daemon re-checks the decoded seller/price before funding anything; so
    /// does this, including the optional buyer-side checks.
    public func ordlockBuy(
        origin: String,
        lockOutpoint: String,
        fee: AppPayment? = nil,
        memo: [String]? = nil,
        label: String? = nil,
        description: String? = nil,
        expectedSeller: String? = nil,
        maxPrice: Int? = nil
    ) async throws -> OrdlockBuyResult {
        try requireUnlocked()
        let key = try keyMaterial()
        let parsed = try parseOutpoint(lockOutpoint)
        let (lockValue, lockScriptHex) = try await outputData(txid: parsed.txid, vout: parsed.vout)
        guard lockValue == 1 else {
            throw WalletError(code: "BAD_OFFER", message: "lock output must be exactly 1 sat")
        }
        guard let decoded = Ordlock.decode(lockScriptHex) else {
            throw WalletError(code: "BAD_OFFER", message: "lock output is not a valid OrdLock")
        }
        let price = decoded.priceSats
        guard price >= 1 else {
            throw WalletError(code: "BAD_OFFER", message: "lock price must be positive")
        }
        if let expectedSeller {
            let want: String
            do {
                want = Hex.encode(try Address.lockingScript(for: expectedSeller))
            } catch {
                throw WalletError(code: "BAD_PARAM", message: "buyerChecks.expectedSeller must be a valid P2PKH address")
            }
            guard decoded.payoutScriptHex.lowercased() == want.lowercased() else {
                throw WalletError(code: "BAD_OFFER", message: "lock payout does not pay the expected seller")
            }
        }
        if let maxPrice {
            guard maxPrice >= 0 else {
                throw WalletError(code: "BAD_PARAM", message: "buyerChecks.maxPrice must be a non-negative sat number")
            }
            guard price <= maxPrice else {
                throw WalletError(code: "BAD_OFFER", message: "lock price \(price) exceeds buyer max \(maxPrice)")
            }
        }
        var feeSats = 0
        if let fee {
            guard fee.sats > 0 else { throw WalletError(code: "BAD_PARAM", message: "fee.sats must be positive") }
            do {
                _ = try Address.lockingScript(for: fee.to)
            } catch {
                throw WalletError(code: "BAD_PARAM", message: "fee.to must be a valid P2PKH address")
            }
            feeSats = fee.sats
        }

        let funding = try await plainFunding()
        var payments = [
            Tx.Payment(address: key.address, sats: 1),                 // [0] the ordinal (FIFO: lock is input 0)
            Tx.Payment(scriptHex: decoded.payoutScriptHex, sats: price), // [1] byte-exact payout
        ]
        if let fee { payments.append(Tx.Payment(address: fee.to, sats: fee.sats)) }
        let built: Tx.Built
        do {
            built = try Tx.build(
                inputs: [Tx.Input(txid: parsed.txid, vout: UInt32(parsed.vout), value: 1, scriptHex: lockScriptHex)] + funding,
                payments: payments,
                changeScriptHex: key.scriptHex,
                opReturn: memo?.isEmpty == false ? memo : nil,
                keepOrder: true
            )
        } catch {
            throw WalletError(code: "INSUFFICIENT", message: "not enough plain sats to fund the purchase and its fee")
        }
        let resolvedLabel = label ?? "market buy \(lockOutpoint)"
        let amount = price + feeSats + built.fee
        let gate = try await policy.check(
            origin: origin, amountSats: amount, action: "ordlock-buy",
            context: SpendContext(
                origin: origin, action: "ordlock-buy", amountSats: amount,
                label: resolvedLabel, to: "\(parsed.txid.prefix(8)) lock",
                description: description
            )
        )
        guard gate.verdict == .allow else {
            throw WalletError(code: "POLICY_DENY", message: "denied: \(gate.reason)")
        }
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
        let broadcast = try await broadcast(hex: Hex.encode(signed))
        try await ledger.record(LocalTx(
            txid: broadcast.txid,
            label: label ?? "ordlock buy \(price) sats from \(parsed.txid.prefix(8))",
            status: broadcast.status == .mined ? "mined" : "seen",
            detail: broadcast.detail,
            createdAt: now(),
            lastCheck: now(),
            spentOutpoints: spentOutpoints(of: built)
        ))
        return OrdlockBuyResult(txid: broadcast.txid, fee: built.fee, priceSats: price)
    }

    /// Seller: cancel a lock back to the wallet. Signature + OP_1 selects the
    /// covenant's cancel path; miner fee only.
    public func ordlockCancel(origin: String, lockOutpoint: String) async throws -> SendResponse {
        try requireUnlocked()
        let key = try keyMaterial()
        let parsed = try parseOutpoint(lockOutpoint)
        let (_, lockScriptHex) = try await outputData(txid: parsed.txid, vout: parsed.vout)
        guard let decoded = Ordlock.decode(lockScriptHex) else {
            throw WalletError(code: "BAD_OFFER", message: "lock output is not a valid OrdLock")
        }
        guard decoded.cancelAddress == key.address else {
            throw WalletError(code: "NOT_OURS", message: "lock is not cancellable by this wallet")
        }
        let funding = try await plainFunding()
        let built: Tx.Built
        do {
            built = try Tx.build(
                inputs: [Tx.Input(txid: parsed.txid, vout: UInt32(parsed.vout), value: 1, scriptHex: lockScriptHex)] + funding,
                payments: [Tx.Payment(address: key.address, sats: 1)],
                changeScriptHex: key.scriptHex,
                keepOrder: true
            )
        } catch {
            throw WalletError(code: "INSUFFICIENT", message: "not enough plain sats to fund the cancel fee")
        }
        let gate = try await policy.check(origin: origin, amountSats: built.fee, action: "ordlock-cancel")
        guard gate.verdict == .allow else {
            throw WalletError(code: "POLICY_DENY", message: "denied: \(gate.reason)")
        }
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
                return Tx.p2pkhUnlock(signature: signature, publicKey: key.publicKey) + [0x51] // OP_1
            }
        )
        let broadcast = try await broadcast(hex: Hex.encode(signed))
        try await ledger.record(LocalTx(
            txid: broadcast.txid,
            label: "ordlock cancel \(parsed.txid.prefix(8))",
            status: broadcast.status == .mined ? "mined" : "seen",
            detail: broadcast.detail,
            createdAt: now(),
            lastCheck: now(),
            spentOutpoints: spentOutpoints(of: built)
        ))
        return SendResponse(txid: broadcast.txid, fee: built.fee)
    }

    /// Seller: pre-sign a swap offer on one of our 1-sat carriers. Off-chain
    /// (nothing broadcast, nothing tracked); proceeds always pay our own
    /// wallet. Ordinal offers use the v4 two-input template; bsv21 offers use
    /// the v3 single-carrier template and must hold exactly `tokenAmount` of
    /// `tokenId` — exact-UTXO only, because partial fills cannot be
    /// atomic-safe.
    public func signSwapOffer(
        origin: String,
        txid: String,
        vout: Int,
        priceSats: Int,
        kind: String? = nil,
        tokenId: String? = nil,
        tokenAmount: String? = nil
    ) async throws -> Ordlock.SwapOffer {
        try requireUnlocked()
        let key = try keyMaterial()
        let requestedKind = kind ?? "ordinal"
        guard requestedKind == "ordinal" || requestedKind == "bsv21" else {
            throw WalletError(code: "BAD_PARAM", message: "kind must be ordinal or bsv21")
        }
        guard priceSats >= 1 else {
            throw WalletError(code: "BAD_PARAM", message: "priceSats must be a positive sat number")
        }
        let (value, carrierScript) = try await outputData(txid: txid, vout: vout)
        try requireOurs(
            carrierScript, key: key, code: "NOT_OURS",
            message: "swap carrier is not ours (P2PKH prefix mismatch)"
        )
        guard value == 1 else {
            throw WalletError(code: "BAD_PARAM", message: "swap carrier must be exactly 1 sat (found \(value))")
        }

        if requestedKind == "bsv21" {
            let id = try requireTokenId(tokenId)
            let amt = try requireTokenAmount(tokenAmount)
            guard let envelope = Bsv21.parseEnvelope(carrierScript),
                  envelope.protocolId == Bsv21.protocolId,
                  envelope.contentType == Bsv21.contentType,
                  envelope.id == id, envelope.amt == amt else {
                throw WalletError(code: "BAD_PARAM", message: "carrier is not the listed token output")
            }
            let gate = try await policy.check(origin: origin, amountSats: 0, action: "app-swap-offer")
            guard gate.verdict == .allow else {
                throw WalletError(code: "POLICY_DENY", message: "denied: \(gate.reason)")
            }
            // v3: one input, one payment output, SINGLE|ANYONECANPAY — the
            // same pre-signature shape the desktop produces.
            let payScriptHex = Hex.encode(try Address.lockingScript(for: key.address))
            let built = Tx.Built(
                inputs: [Tx.Input(txid: txid, vout: UInt32(vout), value: 1, scriptHex: carrierScript)],
                outputs: [Tx.Output(scriptHex: payScriptHex, sats: priceSats)],
                fee: 0, changeSats: 0, changeVout: -1
            )
            let unlocks = try Tx.unlockingScripts(
                built: built, privateKey: key.privateKey, publicKey: key.publicKey,
                scopeFor: { _ in Ordlock.scopeSingleAnyoneCanPay }
            )
            return Ordlock.SwapOffer(
                version: Ordlock.swapVersionToken,
                kind: "bsv21",
                payScriptHex: payScriptHex,
                priceSats: priceSats,
                lockTime: 0,
                input: Ordlock.SwapOfferInput(
                    txid: txid, vout: vout, scriptHex: carrierScript,
                    sequence: Ordlock.swapSequence, unlockHex: Hex.encode(unlocks[0])
                ),
                tokenId: id,
                tokenAmount: amt
            )
        }

        try await requireInscribed(
            carrierScript, txid: txid, vout: vout,
            refusal: "carrier is not inscribed — refusing to list plain dust"
        )
        let gate = try await policy.check(origin: origin, amountSats: 0, action: "app-swap-offer")
        guard gate.verdict == .allow else {
            throw WalletError(code: "POLICY_DENY", message: "denied: \(gate.reason)")
        }

        let dust = try await plainDustExcept(txid: txid, vout: vout, key: key)
        let template = try Ordlock.swapOfferTemplate(
            dustTxid: dust.txid, dustVout: dust.vout, dustScriptHex: dust.scriptHex,
            carrierTxid: txid, carrierVout: vout, carrierScriptHex: carrierScript,
            payAddress: key.address, priceSats: priceSats
        )
        let built = Tx.Built(
            inputs: template.inputs, outputs: template.outputs,
            fee: 0, changeSats: 0, changeVout: -1
        )
        let unlocks = try Tx.unlockingScripts(
            built: built, privateKey: key.privateKey, publicKey: key.publicKey,
            scopeFor: { $0 == 0 ? Ordlock.scopeNoneAnyoneCanPay : Ordlock.scopeSingleAnyoneCanPay }
        )
        return Ordlock.SwapOffer(
            version: Ordlock.swapVersionOrdinal,
            kind: "ordinal",
            payScriptHex: template.payScriptHex,
            priceSats: priceSats,
            lockTime: 0,
            inputs: [
                Ordlock.SwapOfferInput(
                    txid: dust.txid, vout: dust.vout, scriptHex: dust.scriptHex,
                    sequence: Ordlock.swapSequence, unlockHex: Hex.encode(unlocks[0])
                ),
                Ordlock.SwapOfferInput(
                    txid: txid, vout: vout, scriptHex: carrierScript,
                    sequence: Ordlock.swapSequence, unlockHex: Hex.encode(unlocks[1])
                ),
            ]
        )
    }

    /// Buyer: complete a seller's offer — payment to the seller plus the asset
    /// (the inscribed sat, or the token in a fresh transfer envelope) to us in
    /// one tx, funded and signed by us, with the seller's unlocks attached
    /// verbatim. Every constrained byte is re-derived and checked against the
    /// chain before a single input is signed; a bsv21 offer is additionally
    /// checked against the token indexer, which arbitrates spend state.
    public func completeSwap(
        origin: String,
        offer: Ordlock.SwapOffer,
        fee: AppPayment? = nil,
        memo: [String]? = nil,
        label: String? = nil,
        description: String? = nil,
        expectedSeller: String? = nil,
        maxPrice: Int? = nil
    ) async throws -> SendResponse {
        try requireUnlocked()
        let key = try keyMaterial()
        let price = offer.priceSats
        guard price >= 1 else {
            throw WalletError(code: "BAD_OFFER", message: "offer priceSats must be a positive sat number")
        }
        guard offer.kind == "ordinal" || offer.kind == "bsv21" else {
            throw WalletError(code: "BAD_OFFER", message: "offer kind must be ordinal or bsv21")
        }
        guard offer.lockTime == 0 else {
            throw WalletError(code: "BAD_OFFER", message: "offer version/locktime mismatch")
        }
        guard Ordlock.isP2PKHScript(offer.payScriptHex) else {
            throw WalletError(code: "BAD_OFFER", message: "offer payment must be a plain P2PKH script")
        }
        if let expectedSeller {
            let want: String
            do {
                want = Hex.encode(try Address.lockingScript(for: expectedSeller))
            } catch {
                throw WalletError(code: "BAD_PARAM", message: "buyerChecks.expectedSeller must be a valid P2PKH address")
            }
            guard offer.payScriptHex.lowercased() == want.lowercased() else {
                throw WalletError(code: "BAD_OFFER", message: "offer payment does not pay the expected seller")
            }
        }
        if let maxPrice {
            guard maxPrice >= 0 else {
                throw WalletError(code: "BAD_PARAM", message: "buyerChecks.maxPrice must be a non-negative sat number")
            }
            guard price <= maxPrice else {
                throw WalletError(code: "BAD_OFFER", message: "offer price \(price) exceeds buyer max \(maxPrice)")
            }
        }

        var spendInputs: [Tx.Input] = []
        var preSigned: [[UInt8]] = []
        var payments: [Tx.Payment] = []
        var carrierShort = ""
        var tokenId = ""
        var tokenAmount = ""

        if offer.kind == "ordinal" {
            if offer.version == 2 {
                throw WalletError(
                    code: "BAD_OFFER",
                    message: "v2 offers are not indexer-safe (the inscribed sat lands on the payment output) — re-list to upgrade"
                )
            }
            guard offer.version == Ordlock.swapVersionOrdinal else {
                throw WalletError(code: "BAD_OFFER", message: "offer version/locktime mismatch")
            }
            guard let offerInputs = offer.inputs, offerInputs.count == 2 else {
                throw WalletError(code: "BAD_OFFER", message: "v4 offer must carry exactly two inputs (1-sat prefix + carrier)")
            }
            for item in offerInputs {
                let parsed = try parseOutpoint("\(item.txid)_\(item.vout)")
                guard item.sequence == Ordlock.swapSequence else {
                    throw WalletError(code: "BAD_OFFER", message: "offer sequence mismatch")
                }
                guard item.scriptHex.count % 2 == 0, item.scriptHex.allSatisfy({ $0.isHexDigit }) else {
                    throw WalletError(code: "BAD_OFFER", message: "offer scripts must be hex")
                }
                guard let unlockHex = item.unlockHex, !unlockHex.isEmpty,
                      unlockHex.count % 2 == 0, unlockHex.allSatisfy({ $0.isHexDigit }) else {
                    throw WalletError(code: "BAD_OFFER", message: "offer scripts must be hex")
                }
                let (value, chainScript) = try await outputData(txid: parsed.txid, vout: parsed.vout)
                guard chainScript.lowercased() == item.scriptHex.lowercased() else {
                    throw WalletError(code: "BAD_OFFER", message: "offer script disagrees with chain")
                }
                guard value == 1 else {
                    throw WalletError(code: "BAD_OFFER", message: "offer inputs must be exactly 1 sat")
                }
                spendInputs.append(Tx.Input(
                    txid: parsed.txid, vout: UInt32(parsed.vout), value: 1, scriptHex: chainScript
                ))
                preSigned.append(try Hex.decode(unlockHex))
            }
            carrierShort = offerInputs[1].txid.prefix(8).description
            // NFT output FIRST: FIFO assigns the inscribed sat here.
            payments = [
                Tx.Payment(address: key.address, sats: 1),
                Tx.Payment(scriptHex: offer.payScriptHex, sats: price),
            ]
        } else {
            guard offer.version == Ordlock.swapVersionToken else {
                throw WalletError(code: "BAD_OFFER", message: "offer version/locktime mismatch")
            }
            guard let item = offer.input else {
                throw WalletError(code: "BAD_OFFER", message: "offer input must be 64-hex txid + vout")
            }
            let parsed = try parseOutpoint("\(item.txid)_\(item.vout)")
            guard item.sequence == Ordlock.swapSequence else {
                throw WalletError(code: "BAD_OFFER", message: "offer sequence mismatch")
            }
            guard item.scriptHex.count % 2 == 0, item.scriptHex.allSatisfy({ $0.isHexDigit }) else {
                throw WalletError(code: "BAD_OFFER", message: "offer scripts must be hex")
            }
            guard let unlockHex = item.unlockHex, !unlockHex.isEmpty,
                  unlockHex.count % 2 == 0, unlockHex.allSatisfy({ $0.isHexDigit }) else {
                throw WalletError(code: "BAD_OFFER", message: "offer scripts must be hex")
            }
            let (value, chainScript) = try await outputData(txid: parsed.txid, vout: parsed.vout)
            guard chainScript.lowercased() == item.scriptHex.lowercased() else {
                throw WalletError(code: "BAD_OFFER", message: "offer script disagrees with chain")
            }
            guard value == 1 else {
                throw WalletError(code: "BAD_OFFER", message: "offer carrier is not 1 sat")
            }
            guard let id = Bsv21.normalizeTokenId(offer.tokenId) else {
                throw WalletError(code: "BAD_OFFER", message: "offer tokenId must be <64-hex-txid>_<vout>")
            }
            guard let amt = Bsv21.parseTokenAmount(offer.tokenAmount) else {
                throw WalletError(code: "BAD_OFFER", message: "offer tokenAmount must be a positive base-unit integer string")
            }
            tokenId = id
            tokenAmount = amt
            // The indexer is the arbiter of token spend state; the envelope is
            // re-checked locally below — the same two-layer rule as sending.
            do {
                let holdings = try await tokens.holdings(
                    tokenId: id, outpoints: ["\(parsed.txid)_\(parsed.vout)"]
                )
                guard holdings.contains(where: {
                    $0.txid == parsed.txid && $0.vout == parsed.vout && $0.amt == amt
                }) else {
                    throw WalletError(code: "BAD_OFFER", message: "offer token output is spent or disagrees with the indexer")
                }
            } catch let error as WalletError {
                throw error
            } catch {
                throw WalletError(code: "RAILS", message: "token lookup unreachable — cannot verify the offer")
            }
            guard let envelope = Bsv21.parseEnvelope(chainScript),
                  envelope.protocolId == Bsv21.protocolId,
                  envelope.contentType == Bsv21.contentType,
                  envelope.id == id, envelope.amt == amt else {
                throw WalletError(code: "BAD_OFFER", message: "offer script is not the listed token output")
            }
            spendInputs.append(Tx.Input(
                txid: parsed.txid, vout: UInt32(parsed.vout), value: 1, scriptHex: chainScript
            ))
            preSigned.append(try Hex.decode(unlockHex))
            carrierShort = parsed.txid.prefix(8).description
            // Exact-UTXO: the carrier moves whole into a fresh transfer
            // envelope; the payment comes first, as the desktop builds it.
            payments = [
                Tx.Payment(scriptHex: offer.payScriptHex, sats: price),
                Tx.Payment(
                    scriptHex: try Bsv21.transferScript(ownerAddress: key.address, tokenId: id, amount: amt),
                    sats: 1
                ),
            ]
        }

        var feeSats = 0
        if let fee {
            guard fee.sats > 0 else { throw WalletError(code: "BAD_PARAM", message: "fee.sats must be positive") }
            do {
                _ = try Address.lockingScript(for: fee.to)
            } catch {
                throw WalletError(code: "BAD_PARAM", message: "fee.to must be a valid P2PKH address")
            }
            feeSats = fee.sats
            payments.append(Tx.Payment(address: fee.to, sats: fee.sats))
        }
        let funding = try await plainFunding()
        let built: Tx.Built
        do {
            built = try Tx.build(
                inputs: spendInputs + funding,
                payments: payments,
                changeScriptHex: key.scriptHex,
                opReturn: memo?.isEmpty == false ? memo : nil,
                keepOrder: true
            )
        } catch {
            throw WalletError(code: "INSUFFICIENT", message: "not enough plain sats to fund the swap and its fee")
        }
        let amount = price + feeSats + built.fee
        let gate = try await policy.check(
            origin: origin, amountSats: amount, action: "app-swap",
            context: SpendContext(
                origin: origin, action: "app-swap", amountSats: amount,
                label: label, to: "\(carrierShort) listing",
                description: description
            )
        )
        guard gate.verdict == .allow else {
            throw WalletError(code: "POLICY_DENY", message: "denied: \(gate.reason)")
        }
        let signed = try Tx.sign(
            built: built, privateKey: key.privateKey, publicKey: key.publicKey,
            scopeFor: nil,
            customUnlock: { index, _ in index < preSigned.count ? preSigned[index] : nil }
        )
        let broadcast = try await broadcast(hex: Hex.encode(signed))
        let defaultLabel = offer.kind == "bsv21"
            ? "swap buy \(tokenAmount) \(tokenId.prefix(8)) for \(price) sats"
            : "swap buy \(price) sats from \(carrierShort)"
        try await ledger.record(LocalTx(
            txid: broadcast.txid,
            label: label ?? defaultLabel,
            status: broadcast.status == .mined ? "mined" : "seen",
            detail: broadcast.detail,
            createdAt: now(),
            lastCheck: now(),
            spentOutpoints: spentOutpoints(of: built)
        ))
        return SendResponse(txid: broadcast.txid, fee: built.fee)
    }

    /// The single signing path both `send` and `appSpend` use.
    private func spend(payments: [Tx.Payment], label: String) async throws -> SendResponse {
        let key = try keyMaterial()
        let addressUtxos = try await chain.utxos(address: key.address)
        let unavailable = await unavailableOutpoints()
        let inputs = addressUtxos.utxos
            .filter { !unavailable.contains("\($0.txid):\($0.vout)") }
            .map {
                Tx.Input(txid: $0.txid, vout: UInt32($0.vout), value: $0.value, scriptHex: key.scriptHex)
            }

        let built: Tx.Built
        do {
            built = try Tx.build(
                inputs: inputs,
                payments: payments,
                changeScriptHex: key.scriptHex
            )
        } catch Tx.Error.emptyInputs {
            // Everything the index showed is already spent in flight.
            throw WalletError(code: "INSUFFICIENT", message: "no spendable outputs are available right now")
        } catch Tx.Error.insufficientFunds(let have, let need) {
            throw WalletError(
                code: "INSUFFICIENT",
                message: "Insufficient funds: \(have) sats available, \(need) needed including the fee."
            )
        } catch Tx.Error.shortForFee(let short) {
            throw WalletError(code: "INSUFFICIENT", message: "Insufficient funds: short \(short) sats for the fee.")
        }

        let signed = try Tx.sign(built: built, privateKey: key.privateKey, publicKey: key.publicKey)
        let broadcast = try await broadcast(hex: Hex.encode(signed))
        let status = broadcast.status == .mined ? "mined" : "seen"
        try await ledger.record(LocalTx(
            txid: broadcast.txid,
            label: label,
            status: status,
            detail: broadcast.detail,
            createdAt: now(),
            lastCheck: now(),
            spentOutpoints: spentOutpoints(of: built)
        ))
        return SendResponse(txid: broadcast.txid, fee: built.fee)
    }

    public func policyPending() async throws -> PolicyPendingResponse {
        let records = try await policy.pendingRequests()
        return PolicyPendingResponse(requests: records.map { record in
            PendingRequest(
                id: record.id,
                origin: record.origin,
                amountSats: record.amountSats,
                action: record.action,
                createdAt: record.createdAt,
                jevVerdict: record.score?.verdict.rawValue,
                jevProb: record.score?.verdictProb,
                jevRiskLevel: record.score?.riskLevel.rawValue,
                jevConfidence: record.score?.confidence
            )
        })
    }

    public func policyList() async throws -> PolicyListResponse {
        let rows = try await policy.listPolicies()
        return PolicyListResponse(policies: rows.map(\.wireRow))
    }

    public func policyApprove(origin: String, capSats: Int) async throws -> PolicyApproveResponse {
        try await policy.setPolicy(origin: origin, mode: .allow, capSats: capSats)
        return PolicyApproveResponse(origin: origin, mode: PolicyMode.allow.rawValue)
    }

    public func policyDeny(origin: String) async throws -> PolicyApproveResponse {
        try await policy.setPolicy(origin: origin, mode: .deny)
        return PolicyApproveResponse(origin: origin, mode: PolicyMode.deny.rawValue)
    }

    /// Approve with the `auto` mode the daemon's handler accepts. Kept beside
    /// the protocol's two-argument form (which stays allow) so the bundled
    /// shell's `policyApprove` can pass `auto: true` without changing the
    /// device contract.
    public func policyApprove(origin: String, capSats: Int, auto: Bool) async throws -> PolicyApproveResponse {
        try await policy.setPolicy(origin: origin, mode: auto ? .auto : .allow, capSats: capSats)
        return PolicyApproveResponse(origin: origin, mode: (auto ? PolicyMode.auto : .allow).rawValue)
    }

    /// The ORDFS answer for one outpoint, or nil when the indexer is unsure or
    /// unreachable. Gallery reads tolerate both; the lock/list paths use
    /// `requireInscribed`, which fails closed instead.
    public func inscriptionMetadata(txid: String, vout: Int) async -> InscriptionMeta? {
        do {
            return try await inscriptions.metadata(txid: txid, vout: vout)
        } catch {
            return nil
        }
    }

    /// The token gallery: the indexer's registry fanned out to balances for
    /// one address — the wallet's own unless a caller names another. A gallery
    /// read: nothing is signed and no envelope is re-checked here.
    public func tokenPositions(address: String? = nil) async throws -> [TokenPosition] {
        try requireUnlocked()
        let target: String
        if let address, !address.isEmpty {
            target = address
        } else {
            target = try keyMaterial().address
        }
        return try await tokens.positions(address: target)
    }

    public func history() async throws -> HistoryResponse {
        let rows = try await ledger.all().sorted { $0.createdAt > $1.createdAt }
        let policies = try await policy.listPolicies()
        let pending = try await policy.pendingRequests()
        return HistoryResponse(
            transactions: rows.map {
                LedgerTransaction(txid: $0.txid, label: $0.label, status: $0.status, createdAt: $0.createdAt, hint: $0.hint)
            },
            policies: policies.map(\.wireRow),
            summary: HistorySummary(
                inFlight: rows.filter { $0.status == "seen" }.count,
                mined: rows.filter { $0.status == "mined" }.count,
                failed: rows.filter { $0.status == "failed" }.count,
                pendingRequests: pending.count,
                // The daemon counts allow and deny rows only; auto does not
                // report as "allowed origins". Matching it matters because the
                // same number is shown in the same place on both front ends.
                allowedOrigins: policies.filter { $0.mode == .allow }.count,
                deniedOrigins: policies.filter { $0.mode == .deny }.count
            )
        )
    }

    // MARK: - the phone-sized monitor

    /// Check every in-flight transaction once. Called when the app comes back
    /// to the foreground; returns how many changed state. There is no
    /// background rebroadcast on a phone, and pretending otherwise would be a
    /// different lie in the same hint text.
    @discardableResult
    public func refreshPendingTransactions() async -> Int {
        var changed = 0
        let rows = (try? await ledger.all()) ?? []
        for row in rows where row.status == "seen" {
            guard let status = try? await chain.status(txid: row.txid) else { continue }
            var updated = row
            updated.attempts += 1
            updated.lastCheck = now()
            switch status.status {
            case .mined:
                updated.status = "mined"
                updated.detail = nil
                changed += 1
            case .rejected:
                updated.status = "failed"
                updated.detail = status.detail ?? "rejected by the network"
                changed += 1
            case .seen, .unknown:
                updated.detail = status.detail
            }
            try? await ledger.update(updated)
        }
        if await castHasWork() {
            ensureCastTicker()
            _ = await castTickPass()
        }
        return changed
    }

    // MARK: - Cast (the Cast app's wallet side)
    //
    // The daemon's cast + stream loops, on the phone: episodes and sessions in
    // the cast store, one pay-per-minute stream per value split, a minutely
    // ticker that posts a liveness beat and pays what a fresh beat earns, and
    // live broadcasts stored as init + segment files served by the loopback
    // media routes. The payment gate is the daemon's `spendTo` shape —
    // origin `stream`, action `app-spend`, amount including the fee.

    public func castEpisodes() async throws -> [CastEpisode] {
        try await cast.episodes()
    }

    public func castAdd(
        title: String,
        feed: String? = nil,
        media: String? = nil,
        live: Bool = false,
        splits: String?
    ) async throws -> CastEpisode {
        let cleanTitle = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
        guard !cleanTitle.isEmpty else {
            throw WalletError(code: "BAD_PARAM", message: "title required")
        }
        let parsedSplits: [CastSplit]
        do {
            parsedSplits = try CastRules.parseSplits(splits) { address in
                (try? Address.scriptHash(from: address)) != nil
            }
        } catch let error as CastRuleError {
            throw WalletError(code: error.code, message: error.message)
        }
        guard !parsedSplits.isEmpty else {
            throw WalletError(code: "BAD_PARAM", message: "splits required")
        }
        let mediaUrl = String((media ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
        if !mediaUrl.isEmpty, !CastRules.isSiteMediaUrl(mediaUrl) {
            throw WalletError(code: "BAD_PARAM", message: "media must be an http(s) URL or site path")
        }
        let episode = CastEpisode(
            id: CastRules.newId(prefix: "ep"),
            title: cleanTitle,
            feed: String((feed ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(500)),
            mediaUrl: mediaUrl,
            live: live,
            splits: parsedSplits,
            createdAt: now()
        )
        try await cast.saveEpisode(episode)
        return episode
    }

    /// Start a listening session: one stream per split, and the money starts
    /// with it. Not gated on the session lock — payments fail as skipped ticks
    /// if the wallet is locked, exactly as a locked daemon behaves.
    public func castPlay(episode: String, rate: Int, every: String? = nil, maxTotal: Int) async throws -> CastSession {
        guard let row = try await cast.episode(id: episode) else {
            throw WalletError(code: "NOT_FOUND", message: "no episode: \(String(episode.prefix(16)))")
        }
        guard rate > 0 else {
            throw WalletError(code: "BAD_PARAM", message: "rate must be positive sats/min")
        }
        let tickMs: Int
        do {
            tickMs = try CastRules.parseTick(every ?? "5m")
        } catch let error as CastRuleError {
            throw WalletError(code: error.code, message: error.message)
        }
        let tickSecs = Int(floor(Double(tickMs) / 1000))
        guard tickSecs >= 60 else {
            throw WalletError(code: "BAD_PARAM", message: "interval minimum 60s")
        }
        guard maxTotal >= 1000 else {
            throw WalletError(code: "BAD_PARAM", message: "max total must be at least 1000 sats")
        }

        let stamp = now()
        var streamIds: [String] = []
        for split in row.splits {
            let streamRate = max(1, Int((Double(rate) * split.pct / 100).rounded()))
            let streamMax = max(1000, Int(floor(Double(maxTotal) * split.pct / 100)))
            let stream = PayStream(
                id: CastRules.newStreamId(),
                name: "cast \(String(row.title.prefix(40))) \(CastRules.formatNumber(split.pct))% \(String(split.address.prefix(8)))",
                payee: split.address,
                ratePerMin: streamRate,
                tickSecs: tickSecs,
                maxTotal: streamMax,
                board: CastRules.board,
                status: "active",
                paidTotal: 0,
                lastPaidAt: stamp,
                nextDue: stamp + tickSecs * 1000,
                createdAt: stamp
            )
            try await cast.saveStream(stream)
            streamIds.append(stream.id)
        }
        let session = CastSession(
            id: CastRules.newId(prefix: "cs"),
            episode: row.id,
            title: row.title,
            ratePerMin: rate,
            everySecs: tickSecs,
            maxTotal: maxTotal,
            streamIds: streamIds,
            status: "playing",
            startedAt: stamp,
            stoppedAt: nil
        )
        try await cast.saveSession(session)
        stopCastTicker()
        ensureCastTicker()
        _ = await castTickPass()
        return session
    }

    public func castStop(id: String) async throws -> CastSession {
        guard let session = try await cast.session(id: id) else {
            throw WalletError(code: "NOT_FOUND", message: "no session: \(String(id.prefix(16)))")
        }
        guard session.status != "stopped" else { return session }
        for streamId in session.streamIds {
            guard var stream = try? await cast.stream(id: streamId), stream.status != "done" else { continue }
            stream.status = "done"
            try? await cast.saveStream(stream)
        }
        var stopped = session
        stopped.status = "stopped"
        stopped.stoppedAt = now()
        try await cast.saveSession(stopped)
        if !(await castHasWork()) { stopCastTicker() }
        return stopped
    }

    public func streamPause(id: String) async throws -> PayStream {
        guard var stream = try await cast.stream(id: id) else {
            throw WalletError(code: "NOT_FOUND", message: "no stream: \(String(id.prefix(16)))")
        }
        guard stream.status != "done" else {
            throw WalletError(code: "BAD_STATE", message: "closed streams stay closed")
        }
        stream.status = "paused"
        try await cast.saveStream(stream)
        return stream
    }

    public func streamResume(id: String) async throws -> PayStream {
        guard var stream = try await cast.stream(id: id) else {
            throw WalletError(code: "NOT_FOUND", message: "no stream: \(String(id.prefix(16)))")
        }
        guard stream.status != "done" else {
            throw WalletError(code: "BAD_STATE", message: "closed streams stay closed")
        }
        let stamp = now()
        stream.status = "active"
        stream.nextDue = stamp + stream.tickSecs * 1000
        stream.lastPaidAt = stamp
        try await cast.saveStream(stream)
        ensureCastTicker()
        return stream
    }

    public func streamTicks(id: String, limit: Int = 50) async throws -> [StreamTick] {
        guard try await cast.stream(id: id) != nil else {
            throw WalletError(code: "NOT_FOUND", message: "no stream: \(String(id.prefix(16)))")
        }
        return try await cast.ticks(streamId: id, limit: limit)
    }

    public func castSetMedia(episode: String, mediaUrl: String) async throws -> (episode: String, mediaUrl: String) {
        guard var row = try await cast.episode(id: episode) else {
            throw WalletError(code: "NOT_FOUND", message: "no episode \(String(episode.prefix(16)))")
        }
        let url = String(mediaUrl.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
        if !url.isEmpty, !CastRules.isSiteMediaUrl(url) {
            throw WalletError(code: "BAD_PARAM", message: "media must be an http(s) URL or site path")
        }
        row.mediaUrl = url
        try await cast.saveEpisode(row)
        return (episode, url)
    }

    public func castLiveStart(episode: String) async throws -> (live: CastLive, playlist: String) {
        guard var row = try await cast.episode(id: episode) else {
            throw WalletError(code: "NOT_FOUND", message: "no episode: \(String(episode.prefix(16)))")
        }
        let live = CastLive(
            id: CastRules.newLiveId(), episode: episode, status: "live",
            segments: 0, mime: "", startedAt: now(), stoppedAt: nil, lastSegmentAt: nil
        )
        try await cast.saveLive(live)
        row.live = true
        try await cast.saveEpisode(row)
        return (live, "/cast/live/\(live.id)/index.m3u8")
    }

    public func castLiveStop(id: String) async throws -> CastLive {
        guard var live = try await cast.live(id: id) else {
            throw WalletError(code: "NOT_FOUND", message: "no live session: \(id)")
        }
        guard live.status != "ended" else { return live }
        live.status = "ended"
        live.stoppedAt = now()
        try await cast.saveLive(live)
        if var episode = try await cast.episode(id: live.episode) {
            episode.live = false
            try await cast.saveEpisode(episode)
        }
        return live
    }

    public func castLiveGet(id: String) async throws -> CastLive {
        guard CastRules.liveIdValid(id) else {
            throw WalletError(code: "BAD_PARAM", message: "bad live id")
        }
        guard let live = try await cast.live(id: id) else {
            throw WalletError(code: "NOT_FOUND", message: "no live session: \(id)")
        }
        return live
    }

    /// End broadcasts whose recorder went silent (crashed tab, backgrounded
    /// app), so their playlists get ENDLIST and replay as recordings. Called
    /// on the ticker's pass and on foreground.
    @discardableResult
    public func castReapStaleLive() async -> [String] {
        let stamp = now()
        var ended: [String] = []
        for live in (try? await cast.lives()) ?? [] where live.status == "live" {
            let last = max(live.lastSegmentAt ?? live.startedAt, live.startedAt)
            guard stamp - last >= CastRules.liveIdleMs else { continue }
            if var updated = try? await cast.live(id: live.id) {
                updated.status = "ended"
                updated.stoppedAt = stamp
                try? await cast.saveLive(updated)
                ended.append(live.id)
            }
        }
        return ended
    }

    /// One pass of the daemon's cast + stream loops: a liveness beat per
    /// playing session (minutely, as the desktop posts), then the payment
    /// decision for every due active stream. Returns true while there is work,
    /// so the ticker knows whether to keep going.
    @discardableResult
    public func castTickPass() async -> Bool {
        if castTickRunning { return await castHasWork() }
        castTickRunning = true
        defer { castTickRunning = false }
        let stamp = now()

        for session in (try? await cast.sessions()) ?? [] where session.status == "playing" {
            for streamId in session.streamIds {
                if let last = try? await cast.latestBeat(streamId: streamId), stamp - last.ts < 5_000 {
                    continue // an immediate pass right after play must not double-post
                }
                try? await cast.appendBeat(StreamBeat(id: CastRules.newId(prefix: "bt"), streamId: streamId, ts: stamp))
            }
        }

        for stream in (try? await cast.streams()) ?? [] where stream.status == "active" {
            if stream.nextDue > stamp || stream.tickSecs <= 0 { continue }
            let advance = Commitment.advanceDue(nextDueAt: stream.nextDue, cadenceSecs: stream.tickSecs, now: stamp)
            let remaining = stream.maxTotal - stream.paidTotal
            if remaining < CastRules.minTickSats {
                var closed = stream
                closed.status = "done"
                closed.nextDue = advance
                try? await cast.saveStream(closed)
                _ = try? await cast.appendTick(StreamTick(
                    id: 0, streamId: stream.id, beatId: nil, amount: 0, txid: nil, status: "closed",
                    detail: "budget exhausted (remainder \(remaining) sats below pay floor — left unpaid)",
                    createdAt: stamp
                ))
                continue
            }
            let beat = try? await cast.latestBeat(streamId: stream.id)
            let grace = Commitment.graceMsFor(stream.tickSecs)
            let age = beat.map { stamp - $0.ts } ?? Int.max
            let fresh = beat != nil && age <= grace
            let reason: String
            if let beat {
                reason = "last beat \(String(beat.id.prefix(8))) is \(Int((Double(age) / 1000).rounded()))s old (grace \(Int((Double(grace) / 1000).rounded()))s) — auto-paused, resume when beats return"
            } else {
                reason = "no heartbeat on the board yet — auto-paused"
            }
            let terms = Commitment.Terms(
                cadenceSecs: stream.tickSecs, ratePerMin: stream.ratePerMin, fixedSats: 0,
                capSats: stream.maxTotal, paidSats: stream.paidTotal,
                minPaymentSats: CastRules.minTickSats, lastPaidAt: stream.lastPaidAt, nextDueAt: stream.nextDue
            )
            switch Commitment.due(terms, fresh: fresh, ageMs: age == Int.max ? 0 : age, reason: reason, now: stamp) {
            case .wait:
                continue
            case .exhausted(let left):
                var closed = stream
                closed.status = "done"
                closed.nextDue = advance
                try? await cast.saveStream(closed)
                _ = try? await cast.appendTick(StreamTick(
                    id: 0, streamId: stream.id, beatId: nil, amount: 0, txid: nil, status: "closed",
                    detail: "budget exhausted (remainder \(left) sats below pay floor — left unpaid)",
                    createdAt: stamp
                ))
            case .stale(_, let why):
                var paused = stream
                paused.status = "paused"
                paused.nextDue = advance
                try? await cast.saveStream(paused)
                _ = try? await cast.appendTick(StreamTick(
                    id: 0, streamId: stream.id, beatId: nil, amount: 0, txid: nil, status: "stale",
                    detail: why, createdAt: stamp
                ))
            case .accruing(let amount):
                var accrued = stream
                accrued.nextDue = advance
                try? await cast.saveStream(accrued)
                _ = try? await cast.appendTick(StreamTick(
                    id: 0, streamId: stream.id, beatId: beat?.id, amount: amount, txid: nil, status: "skipped",
                    detail: "accrued \(amount) sats below \(CastRules.minTickSats) floor — carrying to next tick",
                    createdAt: stamp
                ))
            case .release(let amount, _):
                do {
                    let paid = try await streamPay(stream: stream, amount: amount, beatId: beat?.id ?? "")
                    var settled = stream
                    settled.paidTotal += amount
                    settled.lastPaidAt = stamp
                    settled.nextDue = advance
                    if settled.paidTotal >= settled.maxTotal { settled.status = "done" }
                    try? await cast.saveStream(settled)
                    _ = try? await cast.appendTick(StreamTick(
                        id: 0, streamId: stream.id, beatId: beat?.id, amount: amount, txid: paid.txid, status: "paid",
                        detail: "beat \(String((beat?.id ?? "").prefix(8)))", createdAt: stamp
                    ))
                } catch {
                    var retry = stream
                    retry.nextDue = advance
                    try? await cast.saveStream(retry)
                    let message = (error as? WalletError)?.message ?? String(describing: error)
                    _ = try? await cast.appendTick(StreamTick(
                        id: 0, streamId: stream.id, beatId: beat?.id, amount: amount, txid: nil, status: "skipped",
                        detail: String("payment failed: \(message)".prefix(200)), createdAt: stamp
                    ))
                }
            }
        }

        _ = await castReapStaleLive()
        return await castHasWork()
    }

    // MARK: - cast internals

    private var castTicker: Task<Void, Never>?
    private var castTickRunning = false

    private func ensureCastTicker() {
        if let castTicker, !castTicker.isCancelled { return }
        castTicker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60 * 1_000_000_000)
                guard let self else { return }
                let keep = await self.castTickPass()
                if !keep { break }
            }
            guard let self else { return }
            await self.castTickerFinished()
        }
    }

    private func castTickerFinished() {
        castTicker = nil
    }

    private func stopCastTicker() {
        castTicker?.cancel()
        castTicker = nil
    }

    private func castHasWork() async -> Bool {
        if ((try? await cast.sessions()) ?? []).contains(where: { $0.status == "playing" }) { return true }
        return ((try? await cast.streams()) ?? []).contains(where: { $0.status == "active" })
    }

    /// The daemon's `spendTo` for a stream tick: plain funding, one payment,
    /// the OP_RETURN memo, the same gate (`origin: stream`, `app-spend`,
    /// amount including the fee), then broadcast and ledger. A throw leaves
    /// the tick unpaid; the pass records it as skipped.
    private func streamPay(stream: PayStream, amount: Int, beatId: String) async throws -> SendResponse {
        let key = try keyMaterial()
        let funding = try await plainFunding()
        guard !funding.isEmpty else {
            throw WalletError(code: "INSUFFICIENT", message: "no plain funding UTXOs for the stream payment")
        }
        let built: Tx.Built
        do {
            built = try Tx.build(
                inputs: funding,
                payments: [Tx.Payment(address: stream.payee, sats: amount)],
                changeScriptHex: key.scriptHex,
                opReturn: ["STREAM-PAY", stream.id, "beat:\(String(beatId.prefix(8)))"]
            )
        } catch {
            throw WalletError(code: "INSUFFICIENT", message: "not enough plain sats to pay the stream tick")
        }
        let total = amount + built.fee
        let label = "stream \(stream.name) tick"
        let description = "streamed pay \(amount) sats to \(stream.payee) for \(stream.name) (heartbeat \(String(beatId.prefix(8))))"
        let gate = try await policy.check(
            origin: "stream", amountSats: total, action: "app-spend",
            context: SpendContext(
                origin: "stream", action: "app-spend", amountSats: total,
                label: label, to: stream.payee, description: description
            )
        )
        guard gate.verdict == .allow else {
            throw WalletError(code: "POLICY_DENY", message: "denied: \(gate.reason)")
        }
        let signed = try Tx.sign(built: built, privateKey: key.privateKey, publicKey: key.publicKey)
        let broadcast = try await broadcast(hex: Hex.encode(signed))
        try await ledger.record(LocalTx(
            txid: broadcast.txid,
            label: label,
            status: broadcast.status == .mined ? "mined" : "seen",
            detail: broadcast.detail,
            createdAt: now(),
            lastCheck: now(),
            spentOutpoints: spentOutpoints(of: built)
        ))
        return SendResponse(txid: broadcast.txid, fee: built.fee)
    }

    // MARK: - internals
    // MARK: - ordlock internals

    /// An outpoint's chain script and value, from the parent transaction.
    private func outputData(txid: String, vout: Int) async throws -> (value: Int, scriptHex: String) {
        guard txid.count == 64, txid.allSatisfy({ $0.isHexDigit }) else {
            throw WalletError(code: "BAD_PARAM", message: "txid must be 64-hex")
        }
        guard let parent = try? await chain.tx(txid: txid),
              vout >= 0, vout < parent.vout.count,
              let scriptHex = parent.vout[vout].scriptHex,
              let value = parent.vout[vout].value else {
            throw WalletError(code: "RAILS", message: "output is not visible on chain yet")
        }
        return (value, scriptHex)
    }

    /// `<64-hex-txid>.<vout>` or with an underscore, as the daemon accepts.
    private func parseOutpoint(_ raw: String) throws -> (txid: String, vout: Int) {
        guard let separator = raw.firstIndex(where: { $0 == "." || $0 == "_" }) else {
            throw WalletError(code: "BAD_PARAM", message: "lockOutpoint must be <64-hex-txid>.<vout>")
        }
        let txid = String(raw[raw.startIndex..<separator])
        let voutText = String(raw[raw.index(after: separator)...])
        guard txid.count == 64, txid.allSatisfy({ $0.isHexDigit }),
              !voutText.isEmpty, let vout = Int(voutText), vout >= 0 else {
            throw WalletError(code: "BAD_PARAM", message: "lockOutpoint must be <64-hex-txid>.<vout>")
        }
        return (txid, vout)
    }

    /// Funding selection, the daemon's `plainFunding`: largest first, up to 12
    /// candidates and 6 spent, never an inscription carrier and never an
    /// outpoint already in flight.
    private func plainFunding(maximum: Int = 6) async throws -> [Tx.Input] {
        let key = try keyMaterial()
        let indexed = try await chain.utxos(address: key.address)
        let unavailable = await unavailableOutpoints()
        let candidates = indexed.utxos
            .filter { $0.value > 1 && !unavailable.contains("\($0.txid):\($0.vout)") }
            .sorted { $0.value > $1.value }
            .prefix(12)
        var funding: [Tx.Input] = []
        for candidate in candidates where funding.count < maximum {
            guard let parent = try? await chain.tx(txid: candidate.txid),
                  candidate.vout >= 0, candidate.vout < parent.vout.count,
                  let scriptHex = parent.vout[candidate.vout].scriptHex,
                  !Inscription.hasOrdEnvelope(scriptHex) else { continue }
            funding.append(Tx.Input(
                txid: candidate.txid, vout: UInt32(candidate.vout),
                value: candidate.value, scriptHex: scriptHex
            ))
        }
        return funding
    }

    /// A plain 1-sat prefix for a v4 offer, the daemon's `findPlainDust`:
    /// unspent, not the carrier, ORDFS-clean, and still ours on chain.
    private func plainDustExcept(
        txid: String, vout: Int, key: KeyMaterial
    ) async throws -> (txid: String, vout: Int, scriptHex: String) {
        let indexed = try await chain.utxos(address: key.address)
        let unavailable = await unavailableOutpoints()
        let carrierKey = "\(txid):\(vout)"
        let candidates = indexed.utxos
            .filter {
                $0.value == 1
                    && "\($0.txid):\($0.vout)" != carrierKey
                    && !unavailable.contains("\($0.txid):\($0.vout)")
            }
            .prefix(10)
        for candidate in candidates {
            let known: Bool
            do {
                known = try await inscriptions.isInscribed(txid: candidate.txid, vout: candidate.vout)
            } catch {
                throw WalletError(code: "RAILS", message: "inscription lookup unreachable — cannot pick a safe prefix input")
            }
            if known { continue }
            guard let parent = try? await chain.tx(txid: candidate.txid),
                  candidate.vout >= 0, candidate.vout < parent.vout.count,
                  let scriptHex = parent.vout[candidate.vout].scriptHex,
                  parent.vout[candidate.vout].value == 1,
                  scriptHex.lowercased().hasPrefix(key.scriptHex.lowercased()) else { continue }
            return (candidate.txid, candidate.vout, scriptHex)
        }
        throw WalletError(
            code: "BAD_PARAM",
            message: "need a plain 1-sat UTXO as the offer prefix (swap change provides one)"
        )
    }

    /// The daemon's token-id and amount gates, with its messages.
    private func requireTokenId(_ raw: String?) throws -> String {
        guard let id = Bsv21.normalizeTokenId(raw) else {
            throw WalletError(code: "BAD_PARAM", message: "tokenId must be <64-hex-txid>_<vout>")
        }
        return id
    }

    private func requireTokenAmount(_ raw: String?) throws -> String {
        guard let amount = Bsv21.parseTokenAmount(raw) else {
            throw WalletError(code: "BAD_PARAM", message: "tokenAmount must be a positive base-unit integer string")
        }
        return amount
    }

    /// The daemon's ownership test for a carrier: the P2PKH prefix.
    private func requireOurs(_ scriptHex: String, key: KeyMaterial, code: String, message: String) throws {
        guard scriptHex.lowercased().hasPrefix(key.scriptHex.lowercased()) else {
            throw WalletError(code: code, message: message)
        }
    }

    /// Envelope in the script, or ORDFS says the outpoint carries an
    /// inscription — the two-layer check the daemon applies before locking or
    /// listing a carrier.
    private func requireInscribed(
        _ scriptHex: String, txid: String, vout: Int, refusal: String
    ) async throws {
        if Inscription.hasOrdEnvelope(scriptHex) { return }
        let known: Bool
        do {
            known = try await inscriptions.isInscribed(txid: txid, vout: vout)
        } catch {
            throw WalletError(code: "RAILS", message: "inscription lookup unreachable — cannot verify the carrier")
        }
        guard known else {
            throw WalletError(code: "BAD_PARAM", message: refusal)
        }
    }


    private struct KeyMaterial {
        var privateKey: [UInt8]
        var publicKey: [UInt8]
        var address: String
        var scriptHex: String
    }

    /// Outpoints spent by transactions this wallet broadcast that are still
    /// in flight. A mined transaction's outputs are gone from the index anyway
    /// and a failed one never moved anything, so only `seen` binds.
    private func unavailableOutpoints() async -> Set<String> {
        let rows = (try? await ledger.all()) ?? []
        return Set(rows.filter { $0.status == "seen" }.flatMap { $0.spentOutpoints ?? [] })
    }

    private func spentOutpoints(of built: Tx.Built) -> [String] {
        built.inputs.map { "\($0.txid):\(Int($0.vout))" }
    }

    private func requireUnlocked() throws {
        guard vault.hasPhrase else {
            throw WalletError(code: "NO_WALLET", message: "No wallet on this device yet.")
        }
        guard !locked else {
            throw WalletError(code: "WALLET_LOCKED", message: "Unlock the wallet first.")
        }
    }

    /// The daemon's custody path, on the phone: the phrase becomes a seed
    /// becomes `m/0/0`. The key bytes live only in this tuple and in the call
    /// that signs.
    private func keyMaterial() throws -> KeyMaterial {
        guard let phrase = try vault.loadPhrase() else {
            throw WalletError(code: "NO_WALLET", message: "No wallet on this device yet.")
        }
        do {
            let master = try BIP32.master(fromSeed: BIP39.seed(fromValidated: phrase))
            let key = try BIP32.derive("m/0/0", from: master)
            let publicKey = try Secp256k1.publicKey(fromPrivateKey: key.privateKey)
            let address = Address.from(publicKey: publicKey)
            return KeyMaterial(
                privateKey: key.privateKey,
                publicKey: publicKey,
                address: address,
                scriptHex: Hex.encode(try Address.lockingScript(for: address))
            )
        } catch {
            throw WalletError(code: "BAD_SEED", message: "The stored recovery phrase could not be used: \(error)")
        }
    }

    private func broadcast(hex: String) async throws -> BroadcastResult {
        do {
            let result = try await chain.broadcast(txHex: hex)
            if result.status == .rejected {
                throw WalletError(
                    code: "BROADCAST_REJECTED",
                    message: result.detail ?? "the network rejected the transaction"
                )
            }
            return result
        } catch let error as WalletError {
            throw error
        } catch let ChainError.broadcastRejected(detail) {
            throw WalletError(code: "BROADCAST_REJECTED", message: detail)
        } catch {
            throw WalletError(code: "BROADCAST_FAILED", message: String(describing: error))
        }
    }
}

private extension PolicyRowRecord {
    var wireRow: PolicyRow {
        PolicyRow(origin: origin, mode: mode.rawValue, spendCapSats: spendCapSats, updatedAt: updatedAt)
    }
}
