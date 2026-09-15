import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { BigNumber, ECDSA, PrivateKey } from "@bsv/sdk";
import { migrate } from "../src/storage.ts";
import {
  certDigest,
  certIdFor,
  getCert,
  listCerts,
  listDisclosures,
  putCert,
  revokeCert,
  showCert,
} from "../src/certs.ts";
import { dispatch, setBackend } from "../src/rpc.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

const issuer = PrivateKey.fromRandom();
const ISSUER = issuer.toPublicKey().toString();
const SUBJECT = PrivateKey.fromRandom().toPublicKey().toString();

function sign(type, certifier, subject, fields) {
  return ECDSA.sign(certDigest(type, certifier, subject, fields), issuer).toDER("hex");
}

const FIELDS = { handle: "satoshi", level: "21" };

test("signed certs verify at put time; id is the canonical hash", async () => {
  const db = await memdb();
  try {
    const sig = sign("twetch-handle", ISSUER, SUBJECT, FIELDS);
    const c = await putCert(db, { type: "twetch-handle", certifier: ISSUER, subject: SUBJECT, fields: FIELDS, signature: sig });
    assert.equal(c.verified, true);
    assert.equal(c.id, certIdFor("twetch-handle", ISSUER, SUBJECT, FIELDS));
    assert.equal(c.valid, true);
    assert.equal((await listCerts(db)).length, 1);
    await assert.rejects(
      putCert(db, { type: "twetch-handle", certifier: ISSUER, subject: SUBJECT, fields: FIELDS, signature: sig }),
      (e) => e.code === "EXISTS",
    );
  } finally {
    await db.destroy();
  }
});

test("tampered fields and wrong keys fail closed", async () => {
  const db = await memdb();
  try {
    const sig = sign("email", ISSUER, SUBJECT, { addr: "a@b.c" });
    await assert.rejects(
      putCert(db, { type: "email", certifier: ISSUER, subject: SUBJECT, fields: { addr: "evil@x.y" }, signature: sig }),
      (e) => e.code === "BAD_SIG",
    );
    const stranger = PrivateKey.fromRandom().toPublicKey().toString();
    await assert.rejects(
      putCert(db, { type: "email", certifier: stranger, subject: SUBJECT, fields: { addr: "a@b.c" }, signature: sig }),
      (e) => e.code === "BAD_SIG",
    );
    await assert.rejects(
      putCert(db, { type: "email", certifier: ISSUER, subject: SUBJECT, fields: { addr: "a@b.c" }, signature: "deadbeef" }),
      (e) => e.code === "BAD_SIG",
    );
  } finally {
    await db.destroy();
  }
});

test("unsigned certs store honestly labeled self-asserted", async () => {
  const db = await memdb();
  try {
    const c = await putCert(db, { type: "nickname", certifier: ISSUER, fields: { name: "bob" } });
    assert.equal(c.verified, false);
    assert.equal(c.subject, "");
    assert.equal(c.valid, true);
  } finally {
    await db.destroy();
  }
});

test("bad shapes rejected: type, keys, fields, expiry", async () => {
  const db = await memdb();
  try {
    const good = { type: "t", certifier: ISSUER, fields: { a: "b" } };
    await assert.rejects(putCert(db, { ...good, type: "BAD TYPE!" }), (e) => e.code === "BAD_PARAM");
    await assert.rejects(putCert(db, { ...good, certifier: "xyz" }), (e) => e.code === "BAD_PARAM");
    await assert.rejects(putCert(db, { ...good, fields: {} }), (e) => e.code === "BAD_PARAM");
    await assert.rejects(putCert(db, { ...good, fields: { a: 1 } }), (e) => e.code === "BAD_PARAM");
    await assert.rejects(putCert(db, { ...good, expiresAt: Date.now() - 1000 }), (e) => e.code === "BAD_PARAM");
    const exp = await putCert(db, { ...good, type: "temp", expiresAt: Date.now() + 40 });
    assert.equal(exp.valid, true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await getCert(db, exp.id)).expired, true);
    assert.equal((await getCert(db, exp.id)).valid, false);
  } finally {
    await db.destroy();
  }
});

test("show discloses only requested fields and logs the audit", async () => {
  const db = await memdb();
  try {
    const sig = sign("profile", ISSUER, SUBJECT, { name: "satoshi", city: "tokyo", age: "49" });
    const c = await putCert(db, {
      type: "profile", certifier: ISSUER, subject: SUBJECT,
      fields: { name: "satoshi", city: "tokyo", age: "49" }, signature: sig,
    });
    const partial = await showCert(db, c.id, { fields: ["name"], to: "demo.app" });
    assert.deepEqual(partial.disclosed, { name: "satoshi" });
    const all = await showCert(db, c.id, {});
    assert.deepEqual(Object.keys(all.disclosed).sort(), ["age", "city", "name"]);
    const log = await listDisclosures(db);
    assert.equal(log.length, 2);
    const full = log.find((d) => d.fields.length === 3);
    assert.deepEqual(full.fields.sort(), ["age", "city", "name"]);
    const demo = log.find((d) => d.to === "demo.app");
    assert.deepEqual(demo.fields, ["name"]);
    assert.equal(demo.certType, "profile");
    await assert.rejects(showCert(db, c.id, { fields: ["missing"] }), (e) => e.code === "BAD_PARAM");
    await assert.rejects(showCert(db, "0".repeat(64), { fields: ["name"] }), (e) => e.code === "NOT_FOUND");
    await revokeCert(db, c.id);
    assert.equal((await getCert(db, c.id)).valid, false);
  } finally {
    await db.destroy();
  }
});

test("cert RPC round-trips and disclosures surface in history", async () => {
  const db = await memdb();
  setBackend({ db, chain: null });
  try {
    const sig = sign("over-18", ISSUER, SUBJECT, { ofAge: "true" });
    const put = await dispatch({
      method: "certPut",
      params: { type: "over-18", certifier: ISSUER, subject: SUBJECT, fields: { ofAge: "true" }, signature: sig },
      id: 1,
    });
    assert.equal(put.result.verified, true);
    const show = await dispatch({ method: "certShow", params: { id: put.result.id, fields: ["ofAge"], to: "club.app" }, id: 2 });
    assert.deepEqual(show.result.disclosed, { ofAge: "true" });
    const hist = await dispatch({ method: "history", id: 3 });
    assert.equal(hist.result.disclosures.length, 1);
    assert.equal(hist.result.disclosures[0].to, "club.app");
    const list = await dispatch({ method: "certList", id: 4 });
    assert.equal(list.result.certs.length, 1);
    const rev = await dispatch({ method: "certRevoke", params: { id: put.result.id }, id: 5 });
    assert.equal(rev.result.revoked, true);
  } finally {
    setBackend(null);
    await db.destroy();
  }
});
