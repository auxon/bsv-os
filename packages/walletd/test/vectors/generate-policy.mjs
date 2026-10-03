// Policy vectors for the Swift port (S3).
//
// Runs the daemon's own `policy.ts` through a matrix of scenarios and records
// what it decided. The Swift test replays the same steps against its engine and
// must reach the same verdict, reason, pending flag and advisor fields — the
// reason strings included, which is why the Swift engine's approval-hint text
// is injectable (it uses the daemon's CLI wording here, the phone's in the app).
//
// Each scenario gets a fresh in-memory database, exactly as the daemon's own
// tests do. Advisor calls are scripted through the `jev` override: the recorder
// counts whether the decider was consulted, which pins the caching rule (ask
// reuses a stored score; auto always re-scores).
import { writeFileSync } from "node:fs";
import knex from "knex";
import { migrate } from "../../src/storage.ts";
import { check, probe, setPolicy, seedRequest, pendingRequests, listPolicies } from "../../src/policy.ts";

// Pin the defaults: no advisor unless a step scripts one, no trust, and the
// stock auto thresholds.
delete process.env.OPENROUTER_API_KEY;
delete process.env.TRUST_MODE;
for (const key of ["BSV_WALLETD_JEV_AUTO_MIN_PROB", "BSV_WALLETD_JEV_AUTO_MAX_RISK", "BSV_WALLETD_JEV_AUTO_MIN_CONF"]) {
  delete process.env[key];
}

const legend = { 0: "routine", 1: "unverified", 2: "harmful" };

/** A confident, low-risk allow — the shape `auto` is meant to approve. */
const allowAnswers = {
  verdict: { type: "choice", choice: "allow", probabilities: { allow: 0.93, ask: 0.05, deny: 0.02 }, confidence: 0.9 },
  risk: { type: "score", score: 0.1, legend, probabilities: { 0: 0.95 }, confidence: 0.9 },
};

/** A confident deny — the shape `auto` must queue for a human. */
const denyAnswers = {
  verdict: { type: "choice", choice: "deny", probabilities: { allow: 0.02, ask: 0.05, deny: 0.93 }, confidence: 0.9 },
  risk: { type: "score", score: 0.8, legend, probabilities: { 2: 0.9 }, confidence: 0.9 },
};

const jevDecider = (which) => async () => ({
  model: `vector-${which}`,
  answers: which === "allow" ? allowAnswers : denyAnswers,
  elapsedMs: 1,
});

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

const scenarios = [
  {
    name: "an unknown origin asks once, then reuses the stored score",
    steps: [
      { call: "check", origin: "app.example", amountSats: 250, action: "send", jev: "allow" },
      { call: "check", origin: "app.example", amountSats: 250, action: "send", jev: "allow" },
      { call: "pending" },
    ],
  },
  {
    name: "a different action is a different request",
    steps: [
      { call: "check", origin: "two.example", amountSats: 250, action: "send", jev: "allow" },
      { call: "check", origin: "two.example", amountSats: 300, action: "anchor", jev: "allow" },
      { call: "pending" },
    ],
  },
  {
    name: "allow within the cap spends without asking",
    steps: [
      { call: "setPolicy", origin: "allow.example", mode: "allow", capSats: 5000 },
      { call: "check", origin: "allow.example", amountSats: 1000, action: "send", jev: "allow" },
      { call: "pending" },
    ],
  },
  {
    name: "allow over the cap denies flat, before the advisor is consulted",
    steps: [
      { call: "setPolicy", origin: "cap.example", mode: "allow", capSats: 500 },
      { call: "check", origin: "cap.example", amountSats: 501, action: "send", jev: "allow" },
      { call: "pending" },
    ],
  },
  {
    name: "a cap of zero is uncapped",
    steps: [
      { call: "setPolicy", origin: "uncapped.example", mode: "allow", capSats: 0 },
      { call: "check", origin: "uncapped.example", amountSats: 10_000_000, action: "send" },
      { call: "pending" },
    ],
  },
  {
    name: "deny wins over everything, including a confident advisor",
    steps: [
      { call: "setPolicy", origin: "deny.example", mode: "deny" },
      { call: "check", origin: "deny.example", amountSats: 1, action: "send", jev: "allow" },
      { call: "pending" },
    ],
  },
  {
    name: "an ask-mode cap does not bind — caps only gate allow and auto",
    steps: [
      { call: "setPolicy", origin: "askcap.example", mode: "ask", capSats: 100 },
      { call: "check", origin: "askcap.example", amountSats: 500, action: "send", jev: "allow" },
      { call: "pending" },
    ],
  },
  {
    name: "auto approves a confident allow, and re-scores every time",
    steps: [
      { call: "setPolicy", origin: "auto.example", mode: "auto", capSats: 100000 },
      { call: "check", origin: "auto.example", amountSats: 250, action: "send", jev: "allow" },
      { call: "check", origin: "auto.example", amountSats: 250, action: "send", jev: "allow" },
      { call: "pending" },
    ],
  },
  {
    name: "auto queues a risky spend and keeps one request",
    steps: [
      { call: "setPolicy", origin: "risky.example", mode: "auto" },
      { call: "check", origin: "risky.example", amountSats: 250, action: "send", jev: "deny" },
      { call: "check", origin: "risky.example", amountSats: 250, action: "send", jev: "deny" },
      { call: "pending" },
    ],
  },
  {
    name: "auto over the cap denies flat without queuing",
    steps: [
      { call: "setPolicy", origin: "autocap.example", mode: "auto", capSats: 100 },
      { call: "check", origin: "autocap.example", amountSats: 500, action: "send", jev: "allow" },
      { call: "pending" },
    ],
  },
  {
    name: "probe judges in full but records nothing",
    steps: [
      { call: "probe", origin: "probe.example", amountSats: 250, action: "send", jev: "allow" },
      { call: "pending" },
      { call: "policies" },
    ],
  },
  {
    name: "probe in auto mode never queues",
    steps: [
      { call: "setPolicy", origin: "probeauto.example", mode: "auto" },
      { call: "probe", origin: "probeauto.example", amountSats: 250, action: "send", jev: "allow" },
      { call: "pending" },
    ],
  },
  {
    name: "approving clears the queue and leaves a policy row",
    steps: [
      { call: "check", origin: "approve.example", amountSats: 250, action: "send", jev: "allow" },
      { call: "pending" },
      { call: "setPolicy", origin: "approve.example", mode: "allow", capSats: 1000 },
      { call: "pending" },
      { call: "policies" },
    ],
  },
  {
    name: "denying clears the queue too",
    steps: [
      { call: "check", origin: "refuse.example", amountSats: 250, action: "send", jev: "allow" },
      { call: "setPolicy", origin: "refuse.example", mode: "deny" },
      { call: "pending" },
    ],
  },
  {
    name: "a seeded request is scored in place, not duplicated",
    steps: [
      { call: "seedRequest", origin: "seeded.example", amountSats: 250, action: "send" },
      { call: "pending" },
      { call: "check", origin: "seeded.example", amountSats: 250, action: "send", jev: "allow" },
      { call: "pending" },
    ],
  },
  {
    name: "a zero-amount request asks without an advisor call",
    steps: [
      { call: "check", origin: "zero.example", amountSats: 0, action: "send", jev: "allow" },
      { call: "pending" },
    ],
  },
  {
    name: "auto without an advisor fails closed",
    steps: [
      { call: "setPolicy", origin: "nojev.example", mode: "auto" },
      { call: "check", origin: "nojev.example", amountSats: 0, action: "send" },
      { call: "pending" },
    ],
  },
];

async function runScenario(scenario) {
  const db = await memdb();
  const steps = [];
  const scores = {};
  try {
    for (const step of scenario.steps) {
      if (step.call === "setPolicy") {
        await setPolicy(db, step.origin, step.mode, step.capSats ?? 0);
        steps.push({ ...step });
        continue;
      }
      if (step.call === "seedRequest") {
        await seedRequest(db, step.origin, step.amountSats, step.action);
        steps.push({ ...step });
        continue;
      }
      if (step.call === "pending") {
        steps.push({ call: "pending", expect: await pendingRequests(db) });
        continue;
      }
      if (step.call === "policies") {
        steps.push({ call: "policies", expect: await listPolicies(db) });
        continue;
      }
      if (step.call === "check" || step.call === "probe") {
        let calls = 0;
        const decider = step.jev ? jevDecider(step.jev) : undefined;
        const wrapped = decider ? async (...args) => { calls += 1; return decider(...args); } : undefined;
        const result = step.call === "probe"
          ? await probe(db, step.origin, step.amountSats, step.action, {
              trust: null, ...(wrapped ? { jev: wrapped } : {}),
            })
          : await check(db, step.origin, step.amountSats, step.action, {
              trust: null, ...(wrapped ? { jev: wrapped } : {}),
            });
        if (result.jev) {
          const key = `${step.origin}|${step.action}|${step.amountSats}`;
          if (!(key in scores)) scores[key] = result.jev;
        }
        steps.push({
          call: step.call, origin: step.origin, amountSats: step.amountSats, action: step.action,
          scorerCalled: calls > 0, expect: result,
        });
        continue;
      }
      throw new Error(`unknown step ${step.call}`);
    }
  } finally {
    await db.destroy();
  }
  return { name: scenario.name, scores, steps };
}

const out = [];
for (const scenario of scenarios) out.push(await runScenario(scenario));

writeFileSync(
  new URL("./policy-vectors.json", import.meta.url),
  JSON.stringify({ generatedBy: "generate-policy.mjs", scenarios: out }, null, 2) + "\n",
);
console.log(`wrote ${out.length} scenarios, ${out.reduce((a, s) => a + s.steps.length, 0)} steps`);
for (const scenario of out) {
  const checks = scenario.steps.filter((s) => s.expect?.verdict);
  console.log(`  ${scenario.name.slice(0, 58).padEnd(60)} ${checks.map((c) => `${c.expect.verdict}${c.expect.pending ? "/pending" : ""}${c.scorerCalled ? " (jev)" : ""}`).join(", ")}`);
}
