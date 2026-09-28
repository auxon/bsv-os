import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resetTrustCache,
  setTrustIdentityProvider,
  trustAdjustedThresholds,
  trustCanonical,
  trustState,
  trustSubject,
  trustTermsForPolicy,
  verifyTrustSignature,
} from "../src/trust.ts";

// The vector was produced by the Trust repo's OWN signer (~/trust
// src/core.ts signProfile) with a throwaway P-256 key, so this verifies the
// bsvOS implementation against the real one, offline.
const fixture = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "trust-vector.json"), "utf8"),
);
const { issuer, signed } = fixture;
const subject = signed.profile.sub;
const beforeExpiry = Date.parse(signed.profile.issuedAt) + 1000;

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (async () => fn())().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** A stub fetch serving the fixture, counting calls per path. */
function stubFetch(counts = {}) {
  return async (url) => {
    const p = String(url);
    counts[p] = (counts[p] ?? 0) + 1;
    if (p.endsWith("/v1/key")) {
      return { ok: true, status: 200, json: async () => ({ alg: issuer.alg, keyId: issuer.keyId, publicJwk: issuer.publicJwk }) };
    }
    if (p.includes("/v1/profile/")) {
      return { ok: true, status: 200, json: async () => signed };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test("trustCanonical matches the issuer's canonical JSON", () => {
  assert.equal(
    trustCanonical({ b: 1, a: [2, { d: 3, c: 4 }], z: null }),
    '{"a":[2,{"c":4,"d":3}],"b":1,"z":null}',
  );
  // The fixture carries the signer's canonical form of the same profile.
  assert.equal(trustCanonical(signed.profile), fixture.canonical);
});

test("verifyTrustSignature accepts the real signer's profile and rejects tampering", () => {
  assert.deepEqual(verifyTrustSignature(issuer.publicJwk, signed, { subject, now: beforeExpiry }), { valid: true });
  // A single changed field breaks the signature.
  const tampered = { ...signed, profile: { ...signed.profile, level: "elite" } };
  assert.equal(verifyTrustSignature(issuer.publicJwk, tampered, { subject, now: beforeExpiry }).valid, false);
  assert.match(verifyTrustSignature(issuer.publicJwk, tampered, { subject, now: beforeExpiry }).reason, /signature/);
  // Subject binding and expiry are checked before trusting a byte.
  assert.match(
    verifyTrustSignature(issuer.publicJwk, signed, { subject: "key:someone-else", now: beforeExpiry }).reason,
    /subject mismatch/,
  );
  assert.match(
    verifyTrustSignature(issuer.publicJwk, signed, { subject, now: Date.parse(signed.profile.expiresAt) + 1 }).reason,
    /expired/,
  );
  assert.match(
    verifyTrustSignature(issuer.publicJwk, { ...signed, alg: "RS256" }, { subject, now: beforeExpiry }).reason,
    /unsupported alg/,
  );
});

test("trustState fetches, verifies, normalizes terms, and caches", async () => {
  resetTrustCache();
  const counts = {};
  await withEnv({ TRUST_URL: "https://trust.test", TRUST_MODE: "enforce", TRUST_CACHE_MS: undefined }, async () => {
    const first = await trustState({ identityKey: subject.slice(4), fetchFn: stubFetch(counts), now: beforeExpiry });
    assert.equal(first.configured, true);
    assert.equal(first.verified, true);
    assert.equal(first.level, "trusted");
    assert.deepEqual(first.terms, { approvalMultiplier: 3, bondDiscountBps: 10000, discountCeilingBps: 2500 });
    assert.equal(first.error, null);
    // Second call inside the TTL: no network.
    const second = await trustState({ identityKey: subject.slice(4), fetchFn: stubFetch(counts), now: beforeExpiry + 1000 });
    assert.equal(second.verified, true);
    assert.equal(counts["https://trust.test/v1/key"], 1);
    assert.equal(counts["https://trust.test/v1/profile/" + encodeURIComponent(subject)], 1);
    // force bypasses the profile cache (the issuer key stays cached).
    const third = await trustState({ identityKey: subject.slice(4), fetchFn: stubFetch(counts), now: beforeExpiry + 2000, force: true });
    assert.equal(third.verified, true);
    assert.equal(counts["https://trust.test/v1/profile/" + encodeURIComponent(subject)], 2);
    assert.equal(counts["https://trust.test/v1/key"], 1);
  });
});

test("trustState fails closed and does not cache failures", async () => {
  resetTrustCache();
  const counts = {};
  await withEnv({ TRUST_URL: "https://trust.test", TRUST_MODE: "enforce", TRUST_CACHE_MS: undefined }, async () => {
    const down = async () => {
      throw new Error("network down");
    };
    const bad = await trustState({ identityKey: subject.slice(4), fetchFn: down, now: beforeExpiry });
    assert.equal(bad.verified, false);
    assert.match(bad.error, /network down/);
    // A later healthy fetch still works (the failure was not cached).
    const good = await trustState({ identityKey: subject.slice(4), fetchFn: stubFetch(counts), now: beforeExpiry });
    assert.equal(good.verified, true);
  });
  await withEnv({ TRUST_URL: undefined }, async () => {
    const off = await trustState({ identityKey: "03ab", now: beforeExpiry });
    assert.equal(off.configured, false);
    assert.equal(off.verified, false);
    assert.match(off.error, /TRUST_URL/);
  });
});

test("trustTermsForPolicy returns verified terms or null, never throws", async () => {
  const counts = {};
  setTrustIdentityProvider(() => subject.slice(4));
  try {
    await withEnv({ TRUST_URL: "https://trust.test", TRUST_MODE: "enforce", TRUST_CACHE_MS: 60_000 }, async () => {
      const terms = await trustTermsForPolicy({ fetchFn: stubFetch(counts), now: beforeExpiry });
      assert.equal(terms.level, "trusted");
      assert.equal(terms.terms.approvalMultiplier, 3);
      assert.equal(terms.expiresAt, signed.profile.expiresAt);
    });
    // Locked wallet -> no identity -> null (fail closed).
    setTrustIdentityProvider(() => null);
    const locked = await trustTermsForPolicy({ fetchFn: stubFetch(counts), now: beforeExpiry });
    assert.equal(locked, null);
    // TRUST_MODE=off -> null even with an identity.
    setTrustIdentityProvider(() => subject.slice(4));
    await withEnv({ TRUST_URL: "https://trust.test", TRUST_MODE: "off" }, async () => {
      assert.equal(await trustTermsForPolicy({ fetchFn: stubFetch({}), now: beforeExpiry }), null);
    });
  } finally {
    setTrustIdentityProvider(() => null);
  }
});

test("trust widens the Jev band by 5 points per multiplier step, floored", () => {
  const base = { minVerdictProb: 0.7, maxRisk: 0.5, minConfidence: 0.6 };
  assert.deepEqual(trustAdjustedThresholds(base, 1), base);
  assert.deepEqual(trustAdjustedThresholds(base, 2), { minVerdictProb: 0.65, maxRisk: 0.5, minConfidence: 0.55 });
  assert.deepEqual(trustAdjustedThresholds(base, 3), { minVerdictProb: 0.6, maxRisk: 0.5, minConfidence: 0.5 });
  // Floors: never below 0.5 probability / 0.4 confidence, and the risk bar
  // never moves (trust loosens confidence, not what counts as risky).
  assert.deepEqual(trustAdjustedThresholds(base, 4), { minVerdictProb: 0.55, maxRisk: 0.5, minConfidence: 0.45 });
  const floored = trustAdjustedThresholds({ minVerdictProb: 0.55, maxRisk: 0.5, minConfidence: 0.45 }, 4);
  assert.equal(floored.minVerdictProb, 0.5);
  assert.equal(floored.minConfidence, 0.4);
  assert.equal(trustSubject("03AB"), "key:03ab");
});