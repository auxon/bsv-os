import { test } from "node:test";
import assert from "node:assert/strict";

// Partitioned keyring namespace (see custody.ts svc()).
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-p2p";
import { KeyDeriver, PrivateKey, ECDSA, BigNumber, Signature } from "@bsv/sdk";
import {
  P2PNode,
  P2P_APP,
  P2P_PROTOCOL,
  P2P_HANDSHAKE_KEY_ID,
  PeerRegistry,
  custodyP2PCrypto,
  decodeBeacon,
  encodeBeacon,
  handshakeTranscript,
  parsePeerSeeds,
} from "../src/p2p.ts";
import { __resetCache, createWallet, destroyWallet, hasWallet, identityPubkeyHex } from "../src/custody.ts";

const KEY_A = PrivateKey.fromRandom().toPublicKey().toString();

test("beacon codec is strict", () => {
  const b = { v: 1, app: P2P_APP, identityKey: KEY_A, port: 21213 };
  assert.equal(encodeBeacon(b), JSON.stringify(b));
  assert.deepEqual(decodeBeacon(encodeBeacon(b)), { ...b, identityKey: KEY_A.toLowerCase() });
  assert.equal(decodeBeacon("not json"), null);
  assert.equal(decodeBeacon(JSON.stringify({ ...b, v: 2 })), null);
  assert.equal(decodeBeacon(JSON.stringify({ ...b, app: "other" })), null);
  assert.equal(decodeBeacon(JSON.stringify({ ...b, identityKey: "xyz" })), null);
  assert.equal(decodeBeacon(JSON.stringify({ ...b, port: 0 })), null);
  assert.equal(decodeBeacon(JSON.stringify({ ...b, port: 70000 })), null);
  assert.equal(decodeBeacon("x".repeat(1024)), null);
});

test("peer registry tracks freshness and prunes", () => {
  let now = 1_000_000;
  const reg = new PeerRegistry(30_000, () => now);
  reg.observe(KEY_A, "10.0.0.9", 21213);
  assert.equal(reg.online(KEY_A), true);
  assert.equal(reg.online(KEY_A.toLowerCase()), true);
  assert.deepEqual(reg.get(KEY_A), {
    identityKey: KEY_A.toLowerCase(), address: "10.0.0.9", port: 21213, lastSeen: now, online: true,
  });
  now += 31_000;
  assert.equal(reg.online(KEY_A), false);
  assert.equal(reg.get(KEY_A).online, false);
  now += 120_000;
  reg.prune();
  assert.equal(reg.get(KEY_A), null);
  reg.observe("nope", "10.0.0.9", 21213);
  assert.equal(reg.list().length, 0);
});

test("handshake transcript binds role, parties, and both nonces", () => {
  const n1 = "aa".repeat(16);
  const n2 = "bb".repeat(16);
  const pk = KEY_A.toLowerCase();
  const base = handshakeTranscript("initiator", pk, pk, n1, n2);
  assert.equal(base.length, 32);
  assert.deepEqual(handshakeTranscript("initiator", pk, pk, n1, n2), base);
  assert.notDeepEqual(handshakeTranscript("responder", pk, pk, n1, n2), base);
  assert.notDeepEqual(handshakeTranscript("initiator", pk, pk, n2, n1), base);
});

function fakeCrypto(root) {
  const pub = root.toPublicKey().toString();
  const deriver = new KeyDeriver(root);
  return {
    available: () => true,
    identity: () => pub,
    sign: (counterparty, digest) =>
      Buffer.from(
        ECDSA.sign(
          BigNumber.fromString(digest.toString("hex"), 16),
          deriver.derivePrivateKey(P2P_PROTOCOL, P2P_HANDSHAKE_KEY_ID, counterparty),
        ).toDER(),
      ),
    verify: (signer, digest, sig) => {
      try {
        return ECDSA.verify(
          BigNumber.fromString(digest.toString("hex"), 16),
          Signature.fromDER([...sig]),
          deriver.derivePublicKey(P2P_PROTOCOL, P2P_HANDSHAKE_KEY_ID, signer, false),
        );
      } catch {
        return false;
      }
    },
  };
}

/** Deterministic discovery for tests: a hub routes beacons between members. */
class MemoryHub {
  constructor() {
    this.nodes = new Map();
  }
  transport(address = "127.0.0.1") {
    const members = this.nodes;
    const self = {};
    return {
      start: async (cb) => {
        self.cb = cb;
        members.set(self, address);
      },
      send: (raw) => {
        for (const [n, addr] of members) {
          if (n === self) continue;
          queueMicrotask(() => n.cb?.(raw, addr));
        }
      },
      stop: async () => {
        members.delete(self);
      },
    };
  }
}

function waitFor(fn, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try {
        ok = fn();
      } catch {
        ok = false;
      }
      if (ok) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timed out"));
      }
    }, 10);
    timer.unref?.();
  });
}

async function startNode(hub, crypto, onDm) {
  const node = new P2PNode({
    crypto,
    discovery: true,
    transport: hub.transport(),
    port: 0,
    onDm,
    connectTimeoutMs: 1000,
    handshakeTimeoutMs: 1000,
    ackTimeoutMs: 1500,
  });
  await node.start();
  return node;
}

test("two nodes discover each other and deliver an authenticated frame", async () => {
  const hub = new MemoryHub();
  const received = [];
  const a = await startNode(hub, fakeCrypto(PrivateKey.fromRandom()), (id, envelope) => {
    received.push({ id, envelope });
  });
  const b = await startNode(hub, fakeCrypto(PrivateKey.fromRandom()));
  try {
    // B's start beacon is already gone; A announces so B learns A.
    a.announce();
    const aKey = a.status().identityKey;
    await waitFor(() => b.registry.online(aKey));
    assert.equal(b.online(aKey), true);
    assert.equal(b.online(PrivateKey.fromRandom().toPublicKey().toString()), false);

    const peer = b.peers().find((p) => p.identityKey === aKey);
    assert.equal(peer.online, true);
    assert.equal(peer.port, a.port);

    // Deliver B -> A over the discovered address; onDm runs, ack returns true.
    const ok = await b.deliver(aKey, "m-direct-1", { v: 1, from: aKey, to: b.status().identityKey, body: "beef", sentAt: 1 });
    assert.equal(ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].id, "m-direct-1");
    assert.equal(received[0].envelope.body, "beef");
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("a peer that signs with the wrong key is rejected", async () => {
  const hub = new MemoryHub();
  const good = await startNode(hub, fakeCrypto(PrivateKey.fromRandom()));
  const broken = fakeCrypto(PrivateKey.fromRandom());
  broken.sign = () => Array.from(Buffer.alloc(70, 9));
  const bad = await startNode(hub, broken);
  try {
    bad.announce();
    const badKey = bad.status().identityKey;
    await waitFor(() => good.registry.online(badKey));
    const ok = await good.deliver(badKey, "m-bad-1", { v: 1, body: "00" });
    assert.equal(ok, false);
  } finally {
    await good.stop();
    await bad.stop();
  }
});

test("deliver to an undiscovered peer is a clean false", async () => {
  const hub = new MemoryHub();
  const a = await startNode(hub, fakeCrypto(PrivateKey.fromRandom()));
  try {
    const unknown = PrivateKey.fromRandom().toPublicKey().toString();
    assert.equal(await a.deliver(unknown, "m-1", {}), false);
  } finally {
    await a.stop();
  }
});

test("static seeds connect without discovery; bad config is ignored", async () => {
  const key = PrivateKey.fromRandom().toPublicKey().toString();
  assert.deepEqual(parsePeerSeeds(`${key}@10.1.2.3:21213`), [
    { identityKey: key.toLowerCase(), address: "10.1.2.3", port: 21213 },
  ]);
  assert.deepEqual(parsePeerSeeds(`${key}@10.1.2.3:90000, junk, x@y:1, ${key}@h:0`), []);
  assert.deepEqual(parsePeerSeeds(undefined), []);
  assert.deepEqual(parsePeerSeeds(`${key.toUpperCase()}@vpn.internal:21214`), [
    { identityKey: key.toLowerCase(), address: "vpn.internal", port: 21214 },
  ]);

  const received = [];
  const b = new P2PNode({
    crypto: fakeCrypto(PrivateKey.fromRandom()),
    discovery: false,
    port: 0,
    connectTimeoutMs: 1000,
    handshakeTimeoutMs: 1000,
    ackTimeoutMs: 1500,
    onDm: (id, envelope) => {
      received.push({ id, envelope });
    },
  });
  await b.start();
  const bKey = b.status().identityKey;
  const a = new P2PNode({
    crypto: fakeCrypto(PrivateKey.fromRandom()),
    discovery: false,
    port: 0,
    seeds: `${bKey}@127.0.0.1:${b.port}`,
    connectTimeoutMs: 1000,
    handshakeTimeoutMs: 1000,
    ackTimeoutMs: 1500,
  });
  await a.start();
  try {
    assert.equal(a.online(bKey), true);
    assert.equal(a.peers().some((p) => p.identityKey === bKey && p.online), true);
    const ok = await a.deliver(bKey, "m-seed-1", { v: 1, body: "5eed" });
    assert.equal(ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].envelope.body, "5eed");

    // Unreachable seed: clean false (the caller falls back to the relay).
    const deadA = new P2PNode({
      crypto: fakeCrypto(PrivateKey.fromRandom()),
      discovery: false,
      port: 0,
      seeds: `${PrivateKey.fromRandom().toPublicKey().toString()}@127.0.0.1:9`,
      connectTimeoutMs: 500,
      handshakeTimeoutMs: 500,
      ackTimeoutMs: 500,
    });
    await deadA.start();
    const deadKey = [...deadA.peers()][0].identityKey;
    assert.equal(await deadA.deliver(deadKey, "m-dead", {}), false);
    await deadA.stop();
  } finally {
    await a.stop();
    await b.stop();
  }
});

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("custody crypto interoperates with a real BRC-42 peer over the wire", async () => {
  await createWallet();
  try {
    const self = identityPubkeyHex().toLowerCase();
    const hub = new MemoryHub();
    const peerRoot = PrivateKey.fromRandom();
    const received = [];
    const a = new P2PNode({
      crypto: custodyP2PCrypto,
      discovery: true,
      transport: hub.transport(),
      port: 0,
      connectTimeoutMs: 1000,
      handshakeTimeoutMs: 1000,
      ackTimeoutMs: 1500,
      onDm: (id, envelope) => {
        received.push({ id, envelope });
      },
    });
    const b = new P2PNode({
      crypto: fakeCrypto(peerRoot),
      discovery: true,
      transport: hub.transport(),
      port: 0,
      connectTimeoutMs: 1000,
      handshakeTimeoutMs: 1000,
      ackTimeoutMs: 1500,
    });
    await a.start();
    await b.start();
    try {
      b.announce();
      const peerKey = b.status().identityKey;
      await waitFor(() => a.registry.online(peerKey));
      // Custody side initiates: real BRC-42 signing + verification.
      const ok = await a.deliver(peerKey, "m-custody-1", { v: 1, from: self, to: peerKey, body: "cafe", sentAt: 1 });
      assert.equal(ok, true);
      // Peer side initiates back over a fresh session.
      const ok2 = await b.deliver(self, "m-custody-2", { v: 1, from: peerKey, to: self, body: "f00d", sentAt: 2 });
      assert.equal(ok2, true);
      assert.equal(received.length, 1);
      assert.equal(received[0].envelope.body, "f00d");
    } finally {
      await a.stop();
      await b.stop();
    }
  } finally {
    await destroyWallet();
    __resetCache();
  }
});
