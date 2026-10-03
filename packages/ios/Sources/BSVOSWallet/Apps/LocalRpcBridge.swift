import Foundation

/// The RPC seam for hosted pages that call `fetch("/")` instead of `window.bsv`.
///
/// `RpcBridge` forwards to the daemon's device surface; `LocalRpcBridge`
/// answers from the phone's own wallet. Same replies, same shape, so the shim
/// injected into the page does not care which one is behind it.
public protocol RpcCalling: Sendable {
    func call(id: Int, method: String, params: [String: JSONValue]) async -> RpcReply
}

/// The in-process dispatcher for a stock app running from the bundle.
///
/// Bundled apps are first-party on the desktop, where loopback means full
/// operator power. Here they still go through the wallet's front door and a
/// spend still passes the policy gate under the app's own origin — stricter
/// than the desktop, deliberately, because on a phone the bundle is the only
/// thing standing between a page and the wallet.
public struct LocalRpcBridge: RpcCalling {
    private let origin: String
    private let wallet: LocalWalletBackend
    private let chain: any ChainProvider

    public init(origin: String, wallet: LocalWalletBackend, chain: any ChainProvider) {
        self.origin = origin
        self.wallet = wallet
        self.chain = chain
    }

    public func call(id: Int, method: String, params: [String: JSONValue]) async -> RpcReply {
        do {
            let result = try await dispatch(method: method, params: params)
            return RpcReply(id: id, ok: true, result: try stringify(result), errorCode: nil, errorMessage: nil)
        } catch let error as WalletError {
            return RpcReply(id: id, ok: false, result: nil, errorCode: error.code, errorMessage: error.message)
        } catch {
            return RpcReply(id: id, ok: false, result: nil, errorCode: "BRIDGE", errorMessage: String(describing: error))
        }
    }

    private func dispatch(method: String, params: [String: JSONValue]) async throws -> JSONValue {
        switch method {
        case "getStatus":
            let status = try await wallet.isAuthenticated()
            return .object([
                "authenticated": .bool(!status.locked),
                "locked": .bool(status.locked),
                "hasWallet": .bool(status.hasWallet),
            ])

        case "getBalance":
            let balance = try await wallet.balance()
            return .object([
                "address": .string(balance.address),
                "confirmed": .int(balance.confirmed),
                "unconfirmed": .int(balance.unconfirmed),
                "utxos": .int(balance.utxos),
            ])

        case "getUtxos":
            let balance = try await wallet.balance()
            let addressUtxos = try await chain.utxos(address: balance.address)
            return .object([
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

        case "history":
            return try encode(try await wallet.history())

        case "policyPending":
            return try encode(try await wallet.policyPending())

        case "policyList":
            return try encode(try await wallet.policyList())

        case "send":
            guard let to = params["to"]?.stringValue, let sats = params["sats"]?.intValue else {
                throw WalletError(code: "BAD_PARAM", message: "to and sats are required")
            }
            let sent = try await wallet.appSpend(
                origin: origin,
                payments: [LocalWalletBackend.AppPayment(to: to, sats: sats)],
                label: "send \(sats) sats"
            )
            return .object(["txid": .string(sent.txid), "fee": .int(sent.fee)])

        default:
            throw WalletError(
                code: "NOT_ALLOWED",
                message: "\(method) is not available to an on-device app"
            )
        }
    }

    private func encode(_ value: some Encodable) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    private func stringify(_ value: JSONValue) throws -> String {
        guard let json = String(data: try JSONEncoder().encode(value), encoding: .utf8) else {
            throw WalletError(code: "BRIDGE", message: "could not encode the reply")
        }
        return json
    }
}
