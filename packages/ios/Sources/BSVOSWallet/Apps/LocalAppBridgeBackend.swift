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
/// - **The ordinal and swap intents answer UNAVAILABLE.** They need indexers,
///   script tooling and marketplace state that only the daemon has. A clear
///   refusal is the honest answer; a half-working transfer is not.
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
