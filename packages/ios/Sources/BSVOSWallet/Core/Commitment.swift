import Foundation

/// Cadence-based commitments, ported from the daemon's `commitment.ts`.
///
/// A stream pays a fixed rate while fresh liveness proofs arrive; when they
/// stop, payment stops (auto-pause), and a host that was down never backfills.
/// The decision ladder is shared by the stream and cast engines on both
/// hosts, so the vectors pin it once.
public enum Commitment {
    public struct Terms: Codable, Equatable, Sendable {
        public var cadenceSecs: Int
        public var ratePerMin: Int
        public var fixedSats: Int
        public var capSats: Int
        public var paidSats: Int
        public var minPaymentSats: Int
        public var lastPaidAt: Int
        public var nextDueAt: Int

        public init(
            cadenceSecs: Int, ratePerMin: Int, fixedSats: Int, capSats: Int, paidSats: Int,
            minPaymentSats: Int, lastPaidAt: Int, nextDueAt: Int
        ) {
            self.cadenceSecs = cadenceSecs
            self.ratePerMin = ratePerMin
            self.fixedSats = fixedSats
            self.capSats = capSats
            self.paidSats = paidSats
            self.minPaymentSats = minPaymentSats
            self.lastPaidAt = lastPaidAt
            self.nextDueAt = nextDueAt
        }
    }

    public enum Decision: Equatable, Sendable {
        case wait(nextDueAt: Int)
        case exhausted(remaining: Int)
        case stale(graceMs: Int, reason: String)
        case accruing(amount: Int)
        case release(amount: Int, remaining: Int)
    }

    /// Liveness grace: two missed cadences, never less than three minutes.
    public static func graceMsFor(_ cadenceSecs: Int) -> Int {
        max(cadenceSecs * 2 * 1000, 180_000)
    }

    /// Next due time, skipping missed periods. Deliberately never backfills.
    public static func advanceDue(nextDueAt: Int, cadenceSecs: Int, now: Int) -> Int {
        guard cadenceSecs > 0 else { return nextDueAt }
        let periods = Int(floor(Double(now - nextDueAt) / Double(cadenceSecs * 1000))) + 1
        return nextDueAt + periods * cadenceSecs * 1000
    }

    /// Sats accrued since the last payment, clamped to what is left.
    public static func accruedSats(_ terms: Terms, now: Int) -> Int {
        let remaining = max(0, terms.capSats - terms.paidSats)
        let amount: Int
        if terms.ratePerMin > 0 {
            let elapsedMin = Double(max(0, now - terms.lastPaidAt)) / 60_000
            amount = Int(floor(Double(terms.ratePerMin) * elapsedMin))
        } else {
            amount = terms.fixedSats
        }
        return min(amount, remaining)
    }

    /// The decision ladder, in order: not due → nothing left → condition not
    /// met → too small to send (accrue) → release.
    public static func due(
        _ terms: Terms, fresh: Bool, ageMs: Int, reason: String?, now: Int
    ) -> Decision {
        if terms.nextDueAt > now { return .wait(nextDueAt: terms.nextDueAt) }
        let remaining = max(0, terms.capSats - terms.paidSats)
        if remaining < terms.minPaymentSats { return .exhausted(remaining: remaining) }
        if !fresh {
            let graceMs = graceMsFor(terms.cadenceSecs)
            let fallback = "no liveness signal for \(Int((Double(ageMs) / 1000).rounded()))s"
            return .stale(graceMs: graceMs, reason: reason ?? fallback)
        }
        let amount = accruedSats(terms, now: now)
        if amount < terms.minPaymentSats { return .accruing(amount: amount) }
        return .release(amount: amount, remaining: remaining)
    }
}
