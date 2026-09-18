import { test } from "node:test";
import assert from "node:assert/strict";

// Hermetic: never let the policy advisor see a real key.
delete process.env.OPENROUTER_API_KEY;

import { autoApprove, decide, scoreSpend, spendQuestions, spendState } from "../src/jev.ts";

function okResponse(answers, model = "typesafe/jev-1.13-20260917") {
  return new Response(JSON.stringify({ model, answers, usage: { input_tokens: 10, output_tokens: 2, cost: 0.00002 } }), {
    status: 200,
  });
}

test("decide posts the decision body and returns typed answers", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    let seen = null;
    const fetchFn = async (url, init) => {
      seen = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
      return okResponse({ q: { type: "noul", noul: 0.9 } });
    };
    const r = await decide("the state", { q: { type: "noul", instructions: "yes?" } }, { fetchFn });
    assert.equal(r.answers.q.noul, 0.9);
    assert.equal(r.usage.cost, 0.00002);
    assert.match(seen.url, /\/decisions$/);
    assert.equal(seen.auth, "Bearer test-key");
    assert.equal(seen.body.state, "the state");
    assert.equal(seen.body.model, "typesafe/jev-1.13");
    assert.equal(seen.body.questions.q.type, "noul");
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

test("decide validates questions before spending a call", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    let fetched = false;
    const fetchFn = async () => {
      fetched = true;
      return okResponse({});
    };
    await assert.rejects(
      decide("x", { q: { type: "score", instructions: "rate", criteria: ["one level"] } }, { fetchFn }),
      (e) => e.code === "BAD_PARAM",
    );
    await assert.rejects(
      decide("x", { q: { type: "choice", instructions: "pick" } }, { fetchFn }),
      (e) => e.code === "BAD_PARAM",
    );
    await assert.rejects(decide("x", {}, { fetchFn }), (e) => e.code === "BAD_PARAM");
    assert.equal(fetched, false);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

test("decide retries 429 and succeeds", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.JEV_RETRIES = "1";
  try {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 });
      return okResponse({ q: { type: "noul", noul: 0.5 } });
    };
    const r = await decide("s", { q: { type: "noul", instructions: "x" } }, { fetchFn });
    assert.equal(calls, 2);
    assert.equal(r.answers.q.noul, 0.5);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.JEV_RETRIES;
  }
});

test("decide maps upstream failures to coded errors", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.JEV_RETRIES = "0";
  try {
    await assert.rejects(
      decide("s", { q: { type: "noul", instructions: "x" } }, { fetchFn: async () => new Response("nope", { status: 401 }) }),
      (e) => e.code === "JEV_401",
    );
    await assert.rejects(
      decide("s", { q: { type: "noul", instructions: "x" } }, { fetchFn: async () => new Response("not json", { status: 200 }) }),
      (e) => e.code === "JEV_BAD_RESPONSE",
    );
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.JEV_RETRIES;
  }
});

test("decide without a key fails NO_KEY and never fetches", async () => {
  let fetched = false;
  await assert.rejects(
    decide("s", { q: { type: "noul", instructions: "x" } }, { fetchFn: async () => { fetched = true; return okResponse({}); } }),
    (e) => e.code === "NO_KEY",
  );
  assert.equal(fetched, false);
});

function fakeDecide(answers) {
  return async () => ({ model: "fake", answers, elapsedMs: 7 });
}

test("scoreSpend turns answers into a score; autoApprove gates it", async () => {
  const s = await scoreSpend(
    { origin: "o", action: "send", amountSats: 100, to: "1abc", label: "test" },
    {
      decide: fakeDecide({
        verdict: { type: "choice", choice: "allow", probabilities: { allow: 0.9, ask: 0.08, deny: 0.02 }, confidence: 0.85 },
        risk: { type: "score", score: 0.1, legend: { 0: "routine", 1: "unverified", 2: "harmful" }, probabilities: { 0: 0.9 }, confidence: 0.8 },
      }),
    },
  );
  assert.equal(s.verdict, "allow");
  assert.equal(s.verdictProb, 0.9);
  assert.equal(s.risk, 0.1);
  assert.equal(s.riskLevel, "routine");
  assert.equal(s.confidence, 0.8);
  assert.equal(autoApprove(s), true);
  assert.equal(autoApprove(s, { minVerdictProb: 0.95, maxRisk: 0.5, minConfidence: 0.6 }), false);
  assert.equal(autoApprove({ ...s, risk: 1.2 }), false);
  assert.equal(autoApprove({ ...s, verdict: "ask", verdictProb: 0.6 }), false);
  assert.equal(autoApprove({ ...s, confidence: 0.4 }), false);
});

test("scoreSpend fails on malformed answers", async () => {
  await assert.rejects(
    scoreSpend({ origin: "o", action: "send", amountSats: 1 }, { decide: fakeDecide({}) }),
    (e) => e.code === "JEV_BAD_RESPONSE",
  );
  await assert.rejects(
    scoreSpend(
      { origin: "o", action: "send", amountSats: 1 },
      { decide: fakeDecide({ verdict: { type: "choice", choice: "allow" } }) },
    ),
    (e) => e.code === "JEV_BAD_RESPONSE",
  );
});

test("x402 context shapes the decision state and criteria", () => {
  const state = spendState({
    origin: "agent:x", action: "send", amountSats: 5, kind: "x402",
    host: "api.example", resourceUrl: "https://api.example/r", description: "weather", to: "1abc",
  });
  assert.equal(state.kind, "x402");
  assert.equal(state.host, "api.example");
  assert.equal(state.pay_to, "1abc");
  const q = spendQuestions({ origin: "agent:x", action: "send", amountSats: 5, kind: "x402" });
  assert.match(q.verdict.instructions, /pay-per-call/);
  assert.equal(q.risk.criteria.length, 3);
});
