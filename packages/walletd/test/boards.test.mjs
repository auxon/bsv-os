import { test } from "node:test";
import assert from "node:assert/strict";

// Partitioned keyring namespace (see custody.ts svc()).
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-boards";
import knex from "knex";
import { BSM, PrivateKey } from "@bsv/sdk";
import { migrate } from "../src/storage.ts";
import { __resetCache, createWallet, destroyWallet, dmEncrypt, hasWallet, identityPubkeyHex } from "../src/custody.ts";
import { packEnvelope, storeInboundEnvelope } from "../src/msgs.ts";
import { addContact } from "../src/people.ts";
import {
  addMember, buildPost, createBoard, decodeContent, emitPost, encodeBoardKey, encodePostCode, envelopeShape,
  getBoard, getPosts, getThread, ingestPost, listBoards, newBoardKeyHex, parseBoardKey, parsePostCode, publishPost,
  removeBoard, removeMember, rotateBoardKey, scanBoardInbox, verifyPost, waitForPost,
} from "../src/boards.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

const fakeRelay = {
  send: async () => {},
  list: async () => [],
  ack: async () => {},
  status: async () => ({}),
  register: async () => ({}),
};

/** A foreign signer that does not need the daemon wallet. */
function foreignSigner() {
  const priv = PrivateKey.fromRandom();
  return {
    priv,
    pub: priv.toPublicKey().toString().toLowerCase(),
    sign: (m) => BSM.sign(Array.from(Buffer.from(m, "utf8")), priv, "base64"),
  };
}

test("post codec: build, verify, encode, parse, decrypt", () => {
  const signer = foreignSigner();
  const keyHex = newBoardKeyHex();
  const env = buildPost({
    board: "ops",
    from: signer.pub,
    agent: "builder",
    keyHex,
    text: "build 42 green",
    kind: "result",
    refs: ["sha256:abc", "agent:reviewer"],
    sign: signer.sign,
  });
  assert.equal(envelopeShape(env)?.id, env.id);
  assert.equal(verifyPost(env), true);

  const content = decodeContent(env, keyHex);
  assert.deepEqual(content, { text: "build 42 green", kind: "result", refs: ["sha256:abc", "agent:reviewer"], replyTo: "" });

  // Wrong key cannot open it, and tampering invalidates both layers.
  assert.equal(decodeContent(env, newBoardKeyHex()), null);
  assert.equal(verifyPost({ ...env, ct: env.ct.replace(/^../, "00") }), false);
  assert.equal(decodeContent({ ...env, ct: env.ct.replace(/^../, "00") }, keyHex), null);
  assert.equal(verifyPost({ ...env, board: "other" }), false);

  // Code round trip keeps the signature check.
  const code = encodePostCode(env);
  assert.ok(code.startsWith("bsvboard1:"));
  assert.deepEqual(parsePostCode(code), env);
  assert.equal(parsePostCode(`${code}xx`), null);
  assert.equal(parsePostCode("bsvboard1:not-base64"), null);
  assert.equal(parsePostCode(encodePostCode({ ...env, sig: "AA" })), null);
});

test("membership, posters, dedupe, and the unknown-board contact rule", async () => {
  const db = await memdb();
  const keyHex = newBoardKeyHex();
  const outsider = foreignSigner();
  try {
    const board = await createBoard(db, { name: "ops", mode: "members", keyHex });
    assert.deepEqual(board.members, []);

    const post = (from, agent = "builder") =>
      buildPost({ board: "ops", from, agent, keyHex, text: `from ${agent}`, sign: from === outsider.pub ? outsider.sign : undefined });

    // A non-member is refused.
    assert.equal(await ingestPost(db, post(outsider.pub)), null);

    // Once a member (and with an allowed poster), it lands and dedupes.
    await db("boards").where({ name: "ops" }).update({ members: JSON.stringify([outsider.pub]), posters: JSON.stringify(["builder"]) });
    const env = post(outsider.pub);
    const first = await ingestPost(db, env);
    assert.equal(first?.fresh, true);
    assert.equal((await ingestPost(db, env))?.fresh, false);

    // A disallowed agent label is refused.
    const otherAgent = buildPost({ board: "ops", from: outsider.pub, agent: "intruder", keyHex, text: "hi", sign: outsider.sign });
    assert.equal(await ingestPost(db, otherAgent), null);

    // Unknown board: accepted only from a saved contact.
    const stranger = foreignSigner();
    const unknown = buildPost({ board: "ghost", from: stranger.pub, agent: "builder", keyHex, text: "hello", sign: stranger.sign });
    assert.equal(await ingestPost(db, unknown), null);
    await addContact(db, { name: "stranger", identityKey: stranger.pub });
    assert.equal((await ingestPost(db, unknown))?.fresh, true);
    assert.equal((await getBoard(db, "ghost"))?.mode, "members");
  } finally {
    await db.destroy();
  }
});

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("board lifecycle with the wallet: post, read, unread, relay scan, waiters", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const self = identityPubkeyHex().toLowerCase();
    const keyHex = newBoardKeyHex();
    await createBoard(db, { name: "ops", mode: "members", keyHex, members: [self] });

    // Local read cursor: our own post is outbound and never unread.
    const mine = buildPost({ board: "ops", from: self, agent: "cli", keyHex, text: "status: ok" });
    const published = await publishPost(db, fakeRelay, null, mine);
    assert.equal(published.accepted, true);
    let read = await getPosts(db, "ops");
    assert.equal(read.posts.length, 1);
    assert.equal(read.posts[0].direction, "out");
    assert.equal(read.posts[0].text, "status: ok");
    assert.equal((await listBoards(db))[0].unread, 0);

    // A relayed post from a member lands through the inbox scan, once.
    const member = foreignSigner();
    await db("boards").where({ name: "ops" }).update({ members: JSON.stringify([self, member.pub]) });
    const inbound = buildPost({ board: "ops", from: member.pub, agent: "builder", keyHex, text: "artifact ready", refs: ["torrent:abc"], sign: member.sign });
    await storeInboundEnvelope(db, "msg-board-1", packEnvelope(self, self, dmEncrypt(self, encodePostCode(inbound))), "relay");
    const scan = await scanBoardInbox(db, fakeRelay);
    assert.equal(scan.posts, 1);
    assert.equal((await scanBoardInbox(db, fakeRelay)).posts, 0); // deduped; mail already acked
    read = await getPosts(db, "ops");
    assert.equal(read.posts.length, 2);
    assert.equal(read.posts.find((p) => p.id === inbound.id)?.text, "artifact ready");
    assert.equal((await listBoards(db))[0].unread, 0); // getPosts advanced the cursor

    // A key delivered by DM creates the board with the inviter as member.
    const invite = encodeBoardKey("design", newBoardKeyHex(), self);
    await storeInboundEnvelope(db, "msg-board-key", packEnvelope(self, self, dmEncrypt(self, invite)), "relay");
    const keyScan = await scanBoardInbox(db, fakeRelay);
    assert.equal(keyScan.keys, 1);
    assert.ok(await getBoard(db, "design"));

    // Waiters fire on emitted posts and honour filters.
    const waitEnv = buildPost({ board: "ops", from: member.pub, agent: "builder", keyHex, text: "answer", sign: member.sign });
    const pending = waitForPost({ board: "ops", timeoutMs: 2000, matches: (e) => e.id === waitEnv.id });
    emitPost(waitEnv);
    assert.equal((await pending)?.id, waitEnv.id);
    const timedOut = await waitForPost({ board: "ops", timeoutMs: 1000, from: "02".repeat(33) });
    assert.equal(timedOut, null);
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

test("removeBoard clears keys so the same name can be created again", async () => {
  const db = await memdb();
  const keyHex = newBoardKeyHex();
  await createBoard(db, { name: "arch", mode: "open", keyHex });
  await ingestPost(db, buildPost({ board: "arch", from: foreignSigner().pub, agent: "a", keyHex, text: "hi", sign: foreignSigner().sign }));
  assert.equal((await removeBoard(db, "arch")).removed, true);
  const again = await createBoard(db, { name: "arch", mode: "open", keyHex, epoch: 1 });
  assert.equal(again.name, "arch");
  assert.equal((await db("board_keys").where({ board: "arch" })).length, 1);
  assert.equal((await db("board_posts").where({ board: "arch" })).length, 0);
  await db.destroy();
});

test("key rotation: new epochs, old posts readable, removed members locked out", async () => {
  const db = await memdb();
  const keyHex = newBoardKeyHex();
  const member = foreignSigner();
  const outsider = foreignSigner();
  try {
    await createBoard(db, { name: "crew", mode: "members", keyHex, members: [member.pub] });

    // Epoch 1 post from the member: readable with the epoch-1 key.
    const first = buildPost({ board: "crew", from: member.pub, agent: "builder", keyHex, text: "epoch one", sign: member.sign });
    assert.equal((await ingestPost(db, first))?.fresh, true);
    let read = await getPosts(db, "crew");
    assert.equal(read.posts[0].text, "epoch one");
    assert.equal(read.locked, 0);

    // Rotation: adding a member bumps the epoch and delivers the new key.
    const before = await getBoard(db, "crew");
    await addMember(db, "crew", outsider.pub);
    const rotated = await rotateBoardKey(db, "crew");
    const after = await getBoard(db, "crew");
    assert.equal(rotated.epoch, before.epoch + 1);
    assert.equal(after.epoch, rotated.epoch);
    assert.notEqual(after.keyHex, before.keyHex);

    // New-epoch post is readable by the board (key history), and the old
    // post still reads under its epoch.
    const second = buildPost({ board: "crew", from: member.pub, agent: "builder", keyHex: rotated.keyHex, epoch: rotated.epoch, text: "epoch two", sign: member.sign });
    assert.equal((await ingestPost(db, second))?.fresh, true);
    read = await getPosts(db, "crew");
    assert.deepEqual(read.posts.map((p) => p.text), ["epoch one", "epoch two"]);
    assert.equal(read.locked, 0);

    // The newcomer holds only the new key: old post stays locked for them.
    assert.equal(decodeContent(first, rotated.keyHex), null);
    assert.equal(decodeContent(second, rotated.keyHex)?.text, "epoch two");

    // Kick: membership drops and the key rotates again for those left.
    const kicked = await removeMember(db, "crew", outsider.pub);
    assert.equal(kicked.members.includes(outsider.pub), false);
    assert.equal(kicked.epoch, rotated.epoch + 1);
    // A post from the removed member is refused under the new membership.
    const fromOutsider = buildPost({ board: "crew", from: outsider.pub, agent: "builder", keyHex: kicked.keyHex, epoch: kicked.epoch, text: "let me in", sign: outsider.sign });
    assert.equal(await ingestPost(db, fromOutsider), null);
  } finally {
    await db.destroy();
  }
});

test("threads assemble root plus descendants in order", async () => {
  const db = await memdb();
  const keyHex = newBoardKeyHex();
  const signer = foreignSigner();
  try {
    await createBoard(db, { name: "crew", mode: "members", keyHex, members: [signer.pub] });
    const env = (text, replyTo = "") =>
      buildPost({ board: "crew", from: signer.pub, agent: "builder", keyHex, text, replyTo, sign: signer.sign });
    const root = env("root question");
    const a = env("first answer", root.id);
    const b = env("second answer", root.id);
    const sub = env("follow-up", a.id);
    for (const post of [root, a, sub, b]) assert.equal((await ingestPost(db, post))?.fresh, true);

    const thread = await getThread(db, root.id);
    assert.equal(thread.board, "crew");
    assert.deepEqual(thread.posts.map((p) => p.text), ["root question", "first answer", "follow-up", "second answer"]);
    assert.equal(thread.posts[0].replyTo, "");
    assert.equal(thread.posts.find((p) => p.text === "follow-up").replyTo, a.id);
    assert.equal(thread.locked, 0);

    // A reply whose parent is unknown is not attached; unknown ids are null.
    assert.equal(await getThread(db, "ab".repeat(16)), null);
  } finally {
    await db.destroy();
  }
});
