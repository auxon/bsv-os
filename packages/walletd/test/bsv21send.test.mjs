import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-bsv21send";
import knex from "knex";
import { Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { sendBsv21 } from "../src/engine.ts";
import { setPolicy } from "../src/policy.ts";
import {
  bsv21TransferScript,
  hasOrdEnvelope,
  normalizeTokenId,
  parseBsv21Envelope,
  parseTokenAmount,
  tokenHoldings,
} from "../src/tokens.ts";
import { p2pkhScript } from "../src/tx.ts";

const TOKEN = `${"a".repeat(64)}_0`;
const OTHER = `${"9".repeat(64)}_0`;
const TO = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";
const T1 = "b".repeat(64);
const T2 = "c".repeat(64);
const F1 = "d".repeat(64);
const F2 = "e".repeat(64);

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code);
    return true;
  });
}

function parentHex(outputs) {
  const tx = new Transaction(2, [], [], 0);
  tx.addInput({
    sourceTXID: "f".repeat(64),
    sourceOutputIndex: 0,
    sequence: 0xffffffff,
    unlockingScript: new UnlockingScript([]),
  });
  for (const o of outputs) {
    tx.addOutput({ lockingScript: Script.fromHex(o.scriptHex), satoshis: o.sats });
  }
  return tx.toHex();
}

function pushBytes(bytes) {
  return bytes.length <= 75 ? [bytes.length, ...bytes] : [0x4c, bytes.length, ...bytes];
}

/** Generic (non-token) ord envelope — funding must skip carriers like this. */
function textEnvelopeScript(owner, text) {
  const prefix = Buffer.from(p2pkhScript(owner).toHex(), "hex");
  const body = Buffer.from([
    0x00, 0x63,
    ...pushBytes([...Buffer.from("ord", "utf8")]),
    0x51,
    ...pushBytes([...Buffer.from("text/plain", "utf8")]),
    0x00,
    ...pushBytes([...Buffer.from(text, "utf8")]),
    0x68,
  ]);
  return Buffer.concat([prefix, body]).toString("hex");
}

function makeNet(selfAddr, opts = {}) {
  const t1amt = opts.t1amt ?? "600";
  const hexes = {
    [T1]: () => parentHex([{ scriptHex: bsv21TransferScript(selfAddr, TOKEN, t1amt), sats: 1 }]),
    [T2]: () => parentHex([
      { scriptHex: p2pkhScript(selfAddr).toHex(), sats: 100 },
      { scriptHex: bsv21TransferScript(selfAddr, TOKEN, "500"), sats: 1 },
    ]),
    [F1]: () => parentHex([{ scriptHex: p2pkhScript(selfAddr).toHex(), sats: 50_000 }]),
    [F2]: () => parentHex([{ scriptHex: textEnvelopeScript(selfAddr, "hello"), sats: 500_000 }]),
  };
  const control = {
    rows: [
      { outpoint: `${T1}.0`, score: 1, data: { bsv21: { amt: "600", id: TOKEN, op: "transfer" } } },
      { outpoint: `${T2}.1`, score: 2, data: { bsv21: { amt: "500", id: TOKEN, op: "transfer" } } },
      { outpoint: `${"f".repeat(64)}.0`, score: 3, spend: "00".repeat(32), data: { bsv21: { amt: "999", id: TOKEN, op: "transfer" } } },
      { outpoint: `${F1}.0`, score: 4, data: { bsv21: { amt: "50", id: OTHER, op: "transfer" } } },
    ],
  };
  const fetchFn = async (url) => {
    const mTok = /\/1sat\/bsv21\/([^/]+)\/outputs$/.exec(String(url));
    if (mTok) {
      // the indexer scopes rows to the requested token
      const rows = decodeURIComponent(mTok[1]) === TOKEN ? control.rows : [];
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(String(url));
    if (m && hexes[m[1]]) return new Response(hexes[m[1]](), { status: 200 });
    return new Response("nope", { status: 404 });
  };
  return { control, fetchFn };
}

test("envelope round-trips; validation is strict", () => {
  const script = bsv21TransferScript(TO, TOKEN, "1000");
  const env = parseBsv21Envelope(script);
  assert.equal(env.protocol, "bsv-20");
  assert.equal(env.op, "transfer");
  assert.equal(env.id, TOKEN);
  assert.equal(env.amt, "1000");
  assert.equal(env.contentType, "application/bsv-20");
  assert.equal(hasOrdEnvelope(script), true);
  assert.equal(parseBsv21Envelope(p2pkhScript(TO).toHex()), null);
  assert.equal(hasOrdEnvelope(p2pkhScript(TO).toHex()), false);
  assert.equal(parseBsv21Envelope("zz"), null);
  assert.equal(parseBsv21Envelope(script.slice(0, -4)), null);
  assert.equal(normalizeTokenId(`${"A".repeat(64)}.3`), `${"a".repeat(64)}_3`);
  assert.equal(normalizeTokenId("nope"), null);
  assert.equal(normalizeTokenId(`${"a".repeat(64)}_x`), null);
  assert.equal(parseTokenAmount("007"), "7");
  assert.equal(parseTokenAmount("1.5"), null);
  assert.equal(parseTokenAmount("-3"), null);
  assert.equal(parseTokenAmount("0"), null);
  assert.equal(parseTokenAmount("18446744073709551615"), "18446744073709551615");
  assert.equal(parseTokenAmount("18446744073709551616"), null);
});

test("tokenHoldings keeps unspent matching rows only", async () => {
  const { fetchFn } = makeNet(TO);
  const rows = await tokenHoldings(TOKEN, [`${T1}_0`, `${T2}_1`, `${F1}_0`], { fetchFn });
  assert.equal(rows.length, 2); // spent + wrong-id rows skipped
  assert.equal(rows[0].amt, "600");
  assert.equal(rows[1].vout, 1);
  await rejectsCode(tokenHoldings(TOKEN, [`${T1}_0`], { fetchFn: async () => new Response("x", { status: 500 }) }), "RAILS");
  // live indexer answers JSON null for unknown outpoints
  assert.deepEqual(await tokenHoldings(TOKEN, [`${T1}_0`], { fetchFn: async () => new Response("null") }), []);
});

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("bsv21 send is policy-gated, conserves tokens, and labels change", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    chain.credit(addr, { txid: T1, vout: 0, value: 1, height: 900 });
    chain.credit(addr, { txid: T2, vout: 1, value: 1, height: 900 });
    chain.credit(addr, { txid: F1, vout: 0, value: 50_000, height: 900 });
    chain.credit(addr, { txid: F2, vout: 0, value: 500_000, height: 900 });
    let seen = "";
    const origBroadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (hex) => {
      seen = hex;
      return origBroadcast(hex);
    };

    await assert.rejects(
      sendBsv21({ db, chain, origin: "cli", tokenId: TOKEN, to: TO, amt: "1000", fetchFn }),
      /first-run approval/,
    );
    await setPolicy(db, "cli", "allow");
    const r = await sendBsv21({ db, chain, origin: "cli", tokenId: TOKEN, to: TO, amt: "1000", fetchFn });
    assert.equal(r.sent, "1000");
    assert.equal(r.change, "100");
    assert.equal(r.tokenId, TOKEN);
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    assert.ok(r.fee >= 100);

    const tx = Transaction.fromHex(seen);
    const ins = tx.inputs.map((i) => `${i.sourceTXID}:${i.sourceOutputIndex}`);
    assert.deepEqual(ins.slice(0, 2), [`${T1}:0`, `${T2}:1`]);
    assert.ok(!ins.some((s) => s.startsWith(F2)), "inscribed funding skipped");
    assert.equal(tx.outputs.length, 3);
    assert.equal(tx.outputs[0].lockingScript.toHex(), bsv21TransferScript(TO, TOKEN, "1000"));
    assert.equal(tx.outputs[0].satoshis, 1);
    const e0 = parseBsv21Envelope(tx.outputs[0].lockingScript.toHex());
    assert.equal(e0.id, TOKEN);
    assert.equal(e0.amt, "1000");
    const e1 = parseBsv21Envelope(tx.outputs[1].lockingScript.toHex());
    assert.equal(e1.amt, "100");
    assert.equal(BigInt(e0.amt) + BigInt(e1.amt), BigInt(600) + BigInt(500));
    assert.equal(parseBsv21Envelope(tx.outputs[2].lockingScript.toHex()), null);

    const rows = await db("pending_txs").where({ txid: r.txid });
    assert.equal(rows.length, 1);
    assert.match(rows[0].label, /^bsv21 send 1000/);
    const labels = await db("basket_members").where({ txid: r.txid });
    assert.ok(labels.length >= 2); // token change + sat change
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("bsv21 send refuses bad params, unknown tokens, and short balances", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    chain.credit(addr, { txid: T1, vout: 0, value: 1, height: 900 });
    chain.credit(addr, { txid: T2, vout: 1, value: 1, height: 900 });
    chain.credit(addr, { txid: F1, vout: 0, value: 50_000, height: 900 });
    await setPolicy(db, "cli", "allow");
    const base = { db, chain, origin: "cli", tokenId: TOKEN, to: TO, amt: "100", fetchFn };
    await rejectsCode(sendBsv21({ ...base, tokenId: "zzz" }), "BAD_PARAM");
    await rejectsCode(sendBsv21({ ...base, to: "not-an-address" }), "BAD_PARAM");
    await rejectsCode(sendBsv21({ ...base, amt: "1.5" }), "BAD_PARAM");
    await rejectsCode(sendBsv21({ ...base, amt: "0" }), "BAD_PARAM");
    await rejectsCode(sendBsv21({ ...base, tokenId: OTHER }), "NOT_FOUND");
    await rejectsCode(sendBsv21({ ...base, amt: "999999" }), "INSUFFICIENT");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("script/indexer disagreement aborts before signing", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr, { t1amt: "1" });
    const chain = new MockChainProvider();
    chain.credit(addr, { txid: T1, vout: 0, value: 1, height: 900 });
    chain.credit(addr, { txid: F1, vout: 0, value: 50_000, height: 900 });
    await setPolicy(db, "cli", "allow");
    await rejectsCode(
      sendBsv21({ db, chain, origin: "cli", tokenId: TOKEN, to: TO, amt: "100", fetchFn }),
      "RAILS",
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
