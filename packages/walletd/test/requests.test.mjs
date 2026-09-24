import { test } from "node:test";
import assert from "node:assert/strict";

// Partitioned keyring namespace (see custody.ts svc()).
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-requests";
import knex from "knex";
import { BSM, PrivateKey } from "@bsv/sdk";
import { migrate } from "../src/storage.ts";
import { __resetCache, createWallet, destroyWallet, dmEncrypt, hasWallet, identityPubkeyHex } from "../src/custody.ts";
import { packEnvelope, storeInboundEnvelope } from "../src/msgs.ts";
import {
  REQUEST_PREFIX,
  RECEIPT_PREFIX,
  buildReceipt,
  buildRequest,
  encodeReceipt,
  encodeRequest,
  expireOld,
  findCode,
  getRequest,
  listRequests,
  markDeclined,
  markPaid,
  parseDuration,
  parseReceipt,
  parseRequest,
  payableError,
  recordOutgoing,
  saveIncoming,
  scanInbound,
} from "../src/requests.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

const KEY_A = PrivateKey.fromRandom().toPublicKey().toString();
const ADDR_A = PrivateKey.fromRandom().toPublicKey().toAddress("mainnet");

function stubRequest(overrides = {}) {
  return buildRequest({
    identityKey: KEY_A,
    address: ADDR_A,
    amount: 5000,
    memo: "lunch",
    sign: () => "stub-signature",
    ...overrides,
  });
}

test("codec rejects malformed and mislabeled codes", () => {
  assert.throws(() => parseRequest("hello world"), /payment request code/);
  assert.throws(() => parseRequest(`${REQUEST_PREFIX}not-base64-json`), /BAD_CODE|JSON|version/);
  assert.throws(() => parseRequest(`${REQUEST_PREFIX}${"=".repeat(5000)}`), /too long|BAD_CODE/);
  const receipt = encodeReceipt(buildReceipt({ requestId: "ab".repeat(16), payer: KEY_A, txid: "cd".repeat(32), amount: 1, sign: () => "s" }));
  assert.ok(receipt.startsWith(RECEIPT_PREFIX));
  assert.throws(() => parseRequest(receipt), /payment request code/);
});

test("durations parse and clamp", () => {
  assert.equal(parseDuration(undefined), 7 * 24 * 3600_000);
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("12h"), 12 * 3600_000);
  assert.equal(parseDuration("2d"), 2 * 86_400_000);
  assert.throws(() => parseDuration("90s"), /30m|BAD_PARAM/);
  assert.throws(() => parseDuration("1m"), /between/);
  assert.throws(() => parseDuration("100d"), /between/);
});

test("findCode pulls the first code out of a message", () => {
  const code = `${REQUEST_PREFIX}abc`;
  assert.equal(findCode(`here you go\n${code}\nthanks`), code);
  assert.equal(findCode("no codes here"), null);
  assert.equal(findCode(`${RECEIPT_PREFIX}xy z`), `${RECEIPT_PREFIX}xy`);
});

test("stored request lifecycle: dedupe, expire, pay, decline", async () => {
  const db = await memdb();
  try {
    const request = stubRequest();
    const saved = await saveIncoming(db, request, encodeRequest(request));
    assert.equal(saved.fresh, true);
    assert.equal((await saveIncoming(db, request)).fresh, false); // replay deduped
    assert.equal((await listRequests(db, "in")).length, 1);
    assert.equal(payableError(saved.row), null);

    // Expiry flips lazily and blocks payment.
    await db("payment_requests").where({ id: request.id }).update({ expires_at: Date.now() - 1 });
    assert.equal(await expireOld(db), 1);
    const expired = (await getRequest(db, request.id));
    assert.equal(expired.status, "expired");
    assert.match(payableError(expired), /expired/);

    // Paid rows keep their txid; decline only moves pending rows.
    const second = stubRequest();
    await saveIncoming(db, second);
    const paid = await markPaid(db, second.id, "ef".repeat(32));
    assert.equal(paid.status, "paid");
    assert.equal(paid.txid, "ef".repeat(32));
    assert.equal((await markDeclined(db, second.id)).status, "paid"); // decline never un-pays

    const third = stubRequest();
    const thirdRow = await saveIncoming(db, third);
    assert.equal((await markDeclined(db, third.id)).status, "declined");
    assert.equal(payableError({ ...thirdRow.row, status: "declined" }), "request is declined");
  } finally {
    await db.destroy();
  }
});

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("signed requests verify, tampering fails; receipts round-trip", async () => {
  await createWallet();
  try {
    const self = identityPubkeyHex();
    const request = buildRequest({ identityKey: self, address: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU", amount: 12345, memo: "rent" });
    const parsed = parseRequest(encodeRequest(request));
    assert.equal(parsed.amount, 12345);
    assert.equal(parsed.memo, "rent");
    assert.equal(parsed.identityKey, self.toLowerCase());

    // Any field change invalidates the signature.
    const tampered = [
      { ...request, amount: 999999 },
      { ...request, address: "1FD7HE6R5nymVVa67rosLHmAktvM3sWeeA" },
      { ...request, memo: "not rent" },
      { ...request, id: "ff".repeat(16) },
    ];
    for (const t of tampered) {
      const { sig, ...payload } = t;
      const code = `${REQUEST_PREFIX}${Buffer.from(JSON.stringify({ ...payload, sig })).toString("base64url")}`;
      assert.throws(() => parseRequest(code), /signature/, `tampered ${JSON.stringify(t).slice(0, 40)}`);
    }
    // Another wallet's signature does not pass as ours.
    const other = PrivateKey.fromRandom();
    const forged = buildRequest({
      identityKey: self,
      address: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU",
      amount: 1,
      sign: (m) => BSM.sign(Array.from(Buffer.from(m, "utf8")), other, "base64"),
    });
    assert.throws(() => parseRequest(encodeRequest(forged)), /signature/);

    const receipt = buildReceipt({ requestId: request.id, payer: self, txid: "ab".repeat(32), amount: 12345 });
    const parsedReceipt = parseReceipt(encodeReceipt(receipt));
    assert.equal(parsedReceipt.requestId, request.id);
    assert.throws(
      () => parseReceipt(encodeReceipt({ ...receipt, amount: 1 })),
      /signature/,
    );
  } finally {
    await destroyWallet();
    __resetCache();
  }
});

it("scanInbound imports requests and settles outgoing ones on signed receipts", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const self = identityPubkeyHex();
    const address = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";

    // An incoming message carrying a request from ourselves (self-test).
    const incoming = buildRequest({ identityKey: self, address, amount: 777, memo: "coffee" });
    await storeInboundEnvelope(
      db, "msg-req-1",
      packEnvelope(self, self, dmEncrypt(self, encodeRequest(incoming))),
      "p2p",
    );
    // And an outgoing request we are waiting to be paid.
    const outgoing = buildRequest({ identityKey: self, address, amount: 2500, memo: "tickets" });
    await recordOutgoing(db, outgoing, self);

    const first = await scanInbound(db);
    assert.equal(first.imported, 1);
    assert.equal(first.paid, 0);
    assert.equal((await getRequest(db, incoming.id)).direction, "in");

    // A signed receipt with the wrong amount is ignored; the right one settles.
    const wrong = buildReceipt({ requestId: outgoing.id, payer: self, txid: "11".repeat(32), amount: 1 });
    await storeInboundEnvelope(db, "msg-rcpt-wrong", packEnvelope(self, self, dmEncrypt(self, encodeReceipt(wrong))), "p2p");
    assert.equal((await scanInbound(db)).paid, 0);
    assert.equal((await getRequest(db, outgoing.id)).status, "pending");

    const right = buildReceipt({ requestId: outgoing.id, payer: self, txid: "22".repeat(32), amount: 2500 });
    await storeInboundEnvelope(db, "msg-rcpt-right", packEnvelope(self, self, dmEncrypt(self, encodeReceipt(right))), "p2p");
    const settled = await scanInbound(db);
    assert.equal(settled.paid, 1);
    const paidRow = await getRequest(db, outgoing.id);
    assert.equal(paidRow.status, "paid");
    assert.equal(paidRow.txid, "22".repeat(32));

    // Idempotent: re-scanning imports and settles nothing new.
    const again = await scanInbound(db);
    assert.deepEqual({ imported: again.imported, paid: again.paid }, { imported: 0, paid: 0 });
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
