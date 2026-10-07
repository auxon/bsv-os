import { test } from "node:test";
import assert from "node:assert/strict";

// Partitioned keyring namespace (see custody.ts svc()).
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-boardsync";
import knex from "knex";
import { BSM, PrivateKey } from "@bsv/sdk";
import { migrate } from "../src/storage.ts";
import { __resetCache, createWallet, destroyWallet, identityPubkeyHex } from "../src/custody.ts";
import { __setRelay, sendDm } from "../src/msgs.ts";
import { addContact } from "../src/people.ts";
import { buildPost, createBoard, encodePostCode, newBoardKeyHex } from "../src/boards.ts";
import { dispatch, setBackend } from "../src/rpc.ts";
import { MockChainProvider } from "../src/chain.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

function fakeRelay() {
  const inbox = [];
  const relay = {
    send: async (to, box, id, envelope) => {
      inbox.push({ messageId: `${id}-relay`, body: envelope });
    },
    list: async () => inbox.slice(),
    ack: async () => {},
    status: async () => ({}),
    register: async () => ({}),
  };
  return { relay, inbox };
}

function foreignSigner() {
  const priv = PrivateKey.fromRandom();
  return {
    priv,
    pub: priv.toPublicKey().toString().toLowerCase(),
    sign: (m) => BSM.sign(Array.from(Buffer.from(m, "utf8")), priv, "base64"),
  };
}

test("boardGet pulls the relay before scanning (no manual msg sync)", async () => {
  const db = await memdb();
  const chain = new MockChainProvider();
  setBackend({ db, chain });
  const f = fakeRelay();
  __setRelay(f.relay);
  try {
    await createWallet();
    const self = identityPubkeyHex();
    const peer = foreignSigner();
    await addContact(db, { name: "peer", identityKey: peer.pub });

    // Board both belong to; post authored + signed by the peer.
    const keyHex = newBoardKeyHex();
    await createBoard(db, {
      name: "sync-test", keyHex, epoch: 1, members: [peer.pub],
    });
    const env = buildPost({
      board: "sync-test", from: peer.pub, agent: "peer-agent",
      keyHex, text: "relay-first post", kind: "note", refs: [],
      sign: peer.sign,
    });

    // The post sits ONLY on the relay (never synced locally): sendDm
    // stores the outbox row + hands the envelope to the relay; the
    // daemon's inbox has nothing until boardGet pulls.
    await sendDm(db, f.relay, self, self, encodePostCode(env));
    assert.equal(f.inbox.length, 1);
    assert.equal((await db("messages").where({ direction: "in" })).length, 0);

    // No manual syncInbox call anywhere: boardGet must pull + ingest.
    const res = await dispatch({ method: "boardGet", params: { board: "sync-test", limit: 10 }, id: 1 });
    assert.ok(!res.error, JSON.stringify(res.error));
    const posts = res.result.posts;
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, env.id);
    assert.equal(posts[0].text, "relay-first post");
  } finally {
    __setRelay(null);
    setBackend(null);
    try { await destroyWallet(); } catch { /* test wallet only */ }
    try { await __resetCache(); } catch { /* test wallet only */ }
    await db.destroy();
  }
});
