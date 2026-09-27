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
  const twetch = await import(new URL("views/twetch.js", appDir).href);
  return [...wallet.default, ...money.default, inscribe, ...social.default, ...twetch.default, ...apps.default, ...work.default];
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
    "twetch-feed": {
      identity: { sub: "32324", handle: "Richard A. Hein", name: "Richard A. Hein", stale: false },
      account: { imported: true, address: "1FgiUa9oMqcEsHyPD6i3yLTu2qq9BzdxR7" },
      feed: [
        { id: 7271976, txid: "ab".repeat(32), userId: 7346, content: "hello world", contentType: "text/plain", postedAtMs: 1790505410321, numLikes: 2, numReplies: 1, numBranches: 0, user: { id: 7346, name: "Satan", icon: "75ebb02c5338f89bba48629ceb82bad31693fac9e032c1df7a1f6674c6cd4057.webp", isTwetchGreen: true } },
        { id: 7271958, txid: "cd".repeat(32), userId: 9, content: "https://twetch.com/t/895343e634bc31bd659339816c7ceb7d8530278237451892d9084cbfbbe14d70", contentType: "text/plain", postedAtMs: 1790505400000, replyPostId: 7271957, user: { id: 9, name: "branchy" } },
      ],
    },
    "twetch-alerts": {
      identity: { sub: "32324", handle: "rh", stale: true },
      notifications: [{ id: 7271883, type: "like", actorUserId: 218281, postId: 7271235, description: "liked your post", createdAtMs: 1790499264089, actor: { id: 218281, name: "Koala Bear" } }],
      postNotifications: [{ id: 7271900, txid: "ef".repeat(32), userId: 1, content: "nice one", postedAtMs: 1790500000000, numLikes: 0, numReplies: 0, numBranches: 0, user: { id: 1, name: "someone" } }],
    },
    "twetch-profile": {
      identity: { sub: "32324", handle: "rh", stale: false },
      profile: { user: { id: 32324, name: "Richard A. Hein", handle: "rh", numFollowers: 12, numFollowing: 30, profile: "https://twetch.com/u/32324" }, posts: [{ id: 1, txid: "aa".repeat(32), userId: 32324, content: "hi", postedAtMs: 1790500000000, numLikes: 0, numReplies: 0, numBranches: 0, user: { id: 32324, name: "Richard A. Hein" } }] },
    },
    "twetch-memes": {
      folders: [{ slug: "laugh", label: "Laugh", count: 467 }, { slug: "wow", label: "Wow", count: 469 }],
      memes: [{ url: "aa".repeat(32) }, { url: "bb".repeat(32) }],
      folder: "laugh",
    },
    "twetch-market": {
      marketView: "listings",
      items: [{ id: 7271893, name: "Egg #441", number: 441, imageUrl: "https://api.twetch.com/v1/media/801ea7eb.jpg?v=4", priceSats: 480000000, outpoint: "cf5f4aef:845", sellerAddress: "142SdkqtZqqJ" }],
    },
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
  // panel never had (inscribe, market, and the five Twetch views). The
  // panel-parity list lives in bsvos-app.test.mjs and is a subset check.
  assert.equal(seen.size, 33, "33 views: 27 panel sections plus inscribe, market and 5 Twetch views");
});

test("twetch market only offers Buy when swapBuyFor would accept it", async () => {
  // swapBuyFor validates /^([0-9a-f]{64})[._](\d+)$/ and requires priceSats
  // and sellerAddress, but the market returns "txid:vout" with a colon. Passing
  // the raw value dies on BAD_PARAM, so the view must normalise and gate.
  const views = await loadViews();
  const market = views.find((v) => v.id === "twetch-market");
  const src = fs.readFileSync(new URL("views/twetch.js", appDir), "utf8");
  assert.ok(/replace\(":", "\."\)/.test(src), "outpoint separator is normalised");
  assert.ok(/priceSats: price/.test(src), "priceSats is sent");
  assert.ok(/sellerAddress: b\.dataset\.seller/.test(src), "sellerAddress is sent");
  const ctx = { data: {}, params: {}, go() {}, toast() {}, fail() {}, run: (f) => f(), reload: async () => {}, openExternal() {}, openExplorer() {} };
  const good = market.render({ ...ctx, data: { marketView: "listings", items: [{ id: 1, name: "Egg", imageUrl: "https://x/y.jpg", priceSats: 480000000, outpoint: `${"ab".repeat(32)}:845`, sellerAddress: "142SdkqtZqqJ" }] } });
  assert.ok(/data-buy="ab{32}\.845"/.test(good) || /data-buy="[a-f0-9]{64}\.\d+"/.test(good), "buyable listing gets a normalised Buy button");
  // Missing a price or seller means the buy would be rejected, so do not offer it.
  const bad = market.render({ ...ctx, data: { marketView: "listings", items: [{ id: 2, name: "NoSeller", priceSats: 100, outpoint: `${"cd".repeat(32)}:1` }] } });
  assert.ok(/not buyable/.test(bad), "a listing that cannot be bought is not offered as buyable");
  assert.ok(!/data-buy=/.test(bad), "no Buy button for an unbuyable listing");
});

test("twetch views degrade correctly when signed out", async () => {
  // Every Twetch view must offer a way in rather than an error. This was the
  // state this machine was actually in: identity present but stale.
  const views = await loadViews();
  const twetchish = views.filter((v) => v.group === "Twetch");
  assert.equal(twetchish.length, 5, "five Twetch views");
  const ctx = { data: {}, params: {}, go() {}, toast() {}, fail() {}, run: (f) => f(), reload: async () => {}, openExternal() {}, openExplorer() {} };
  for (const v of twetchish) {
    const html = v.render({ ...ctx, data: { identity: null } });
    assert.ok(html.length > 0, `${v.id} renders when signed out`);
    assert.ok(!html.includes("undefined"), `${v.id} signed-out has no undefined`);
    assert.ok(!html.includes("NaN"), `${v.id} signed-out has no NaN`);
  }
  // A stale session is the common case (public clients get no refresh token)
  // and must be called out, since posting silently fails without it.
  const feed = views.find((v) => v.id === "twetch-feed");
  const stale = feed.render({ ...ctx, data: { identity: { sub: "1", stale: true }, account: { address: "1abc" }, feed: [] } });
  assert.ok(/expired/i.test(stale), "a stale session is surfaced");
  assert.ok(/disabled/.test(stale), "posting is disabled while stale");
});

test("a feed post that is only a permalink renders as a link, not bare text", async () => {
  // Live feed data includes branch/reply stubs whose content is just a
  // twetch.com permalink. Dumping that as prose looks broken.
  const views = await loadViews();
  const feed = views.find((v) => v.id === "twetch-feed");
  const ctx = { data: {}, params: {}, go() {}, toast() {}, fail() {}, run: (f) => f(), reload: async () => {}, openExternal() {}, openExplorer() {} };
  const data = JSON.parse(JSON.stringify({
    identity: { sub: "32324", stale: false },
    account: { address: "1abc" },
    feed: [{ id: 1, txid: "aa".repeat(32), userId: 2, content: "https://twetch.com/t/895343e634bc31bd659339816c7ceb7d8530278237451892d9084cbfbbe14d70", replyPostId: 7, postedAtMs: 1790500000000, numLikes: 0, numReplies: 0, numBranches: 0, user: { id: 2, name: "x" } }],
  }));
  const html = feed.render({ ...ctx, data });
  assert.ok(/post-link/.test(html), "renders as a link");
  assert.ok(!/>https:\/\/twetch\.com\/t\//.test(html.replace(/href="[^"]*"/g, "")), "the bare URL is not shown as body text");
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
