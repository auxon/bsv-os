import { test } from "node:test";
import assert from "node:assert/strict";

// The shell's views build HTML strings. A parse gate proves the syntax; this
// proves every view actually *renders* against realistic daemon payloads
// without throwing — the failure mode a browser window hides from you.
//
// views/apps.js reads `location.origin` at module scope, so a minimal global
// is installed before the dynamic imports below.

globalThis.location = { origin: "https://127.0.0.1:2121", hash: "#/overview" };

const appDir = new URL("../../runner/apps/bsvos/", import.meta.url);

async function loadViews() {
  const wallet = await import(new URL("views/wallet.js", appDir).href);
  const money = await import(new URL("views/money.js", appDir).href);
  const social = await import(new URL("views/social.js", appDir).href);
  const apps = await import(new URL("views/apps.js", appDir).href);
  const work = await import(new URL("views/work.js", appDir).href);
  return [...wallet.default, ...money.default, ...social.default, ...apps.default, ...work.default];
}

/** A ctx whose data is a realistic (non-empty) daemon payload for that view. */
function fixtures() {
  return {
    overview: {
      auth: { authenticated: true, locked: false, hasWallet: true, identityKey: "03dd" },
      balance: { address: "1EJRqdsscAmiC3TUk1576iN5jsZBuFkKAh", confirmed: 25000, unconfirmed: 0, utxos: 1 },
      qr: { address: "1EJRqdsscAmiC3TUk1576iN5jsZBuFkKAh", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
      pending: [{ txid: "aa".repeat(32), label: "send", status: "seen" }],
      requests: [{ id: 1, origin: "research-agent", action: "anchor", amount_sats: 5000, created_at: Date.now() }],
      history: { summary: { mined: 3, failed: 0, inFlight: 1, pendingRequests: 1, allowedOrigins: 2, deniedOrigins: 1 } },
      doctor: { checks: [{ id: "wallet", status: "ok", detail: "wallet present" }] },
    },
    approvals: {
      requests: [
        { id: 1, origin: "research-agent", action: "anchor", amount_sats: 5000, created_at: Date.now(), jev_verdict: "allow", jev_prob: 0.2, jev_risk_level: "low" },
        { id: 2, origin: "pocketpets.entangleit.com", action: "app-spend", amount_sats: 0, created_at: Date.now() },
      ],
    },
    transactions: {
      history: { transactions: [{ txid: "ab".repeat(32), status: "mined", label: "send", created_at: Date.now() }] },
      pending: [{ txid: "cd".repeat(32), label: "send", status: "seen" }],
    },
    policy: {
      policies: [
        { origin: "research-agent", mode: "allow", cap_sats: 100000 },
        { origin: "evil.example.com", mode: "deny", cap_sats: 0 },
      ],
    },
    agents: {
      agents: [{ name: "research-agent", budgetSats: 100000, remainingSats: 40000, dailySats: 10000, expiresAt: Date.now() + 86400000, active: true }],
    },
    receive: { qr: { address: "1EJRqdsscAmiC3TUk1576iN5jsZBuFkKAh", dataUrl: "data:image/png;base64,iVBORw0KGgo=" } },
    send: { balance: { confirmed: 25000, unconfirmed: 0 } },
    pay: { contacts: [{ name: "alice", identityKey: "02".repeat(33), address: "1abc" }] },
    requests: {
      list: {
        incoming: [{ id: 1, status: "pending", amount: 1000, memo: "lunch", to_name: "alice" }],
        outgoing: [{ id: 2, status: "pending", amount: 2000, memo: "rent", to: { name: "bob" } }],
        sync: {},
      },
      code: { code: "bsvpay1:abc", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
    },
    receipts: {
      receipts: [{ id: "abc", amount: 1000, memo: "lunch" }],
      detail: { payload: { amount: 1000, memo: "lunch", from: "1aaa", to: "1bbb", at: Date.now() }, verified: true, explorer: "https://whatsonchain.com/tx/aa", indexer: "https://ordinals.com/x", outpoint: "aa:0", paymentTxid: "bb" },
    },
    baskets: { baskets: [{ name: "savings", balance: 12000, utxos: 2 }] },
    collectibles: { ordinals: [{ contentType: "image/png", contentLength: 1024, outpoint: "aa:0", contentUrl: "https://ordinals.com/x" }] },
    tokens: { tokens: [{ symbol: "USDX", balance: 500, utxoCount: 1 }] },
    identity: {
      session: { handle: "rah", sub: 42, walletIdentityKey: "03".repeat(33), stale: false },
      twetch: { account: { address: "1twetch", verifiedUserId: 42 } },
      certs: [{ id: "cert1", type: "person", certifier: "alice", verified: true, revoked: false, fields: { name: "Rah" } }],
      identityKey: "03dd801123fa28247581d20e35ff865ab7a886b0af3da9305b5519e655e0797ed4",
      disclosure: { name: "Rah" },
    },
    people: { contacts: [{ name: "alice", identityKey: "02".repeat(33) }], name: "rah" },
    inbox: {
      messages: [{ id: 1, peer: "02".repeat(33), direction: "in", createdAt: Date.now(), acked: false, transport: "p2p" }],
      opened: { id: 1, text: "hello" },
    },
    peers: {
      p2p: {
        enabled: true,
        peers: [{ identityKey: "02".repeat(33), name: "alice", nameVerified: true, payTo: "1peer", address: "127.0.0.1", port: 21213, online: true }],
      },
    },
    compose: { peers: [{ identityKey: "02".repeat(33), name: "alice", online: true }], contacts: [{ name: "bob" }], sent: { transport: "p2p", id: "m1" } },
    apps: {
      installed: [
        { domain: "127.0.0.1", name: "bsvOS", startUrl: "https://127.0.0.1:2121/bsvos/", icon: null, spendCapSats: 0, intents: [] },
        { domain: "localhost", name: "Ordinal Colosseum", startUrl: "https://localhost:2121/colosseum/", icon: null, spendCapSats: 20000, intents: [] },
      ],
      store: [
        { domain: "127.0.0.1", name: "bsvOS", blurb: "shell", devOnly: false, status: "current", installed: true, live: null, changes: [] },
        { domain: "market.entangleit.com", name: "Atomic Market", blurb: "market", devOnly: false, status: "not-installed", live: { spendCapSats: 5000000 }, changes: [] },
        { domain: "twetch.example", name: "Twetch", blurb: "widened", devOnly: false, status: "widened", live: { spendCapSats: 9000 }, changes: [] },
      ],
    },
    market: { market: { domain: "market.entangleit.com" } },
    share: { result: { txid: "ab".repeat(32), filename: "notes.txt", size: 12, explorer: "https://whatsonchain.com/tx/ab" } },
    gigs: {
      board: [{ id: "g1", title: "Index the chain", amountSats: 50000, status: "open" }],
      mine: [{ id: "g1", title: "Index the chain", amountSats: 50000, status: "open", lifecycle: "submitted" }],
    },
    nightshift: {
      orders: [{ id: 1, name: "nightly", agent: "indexer", cycleSats: 10000, status: "active" }],
      runs: [{ id: 7, agent: "indexer", cycleSats: 10000, status: "submitted" }],
    },
    overlays: {
      overlays: [{ name: "topic-1", live: true, latencyMs: 42 }],
      lookup: { topic: "tm_abc_0", what: "unspent", rows: [{ a: 1 }] },
    },
    files: {
      torrents: { enabled: true, port: 6881, torrents: [{ name: "movie", infoHash: "ab".repeat(20) }] },
    },
    faucet: { faucet: { funded: true, amount: 10000, claimed: false } },
    recovery: { recovery: { protected: true, sets: [{ setId: "set1", have: 2, need: 3, guardians: ["alice", "bob"] }] } },
  };
}

test("every shell view renders without throwing on realistic data", async () => {
  const views = await loadViews();
  const data = fixtures();
  const seen = new Set();
  for (const v of views) {
    assert.ok(!seen.has(v.id), `duplicate view id: ${v.id}`);
    seen.add(v.id);
    assert.ok(v.title, `${v.id} has a title`);
    assert.ok(v.group, `${v.id} has a group`);
    assert.equal(typeof v.render, "function", `${v.id} renders`);
    const ctx = { data: data[v.id] ?? {}, params: {}, go() {}, toast() {}, fail() {}, run: (f) => f(), reload: async () => {}, openExternal() {}, openExplorer() {} };
    const html = v.render(ctx);
    assert.equal(typeof html, "string", `${v.id} returns a string`);
    assert.ok(html.length > 0, `${v.id} renders something`);
    // Undefined leaking into the page means a payload field was guessed wrong.
    assert.ok(!html.includes("undefined"), `${v.id} does not render "undefined"`);
    assert.ok(!html.includes("NaN"), `${v.id} does not render NaN`);
  }
  assert.equal(seen.size, 27, "27 views, matching the panel's section count");
});

test("views with no data degrade to empty states, not crashes", async () => {
  const views = await loadViews();
  for (const v of views) {
    const ctx = { data: {}, params: {}, go() {}, toast() {}, fail() {}, run: (f) => f(), reload: async () => {}, openExternal() {}, openExplorer() {} };
    const html = v.render(ctx);
    assert.equal(typeof html, "string", `${v.id} survives empty data`);
    assert.ok(html.length > 0, `${v.id} renders an empty state`);
    assert.ok(!html.includes("undefined"), `${v.id} empty state has no undefined`);
  }
});

test("overview reports the locked and no-wallet states", async () => {
  const views = await loadViews();
  const overview = views.find((v) => v.id === "overview");
  const base = { params: {}, go() {}, toast() {}, fail() {}, run: (f) => f(), reload: async () => {}, openExternal() {}, openExplorer() {} };
  const noWallet = overview.render({ ...base, data: { auth: { hasWallet: false, locked: true } } });
  assert.ok(/No wallet/.test(noWallet), "no-wallet state explains bsv create");
  const locked = overview.render({ ...base, data: fixtures().overview });
  assert.ok(/Unlock/.test(locked) || /locked/i.test(locked), "locked state points at the unlock path");
});
