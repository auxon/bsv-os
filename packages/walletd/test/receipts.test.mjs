import { test } from "node:test";
import assert from "node:assert/strict";

// Partitioned keyring namespace (see custody.ts svc()).
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-receipts";
import knex from "knex";
import { PrivateKey } from "@bsv/sdk";
import { migrate } from "../src/storage.ts";
import { __resetCache, createWallet, destroyWallet, hasWallet, identityPubkeyHex } from "../src/custody.ts";
import {
  RECEIPT_TYPE,
  buildReceipt,
  getReceipt,
  issueReceipt,
  listReceipts,
  parseReceiptPayload,
  receiptDetail,
  receiptCanonical,
  receiptDataHex,
  verifyReceipt,
} from "../src/receipts.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

const KEY_A = PrivateKey.fromRandom().toPublicKey().toString();
const ADDR_A = PrivateKey.fromRandom().toPublicKey().toAddress("mainnet");
const TXID = "ab".repeat(32);
const INSCRIBE_TXID = "cd".repeat(32);

function stubReceipt(overrides = {}) {
  return buildReceipt({
    txid: TXID,
    amount: 5000,
    from: KEY_A,
    to: ADDR_A,
    memo: "lunch",
    sign: (m) => `stub:${receiptCanonical({ txid: TXID, amount: 5000, from: KEY_A.toLowerCase(), to: ADDR_A, memo: "lunch", at: 1, requestId: "" }).length}:${m.slice(0, 8)}`,
    at: 1,
    ...overrides,
  });
}

test("payload shape, sanitizing, and strict inputs", () => {
  const receipt = stubReceipt();
  assert.equal(receipt.v, 1);
  assert.equal(receipt.t, RECEIPT_TYPE);
  assert.equal(receipt.amount, 5000);
  assert.equal(receipt.memo, "lunch");

  // Memo pipes/control chars become spaces; length caps at 120.
  const messy = buildReceipt({
    txid: TXID, amount: 1, from: KEY_A, to: ADDR_A,
    memo: `a|b\nc\u0000${"x".repeat(200)}`,
    sign: () => "s",
  });
  assert.equal(messy.memo.startsWith("a b c "), true);
  assert.equal(messy.memo.length, 120);

  assert.throws(() => buildReceipt({ txid: "nope", amount: 1, from: KEY_A, to: ADDR_A }), /txid/);
  assert.throws(() => buildReceipt({ txid: TXID, amount: 0, from: KEY_A, to: ADDR_A }), /positive/);
  assert.throws(() => buildReceipt({ txid: TXID, amount: 1, from: "nope", to: ADDR_A }), /payer identity/);
  assert.throws(() => buildReceipt({ txid: TXID, amount: 1, from: KEY_A, to: "" }), /recipient/);
});

test("parse rejects tampered payloads", () => {
  const receipt = stubReceipt();
  const dataHex = receiptDataHex(receipt);
  const parsed = JSON.parse(Buffer.from(dataHex, "hex").toString("utf8"));
  assert.equal(parsed.sig, receipt.sig);

  // A stub signature never verifies (BSM rejects it) — the guard that keeps
  // forged inscriptions from ever being treated as valid receipts.
  assert.equal(verifyReceipt(receipt), false);
  assert.equal(parseReceiptPayload(dataHex), null);
  assert.equal(parseReceiptPayload("not hex"), null);

  const { sig, ...rest } = receipt;
  assert.equal(typeof receiptCanonical(rest), "string");
  assert.notEqual(
    receiptCanonical({ ...rest, amount: 1 }),
    receiptCanonical(rest),
  );
});

test("receiptDetail exposes the NFT view; unverifiable payloads flag invalid", () => {
  const row = {
    id: INSCRIBE_TXID, paymentTxid: TXID, requestId: "", peer: KEY_A, peerAddress: ADDR_A,
    amount: 5000, memo: "lunch", dataHex: receiptDataHex(stubReceipt()), status: "inscribed", createdAt: 1,
  };
  const detail = receiptDetail(row);
  assert.equal(detail.outpoint, `${INSCRIBE_TXID}:0`);
  assert.equal(detail.contentType, "application/json");
  assert.equal(detail.verified, false); // stub signature never verifies
  assert.equal(detail.payload, null);
  assert.equal(detail.explorer, `https://whatsonchain.com/tx/${INSCRIBE_TXID}`);
});

test("issueReceipt orchestrates inscribe, ledger, and notify", async () => {
  const db = await memdb();
  const calls = { inscribed: [], notified: [] };
  let n = 0;
  const SECOND_TXID = "ef".repeat(32);
  const deps = {
    db,
    selfKey: () => KEY_A,
    sign: () => "stub-sig",
    now: () => 42,
    inscribe: async (opts) => {
      calls.inscribed.push(opts);
      n++;
      return { txid: n === 1 ? INSCRIBE_TXID : SECOND_TXID, fee: 321 };
    },
    notify: async (peer, text) => {
      calls.notified.push({ peer, text });
      return { sent: true };
    },
  };
  try {
    const result = await issueReceipt(deps, {
      txid: TXID,
      amount: 5000,
      memo: "lunch",
      peer: KEY_A,
      peerAddress: ADDR_A,
      requestId: "req-1",
    });
    assert.equal(result.id, INSCRIBE_TXID);
    assert.equal(result.outpoint, `${INSCRIBE_TXID}:0`);
    assert.equal(result.fee, 321);
    assert.equal(result.notified, true);

    // Inscription received the JSON payload and the recipient address.
    assert.equal(calls.inscribed.length, 1);
    assert.equal(calls.inscribed[0].to, ADDR_A);
    assert.equal(calls.inscribed[0].contentType, "application/json");
    assert.match(calls.inscribed[0].label, /^receipt abababababab/);
    const payload = JSON.parse(Buffer.from(calls.inscribed[0].dataHex, "hex").toString("utf8"));
    assert.equal(payload.t, RECEIPT_TYPE);
    assert.equal(payload.amount, 5000);
    assert.equal(payload.memo, "lunch");
    assert.equal(payload.to, KEY_A.toLowerCase());
    assert.equal(payload.requestId, "req-1");
    assert.equal(payload.at, 42);

    // Ledger row + DM.
    const row = await getReceipt(db, INSCRIBE_TXID);
    assert.equal(row.paymentTxid, TXID);
    assert.equal(row.status, "notified");
    assert.equal(row.peer, KEY_A.toLowerCase());
    assert.equal(row.peerAddress, ADDR_A);
    assert.equal(calls.notified.length, 1);
    assert.match(calls.notified[0].text, /Receipt inscribed: 5000 sats/);
    assert.equal((await listReceipts(db)).length, 1);

    // Address-only recipients: no DM, ledger stays inscribed.
    await issueReceipt(deps, { txid: TXID, amount: 1, peerAddress: PrivateKey.fromRandom().toPublicKey().toAddress("mainnet") });
    assert.equal(calls.notified.length, 1);
    assert.equal((await getReceipt(db, SECOND_TXID)).status, "inscribed");
    await assert.rejects(
      issueReceipt(deps, { txid: TXID, amount: 1, peerAddress: "not-an-address" }),
      /P2PKH/,
    );
  } finally {
    await db.destroy();
  }
});

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("signed receipts verify with the real identity key", async () => {
  await createWallet();
  try {
    const self = identityPubkeyHex();
    const receipt = buildReceipt({ txid: TXID, amount: 777, from: self, to: self, memo: "coffee" });
    assert.equal(verifyReceipt(receipt), true);
    const parsed = parseReceiptPayload(receiptDataHex(receipt));
    assert.equal(parsed.amount, 777);
    assert.equal(parsed.from, self.toLowerCase());

    for (const tampered of [
      { ...receipt, amount: 1 },
      { ...receipt, memo: "not coffee" },
      { ...receipt, txid: "ff".repeat(32) },
      { ...receipt, to: ADDR_A },
    ]) {
      assert.equal(verifyReceipt(tampered), false);
    }

    // The panel's view model decodes and verifies the same payload.
    const detail = receiptDetail({
      id: "4b".repeat(32), paymentTxid: TXID, requestId: "", peer: self, peerAddress: ADDR_A,
      amount: 777, memo: "coffee", dataHex: receiptDataHex(receipt), status: "inscribed", createdAt: 1,
    });
    assert.equal(detail.verified, true);
    assert.equal(detail.payload.amount, 777);
    assert.equal(detail.payload.memo, "coffee");
  } finally {
    await destroyWallet();
    __resetCache();
  }
});
