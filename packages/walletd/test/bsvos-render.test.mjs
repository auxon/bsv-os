import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// The shell's views build HTML strings. A parse gate proves the syntax; this
// proves every view actually *renders* against realistic daemon payloads
// without throwing — the failure mode a browser window hides from you.
//
// views/apps.js reads `location.origin` at module scope, so a minimal global
// is installed before the dynamic imports below.

globalThis.location = { origin: "https://127.0.0.1:2121", hash: "#/overview" };

const appDir = new URL("../../runner/apps/bsvos/", import.meta.url);
/** Read a file from the app bundle. readFileSync will not take a URL object. */
const readApp = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, appDir)), "utf8");

/**
 * The app's REAL view list, imported from the same module app.js uses.
 *
 * This used to rebuild the array here from the individual view modules, which
 * is exactly why the missing-spread bug in app.js slipped through every test:
 * the suite verified the modules were fine and never checked the one line that
 * assembled them. Import views/index.js so a wiring mistake fails here.
 */
async function loadViews() {
  const registry = await import(new URL("views/index.js", appDir).href);
  return registry.VIEWS;
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
      folders: [{ slug: "laugh", label: "Laugh", count: 467 }, { slug: "reaction-memes", label: "Reaction Memes", count: 2880 }],
      items: [
        {
          id: `${"3b".repeat(32)}:b://${"00".repeat(32)}@0`,
          title: "Monkey Looking Awkwardly",
          folder: "Reaction Memes",
          folderSlug: "reaction-memes",
          format: "gif",
          mediaUrl: "https://api.twetch.com/v1/media/0026212e-o0.jpg?v=3",
          previewUrl: "https://api.twetch.com/v1/media/0026212e-o0.jpg?v=3",
          sha256: "3b7cf206d97e75a4a5a7d5ee77f0f93669f29a919c55de51869fba688ab9233d",
          tokenNumber: 7889,
          url: "https://twetch.com/meme-library/meme/3b7cf206/monkey-looking-awkwardly",
        },
        {
          title: "A Clip", folder: "Reaction Memes", folderSlug: "reaction-memes", format: "mp4",
          mediaUrl: "https://api.twetch.com/v1/media/clip-o0.mp4?v=3",
          previewUrl: "https://api.twetch.com/v1/media/clip-o0.jpg?v=3",
          url: "https://twetch.com/meme-library/meme/clip",
        },
      ],
      folder: "laugh",
    },
    "twetch-market": {
      marketView: "listings",
      items: [{ id: 7271893, name: "Egg #441", number: 441, imageUrl: "https://api.twetch.com/v1/media/801ea7eb.jpg?v=4", priceSats: 480000000, outpoint: "cf5f4aef:845", sellerAddress: "142SdkqtZqqJ" }],
    },
    setup: {
      hasWallet: true, locked: false, identityKey: "03dd", name: "rah",
      funded: true, claimed: false, faucetAmount: 25000, appCount: 3,
      oidc: { issuer: "https://id.entangleit.com", clientId: "twetch_abc", redirectPort: 2122 },
    },
    inscribe: {
      picked: { name: "cat.png", size: 4096, contentType: "image/png", sha256: "ab".repeat(32), hex: "89504e47", previewUrl: "blob:x", tooBig: false },
      recent: [{ contentType: "image/png", contentLength: 2048, outpoint: "aa:0", contentUrl: "https://ordinals.com/x" }],
      balance: 500000,
    },
  };
}

test("the view registry is wired correctly, not just the modules", async () => {
  // The bug this guards: one entry in the VIEWS array lost its `...`, so an
  // entire module's array was inserted as ONE view with no id. The nav then
  // rendered an empty row and that module's views never appeared — which is
  // exactly how "I don't see a Twetch group" happened.
  const registry = await import(new URL("views/index.js", appDir).href);
  const { VIEWS, GROUP_ORDER, BY_ID } = registry;

  assert.ok(Array.isArray(VIEWS), "VIEWS is an array");
  const bad = VIEWS.map((v, i) => [i, v]).filter(([, v]) => !v || typeof v.id !== "string" || v.id === "" || typeof v.group !== "string" || v.group === "");
  assert.equal(bad.length, 0, `every entry needs an id and a group; offenders: ${JSON.stringify(bad.map(([i, v]) => [i, v === undefined ? "undefined" : v]))}`);
  for (const v of VIEWS) {
    assert.ok(v.title, `${v.id} has a title`);
    assert.ok(GROUP_ORDER.includes(v.group), `${v.id} group ${v.group} is in GROUP_ORDER`);
  }
  const ids = VIEWS.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  // BY_ID is what the router uses; a missing entry means a dead nav link.
  for (const v of VIEWS) assert.equal(BY_ID.get(v.id), v, `${v.id} is reachable by id`);
  // Named expectations, so dropping a module fails loudly.
  assert.equal(VIEWS.length, 34, "34 views");
  for (const id of ["setup", "inscribe", "twetch-feed", "twetch-alerts", "twetch-profile", "twetch-memes", "twetch-market"]) {
    assert.ok(ids.includes(id), `${id} is registered`);
  }
  assert.equal(VIEWS.filter((v) => v.group === "Twetch").length, 5, "all five Twetch views are in the nav");
  assert.equal(VIEWS[0].id, "setup", "setup is first, so a new machine starts there");
});

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
  assert.equal(seen.size, 34, "34 views: 27 panel sections plus setup, inscribe, market and 5 Twetch views");
});

test("setup never puts a recovery phrase in front of a browser", async () => {
  // createWallet and importWallet are plain RPCs and createWallet RETURNS the
  // 12-word phrase. The wizard must orchestrate that step in the terminal and
  // must not call either from the page, or the phrase lands in a browser.
  const views = await loadViews();
  const view = views.find((v) => v.id === "setup");
  assert.ok(view, "setup view exists");
  const src = readApp("views/setup.js");
  // Match the CALL, not the word: the file's header comment explains exactly
  // why these two are never invoked, and must keep doing so.
  assert.ok(!/rpc\(\s*"(?:create|import)Wallet"/.test(src), "setup never calls createWallet/importWallet");
  assert.ok(/createWallet and importWallet are plain RPCs/.test(src), "the reason is still documented");
  // It must instead hand the command over and offer to re-check.
  assert.ok(/bsv create/.test(src), "names the terminal command");
  assert.ok(/data-copy-cmd/.test(src), "offers to copy the command");
  assert.ok(/data-recheck/.test(src), "polls for completion instead of doing it here");
  // Everything that IS safe must be in-app.
  assert.ok(/rpc\("unlock"/.test(src), "unlock is in-app (keyring, no TTY)");
  assert.ok(/rpc\("profileSet"/.test(src), "naming is in-app");
  assert.ok(/rpc\("faucetClaim"/.test(src), "faucet claim is in-app");
  assert.ok(/confirmDialog\("Claim starter sats"/.test(src), "the claim is confirmed");
});

test("setup shows real progress from daemon state, not a local flag", async () => {
  const views = await loadViews();
  const view = views.find((v) => v.id === "setup");
  const base = { params: {}, go() {}, toast() {}, fail() {}, run: (f) => f(), reload: async () => {}, openExternal() {}, openExplorer() {} };
  const done = view.render({ ...base, data: { hasWallet: true, locked: false, name: "rah", claimed: true, appCount: 3, oidc: { clientId: "x", redirectPort: 2122 } } });
  assert.ok(/6 of 6/.test(done), "a finished machine reads 6 of 6");
  assert.ok(/All set/.test(done), "and says so");
  const fresh = view.render({ ...base, data: { hasWallet: false, locked: true, name: "", claimed: false, appCount: 1, oidc: null } });
  assert.ok(/0 of 6/.test(fresh), "a fresh machine reads 0 of 6");
  assert.ok(/bsv create/.test(fresh), "and points at the terminal");
  assert.ok(!fresh.includes("undefined") && !fresh.includes("NaN"), "no undefined/NaN in either state");
  // A claimed faucet must not offer a second claim.
  const claimed = view.render({ ...base, data: { hasWallet: true, locked: false, name: "x", claimed: true, funded: true, faucetAmount: 25000, appCount: 1, oidc: null } });
  assert.ok(!/Claim 25,000 sats/.test(claimed), "a claimed faucet is not offered again");
  assert.ok(/one-time grant per wallet/.test(claimed), "and says why");
});

test("meme tiles use the media URL, never the twetch.com page URL", async () => {
  // The bug: a meme item's `url` is its twetch.com WEB PAGE. The first version
  // read `m.url` first, and the media resolver passes any https URL straight
  // through, so the browser was handed an HTML page as <img src> and every
  // tile rendered broken. Real payload shape, captured from the live daemon.
  const views = await loadViews();
  const memes = views.find((v) => v.id === "twetch-memes");
  const base = { params: {}, go() {}, toast() {}, fail() {}, run: (f) => f(), reload: async () => {}, openExternal() {}, openExplorer() {} };
  const data = {
    folder: "reaction-memes", q: "", format: "", sort: "", tag: "", nextCursor: null, total: 2880, tags: [],
    folders: [{ slug: "reaction-memes", label: "Reaction Memes", count: 2880 }],
    items: [{
      title: "Monkey", folder: "Reaction Memes", format: "gif",
      mediaUrl: "https://api.twetch.com/v1/media/abc-o0.jpg?v=3",
      previewUrl: "https://api.twetch.com/v1/media/abc-o0.jpg?v=3",
      url: "https://twetch.com/meme-library/meme/3b7cf206/monkey",
    }],
  };
  const html = memes.render({ ...base, data });

  // The image source must be the media host...
  const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length > 0, "a tile rendered an img");
  for (const src of srcs) {
    assert.ok(!/twetch\.com\/meme-library/.test(src), `img src must not be the web page (${src})`);
    assert.ok(/api\.twetch\.com\/v1\/media\//.test(src), `img src should be the media host (${src})`);
  }
  // ...and the page URL is still reachable, as the outbound link.
  assert.ok(/data-ext="https:\/\/twetch\.com\/meme-library/.test(html), "the page URL is the outbound link");
  // A gif wants the full media, not the static first frame.
  assert.ok(/abc-o0/.test(html), "gif uses the media url");
  // A broken image must degrade to text, not an empty box.
  assert.ok(/onerror=/.test(html), "tiles have an error fallback");
  // Titles and folder metadata should be visible.
  assert.ok(/Monkey/.test(html), "title is shown");
  assert.ok(/Reaction Memes/.test(html), "folder is shown");
  // Video formats need <video>, not <img>.
  const vid = memes.render({ ...base, data: { ...data, items: [{ ...data.items[0], format: "mp4", mediaUrl: "https://api.twetch.com/v1/media/clip.mp4" }] } });
  assert.ok(/<video /.test(vid), "mp4 renders as <video>");
  // A folder with no usable media still renders a labelled placeholder.
  const none = memes.render({ ...base, data: { ...data, items: [{ title: "Broken", url: "https://twetch.com/x" }] } });
  assert.ok(/meme-fallback/.test(none), "missing media shows a placeholder");
});

test("the shell can sweep out but never handles a sweep-in key", async () => {
  // Sweep out is the wallet's own funds leaving and needs no secret, so it
  // belongs in the UI. Sweep in takes a WIF, so the UI must point at the
  // terminal instead of offering a field — the same boundary as seed phrases.
  const src = readApp("views/money.js");
  assert.ok(src.includes('rpc("sweepOut"'), "the shell can sweep out");
  assert.ok(src.includes("Send everything"), "and offers it in plain words");
  assert.ok(!/sweepIn/.test(src), "the shell never calls sweepIn");
  assert.ok(!/\bwif\b/i.test(src) || /never pass through a page|stays in the terminal/.test(src), "no WIF field, and the reason is stated");
  assert.ok(src.includes("bsv sweep in"), "sweep in is documented as a terminal command");

  const views = await loadViews();
  const send = views.find((v) => v.id === "send");
  const base = { params: {}, go() {}, toast() {}, fail() {}, run: (f) => f(), reload: async () => {}, openExternal() {}, openExplorer() {} };
  const html = send.render({ ...base, data: { balance: { confirmed: 25000, unconfirmed: 0 } } });
  assert.ok(/Send everything/.test(html), "renders the sweep-out control");
  assert.ok(/bsv sweep in/.test(html), "renders the terminal pointer for sweep-in");
  assert.ok(!html.includes("undefined") && !html.includes("NaN"), "clean render");
  // After a sweep the result is shown with the real amount and fee.
  const done = send.render({ ...base, data: { balance: { confirmed: 0 }, swept: { txid: "ab".repeat(32), sats: 24000, fee: 275 } } });
  assert.ok(/Swept/.test(done), "shows the sweep result");
  assert.ok(/24,000 sats/.test(done), "with the amount the daemon actually sent");
});

test("twetchUser is called with the key the handler actually reads", async () => {
  // The handler is `const id = Math.floor(Number(raw.id) || 0)` — it reads `id`,
  // but its error message says "userId required". Sending the key the error
  // text suggests therefore always fails, which is what broke the profile tab.
  const src = readApp("views/twetch.js");
  assert.ok(src.includes('tryRpc("twetchUser", { id: Number(userId) })'), "sends id, the key the handler reads");
  assert.ok(!/twetchUser",[ ]*\{[ ]*userId:/.test(src), "does not send userId");
  // Cross-check against the daemon source so the two cannot drift.
  const rpcSrc = fs.readFileSync(fileURLToPath(new URL("../src/rpc.ts", import.meta.url)), "utf8");
  const at = rpcSrc.indexOf("twetchUser: async");
  assert.ok(at > 0, "twetchUser handler found");
  const handler = rpcSrc.slice(at, rpcSrc.indexOf("},", at));
  assert.ok(/raw\.id\b/.test(handler), "the handler really does read raw.id");
});

test("no two tabs in the sidebar share a title", async () => {
  // Two tabs both called "Market" (Twetch's NFT market and the BRC-100 atomic
  // market) made it impossible to tell from the sidebar which one you were
  // opening.
  const { VIEWS } = await import(new URL("views/index.js", appDir).href);
  const titles = VIEWS.map((v) => v.title);
  const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
  assert.deepEqual([...new Set(dupes)], [], "every view title is unique");
  const markets = VIEWS.filter((v) => /market/i.test(v.title));
  assert.equal(markets.length, 2, "there are two markets");
  assert.deepEqual(
    markets.map((m) => m.title).sort(),
    ["Atomic Market", "NFT Market"],
    "and they are named differently",
  );
});

test("meme filters survive a reload instead of being overwritten", async () => {
  // The reported bug: clicking a folder fetched a filtered list and then
  // called ctx.reload(), which re-ran load() with NO folder — so the
  // unfiltered results overwrote the filtered ones and the button looked
  // inert. load() must build its query from the view's own state.
  const views = await loadViews();
  const memes = views.find((v) => v.id === "twetch-memes");
  const src = readApp("views/twetch.js");
  const loadBody = memes.load.toString();
  for (const key of ["folder", "q", "format", "sort"]) {
    assert.ok(loadBody.includes(key), `load() honours ${key}`);
  }
  assert.ok(loadBody.includes("twetchMemes"), "load() is what queries the API");
  // The handler must not fetch and then reload — that is the bug's shape.
  assert.ok(!/twetchMemes[\s\S]{0,200}ctx\.reload\(\)/.test(src), "no fetch-then-reload in the folder handler");
  // Tag filtering is local by design, so it must not trigger a refetch.
  const tagHandler = /const t = e\.target\.closest\("\[data-tag\]"\);[\s\S]*?return repaint\(\);/.test(src);
  assert.ok(tagHandler, "the tag filter repaints locally instead of refetching");
  assert.ok(src.includes("function harvestTags"), "tags are harvested from the loaded page");
});

test("meme tag filter is local, and says so, because the API has none", async () => {
  // Upstream /v1/dank-rares treats `tag` as a CATEGORY and 400s on a real
  // tag; `q` is a fuzzy text search that ignores tags (q=awkward returns 341
  // hits, none carrying the tag). So tag filtering is client-side only and
  // the UI must not imply otherwise.
  const views = await loadViews();
  const memes = views.find((v) => v.id === "twetch-memes");
  const base = { params: {}, go() {}, toast() {}, fail() {}, run: (f) => f(), reload: async () => {}, openExternal() {}, openExplorer() {} };
  const data = {
    folder: "", q: "", format: "", sort: "", tag: "funny",
    folders: [{ slug: "reaction-memes", label: "Reaction Memes", count: 2880 }],
    items: [
      { title: "A", format: "gif", tags: ["funny", "relatable"], mediaUrl: "https://api.twetch.com/v1/media/a.jpg", url: "https://twetch.com/meme-library/meme/a" },
      { title: "B", format: "gif", tags: ["relatable"], mediaUrl: "https://api.twetch.com/v1/media/b.jpg", url: "https://twetch.com/meme-library/meme/b" },
    ],
    nextCursor: null, total: 10544,
    tags: [{ name: "funny", count: 1 }, { name: "relatable", count: 2 }],
  };
  const html = memes.render({ ...base, data });
  // Only the tagged item is rendered.
  const titles = [...html.matchAll(/meme-title">([^<]*)/g)].map((m) => m[1]);
  assert.deepEqual(titles, ["A"], "only items carrying the tag are shown");
  assert.ok(/local/i.test(html), "the UI says the tag filter is local");
  assert.ok(/Showing 1 of 10,544/.test(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")), "counts are honest about the scope");
  // With no tag selected, everything shows.
  const all = memes.render({ ...base, data: { ...data, tag: "" } });
  assert.equal((all.match(/meme-title/g) || []).length, 2, "no tag means no local filtering");
  // A tag nobody has gives a helpful empty state, not a blank page.
  const none = memes.render({ ...base, data: { ...data, tag: "zzz" } });
  assert.ok(/No loaded memes carry the tag/.test(none), "explains an empty local result");
});

test("twetch market only offers Buy when swapBuyFor would accept it", async () => {
  // swapBuyFor validates /^([0-9a-f]{64})[._](\d+)$/ and requires priceSats
  // and sellerAddress, but the market returns "txid:vout" with a colon. Passing
  // the raw value dies on BAD_PARAM, so the view must normalise and gate.
  const views = await loadViews();
  const market = views.find((v) => v.id === "twetch-market");
  const src = readApp("views/twetch.js");
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
  const src = readApp("views/inscribe.js");
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
