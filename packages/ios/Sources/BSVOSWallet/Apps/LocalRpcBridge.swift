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
///
/// The desktop shell calls ~100 methods. The ones a standalone phone can
/// answer truthfully are here; the rest fail with a message that says why,
/// so the shell renders a hint instead of a mystery. Three in particular stay
/// off the page on purpose: the session lock (the app owns it), the key
/// sweep (terminal-only by design), and app management (the bsvOS Apps tab
/// owns the registry on this device).
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
        case "getStatus", "isAuthenticated":
            let status = try await wallet.isAuthenticated()
            return .object([
                "authenticated": .bool(!status.locked),
                "locked": .bool(status.locked),
                "hasWallet": .bool(status.hasWallet),
            ])

        case "getBalance", "balance":
            return try await balanceValue()

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

        case "addressQr":
            let qr = try await wallet.addressQr()
            return .object(["address": .string(qr.address), "dataUrl": .string(qr.dataUrl)])

        case "history":
            let history = try await wallet.history()
            return .object([
                // The shell reads the daemon's snake_case wire shape; the
                // phone's ledger rows are mapped onto it here.
                "transactions": .array(history.transactions.map { row in
                    .object([
                        "txid": .string(row.txid),
                        "label": row.label.map(JSONValue.string) ?? .null,
                        "status": .string(row.status),
                        "attempts": .int(0),
                        "last_check": row.createdAt.map(JSONValue.int) ?? .null,
                        "created_at": row.createdAt.map(JSONValue.int) ?? .null,
                        "detail": row.hint.map(JSONValue.string) ?? .null,
                        "hint": row.hint.map(JSONValue.string) ?? .null,
                    ])
                }),
                "requests": .array([]),
                "policies": .array(history.policies.map { policy in
                    .object([
                        "origin": .string(policy.origin),
                        "mode": .string(policy.mode),
                        "spend_cap_sats": .int(policy.spendCapSats),
                        "updated_at": policy.updatedAt.map(JSONValue.int) ?? .null,
                    ])
                }),
                "agents": .array([]),
                "disclosures": .array([]),
                "baskets": .array([]),
                "receipts": .array([]),
                "summary": try encode(history.summary),
            ])

        case "pending":
            let history = try await wallet.history()
            let tracked = history.transactions
                .filter { $0.status == "seen" }
                .map { row in
                    JSONValue.object([
                        "txid": .string(row.txid),
                        "label": row.label.map(JSONValue.string) ?? .null,
                        "status": .string(row.status),
                        "attempts": .int(0),
                        "last_check": row.createdAt.map(JSONValue.int) ?? .null,
                        "detail": row.hint.map(JSONValue.string) ?? .null,
                    ])
                }
            return .object(["tracked": .array(tracked)])

        case "policyPending":
            return try encode(try await wallet.policyPending())

        case "policyList":
            return try encode(try await wallet.policyList())

        case "policyApprove":
            guard let origin = params["origin"]?.stringValue, !origin.isEmpty else {
                throw WalletError(code: "BAD_PARAM", message: "origin required")
            }
            var auto = false
            if case .bool(let value) = params["auto"] ?? .null { auto = value }
            let approved = try await wallet.policyApprove(
                origin: origin,
                capSats: params["capSats"]?.intValue ?? 0,
                auto: auto
            )
            return try encode(approved)

        case "policyDeny":
            guard let origin = params["origin"]?.stringValue, !origin.isEmpty else {
                throw WalletError(code: "BAD_PARAM", message: "origin required")
            }
            return try encode(try await wallet.policyDeny(origin: origin))

        case "ordList":
            return try await ordinalsValue()

        case "bsv21List":
            let positions = try await wallet.tokenPositions(address: params["address"]?.stringValue)
            return .object(["tokens": try encode(positions)])

        case "getVersion":
            // The daemon reports its own version; a phone carries the same
            // wallet with a marker so a page can tell the two hosts apart.
            return .object([
                "version": .string("0.1.0"),
                "brc100": .bool(true),
                "standalone": .bool(true),
            ])

        case "doctor":
            return try await doctorValue()

        case "send":
            guard let to = params["to"]?.stringValue, !to.isEmpty,
                  let sats = params["sats"]?.intValue, sats > 0 else {
                throw WalletError(code: "BAD_PARAM", message: "to and a positive sats amount are required")
            }
            let requestedLabel = params["label"]?.stringValue
            let label = (requestedLabel?.isEmpty == false ? requestedLabel : nil) ?? "send \(sats) sats"
            let sent = try await wallet.appSpend(
                origin: origin,
                payments: [LocalWalletBackend.AppPayment(to: to, sats: sats)],
                label: label
            )
            return .object(["txid": .string(sent.txid), "fee": .int(sent.fee)])

        case "unlock", "lock":
            throw WalletError(
                code: "NOT_ALLOWED",
                message: "the session lock is controlled by the bsvOS app on this device, not by a page"
            )

        case "sweepOut":
            throw WalletError(
                code: "NOT_ALLOWED",
                message: "sweeping is terminal-only by design and never runs from a page"
            )

        case "appList", "appInstall", "appUpdate", "appRemove", "appLaunch", "appOpen", "storeList":
            throw WalletError(
                code: "NOT_ALLOWED",
                message: "use the Apps tab in bsvOS to manage apps on this device"
            )

        default:
            throw WalletError(
                code: "NOT_ALLOWED",
                message: "\(method) is not available to an on-device app"
            )
        }
    }

    // MARK: - composed reads

    private func balanceValue() async throws -> JSONValue {
        let balance = try await wallet.balance()
        return .object([
            "address": .string(balance.address),
            "confirmed": .int(balance.confirmed),
            "unconfirmed": .int(balance.unconfirmed),
            "utxos": .int(balance.utxos),
        ])
    }

    /// 1-sat carriers whose script carries an envelope, plus those whose
    /// envelope has moved on and only ORDFS can identify. The phone has no
    /// gallery index, so this is a chain scan with the same two-layer rule
    /// the lock paths use.
    private func ordinalsValue() async throws -> JSONValue {
        let balance = try await wallet.balance()
        let addressUtxos = try await chain.utxos(address: balance.address)
        var ordinals: [JSONValue] = []
        for utxo in addressUtxos.utxos where utxo.value == 1 {
            guard let parent = try? await chain.tx(txid: utxo.txid),
                  utxo.vout >= 0, utxo.vout < parent.vout.count,
                  let scriptHex = parent.vout[utxo.vout].scriptHex else { continue }
            let outpoint = "\(utxo.txid)_\(utxo.vout)"
            if let envelope = Inscription.envelopeMetadata(scriptHex) {
                ordinals.append(ordinalRow(
                    outpoint: outpoint,
                    contentType: envelope.contentType,
                    contentLength: envelope.contentLength
                ))
            } else if let meta = await wallet.inscriptionMetadata(txid: utxo.txid, vout: utxo.vout) {
                ordinals.append(ordinalRow(
                    outpoint: outpoint,
                    contentType: meta.contentType,
                    contentLength: meta.contentLength ?? 0
                ))
            }
        }
        return .object(["ordinals": .array(ordinals)])
    }

    private func ordinalRow(outpoint: String, contentType: String, contentLength: Int) -> JSONValue {
        .object([
            "outpoint": .string(outpoint),
            "contentType": .string(contentType),
            "contentLength": .int(contentLength),
            "contentUrl": .string("https://api.1sat.app/content/\(outpoint)"),
        ])
    }

    /// The daemon's `doctor` checks, reduced to the ones a phone can answer:
    /// the wallet, the caps, and the queue of requests waiting on a human.
    /// Chain and Jev checks belong to the daemon and are simply absent.
    private func doctorValue() async throws -> JSONValue {
        let status = try await wallet.isAuthenticated()
        let policies = try await wallet.policyList()
        let pending = try await wallet.policyPending()

        var checks: [JSONValue] = []
        if !status.hasWallet {
            checks.append(check("wallet", "fail", "no wallet on this device yet"))
        } else if status.locked {
            checks.append(check("wallet", "warn", "wallet locked — unlock in the bsvOS app before spending"))
        } else {
            checks.append(check("wallet", "ok", "wallet enrolled and unlocked"))
        }

        let uncapped = policies.policies.filter {
            ($0.mode == "allow" || $0.mode == "auto") && $0.spendCapSats == 0 && $0.origin != "cli"
        }
        checks.append(check(
            "caps",
            uncapped.isEmpty ? "ok" : "warn",
            uncapped.isEmpty
                ? "every allow/auto origin has a spend cap"
                : "uncapped allow/auto origins: \(uncapped.map(\.origin).joined(separator: ", "))"
        ))
        checks.append(check(
            "requests",
            pending.requests.isEmpty ? "ok" : "warn",
            pending.requests.isEmpty
                ? "no requests waiting on a human"
                : "\(pending.requests.count) request(s) waiting on a human"
        ))
        return .object(["checks": .array(checks)])
    }

    private func check(_ id: String, _ status: String, _ detail: String) -> JSONValue {
        .object(["id": .string(id), "status": .string(status), "detail": .string(detail)])
    }

    // MARK: - encoding

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
