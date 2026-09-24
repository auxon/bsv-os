import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { PrivateKey } from "@bsv/sdk";
import { migratePeople } from "../src/people.ts";
import {
  addContact,
  announcedName,
  cleanAnnounceName,
  getContact,
  learnAddress,
  listContacts,
  profileName,
  rememberAnnouncedName,
  removeContact,
  resolvePerson,
  setProfileName,
  slugName,
  validPayTo,
} from "../src/people.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migratePeople(db);
  return db;
}

const KEY_A = PrivateKey.fromRandom().toPublicKey().toString();
const KEY_B = PrivateKey.fromRandom().toPublicKey().toString();
const ADDR_A = PrivateKey.fromRandom().toPublicKey().toAddress("mainnet");
const ADDR_B = PrivateKey.fromRandom().toPublicKey().toAddress("mainnet");
const BARE = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";

test("names normalize and reject junk", () => {
  assert.equal(slugName("@Richard"), "richard");
  assert.equal(slugName("Richard A. Hein"), "richard-a-hein");
  assert.equal(slugName("--ana--"), "ana");
  assert.throws(() => slugName("a"), /BAD_PARAM|letters|digits/);
  assert.equal(cleanAnnounceName("  Rich\u0000ard  "), "Richard");
  assert.equal(cleanAnnounceName("x".repeat(80)).length, 24);
});

test("addresses validate as P2PKH only", () => {
  assert.equal(validPayTo(BARE), true);
  assert.equal(validPayTo(""), false);
  assert.equal(validPayTo(KEY_A), false);
  assert.equal(validPayTo("not-an-address"), false);
});

test("contacts add/list/update/remove with address learning", async () => {
  const db = await memdb();
  try {
    const c = await addContact(db, { name: "@Ana", identityKey: KEY_A, note: "neighbour" });
    assert.equal(c.name, "ana");
    assert.equal(c.display, "Ana");
    assert.equal(c.identityKey, KEY_A.toLowerCase());
    assert.equal(c.address, "");
    assert.equal(c.note, "neighbour");
    assert.equal((await listContacts(db)).length, 1);

    // Update by add: same slug, new key/address.
    const u = await addContact(db, { name: "ana", identityKey: KEY_B, address: ADDR_B });
    assert.equal(u.identityKey, KEY_B.toLowerCase());
    assert.equal(u.address, ADDR_B);

    // learnAddress only fills empty addresses.
    await learnAddress(db, KEY_B, ADDR_A);
    assert.equal((await getContact(db, "ana")).address, ADDR_B);
    await addContact(db, { name: "bo", identityKey: KEY_A, address: "" });
    await learnAddress(db, KEY_A, ADDR_A);
    assert.equal((await getContact(db, "bo")).address, ADDR_A);
    await learnAddress(db, KEY_A, "garbage");
    assert.equal((await getContact(db, "bo")).address, ADDR_A);

    await assert.rejects(addContact(db, { name: "bad", identityKey: "xyz" }), /BAD_PARAM|pubkey/);
    await assert.rejects(addContact(db, { name: "bad", identityKey: KEY_A, address: "nope" }), /BAD_PARAM|P2PKH/);

    assert.deepEqual(await removeContact(db, "@Bo"), { removed: true });
    assert.deepEqual(await removeContact(db, "bo"), { removed: false });
    assert.equal((await listContacts(db)).length, 1);
  } finally {
    await db.destroy();
  }
});

test("profile name persists and feeds the beacon cache", async () => {
  const db = await memdb();
  try {
    assert.equal(await profileName(db), "");
    assert.equal(announcedName(), "");
    assert.deepEqual(await setProfileName(db, "  bsv-air "), { name: "bsv-air" });
    assert.equal(await profileName(db), "bsv-air");
    assert.equal(announcedName(), "bsv-air");
    rememberAnnouncedName("");
    await assert.rejects(setProfileName(db, "x"), /visible characters/);
  } finally {
    await db.destroy();
  }
});

test("resolvePerson handles @name, bare name, key, address, and live peers", async () => {
  const db = await memdb();
  try {
    await addContact(db, { name: "ana", identityKey: KEY_A, address: ADDR_A });
    const byName = await resolvePerson(db, "@Ana");
    assert.equal(byName.identityKey, KEY_A.toLowerCase());
    assert.equal(byName.address, ADDR_A);
    assert.equal((await resolvePerson(db, "ana")).name, "ana");
    assert.equal((await resolvePerson(db, KEY_A.toUpperCase())).name, "ana");
    assert.equal((await resolvePerson(db, KEY_B)).name, "");

    const byAddr = await resolvePerson(db, ADDR_B);
    assert.equal(byAddr.address, ADDR_B);
    assert.equal(byAddr.identityKey, "");

    // Live peer with a verified name resolves without a contact row.
    const live = [{ identityKey: KEY_B.toLowerCase(), name: "Cara", payTo: ADDR_B, nameVerified: true }];
    const peer = await resolvePerson(db, "@cara", live);
    assert.equal(peer.identityKey, KEY_B.toLowerCase());
    assert.equal(peer.address, ADDR_B);
    // Unverified names never resolve.
    await assert.rejects(
      resolvePerson(db, "@cara", [{ identityKey: KEY_B.toLowerCase(), name: "Cara", payTo: ADDR_B, nameVerified: false }]),
      /no person named/,
    );
    await assert.rejects(resolvePerson(db, "@nobody"), /no person named/);
    await assert.rejects(resolvePerson(db, "   "), /who required|letters|digits/);
  } finally {
    await db.destroy();
  }
});
