import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-x402";
// Hermetic: the policy advisor must never reach a real decision endpoint.
delete process.env.OPENROUTER_API_KEY;
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, getStatus, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { sendSats } from "../src/engine.ts";
import { pendingRequests, setPolicy } from "../src/policy.ts";
import {
  attestSpend,
  listReceipts,
  parseRequirement,
  verifyAttestation,
  x402Pay,
} from "../src/x402.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

const QUOTE_B64 = Buffer.from(JSON.stringify({
  x402Version: 2, scheme: "exact", network: "bsv:mainnet", amount: "2",
  payTo: "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4", asset: "native:BSV",
  resource: { url: "https://x.example/r", description: "demo", mimeType: "application/json" },
  extra: { satoshis: "2" },
})).toString("base64");

test("parses the gateway 402 (header first, body fallback)", () => {
  const q = parseRequirement({ "payment-required": QUOTE_B64 }, null, "https://x.example/r");
  assert.equal(q.scheme, "exact");
  assert.equal(q.network, "bsv:mainnet");
  assert.equal(q.amount, 2);
  assert.equal(q.payTo, "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4");
  const fallback = parseRequirement({}, { priceSats: 5, payTo: "1abc", network: "bsv:mainnet" }, "https://x.example/");
  assert.equal(fallback.amount, 5);
  assert.throws(() => parseRequirement({}, null, "https://x.example/"), /BSV requirement/);
  assert.throws(
    () => parseRequirement({ "payment-required": Buffer.from(JSON.stringify({ network: "eip155:1", amount: "1", payTo: "0x0" })).toString("base64") }, null, "u"),
    /BSV requirement/,
  );
  assert.throws(() => parseRequirement({}, { priceSats: 0, payTo: "x", network: "bsv:mainnet" }, "u"), /positive/);
});

function stubGateway(outcomes) {
  // outcomes: { quoteB64, settleOk }
  return async (url, init = {}) => {
    const sig = init.headers?.["PAYMENT-SIGNATURE"] ?? init.headers?.["payment-signature"];
    if (!sig) {
      return new Response(JSON.stringify({ error: "payment_required" }), {
        status: 402,
        headers: { "payment-required": outcomes.quoteB64, "content-type": "application/json" },
      });
    }
    if (outcomes.settleOk === false) {
      return new Response(JSON.stringify({ error: "payment_required" }), {
        status: 402,
        headers: { "payment-required": outcomes.quoteB64, "content-type": "application/json" },
      });
    }
    const proof = JSON.parse(Buffer.from(String(sig), "base64").toString("utf8"));
    assert.equal(proof.network, "bsv:mainnet");
    assert.equal(proof.scheme, "exact");
    assert.equal(proof.encoding, "raw-hex");
    assert.match(proof.txHex, /^[0-9a-f]{200,}$/);
    return new Response(JSON.stringify({ data: "served" }), {
      status: 200,
      headers: {
        "payment-response": Buffer.from(JSON.stringify({ success: true })).toString("base64"),
        "content-type": "application/json",
      },
    });
  };
}

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("full metered loop against a stub gateway", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    chain.credit(selfAddress(), { txid: "a".repeat(64), vout: 0, value: 5_000_000, height: 900 });
    await setPolicy(db, "cli", "allow");

    // free resource: no payment, no receipt
    const free = await x402Pay({
      db, chain, url: "https://x.example/free", origin: "cli",
      fetchFn: async () => new Response(JSON.stringify({ hello: 1 }), { status: 200 }),
    });
    assert.equal(free.paid, false);
    assert.equal(free.status, 200);

    // paid resource: quote -> pay -> proof -> receipt
    const paid = await x402Pay({
      db, chain, url: "https://x.example/r", origin: "cli",
      fetchFn: stubGateway({ quoteB64: QUOTE_B64 }),
    });
    assert.equal(paid.paid, true);
    assert.equal(paid.receipt.amountSats, 2);
    assert.match(paid.receipt.txid, /^[0-9a-f]{64}$/);
    assert.deepEqual(paid.receipt.settled, { success: true });
    const receipts = await listReceipts(db);
    assert.equal(receipts.length, 1);

    // gateway that keeps 402ing surfaces proof rejection (payment left the wallet)
    await assert.rejects(
      x402Pay({ db, chain, url: "https://x.example/r", origin: "cli", fetchFn: stubGateway({ quoteB64: QUOTE_B64, settleOk: false }) }),
      /rejected the payment proof/,
    );

    // POST probe carries the body so body-validating servers can quote
    let probeBody = null;
    const postGateway = stubGateway({ quoteB64: QUOTE_B64 });
    const postPaid = await x402Pay({
      db, chain, url: "https://x.example/metered-post", origin: "cli", method: "POST", body: { subject: "s", body: "b" },
      fetchFn: async (url, init) => {
        if (!(init?.headers?.["PAYMENT-SIGNATURE"] ?? init?.headers?.["payment-signature"])) probeBody = init?.body;
        return postGateway(url, init);
      },
    });
    assert.equal(postPaid.paid, true);
    assert.equal(probeBody, JSON.stringify({ subject: "s", body: "b" }));

    // first spend denied without approval
    await db("policies").where({ origin: "cli" }).delete();
    await assert.rejects(
      x402Pay({ db, chain, url: "https://x.example/r", origin: "cli", fetchFn: stubGateway({ quoteB64: QUOTE_B64 }) }),
      /first-run approval/,
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("sendSats debits the total leaving the wallet", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    chain.credit(selfAddress(), { txid: "b".repeat(64), vout: 0, value: 5_000_000, height: 900 });
    await setPolicy(db, "cli", "allow");
    const { mintAgent, getAgent } = await import("../src/agents.ts");
    await mintAgent(db, { name: "spender", budgetSats: 10_000 });
    const r = await sendSats({
      db, chain, origin: "spender",
      to: "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4", sats: 1000,
    });
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    const agent = await getAgent(db, "spender");
    assert.equal(agent.spent_total, 1000 + r.fee);
    await assert.rejects(
      sendSats({ db, chain, origin: "cli", to: "nope", sats: 10 }),
      /valid P2PKH/,
    );
    await assert.rejects(
      sendSats({ db, chain, origin: "cli", to: "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4", sats: 0 }),
      /positive/,
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("attestations mint and verify; tampering fails", async () => {
  const db = await memdb();
  try {
    await createWallet();
    await db("pending_txs").insert([
      { txid: "a".repeat(64), label: "x", status: "mined", attempts: 1, last_check: 1, created_at: Date.now() },
      { txid: "b".repeat(64), label: "y", status: "seen", attempts: 0, last_check: 0, created_at: Date.now() },
    ]);
    const s = await getStatus();
    const a = await attestSpend(db, s.identityKey, { days: 30 });
    assert.equal(a.statement.txCount, 2);
    assert.equal(a.statement.version, 1);
    assert.equal(verifyAttestation({ statement: a.statement, keyId: a.keyId, signature: a.signature }).valid, true);
    const tampered = { ...a.statement, txCount: 999 };
    assert.equal(verifyAttestation({ statement: tampered, keyId: a.keyId, signature: a.signature }).valid, false);
    assert.equal(verifyAttestation({ statement: a.statement, keyId: "deadbeef", signature: a.signature }).valid, false);
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("x402 quote screening: quote details reach the decision and a deny blocks payment", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    chain.credit(selfAddress(), { txid: "c".repeat(64), vout: 0, value: 5_000_000, height: 900 });
    await setPolicy(db, "cli", "ask");
    let state = null;
    let questions = null;
    const jev = async (s, q) => {
      state = s;
      questions = q;
      return {
        model: "fake",
        answers: {
          verdict: { type: "choice", choice: "deny", probabilities: { allow: 0.02, ask: 0.08, deny: 0.9 }, confidence: 0.9 },
          risk: { type: "score", score: 1.8, legend: { 0: "routine", 1: "unverified", 2: "harmful" }, probabilities: { 2: 0.9 }, confidence: 0.9 },
        },
        elapsedMs: 1,
      };
    };
    await assert.rejects(
      x402Pay({ db, chain, url: "https://x.example/r", origin: "cli", fetchFn: stubGateway({ quoteB64: QUOTE_B64 }), jev }),
      /first-run approval required/,
    );
    assert.equal(state.kind, "x402");
    assert.equal(state.host, "x.example");
    assert.equal(state.pay_to, "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4");
    assert.equal(state.resource_url, "https://x.example/r");
    assert.equal(state.description, "demo");
    assert.ok(state.amount_sats >= 2); // quote + fee, the total leaving the wallet
    assert.match(questions.verdict.instructions, /pay-per-call/);
    const rows = await pendingRequests(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].jev_verdict, "deny");
    assert.equal(rows[0].jev_risk_level, "harmful");
    assert.equal((await listReceipts(db)).length, 0); // nothing paid
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
