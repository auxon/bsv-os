import Foundation

/// Spending policy, ported from the daemon's `policy.ts`.
///
/// The shapes are BRC-116-shaped on purpose, because apps already speak that
/// shape to the daemon and will speak the same one to a local backend:
///
/// - an origin (an app name, a host) has a mode — `allow`, `deny`, `ask`,
///   `auto` — and a spend cap in sats, 0 meaning uncapped;
/// - `ask` refuses the first spend and records a pending request for the human;
///   approval is `setPolicy(origin, .allow)`, which clears the queue;
/// - `auto` lets a confident advisor verdict spend inside the caps without
///   waking anyone, and fails closed (pending) whenever the advisor is missing
///   or unsure;
/// - `probe` judges a hypothetical spend exactly like a real one but records
///   nothing.
///
/// Two daemon layers are deliberately seams here rather than ports:
///
/// - **Jev** arrives as a `SpendScoring` implementation. With none configured,
///   `auto` behaves as the daemon does with no API key: a pending request.
/// - **Agent sub-wallets** arrive as a `SpendBudgeting` implementation. There
///   are no agent sub-wallets on the phone, so the default is the daemon's
///   answer for an origin that has no budget: unbudgeted, not covered.
///
/// The EntangleIT Trust worker is daemon-side only and is not ported; with no
/// trust profile there is nothing to apply, and every decision is the base
/// decision.
public enum PolicyMode: String, Codable, Sendable, CaseIterable {
    case allow
    case deny
    case ask
    case auto

    /// The daemon defaults to `ask` when no row exists, and treats a mode it
    /// does not recognise the same way rather than failing open.
    public init(stored: String?) {
        self = PolicyMode(rawValue: stored ?? "") ?? .ask
    }
}

public enum PolicyVerdict: String, Codable, Sendable {
    case allow
    case deny
}

/// What the advisor returns: a verdict with probabilities, a risk score and
/// the model that said so. Field-for-field the daemon's `SpendScore`.
public struct SpendScore: Codable, Sendable, Equatable {
    public enum Verdict: String, Codable, Sendable {
        case allow
        case ask
        case deny
    }

    public enum RiskLevel: String, Codable, Sendable {
        case routine
        case unverified
        case harmful

        public init(stored: String?) {
            self = RiskLevel(rawValue: stored ?? "") ?? .routine
        }
    }

    public var verdict: Verdict
    public var verdictProb: Double
    public var risk: Double
    public var riskLevel: RiskLevel
    public var confidence: Double
    public var model: String
    public var cost: Double
    public var elapsedMs: Int

    public init(
        verdict: Verdict, verdictProb: Double, risk: Double, riskLevel: RiskLevel,
        confidence: Double, model: String, cost: Double = 0, elapsedMs: Int = 0
    ) {
        self.verdict = verdict
        self.verdictProb = verdictProb
        self.risk = risk
        self.riskLevel = riskLevel
        self.confidence = confidence
        self.model = model
        self.cost = cost
        self.elapsedMs = elapsedMs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        verdict = Verdict(rawValue: (try? c.decode(String.self, forKey: .verdict)) ?? "") ?? .ask
        verdictProb = (try? c.decode(Double.self, forKey: .verdictProb)) ?? 0
        risk = (try? c.decode(Double.self, forKey: .risk)) ?? 0
        riskLevel = RiskLevel(stored: try? c.decode(String.self, forKey: .riskLevel))
        confidence = (try? c.decode(Double.self, forKey: .confidence)) ?? 0
        model = (try? c.decode(String.self, forKey: .model)) ?? "cached"
        cost = (try? c.decode(Double.self, forKey: .cost)) ?? 0
        elapsedMs = (try? c.decode(Int.self, forKey: .elapsedMs)) ?? 0
    }
}

/// The daemon's `describeScore`, character for character — the string is what
/// ends up in request reasons and in app-visible errors.
public func describeScore(_ score: SpendScore) -> String {
    func f(_ value: Double) -> String { String(format: "%.2f", value) }
    return "Jev \(score.verdict.rawValue) p=\(f(score.verdictProb)) "
        + "risk=\(f(score.risk)) \(score.riskLevel.rawValue) conf=\(f(score.confidence))"
}

/// Facts about a spend, for the advisor. The daemon spreads caller context
/// over `{origin, action, amountSats}`; the engine does the same.
public struct SpendContext: Codable, Sendable, Equatable {
    public var origin: String
    public var action: String
    public var amountSats: Int
    public var kind: String?
    public var label: String?
    public var to: String?
    public var host: String?
    public var resourceUrl: String?
    public var description: String?

    public init(
        origin: String, action: String, amountSats: Int,
        kind: String? = nil, label: String? = nil, to: String? = nil,
        host: String? = nil, resourceUrl: String? = nil, description: String? = nil
    ) {
        self.origin = origin
        self.action = action
        self.amountSats = amountSats
        self.kind = kind
        self.label = label
        self.to = to
        self.host = host
        self.resourceUrl = resourceUrl
        self.description = description
    }
}

/// One policy decision. The daemon's `PolicyCheck`, plus the fields it carries
/// so callers can show the advisor's reasoning verbatim.
public struct PolicyCheck: Codable, Sendable, Equatable {
    public var verdict: PolicyVerdict
    public var reason: String
    public var pending: Bool
    public var jev: SpendScore?
    public var mode: PolicyMode
    public var capSats: Int
    public var budgetCovered: Bool

    public init(
        verdict: PolicyVerdict, reason: String, pending: Bool, jev: SpendScore?,
        mode: PolicyMode, capSats: Int, budgetCovered: Bool
    ) {
        self.verdict = verdict
        self.reason = reason
        self.pending = pending
        self.jev = jev
        self.mode = mode
        self.capSats = capSats
        self.budgetCovered = budgetCovered
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        verdict = PolicyVerdict(rawValue: try c.decode(String.self, forKey: .verdict)) ?? .deny
        reason = (try? c.decode(String.self, forKey: .reason)) ?? ""
        pending = (try? c.decode(Bool.self, forKey: .pending)) ?? false
        jev = try? c.decodeIfPresent(SpendScore.self, forKey: .jev)
        mode = PolicyMode(rawValue: (try? c.decode(String.self, forKey: .mode)) ?? "") ?? .ask
        capSats = (try? c.decode(Int.self, forKey: .capSats)) ?? 0
        budgetCovered = (try? c.decode(Bool.self, forKey: .budgetCovered)) ?? false
    }
}

/// `auto` thresholds. The daemon reads them from the environment with these
/// defaults; a phone build has no environment to speak of, so they are values.
public struct AutoThresholds: Equatable, Sendable {
    public var minVerdictProb: Double
    public var maxRisk: Double
    public var minConfidence: Double

    public init(minVerdictProb: Double = 0.7, maxRisk: Double = 0.5, minConfidence: Double = 0.6) {
        self.minVerdictProb = minVerdictProb
        self.maxRisk = maxRisk
        self.minConfidence = minConfidence
    }

    public static let `default` = AutoThresholds()
}

/// The daemon's `autoApprove`: an allow verdict, confidently, with low risk.
/// Note it is strict on risk (`<`) and inclusive on the probabilities (`>=`).
public func autoApprove(_ score: SpendScore, _ thresholds: AutoThresholds = .default) -> Bool {
    score.verdict == .allow
        && score.verdictProb >= thresholds.minVerdictProb
        && score.risk < thresholds.maxRisk
        && score.confidence >= thresholds.minConfidence
}

/// The advice line in a pending reason. The daemon tells the human to run the
/// CLI; a phone has no CLI, so the app says where approval happens. Keeping
/// this injectable is what lets the vector test compare reasons with the
/// daemon byte for byte while the app shows phone-appropriate text.
public struct PolicyHints: Sendable {
    public var askApproval: @Sendable (String) -> String
    public var autoApproval: @Sendable (String) -> String

    public init(
        askApproval: @escaping @Sendable (String) -> String,
        autoApproval: @escaping @Sendable (String) -> String
    ) {
        self.askApproval = askApproval
        self.autoApproval = autoApproval
    }

    /// What a person on the phone can actually do.
    public static let iOS = PolicyHints(
        askApproval: { _ in "approve in Policy" },
        autoApproval: { _ in "approve in Policy" }
    )

    /// The daemon's own words, for parity tests only.
    public static let daemonCLI = PolicyHints(
        askApproval: { "approve with: bsv allow \($0)" },
        autoApproval: { "bsv allow \($0)" }
    )
}

// MARK: - the seams

public protocol SpendScoring: Sendable {
    func score(_ context: SpendContext) async throws -> SpendScore
}

public struct BudgetDecision: Equatable, Sendable {
    public var ok: Bool
    public var reason: String
    public var covered: Bool

    public init(ok: Bool = true, reason: String = "", covered: Bool = false) {
        self.ok = ok
        self.reason = reason
        self.covered = covered
    }
}

public protocol SpendBudgeting: Sendable {
    func check(origin: String, amountSats: Int) async throws -> BudgetDecision
}

// MARK: - records and storage

public struct PolicyRowRecord: Codable, Sendable, Equatable, Identifiable {
    public var origin: String
    public var mode: PolicyMode
    public var spendCapSats: Int
    public var updatedAt: Int

    public var id: String { origin }

    public init(origin: String, mode: PolicyMode, spendCapSats: Int, updatedAt: Int) {
        self.origin = origin
        self.mode = mode
        self.spendCapSats = spendCapSats
        self.updatedAt = updatedAt
    }
}

/// One queued approval.
///
/// The daemon stores the advisor's fields in seven columns; a phone stores the
/// same thing as one optional score. The difference is invisible outside the
/// store: `scoreFromRow` rebuilds the score with `cost` and `elapsedMs` zeroed
/// either way, because those belong to the call that produced it, not to the
/// request.
public struct PolicyRequestRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: Int
    public var origin: String
    public var amountSats: Int
    public var action: String
    public var createdAt: Int
    public var score: SpendScore?

    public init(id: Int, origin: String, amountSats: Int, action: String, createdAt: Int, score: SpendScore? = nil) {
        self.id = id
        self.origin = origin
        self.amountSats = amountSats
        self.action = action
        self.createdAt = createdAt
        self.score = score
    }
}

public protocol PolicyStore: Sendable {
    func policy(origin: String) async throws -> PolicyRowRecord?
    func savePolicy(_ row: PolicyRowRecord) async throws
    func request(origin: String, action: String) async throws -> PolicyRequestRecord?
    @discardableResult
    func insertRequest(origin: String, amountSats: Int, action: String, createdAt: Int, score: SpendScore?) async throws -> PolicyRequestRecord
    func updateScore(id: Int, score: SpendScore) async throws
    /// Newest first, the daemon's `ORDER BY created_at DESC LIMIT 100`.
    func pendingRequests(limit: Int) async throws -> [PolicyRequestRecord]
    func deleteRequests(origin: String) async throws
    /// The daemon's `ORDER BY origin`.
    func allPolicies() async throws -> [PolicyRowRecord]
}

// MARK: - the engine

public struct PolicyEngine: Sendable {
    private let store: any PolicyStore
    private let scorer: (any SpendScoring)?
    private let budget: (any SpendBudgeting)?
    private let thresholds: AutoThresholds
    private let hints: PolicyHints
    private let now: @Sendable () -> Int

    public init(
        store: any PolicyStore,
        scorer: (any SpendScoring)? = nil,
        budget: (any SpendBudgeting)? = nil,
        thresholds: AutoThresholds = .default,
        hints: PolicyHints = .iOS,
        now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.store = store
        self.scorer = scorer
        self.budget = budget
        self.thresholds = thresholds
        self.hints = hints
        self.now = now
    }

    public func check(
        origin: String,
        amountSats: Int,
        action: String,
        context: SpendContext? = nil,
        dryRun: Bool = false
    ) async throws -> PolicyCheck {
        let row = try await store.policy(origin: origin)
        let mode = row?.mode ?? .ask
        let capSats = row?.spendCapSats ?? 0

        if mode == .allow || mode == .auto {
            if capSats > 0 && amountSats > capSats {
                return PolicyCheck(
                    verdict: .deny, reason: "over spend cap (\(capSats) sats)", pending: false,
                    jev: nil, mode: mode, capSats: capSats, budgetCovered: false
                )
            }
        } else if mode == .deny {
            return PolicyCheck(
                verdict: .deny, reason: "denied by policy", pending: false,
                jev: nil, mode: mode, capSats: capSats, budgetCovered: false
            )
        }

        // Sub-wallet budgets bind allow-mode survivors and ask-mode origins
        // alike; a spend covered by a live budget is approved even in ask mode.
        // With no budget implementation this is the daemon's answer for an
        // origin with no sub-wallet: ok, not covered.
        let purse = try await (budget?.check(origin: origin, amountSats: amountSats)) ?? BudgetDecision()
        if !purse.ok {
            return PolicyCheck(
                verdict: .deny, reason: purse.reason, pending: false,
                jev: nil, mode: mode, capSats: capSats, budgetCovered: false
            )
        }
        if mode == .allow || purse.covered {
            return PolicyCheck(
                verdict: .allow,
                reason: purse.covered ? "allowed by agent budget" : "allowed by policy",
                pending: false, jev: nil, mode: mode, capSats: capSats, budgetCovered: purse.covered
            )
        }

        // ask / auto (and unknown). One advisor call per request — except in
        // auto mode, where the score *is* the decision and is always fresh.
        let seen = try await store.request(origin: origin, action: action)
        let score: SpendScore?
        if mode == .auto || seen?.score == nil {
            score = await maybeScore(origin: origin, amountSats: amountSats, action: action, context: context)
        } else {
            score = scoreForDecision(seen)
        }

        if mode == .auto {
            if let score, autoApprove(score, thresholds) {
                return PolicyCheck(
                    verdict: .allow, reason: "allowed by Jev: \(describeScore(score))", pending: false,
                    jev: score, mode: mode, capSats: capSats, budgetCovered: false
                )
            }
            if !dryRun {
                try await upsertRequest(origin: origin, amountSats: amountSats, action: action, score: score, seen: seen)
            }
            let why = score.map(describeScore) ?? "Jev unavailable (no answer)"
            return PolicyCheck(
                verdict: .deny,
                reason: "\(why) — human approval required: \(hints.autoApproval(origin))",
                pending: true, jev: score, mode: mode, capSats: capSats, budgetCovered: false
            )
        }

        if !dryRun {
            try await upsertRequest(origin: origin, amountSats: amountSats, action: action, score: score, seen: seen)
        }
        let reason: String
        if let score {
            reason = "first-run approval required — \(describeScore(score)); \(hints.askApproval(origin))"
        } else {
            reason = "first-run approval required — \(hints.askApproval(origin))"
        }
        return PolicyCheck(
            verdict: .deny, reason: reason, pending: true,
            jev: score, mode: mode, capSats: capSats, budgetCovered: false
        )
    }

    /// Judge a spend through the full pipeline without writing anything.
    public func probe(
        origin: String,
        amountSats: Int,
        action: String,
        context: SpendContext? = nil
    ) async throws -> PolicyCheck {
        try await check(origin: origin, amountSats: amountSats, action: action, context: context, dryRun: true)
    }

    public func setPolicy(origin: String, mode: PolicyMode, capSats: Int = 0) async throws {
        let cap = max(0, capSats)
        try await store.savePolicy(PolicyRowRecord(origin: origin, mode: mode, spendCapSats: cap, updatedAt: now()))
        // Any non-ask mode answers the queue: allow/auto approve it, deny
        // refuses it. A pending request is only meaningful while the mode is ask.
        if mode != .ask {
            try await store.deleteRequests(origin: origin)
        }
    }

    /// Record a pending request without judging it. The daemon seeds requests
    /// this way for spends it learns about out-of-band (an oracle, a watcher);
    /// kept for parity and used by the local backend's import path.
    public func seedRequest(origin: String, amountSats: Int, action: String) async throws {
        if try await store.request(origin: origin, action: action) == nil {
            try await store.insertRequest(
                origin: origin, amountSats: amountSats, action: action, createdAt: now(), score: nil
            )
        }
    }

    public func pendingRequests() async throws -> [PolicyRequestRecord] {
        try await store.pendingRequests(limit: 100)
    }

    public func listPolicies() async throws -> [PolicyRowRecord] {
        try await store.allPolicies()
    }

    // MARK: - internals

    private func maybeScore(
        origin: String,
        amountSats: Int,
        action: String,
        context: SpendContext?
    ) async -> SpendScore? {
        guard amountSats > 0, let scorer else { return nil }
        var ctx = context ?? SpendContext(origin: origin, action: action, amountSats: amountSats)
        // The spread of the real arguments happens last in the daemon, so the
        // caller's context cannot change what is being judged.
        ctx.origin = origin
        ctx.action = action
        ctx.amountSats = amountSats
        do {
            return try await scorer.score(ctx)
        } catch {
            return nil
        }
    }

    /// A stored score as the daemon rebuilds it for a decision: the original
    /// model and numbers, but cost and elapsed time are the decision's, not the
    /// stored call's.
    private func scoreForDecision(_ record: PolicyRequestRecord?) -> SpendScore? {
        guard let stored = record?.score else { return nil }
        var score = stored
        score.cost = 0
        score.elapsedMs = 0
        return score
    }

    private func upsertRequest(
        origin: String,
        amountSats: Int,
        action: String,
        score: SpendScore?,
        seen: PolicyRequestRecord?
    ) async throws {
        if seen == nil {
            try await store.insertRequest(
                origin: origin, amountSats: amountSats, action: action, createdAt: now(), score: score
            )
        } else if let score, let id = seen?.id {
            try await store.updateScore(id: id, score: score)
        }
    }
}
