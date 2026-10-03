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
    private let now: @Sendable () -> Int
    private var locked = true

    public init(
        vault: any SeedVault,
        chain: any ChainProvider,
        policy: PolicyEngine,
        ledger: any LedgerStore,
        now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.vault = vault
        self.chain = chain
        self.policy = policy
        self.ledger = ledger
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
        return changed
    }

    // MARK: - internals

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
