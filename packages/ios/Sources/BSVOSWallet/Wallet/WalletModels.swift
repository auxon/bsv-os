import Foundation

// Phase 1 models, derived from the daemon's live responses rather than from
// the docs — the wire keys below were read off `bsv balance`, `bsv history`,
// `bsv policyPending` and friends while a wallet was unlocked.
//
// Note the daemon speaks snake_case in these payloads while the BRC-100 calls
// use camelCase. Both appear in the same client, which is why every model here
// spells out its CodingKeys instead of relying on a global strategy.

public struct BalanceResponse: Codable, Sendable, Equatable {
    public let address: String
    public let confirmed: Int
    public let unconfirmed: Int
    public let utxos: Int

    public init(address: String, confirmed: Int, unconfirmed: Int, utxos: Int) {
        self.address = address
        self.confirmed = confirmed
        self.unconfirmed = unconfirmed
        self.utxos = utxos
    }

    public var total: Int { confirmed + unconfirmed }
}

/// `addressQr` returns a PNG data URL, so the QR is rendered for free rather
/// than generated on the client. `Image` can load it directly.
public struct AddressQrResponse: Codable, Sendable, Equatable {
    public let address: String
    public let dataUrl: String

    public init(address: String, dataUrl: String) {
        self.address = address
        self.dataUrl = dataUrl
    }
}

/// One open spend request — the subject of the approvals screen.
public struct PendingRequest: Codable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let origin: String
    public let amountSats: Int
    public let action: String
    public let createdAt: Int
    /// Jev's advisory verdict, when the advisor is enabled. Advisory only:
    /// nothing spends on it.
    public let jevVerdict: String?
    public let jevProb: Double?
    public let jevRiskLevel: String?
    public let jevConfidence: Double?

    public init(
        id: Int, origin: String, amountSats: Int, action: String, createdAt: Int,
        jevVerdict: String? = nil, jevProb: Double? = nil,
        jevRiskLevel: String? = nil, jevConfidence: Double? = nil
    ) {
        self.id = id
        self.origin = origin
        self.amountSats = amountSats
        self.action = action
        self.createdAt = createdAt
        self.jevVerdict = jevVerdict
        self.jevProb = jevProb
        self.jevRiskLevel = jevRiskLevel
        self.jevConfidence = jevConfidence
    }

    enum CodingKeys: String, CodingKey {
        case id, origin, action
        case amountSats = "amount_sats"
        case createdAt = "created_at"
        case jevVerdict = "jev_verdict"
        case jevProb = "jev_prob"
        case jevRiskLevel = "jev_risk_level"
        case jevConfidence = "jev_confidence"
    }
}

public struct PolicyPendingResponse: Codable, Sendable, Equatable {
    public let requests: [PendingRequest]
    public init(requests: [PendingRequest]) { self.requests = requests }
}

/// One policy row. `mode` is "allow", "deny" or "ask".
public struct PolicyRow: Codable, Sendable, Equatable, Identifiable {
    public let origin: String
    public let mode: String
    public let spendCapSats: Int
    public let updatedAt: Int?

    public var id: String { origin }

    public init(origin: String, mode: String, spendCapSats: Int, updatedAt: Int? = nil) {
        self.origin = origin
        self.mode = mode
        self.spendCapSats = spendCapSats
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case origin, mode
        case spendCapSats = "spend_cap_sats"
        case updatedAt = "updated_at"
    }
}

public struct PolicyListResponse: Codable, Sendable, Equatable {
    public let policies: [PolicyRow]
    public init(policies: [PolicyRow]) { self.policies = policies }
}

/// A ledger row. `status` is one of seen/mined/failed; `hint` is the daemon's
/// plain-language explanation of that status, which is worth showing rather
/// than inventing our own copy.
public struct LedgerTransaction: Codable, Sendable, Equatable, Identifiable {
    public let txid: String
    public let label: String?
    public let status: String
    public let createdAt: Int?
    public let hint: String?

    public var id: String { txid }

    enum CodingKeys: String, CodingKey {
        case txid, label, status, hint
        case createdAt = "created_at"
    }
}

public struct HistorySummary: Codable, Sendable, Equatable {
    public let inFlight: Int
    public let mined: Int
    public let failed: Int
    public let pendingRequests: Int
    public let allowedOrigins: Int
    public let deniedOrigins: Int

    /// Older daemons may omit a field; these defaults keep the UI rendering.
    public init(
        inFlight: Int = 0, mined: Int = 0, failed: Int = 0,
        pendingRequests: Int = 0, allowedOrigins: Int = 0, deniedOrigins: Int = 0
    ) {
        self.inFlight = inFlight
        self.mined = mined
        self.failed = failed
        self.pendingRequests = pendingRequests
        self.allowedOrigins = allowedOrigins
        self.deniedOrigins = deniedOrigins
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inFlight = (try? c.decode(Int.self, forKey: .inFlight)) ?? 0
        mined = (try? c.decode(Int.self, forKey: .mined)) ?? 0
        failed = (try? c.decode(Int.self, forKey: .failed)) ?? 0
        pendingRequests = (try? c.decode(Int.self, forKey: .pendingRequests)) ?? 0
        allowedOrigins = (try? c.decode(Int.self, forKey: .allowedOrigins)) ?? 0
        deniedOrigins = (try? c.decode(Int.self, forKey: .deniedOrigins)) ?? 0
    }
}

public struct HistoryResponse: Codable, Sendable, Equatable {
    public let transactions: [LedgerTransaction]
    public let policies: [PolicyRow]
    public let summary: HistorySummary

    public init(transactions: [LedgerTransaction] = [], policies: [PolicyRow] = [], summary: HistorySummary = HistorySummary()) {
        self.transactions = transactions
        self.policies = policies
        self.summary = summary
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        transactions = (try? c.decode([LedgerTransaction].self, forKey: .transactions)) ?? []
        policies = (try? c.decode([PolicyRow].self, forKey: .policies)) ?? []
        summary = (try? c.decode(HistorySummary.self, forKey: .summary)) ?? HistorySummary()
    }
}

public struct SendResponse: Codable, Sendable, Equatable {
    public let txid: String
    public let fee: Int
    public init(txid: String, fee: Int) {
        self.txid = txid
        self.fee = fee
    }
}

public struct PolicyApproveResponse: Codable, Sendable, Equatable {
    public let origin: String
    public let mode: String
    public init(origin: String, mode: String) {
        self.origin = origin
        self.mode = mode
    }
}
