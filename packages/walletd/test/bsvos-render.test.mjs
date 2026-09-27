import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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
  const { inscribe } = await import(new URL("views/inscribe.js", appDir).href);
  return [...wallet.default, ...money.default, inscribe, ...social.default, ...apps.default, ...work.default];
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
    inscribe: {
      picked: { name: "cat.png", size: 4096, contentType: "image/png", sha256: "ab".repeat(32), hex: "89504e47", previewUrl: "blob:x", tooBig: false },
      recent: [{ contentType: "image/png", contentLength: 2048, outpoint: "aa:0", contentUrl: "https://ordinals.com/x" }],
      balance: 500000,
    },
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
  // 27 of these mirror a Quickshell panel section; the rest are additions the
  // panel never had (inscribe, market). The panel-parity list lives in
  // bsvos-app.test.mjs and is a subset check.
  assert.equal(seen.size, 28, "28 views: 27 panel sections plus inscribe");
});

test("the inscribe view never sends a file path, only hex", async () => {
  const views = await loadViews();
  const view = views.find((v) => v.id === "inscribe");
  assert.ok(view, "inscribe view exists");
  const src = fs.readFileSync(new URL("views/inscribe.js", appDir), "utf8");
  // ordInscribe takes dataHex + contentType; a path would be un-sendable from
  // a browser and would leak the filesystem layout.
  assert.ok(/rpc\("ordInscribe", \{/.test(src), "uses ordInscribe");
  assert.ok(/dataHex: picked\.hex/.test(src), "sends hex");
  assert.ok(/contentType: picked\.contentType/.test(src), "sends a content type");
  assert.ok(!/path:/.test(src), "never sends a path");
  // The daemon enforces 256 KiB; the UI must not pretend otherwise.
  assert.ok(/256 \* 1024/.test(src), "mirrors MAX_INSCRIPTION_BYTES");
  assert.ok(/tooBig/.test(src), "oversized files are refused client-side");
  // Irreversible and public, so it is confirmed, and warned about.
  assert.ok(/confirmDialog\(\s*"Inscribe on chain"/.test(src), "spend is confirmed");
  assert.ok(/permanent and public/i.test(src), "warns it is permanent and public");
  const base = { params: {}, go() {}, toast() {}, fail() {}, run: (f) => f(), reload: async () => {}, openExternal() {}, openExplorer() {} };
  const empty = view.render({ ...base, data: {} });
  assert.ok(/not reversible|permanent/i.test(empty), "empty state warns too");

  // Fee must scale with the file. A flat "about 10 sats" estimate was a real
  // bug: the daemon prices at 1 sat/byte, so a 256 KiB file really costs
  // ~263,510 sats. Under-promising here would burn someone's balance.
  assert.ok(/1 sat per byte/.test(src), "explains the 1 sat/byte pricing");
  const small = view.render({ ...base, data: { balance: 500000, picked: { name: "a.png", size: 4096, contentType: "image/png", sha256: "ab", hex: "89", tooBig: false } } });
  const large = view.render({ ...base, data: { balance: 500000, picked: { name: "b.png", size: 200000, contentType: "image/png", sha256: "ab", hex: "89", tooBig: false } } });
  const feeOf = (html) => Number(/~([\d,]+) sats/.exec(html)?.[1]?.replace(/,/g, "") ?? 0);
  assert.ok(feeOf(large) > feeOf(small) * 10, "a 50x bigger file must cost far more, not a flat fee");
  assert.ok(feeOf(small) > 0 && feeOf(large) > 150000, "large-file estimate is in the right order of magnitude");
  // Fitted to two live daemon measurements: 8 B -> 275 sats, 256 KiB -> 263,510.
  // A flat +2000 was 7x too high for a small file; assert the fit at both ends.
  const tiny = view.render({ ...base, data: { balance: 500000, picked: { name: "t.png", size: 8, contentType: "image/png", sha256: "ab", hex: "89", tooBig: false } } });
  const max = view.render({ ...base, data: { balance: 10_000_000, picked: { name: "m.png", size: 262144, contentType: "image/png", sha256: "ab", hex: "89", tooBig: false } } });
  assert.ok(Math.abs(feeOf(tiny) - 275) / 275 < 0.5, `8 B estimate near the real 275 (got ${feeOf(tiny)})`);
  assert.ok(Math.abs(feeOf(max) - 263510) / 263510 < 0.02, `256 KiB estimate within 2% of the real 263,510 (got ${feeOf(max)})`);

  // Unaffordable files are called out before the user spends anything.
  const broke = view.render({ ...base, data: { balance: 1000, picked: { name: "c.png", size: 200000, contentType: "image/png", sha256: "ab", hex: "89", tooBig: false } } });
  assert.ok(/cannot afford/i.test(broke), "says so when the balance will not cover it");
  assert.ok(/disabled/.test(broke), "the inscribe button is disabled");
  // Too-big is still refused on size regardless of balance.
  const huge = view.render({ ...base, data: { balance: 10_000_000, picked: { name: "d.mp4", size: 300000, contentType: "video/mp4", sha256: "ab", hex: null, tooBig: true } } });
  assert.ok(/Too large/i.test(huge), "size ceiling is enforced");
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
