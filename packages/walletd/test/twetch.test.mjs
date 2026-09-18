import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-twetch";
import knex from "knex";
import { Hash, PrivateKey, Script, Transaction, UnlockingScript, Utils } from "@bsv/sdk";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import {
  __resetCache,
  createWallet,
  destroyWallet,
  selfAddress,
  twetchAccountImport,
  twetchAccountImportFromSeed,
  twetchAccountRemove,
  twetchAccountStatus,
  twetchSignBytes,
} from "../src/custody.ts";
import {
  AIP_PREFIX,
  B_PREFIX,
  MEDIA_MAX_BYTES,
  aipMessage,
  authMessage,
  buildMediaScript,
  buildPostScript,
  feedLatest,
  indexPost,
  notifications,
  parsePostTx,
  postFields,
  postNotifications,
  postText,
  verifyAip,
} from "../src/twetch.ts";
import { setPolicy } from "../src/policy.ts";
import { p2pkhScript } from "../src/tx.ts";

const FUNDING = "d".repeat(64);

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

function parentHex(scriptHex, sats) {
  const tx = new Transaction(2, [], [], 0);
  tx.addInput({
    sourceTXID: "f".repeat(64),
    sourceOutputIndex: 0,
    sequence: 0xffffffff,
    unlockingScript: new UnlockingScript([]),
  });
  tx.addOutput({ lockingScript: Script.fromHex(scriptHex), satoshis: sats });
  return tx.toHex();
}

function aipFromScript(scriptHex) {
  const b = Buffer.from(scriptHex, "hex");
  const pushes = [];
  let i = 2;
  while (i < b.length) {
    const op = b[i++];
    let len;
    if (op < 0x4c) len = op;
    else if (op === 0x4c) len = b[i++];
    else if (op === 0x4d) { len = b[i] | (b[i + 1] << 8); i += 2; }
    else throw new Error(`opcode 0x${op.toString(16)}`);
    pushes.push(b.subarray(i, i + len).toString("utf8"));
    i += len;
  }
  const idx = pushes.indexOf(AIP_PREFIX);
  assert.ok(idx > 0, "AIP prefix present");
  assert.equal(pushes[idx + 1], "BITCOIN_ECDSA");
  return { address: pushes[idx + 2], signature: pushes[idx + 3], fields: pushes.slice(0, idx) };
}

test("twetch: exact on-chain post script (byte-for-byte reference tx)", () => {
  const content = "Weak sauce 😅";
  const aip = {
    address: "1BRHwsJ1QJQ7A3ezGT2JQa4tt5eyHu7Pr7",
    signature: "H1m1kak/cjZFsvXBiPX3fIRVY76W8b93IYnkdclwYFXDEz5ufONlTgTtqhp9pLVxYcsn6mkpzjufuS7oD+d/N10=",
  };
  const known =
    "006a2231394878696756345179427633744870515663554551797131707a5a56646f4175740f5765616b20736175636520f09f98850d746578742f6d61726b646f776e055554462d38017c223150755161374b36324d694b43747373534c4b79316b683536575755374d74555235035345540361707006747765746368047479706504706f7374017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f4543445341223142524877734a31514a51374133657a4754324a51613474743565794875375072374c5848316d316b616b2f636a5a46737658426950583366495256593736573862393349596e6b64636c7759465844457a3575664f4e6c5467547471687039704c56785963736e366d6b707a6a75667553376f442b642f4e31303d";
  assert.equal(buildPostScript(content, aip), known);
  assert.equal(verifyAip(content, aip), true);
  assert.equal(verifyAip(`${content}!`, aip), false);
});

test("twetch: AIP message is 0x6a + concatenated field bytes", () => {
  const fields = postFields("hi");
  const msg = aipMessage(fields);
  assert.equal(msg[0], 0x6a);
  assert.deepEqual(msg.slice(1), Utils.toArray(fields.join(""), "utf8"));
});

test("twetch: public reads (feed, notifications, post-notifications)", async () => {
  const seen = [];
  const fetchFn = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("/v1/feed/latest")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 1, txid: "a".repeat(64), userId: 7, content: "hello twetch",
              contentType: "text/markdown", postedAtMs: 1000, numLikes: 2,
              numReplies: 1, numBranches: 0, replyPostId: null,
            },
          ],
          users: { "7": { id: 7, name: "Alice", handle: "alice" } },
          nextCursor: "c1",
        }),
        { status: 200 },
      );
    }
    if (u.includes("/v1/users/32324/notifications")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 9, type: "reply", actorUserId: 8, postId: 2, actionPostId: 3,
              description: "replied to your post", createdAtMs: 2000,
            },
          ],
          users: { "8": { id: 8, name: "Bob", handle: "bob" } },
          nextCursor: null,
        }),
        { status: 200 },
      );
    }
    if (u.includes("/v1/feed/post-notifications")) {
      return new Response(JSON.stringify({ data: [], users: {}, nextCursor: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: `unexpected ${u}` }), { status: 404 });
  };

  const feed = await feedLatest(fetchFn, { limit: 5 });
  assert.equal(feed.posts.length, 1);
  assert.equal(feed.posts[0].content, "hello twetch");
  assert.equal(feed.posts[0].user.name, "Alice");
  assert.equal(feed.nextCursor, "c1");

  const n = await notifications(fetchFn, 32324);
  assert.equal(n.notifications[0].type, "reply");
  assert.equal(n.notifications[0].actor.handle, "bob");

  assert.deepEqual((await postNotifications(fetchFn, 32324)).posts, []);
  await assert.rejects(notifications(fetchFn, 0), (e) => e.code === "BAD_PARAM");
});

test("twetch: post builds the exact script, policy-gates, broadcasts, auth-signs submit", async () => {
  const db = await memdb();
  try {
    await destroyWallet();
    __resetCache();
    await createWallet();
    await twetchAccountRemove();
    const twetchKey = PrivateKey.fromRandom();
    await twetchAccountImport(twetchKey.toWif());
    const st = await twetchAccountStatus();
    assert.equal(st.imported, true);
    assert.equal(st.address, twetchKey.toPublicKey().toAddress("mainnet"));

    const self = selfAddress();
    const chain = new MockChainProvider([
      { address: self, utxos: [{ txid: FUNDING, vout: 0, value: 500_000, height: 100 }] },
    ]);
    const broadcasted = new Map();
    chain.broadcast = async (hex) => {
      const tx = Transaction.fromHex(hex);
      const txid = tx.id("hex");
      broadcasted.set(txid, hex);
      return { txid, status: "SEEN" };
    };
    await setPolicy(db, "twetch", "allow", 10_000);

    const apiCalls = [];
    const fetchFn = async (url, init) => {
      const u = String(url);
      if (u.endsWith(`/tx/${FUNDING}/hex`)) return new Response(parentHex(p2pkhScript(self).toHex(), 500_000), { status: 200 });
      const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(u);
      if (m) {
        const hex = broadcasted.get(m[1]);
        return hex ? new Response(hex, { status: 200 }) : new Response("not found", { status: 404 });
      }
      if (u.endsWith("/chain/info")) return new Response(JSON.stringify({ blocks: 900000 }), { status: 200 });
      if (u.includes("api.twetch.com")) {
        apiCalls.push({ url: u, init });
        if (u.endsWith("/v1/posts")) return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
        return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
      }
      return new Response(JSON.stringify({ error: `unexpected ${u}` }), { status: 404 });
    };

    const res = await postText({ db, chain, fetchFn, origin: "twetch" }, "gm bsv-os", { userId: 32324 });
    assert.match(res.txid, /^[0-9a-f]{64}$/);
    assert.equal(res.submitted, true);
    assert.equal(res.submitDetail, "indexed by twetch");
    assert.equal(res.authorAddress, twetchKey.toPublicKey().toAddress("mainnet"));

    const hex = broadcasted.get(res.txid);
    assert.ok(hex, "post tx was broadcast");
    const tx = Transaction.fromHex(hex);
    const opReturn = tx.outputs.find((o) => o.lockingScript.toHex().startsWith("006a"));
    assert.ok(opReturn, "post has an OP_RETURN output");
    const aip = aipFromScript(opReturn.lockingScript.toHex());
    assert.deepEqual(aip.fields.slice(0, 4), [
      "19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut", "gm bsv-os", "text/markdown", "UTF-8",
    ]);
    assert.equal(verifyAip("gm bsv-os", { address: aip.address, signature: aip.signature }), true);
    assert.equal(aip.address, twetchKey.toPublicKey().toAddress("mainnet"));

    const tracked = await db("brc100_actions").where({ txid: res.txid }).first();
    assert.ok(tracked, "action tracked in the wallet");

    assert.equal(apiCalls.length, 1);
    const call = apiCalls[0];
    assert.equal(call.init.method, "POST");
    const body = JSON.parse(call.init.body);
    assert.equal(body.userId, 32324);
    assert.equal(body.content, "gm bsv-os");
    assert.equal(body.metadataVersion, 2);
    assert.equal(body.txHex, hex);
    const ts = Number(call.init.headers["x-twetch-ts"]);
    const expectSig = await twetchSignBytes(Utils.toArray(authMessage("POST", "/v1/posts", 32324, ts, call.init.body), "utf8"));
    assert.equal(call.init.headers["x-twetch-sig"], expectSig);
  } finally {
    await db.destroy();
    await destroyWallet();
    await twetchAccountRemove();
    __resetCache();
  }
});

test("twetch: posting requires the Twetch key and wallet unlock", async () => {
  const db = await memdb();
  try {
    await destroyWallet();
    __resetCache();
    await twetchAccountRemove();
    await createWallet();
    await setPolicy(db, "twetch", "allow", 10_000);
    const chain = new MockChainProvider([]);
    const fetchFn = async () => new Response("{}", { status: 200 });
    await assert.rejects(
      postText({ db, chain, fetchFn, origin: "twetch" }, "gm"),
      (e) => e.code === "NO_TWETCH_ACCOUNT",
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    await twetchAccountRemove();
    __resetCache();
  }
});
test("twetch: one-tap seed import derives m/44'/0'/0'/0/0 and stores it (WIF never returned)", async () => {
  await destroyWallet();
  __resetCache();
  await twetchAccountRemove();
  const { backup } = await createWallet();
  const res = await twetchAccountImportFromSeed();
  assert.equal(res.path, "m/44'/0'/0'/0/0");
  assert.match(res.address, /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/);
  assert.match(res.publicKey, /^[0-9a-f]{66}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(res, "wif"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res, "privateKey"), false);

  const { HD, Mnemonic } = await import("@bsv/sdk");
  const expected = HD.fromSeed(new Mnemonic(backup).toSeed()).derive("m/44'/0'/0'/0/0").privKey;
  assert.equal(res.publicKey, expected.toPublicKey().toString());
  assert.equal(res.address, expected.toPublicKey().toAddress("mainnet"));

  const stored = await twetchAccountStatus();
  assert.equal(stored.address, res.address);

  const other = await twetchAccountImportFromSeed("m/44'/0'/0'/0/1");
  assert.notEqual(other.address, res.address);
  assert.equal((await twetchAccountStatus()).address, other.address);

  await destroyWallet();
  await twetchAccountRemove();
  __resetCache();
});

test("twetch: seed import fails gracefully without a wallet and on a bad path", async () => {
  await destroyWallet();
  __resetCache();
  await twetchAccountRemove();
  await assert.rejects(twetchAccountImportFromSeed(), (e) => e.code === "NO_WALLET");

  await createWallet();
  await assert.rejects(twetchAccountImportFromSeed("not-a-path"), (e) => e.code === "BAD_PARAM");
  await assert.rejects(twetchAccountImportFromSeed("m/44'/0'/x"), (e) => e.code === "BAD_PARAM");

  await destroyWallet();
  await twetchAccountRemove();
  __resetCache();
});

test("twetch: user-by-pubkey linkage check (found, unlinked, malformed)", async () => {
  const { userByPubkey } = await import("../src/twetch.ts");
  const found = async (url) =>
    String(url).includes("/v1/auth/user-by-pubkey/")
      ? new Response(JSON.stringify({ userId: 32324 }), { status: 200 })
      : new Response("{}", { status: 404 });
  assert.equal(await userByPubkey(found, "02".repeat(33)), 32324);

  const missing = async () => new Response("not found", { status: 404 });
  assert.equal(await userByPubkey(missing, "02".repeat(33)), null);

  const boom = async () => new Response("nope", { status: 500 });
  await assert.rejects(userByPubkey(boom, "02".repeat(33)), (e) => e.code === "RAILS");
  await assert.rejects(userByPubkey(found, "zz"), (e) => e.code === "BAD_PARAM");
});

test("twetch: seed import scans for the account key when the OIDC target is known", async () => {
  await destroyWallet();
  __resetCache();
  await twetchAccountRemove();
  const { backup } = await createWallet();
  const { HD, Mnemonic } = await import("@bsv/sdk");
  const hd = HD.fromSeed(new Mnemonic(backup).toSeed());

  const targetPath = "m/0'/0'/0'";
  const targetPub = hd.derive(targetPath).privKey.toPublicKey().toString();
  const res = await twetchAccountImportFromSeed(undefined, targetPub);
  assert.equal(res.path, targetPath);
  assert.ok(res.scanned > 1);
  assert.equal(res.publicKey, targetPub);
  assert.equal((await twetchAccountStatus()).address, res.address);

  const foreign = "02" + "ab".repeat(32);
  await assert.rejects(
    twetchAccountImportFromSeed(undefined, foreign),
    (e) => e.code === "NOT_FOUND",
  );
  assert.equal((await twetchAccountStatus()).address, res.address, "failed scan leaves the stored key untouched");

  await destroyWallet();
  await twetchAccountRemove();
  __resetCache();
});

test("twetch: posting refuses an unlinked key when signed in", async () => {
  const db = await memdb();
  try {
    await destroyWallet();
    __resetCache();
    await createWallet();
    await twetchAccountRemove();
    const key = PrivateKey.fromRandom();
    await twetchAccountImport(key.toWif());
    const self = selfAddress();
    const chain = new MockChainProvider([
      { address: self, utxos: [{ txid: FUNDING, vout: 0, value: 500_000, height: 100 }] },
    ]);
    await setPolicy(db, "twetch", "allow", 10_000);
    const fetchFn = async (url) => {
      const u = String(url);
      if (u.includes("/v1/auth/user-by-pubkey/")) {
        return new Response(JSON.stringify({ userId: 111 }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };
    await assert.rejects(
      postText({ db, chain, fetchFn, origin: "twetch", expectUserId: 32324 }, "should not post"),
      (e) => e.code === "TWETCH_KEY_MISMATCH",
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    await twetchAccountRemove();
    __resetCache();
  }
});

test("twetch: phrase import scans and stores only on a target match", async () => {
  await destroyWallet();
  __resetCache();
  await twetchAccountRemove();
  const { twetchAccountImportFromPhrase } = await import("../src/custody.ts");
  const { HD, Mnemonic } = await import("@bsv/sdk");
  const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const hd = HD.fromSeed(new Mnemonic(phrase).toSeed());
  const targetPath = "m/44'/236'/0'/0/1";
  const targetPub = hd.derive(targetPath).privKey.toPublicKey().toString();

  const res = await twetchAccountImportFromPhrase(phrase, undefined, targetPub);
  assert.equal(res.path, targetPath);
  assert.ok(res.scanned > 1);
  assert.equal(res.publicKey, targetPub);
  assert.equal((await twetchAccountStatus()).address, res.address);
  assert.equal(Object.prototype.hasOwnProperty.call(res, "wif"), false);

  await assert.rejects(
    twetchAccountImportFromPhrase("definitely not a phrase", undefined, targetPub),
    (e) => e.code === "BAD_PHRASE",
  );
  await assert.rejects(
    twetchAccountImportFromPhrase(phrase, undefined, "02" + "ab".repeat(32)),
    (e) => e.code === "NOT_FOUND",
  );
  assert.equal((await twetchAccountStatus()).address, res.address, "failed scan leaves the stored key untouched");

  await twetchAccountRemove();
  __resetCache();
});

test("twetch: meme library browse/search maps media and folders", async () => {
  const { memeLibrary, memeFolders } = await import("../src/twetch.ts");
  const mediaPath = "/v1/media/deadbeef-o0.jpg?v=3";
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes("/v1/dank-rares/folders")) {
      return new Response(
        JSON.stringify({
          categories: [
            { slug: "laugh", label: "Laugh", name: "laugh", count: 466, cover: {} },
            { slug: "happy", label: "Happy", name: "happy", count: 1046 },
          ],
        }),
        { status: 200 },
      );
    }
    if (u.includes("/v1/dank-rares")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "abc:b://def@0", title: "Monkey Looking Awkwardly", description: "oops",
              folder: "Reaction Memes", folderSlug: "reaction-memes", format: "gif",
              mediaUrl: mediaPath, previewUrl: mediaPath, onchainRef: "b://deadbeef@0",
              sha256: "a".repeat(64), tags: ["monkey", "funny"], tokenNumber: 7889,
              ownerUserId: 259, uploadedAtMs: 17865400, bytes: 1832534,
            },
          ],
          nextCursor: "cur2",
          total: 2618,
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  };
  const page = await memeLibrary(fetchFn, { q: "monkey", folder: "reaction-memes", sort: "top", limit: 5 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].mediaUrl, `https://api.twetch.com${mediaPath}`);
  assert.equal(page.items[0].previewUrl, `https://api.twetch.com${mediaPath}`);
  assert.equal(page.items[0].onchainRef, "b://deadbeef@0");
  assert.equal(
    page.items[0].url,
    `https://twetch.com/meme-library/meme/${"a".repeat(64)}/monkey-looking-awkwardly`,
  );
  assert.deepEqual(page.items[0].tags, ["monkey", "funny"]);
  assert.equal(page.nextCursor, "cur2");
  assert.equal(page.total, 2618);

  const folders = await memeFolders(fetchFn);
  assert.equal(folders.length, 2);
  assert.deepEqual(folders[0], { slug: "laugh", label: "Laugh", name: "laugh", count: 466 });
});

test("twetch: market listings/sales/collections map and deep-link", async () => {
  const { marketListings, marketSales, marketCollections } = await import("../src/twetch.ts");
  const img = `b://${"1a".repeat(32)}`;
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes("/v1/market/listings")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 7244888, collection: "964a", collectionName: null, createdAtMs: 1, image: img,
              name: "LizerVAXX #1396", number: 1396, outpoint: "5a94:0", priceSats: 99900000,
              rarity: null, sellerAddress: "1K7f", sellerUserId: 296, status: "listed",
            },
          ],
          nextCursor: "mc1",
        }),
        { status: 200 },
      );
    }
    if (u.includes("/v1/market/sales")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              txid: "deee", tokenName: "LizerVAXX #1563", number: 1563, collection: "964a",
              collectionName: "LizerVAXX", image: img, priceSats: 99900000, listPriceSats: 169000000,
              outpoint: "30de", timestampMs: 2,
            },
          ],
          nextCursor: null,
        }),
        { status: 200 },
      );
    }
    if (u.includes("/v1/market/collections")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              contractAddress: "c1fc", name: "Meme Library", description: "", profileImage: img,
              bannerImage: img, floorSats: 21800000, volumeSats: 27656395680, numListings: 308,
              owners: 86, salesCount: 345, circulating: 10043, total: 10043, status: "active",
              launchDateMs: 3,
            },
          ],
          nextCursor: null,
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  };

  const listings = await marketListings(fetchFn, { limit: 5 });
  assert.equal(listings.items.length, 1);
  assert.ok(listings.items[0].imageUrl.startsWith("https://api.twetch.com/v1/media/"));
  assert.equal(listings.items[0].priceSats, 99900000);
  assert.equal(listings.items[0].url, "https://twetch.com/market/964a?token=1396");
  assert.equal(listings.nextCursor, "mc1");

  const sales = await marketSales(fetchFn, {});
  assert.equal(sales.items[0].tokenName, "LizerVAXX #1563");
  assert.equal(sales.items[0].soldAtMs, 2);
  assert.equal(sales.items[0].listPriceSats, 169000000);
  assert.equal(sales.items[0].url, "https://twetch.com/market/964a?token=1563");

  const collections = await marketCollections(fetchFn, {});
  assert.equal(collections.items[0].name, "Meme Library");
  assert.equal(collections.items[0].floorSats, 21800000);
  assert.equal(collections.items[0].url, "https://twetch.com/market/c1fc");
  assert.ok(collections.items[0].imageUrl.startsWith("https://api.twetch.com/v1/media/"));
});

test("twetch: user profile + posts map for the profile view", async () => {
  const { userProfile, userPosts } = await import("../src/twetch.ts");
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/users/32324")) {
      return new Response(
        JSON.stringify({
          id: 32324, name: "Richard A. Hein", icon: "64fa83.jpeg", banner: "654af3.jpeg",
          description: "Software Developer & Architect", publicKey: "02a0fa42",
          isTwetchGreen: false, numFollowers: 513, numFollowing: 709, createdAtMs: 1560693182313,
        }),
        { status: 200 },
      );
    }
    if (u.includes("/v1/users/32324/posts")) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 1, txid: "a".repeat(64), userId: 32324, content: "hello", contentType: "text/plain", postedAtMs: 5, numLikes: 1, numReplies: 2, numBranches: 0, replyPostId: null },
          ],
          users: { "32324": { id: 32324, name: "Richard A. Hein", handle: "richard" } },
          nextCursor: "uc1",
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  };
  const profile = await userProfile(fetchFn, 32324);
  assert.equal(profile.name, "Richard A. Hein");
  assert.equal(profile.avatarUrl, "https://media.ordinalswallet.com/64fa83.jpeg");
  assert.equal(profile.bannerUrl, "https://media.ordinalswallet.com/654af3.jpeg");
  assert.equal(profile.numFollowers, 513);
  assert.equal(profile.url, "https://twetch.com/u/32324");

  const page = await userPosts(fetchFn, 32324, { limit: 5 });
  assert.equal(page.posts.length, 1);
  assert.equal(page.posts[0].content, "hello");
  assert.equal(page.posts[0].user.name, "Richard A. Hein");
  assert.equal(page.nextCursor, "uc1");
  await assert.rejects(userProfile(fetchFn, 0), (e) => e.code === "BAD_PARAM");
});

test("twetch: media script matches Twetch's B:// media output", () => {
  const media = Array.from({ length: 6010 }, (_, i) => i % 251);
  const hex = buildMediaScript(media, "image/webp");
  const b = Buffer.from(hex, "hex");
  assert.equal(b[0], 0x00);
  assert.equal(b[1], 0x6a);
  let k = 2;
  const readPush = () => {
    const op = b[k++];
    let len;
    if (op < 0x4c) len = op;
    else if (op === 0x4c) len = b[k++];
    else if (op === 0x4d) { len = b[k] | (b[k + 1] << 8); k += 2; }
    else throw new Error("unexpected opcode");
    const data = b.subarray(k, k + len);
    k += len;
    return data;
  };
  assert.equal(readPush().toString("utf8"), B_PREFIX);
  assert.deepEqual(Array.from(readPush()), media);
  assert.equal(readPush().toString("utf8"), "image/webp");
  assert.equal(k, b.length);
});

test("twetch: parsePostTx recovers text and media ref from a broadcast tx", () => {
  const address = "1FgiUa9oMqcEsHyPD6i3yLTu2qq9BzdxR7";
  const textHex = buildPostScript("hello chain\n\nb://abc", { address, signature: "sig" });
  const textOnly = parsePostTx(textHex);
  assert.equal(textOnly.content, "hello chain\n\nb://abc");
  assert.equal(textOnly.mime, "text/markdown");
  assert.equal(textOnly.encoding, "UTF-8");
  assert.equal(textOnly.media, null);

  const media = Array.from({ length: 300 }, (_, i) => (i * 13) % 256);
  const withMedia = parsePostTx(textHex + buildMediaScript(media, "image/jpeg"));
  assert.equal(withMedia.content, textOnly.content);
  assert.equal(withMedia.media.mime, "image/jpeg");
  assert.equal(withMedia.media.sha256, Utils.toHex(Hash.sha256(media)));

  assert.equal(parsePostTx("deadbeef"), null);
  assert.equal(parsePostTx(""), null);
});

test("twetch: index falls back to the locally stored tx hex when WoC is down", async () => {
  const db = await memdb();
  try {
    await destroyWallet();
    __resetCache();
    await createWallet();
    await twetchAccountRemove();
    const key = PrivateKey.fromRandom();
    await twetchAccountImport(key.toWif());
    const address = key.toPublicKey().toAddress("mainnet");

    const scriptHex =
      buildPostScript("db fallback post", { address, signature: "sig" }) +
      buildMediaScript([1, 2, 3, 4], "image/png");
    const txid = "e".repeat(64);
    await db("pending_txs").insert({ txid, label: "test", status: "seen", created_at: Date.now(), tx_hex: scriptHex });

    const apiCalls = [];
    const fetchFn = async (url, init) => {
      const u = String(url);
      if (u.includes("whatsonchain.com")) return new Response("not found", { status: 404 });
      if (u.includes("/v1/auth/user-by-pubkey/")) return new Response(JSON.stringify({ userId: 32324 }), { status: 200 });
      if (u.endsWith("/v1/posts")) {
        apiCalls.push(init);
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const res = await indexPost(
      { db, chain: null, fetchFn, origin: "twetch", expectUserId: 32324 },
      txid,
      { userId: 32324 },
    );
    assert.equal(res.content, "db fallback post");
    assert.equal(res.mediaRef, `b://${Utils.toHex(Hash.sha256([1, 2, 3, 4]))}`);
    assert.equal(apiCalls.length, 1);
    assert.equal(JSON.parse(apiCalls[0].body).txHex, scriptHex);
  } finally {
    await db.destroy();
    await destroyWallet();
    await twetchAccountRemove();
    __resetCache();
  }
});

test("twetch: posting with media embeds a second OP_RETURN and pays for it", async () => {
  const db = await memdb();
  try {
    await destroyWallet();
    __resetCache();
    await createWallet();
    await twetchAccountRemove();
    const key = PrivateKey.fromRandom();
    await twetchAccountImport(key.toWif());

    const self = selfAddress();
    const chain = new MockChainProvider([
      { address: self, utxos: [{ txid: FUNDING, vout: 0, value: 500_000, height: 100 }] },
    ]);
    const broadcasted = new Map();
    chain.broadcast = async (hex) => {
      const tx = Transaction.fromHex(hex);
      const txid = tx.id("hex");
      broadcasted.set(txid, hex);
      return { txid, status: "SEEN" };
    };
    await setPolicy(db, "twetch", "allow", 400_000);

    const media = Array.from({ length: 50_000 }, (_, i) => (i * 7) % 256);
    const mediaSha = Utils.toHex(Hash.sha256(media));
    const mediaRef = `b://${mediaSha}`;
    const apiCalls = [];
    const fetchFn = async (url, init) => {
      const u = String(url);
      if (u.endsWith(`/tx/${FUNDING}/hex`)) return new Response(parentHex(p2pkhScript(self).toHex(), 500_000), { status: 200 });
      const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(u);
      if (m) {
        const hex = broadcasted.get(m[1]);
        return hex ? new Response(hex, { status: 200 }) : new Response("not found", { status: 404 });
      }
      if (u.endsWith("/chain/info")) return new Response(JSON.stringify({ blocks: 900000 }), { status: 200 });
      if (u.includes("/v1/auth/user-by-pubkey/")) return new Response(JSON.stringify({ userId: 32324 }), { status: 200 });
      if (u.endsWith("/v1/posts")) {
        apiCalls.push({ url: u, init });
        return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const res = await postText(
      { db, chain, fetchFn, origin: "twetch", expectUserId: 32324 },
      "vintage chair for sale",
      { userId: 32324, media: { bytes: media, mime: "image/jpeg" } },
    );
    assert.equal(res.mediaBytes, media.length);
    assert.equal(res.submitted, true);
    const expectedText = `vintage chair for sale\n\n${mediaRef}`;
    assert.equal(res.content, expectedText);

    const hex = broadcasted.get(res.txid);
    const tx = Transaction.fromHex(hex);
    const opReturns = tx.outputs.filter((o) => o.lockingScript.toHex().startsWith("006a"));
    assert.equal(opReturns.length, 2, "text post + media output");
    assert.equal(opReturns[1].lockingScript.toHex(), buildMediaScript(media, "image/jpeg"));
    const aip = aipFromScript(opReturns[0].lockingScript.toHex());
    assert.equal(aip.fields[1], expectedText, "b:// ref is part of the signed post text");
    assert.equal(verifyAip(expectedText, { address: aip.address, signature: aip.signature }), true);

    assert.equal(apiCalls.length, 1, "post submitted to the Twetch API");
    const body = JSON.parse(apiCalls[0].init.body);
    assert.equal(body.content, expectedText);
    assert.deepEqual(body.mediaRefs, [mediaRef], "mediaRefs drives twetch.com rendering");

    // Recovery path: re-submitting an already-broadcast post parses the tx
    // back (content + media sha) instead of needing the original text.
    const reindexed = await indexPost(
      { db, chain, fetchFn, origin: "twetch", expectUserId: 32324 },
      res.txid,
      { userId: 32324 },
    );
    assert.equal(reindexed.content, expectedText);
    assert.equal(reindexed.mediaRef, mediaRef);
    assert.equal(reindexed.submitted, true);
    assert.equal(apiCalls.length, 2, "re-index submitted to the Twetch API");
    const reBody = JSON.parse(apiCalls[1].init.body);
    assert.equal(reBody.txHex, hex);
    assert.equal(reBody.content, expectedText);
    assert.deepEqual(reBody.mediaRefs, [mediaRef]);
    await assert.rejects(
      indexPost({ db, chain, fetchFn, origin: "twetch" }, "not-a-txid", { userId: 32324 }),
      (e) => e.code === "BAD_PARAM",
    );

    const change = tx.outputs.find((o) => o.lockingScript.toHex().startsWith("76a914"));
    assert.ok(change, "change output present");
    assert.ok(change.satoshis < 500_000 - media.length * 0.5, `fee should scale with media size (change ${change.satoshis})`);

    await assert.rejects(
      postText({ db, chain, fetchFn, origin: "twetch" }, "x", { media: { bytes: new Array(MEDIA_MAX_BYTES + 1).fill(0), mime: "image/jpeg" } }),
      (e) => e.code === "BAD_PARAM",
    );
    await assert.rejects(
      postText({ db, chain, fetchFn, origin: "twetch" }, "x", { media: { bytes: [1, 2, 3], mime: "" } }),
      (e) => e.code === "BAD_PARAM",
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    await twetchAccountRemove();
    __resetCache();
  }
});
