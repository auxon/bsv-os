import Foundation

/// The in-process `window.bsv` backend: a hosted app's calls answered by the
/// phone's own wallet, with no daemon anywhere.
///
/// The rules do not change from the device-backed bridge: the app is pinned by
/// the host, the intent allowlist still applies, and every write is
/// policy-gated under the app's domain — so an app carries the same origin,
/// the same caps and the same pending approvals it would on the desktop.
///
/// What changes is the boundary of what exists here:
///
/// - **Reads and `spend` are real.** They are the ones a phone wallet can be
///   truthful about: chain reads and a policy-gated payment from the same
///   signer the Send screen uses.
/// - **The ordinal, OrdLock and ordinal-swap intents are real.** The covenant
///   scripts, the purchase preimage and both swap kinds (v4 ordinal, v3
///   bsv21) are ported and pinned to the daemon byte for byte; carriers whose
///   envelope is not in the script are verified through ORDFS and token offers
///   through the 1Sat holdings endpoint, exactly as the daemon verifies them.
/// - Reads require the wallet to be unlocked, which is stricter than the
///   daemon (its app reads answer while locked). Stricter is the right
///   direction to differ in.
public struct LocalAppBridgeBackend: AppBridgeBackend {
    private let wallet: LocalWalletBackend
    private let chain: any ChainProvider

    public init(wallet: LocalWalletBackend, chain: any ChainProvider) {
        self.wallet = wallet
        self.chain = chain
    }

    public func invoke(app domain: String, intent: AppIntent, params: [String: JSONValue]) async throws -> String {
        let result: JSONValue
        switch intent {
        case .getStatus:
            let status = try await wallet.isAuthenticated()
            result = .object([
                "authenticated": .bool(!status.locked),
                "locked": .bool(status.locked),
                "hasWallet": .bool(status.hasWallet),
            ])

        case .getIdentity:
            let status = try await wallet.isAuthenticated()
            let identity = try await wallet.identityKey()
            result = .object([
                "identityKey": identity.map { JSONValue.string($0) } ?? .null,
                "locked": .bool(status.locked),
            ])

        case .getBalance:
            let balance = try await wallet.balance()
            result = .object([
                "address": .string(balance.address),
                "confirmed": .int(balance.confirmed),
                "unconfirmed": .int(balance.unconfirmed),
                "utxos": .int(balance.utxos),
            ])

        case .getUtxos:
            let balance = try await wallet.balance()
            let addressUtxos = try await chain.utxos(address: balance.address)
            result = .object([
                "address": .string(balance.address),
                "confirmed": .int(addressUtxos.confirmed),
                "unconfirmed": .int(addressUtxos.unconfirmed),
                "utxos": .array(addressUtxos.utxos.map { utxo in
                    .object([
                        "txid": .string(utxo.txid),
                        "vout": .int(utxo.vout),
                        "value": .int(utxo.value),
                        "height": .int(utxo.height),
                    ])
                }),
            ])

        case .spend:
            let intentPayments = try payments(from: params)
            let memo = strings(from: params["memo"])
            let sent = try await wallet.appSpend(
                origin: domain,
                payments: intentPayments,
                memo: memo,
                label: params["label"]?.stringValue
            )
            result = .object(["txid": .string(sent.txid), "fee": .int(sent.fee)])

        case .inscribe:
            guard let dataHex = params["dataHex"]?.stringValue, !dataHex.isEmpty else {
                throw WalletError(code: "BAD_PARAM", message: "dataHex required")
            }
            guard let contentType = params["contentType"]?.stringValue, !contentType.isEmpty else {
                throw WalletError(code: "BAD_PARAM", message: "contentType required")
            }
            var fee: LocalWalletBackend.AppPayment? = nil
            if case .object(let feeObject)? = params["fee"],
               let feeTo = feeObject["to"]?.stringValue,
               let feeSats = feeObject["sats"]?.intValue {
                fee = LocalWalletBackend.AppPayment(to: feeTo, sats: feeSats)
            }
            let inscription = try await wallet.appInscribe(
                origin: domain,
                to: params["to"]?.stringValue ?? "",
                contentType: contentType,
                dataHex: dataHex,
                fee: fee,
                memo: strings(from: params["memo"]),
                label: params["label"]?.stringValue
            )
            result = .object(["txid": .string(inscription.txid), "fee": .int(inscription.fee)])

        case .transferNft:
            guard let txid = params["txid"]?.stringValue, !txid.isEmpty else {
                throw WalletError(code: "BAD_PARAM", message: "txid required")
            }
            guard let to = params["to"]?.stringValue, !to.isEmpty else {
                throw WalletError(code: "BAD_PARAM", message: "recipient address required")
            }
            let sent = try await wallet.appSendOrdinal(
                origin: domain,
                txid: txid,
                vout: params["vout"]?.intValue ?? 0,
                to: to,
                memo: strings(from: params["memo"])
            )
            result = .object(["txid": .string(sent.txid), "fee": .int(sent.fee)])

        case .ordlockLock:
            guard let txid = params["txid"]?.stringValue, !txid.isEmpty else {
                throw WalletError(code: "BAD_PARAM", message: "txid required")
            }
            let locked = try await wallet.ordlockLock(
                origin: domain,
                txid: txid,
                vout: params["vout"]?.intValue ?? 0,
                priceSats: params["priceSats"]?.intValue ?? 0
            )
            result = .object([
                "txid": .string(locked.txid),
                "lockOutpoint": .string(locked.lockOutpoint),
                "fee": .int(locked.fee),
            ])

        case .ordlockBuy:
            guard let lockOutpoint = params["lockOutpoint"]?.stringValue, !lockOutpoint.isEmpty else {
                throw WalletError(code: "BAD_PARAM", message: "lockOutpoint required")
            }
            let bought = try await wallet.ordlockBuy(
                origin: domain,
                lockOutpoint: lockOutpoint,
                fee: try feePayment(from: params["fee"]),
                // The daemon's app path tags the spend itself; mirror it so the
                // ledger and policy reasons read the same on both hosts.
                memo: ["MARKET-BUY", lockOutpoint],
                label: "market buy \(lockOutpoint)"
            )
            result = .object([
                "txid": .string(bought.txid),
                "fee": .int(bought.fee),
                "priceSats": .int(bought.priceSats),
            ])

        case .ordlockCancel:
            guard let lockOutpoint = params["lockOutpoint"]?.stringValue, !lockOutpoint.isEmpty else {
                throw WalletError(code: "BAD_PARAM", message: "lockOutpoint required")
            }
            let cancelled = try await wallet.ordlockCancel(origin: domain, lockOutpoint: lockOutpoint)
            result = .object(["txid": .string(cancelled.txid), "fee": .int(cancelled.fee)])

        case .signSwapOffer:
            guard let txid = params["txid"]?.stringValue, !txid.isEmpty else {
                throw WalletError(code: "BAD_PARAM", message: "txid required")
            }
            // JS may hand the amount over as a number; the token layer only
            // takes base-unit strings.
            let tokenAmount = params["tokenAmount"]?.stringValue
                ?? params["tokenAmount"]?.intValue.map(String.init)
            let offer = try await wallet.signSwapOffer(
                origin: domain,
                txid: txid,
                vout: params["vout"]?.intValue ?? 0,
                priceSats: params["priceSats"]?.intValue ?? 0,
                kind: params["kind"]?.stringValue,
                tokenId: params["tokenId"]?.stringValue,
                tokenAmount: tokenAmount
            )
            result = try asJSONValue(offer)

        case .completeSwap:
            guard case .object? = params["offer"] else {
                throw WalletError(code: "BAD_PARAM", message: "offer required")
            }
            let offer = try swapOffer(from: params["offer"])
            var expectedSeller: String? = nil
            var maxPrice: Int? = nil
            if case .object(let checks)? = params["buyerChecks"] {
                expectedSeller = checks["expectedSeller"]?.stringValue
                maxPrice = checks["maxPrice"]?.intValue
            }
            let completed = try await wallet.completeSwap(
                origin: domain,
                offer: offer,
                fee: try feePayment(from: params["fee"]),
                memo: strings(from: params["memo"]),
                label: params["label"]?.stringValue,
                expectedSeller: expectedSeller,
                maxPrice: maxPrice
            )
            result = .object(["txid": .string(completed.txid), "fee": .int(completed.fee)])

        default:
            throw WalletError(
                code: "UNAVAILABLE",
                message: "\(intent.rawValue) is not available in the on-device wallet yet"
            )
        }
        return try encode(result)
    }

    // MARK: - params and results

    private func payments(from params: [String: JSONValue]) throws -> [LocalWalletBackend.AppPayment] {
        guard case .array(let items)? = params["payments"] else {
            throw WalletError(code: "BAD_PARAM", message: "payments required")
        }
        let parsed = items.compactMap { item -> LocalWalletBackend.AppPayment? in
            guard case .object(let object) = item,
                  let to = object["to"]?.stringValue,
                  let sats = object["sats"]?.intValue else { return nil }
            return LocalWalletBackend.AppPayment(to: to, sats: sats)
        }
        guard !parsed.isEmpty else {
            throw WalletError(code: "BAD_PARAM", message: "payments required")
        }
        return parsed
    }

    private func strings(from value: JSONValue?) -> [String]? {
        guard case .array(let items)? = value else { return nil }
        return items.compactMap(\.stringValue)
    }

    private func feePayment(from value: JSONValue?) throws -> LocalWalletBackend.AppPayment? {
        guard case .object(let object)? = value else { return nil }
        guard let to = object["to"]?.stringValue, let sats = object["sats"]?.intValue else { return nil }
        return LocalWalletBackend.AppPayment(to: to, sats: sats)
    }

    private func swapOffer(from value: JSONValue?) throws -> Ordlock.SwapOffer {
        let data = try JSONEncoder().encode(value)
        do {
            return try JSONDecoder().decode(Ordlock.SwapOffer.self, from: data)
        } catch {
            throw WalletError(code: "BAD_OFFER", message: "offer is not a valid swap offer")
        }
    }

    private func asJSONValue<T: Encodable>(_ value: T) throws -> JSONValue {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    private func encode(_ value: JSONValue) throws -> String {
        let data = try JSONEncoder().encode(value)
        guard let json = String(data: data, encoding: .utf8) else {
            throw WalletError(code: "ENCODE", message: "could not encode the result")
        }
        return json
    }
}

extension JSONValue {
    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// JavaScript numbers arrive as doubles on some paths and ints on others,
    /// so both count as an integer here.
    var intValue: Int? {
        switch self {
        case .int(let value): return value
        case .double(let value): return Int(value)
        default: return nil
        }
    }
}
