import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { createVerify, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/storage.ts";
import { setPolicy } from "../src/policy.ts";
import { onRequestCreated } from "../src/policy.ts";
import {
  ApnsTokenProvider,
  apnsConfigFromEnv,
  approvalPushContent,
  sendToDevices,
} from "../src/push.ts";
import { completePairing, forgetPushToken, mintPairingCode, pushTargets, setDevicePushToken } from "../src/device.ts";

test("walletd sources stay erasable-syntax-only", () => {
  // `tsc` accepts parameter properties; the strip-types test loader does not,
  // so a parameter property passes typecheck and the build, then fails at
  // import time the first time a test touches the module. I hit exactly that
  // with ApnsTokenProvider. This guard says so in one place instead of in the
  // handoff notes.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const offenders = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".ts")) continue;
    const source = fs.readFileSync(path.join(dir, entry), "utf8");
    // constructor(private x: T) / (public readonly x) / (protected x)
    for (const m of source.matchAll(/constructor\s*\(([^)]*)\)/g)) {
      if (/\b(private|public|protected|readonly)\b/.test(m[1])) {
        offenders.push(`${entry}: ${m[1].trim().slice(0, 60)}`);
      }
    }
    // enums and namespaces are not erasable either.
    if (/^\s*(export\s+)?enum\s/.test(source)) offenders.push(`${entry}: enum`);
    if (/^\s*(export\s+)?namespace\s/.test(source)) offenders.push(`${entry}: namespace`);
  }
  assert.deepEqual(offenders, [], `non-erasable syntax:\n${offenders.join("\n")}`);
});

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

async function paired(db, name = "phone") {
  const { code } = mintPairingCode();
  return completePairing(db, { code, name, platform: "ios" });
}

/** Records what would have gone to Apple. */
function recordingTransport(result = { ok: true, status: 200 }) {
  const sent = [];
  return {
    sent,
    transport: {
      async send(message, authorization) {
        sent.push({ message, authorization });
        return typeof result === "function" ? result(message) : result;
      },
    },
  };
}

test("push: a token is stored, listed, and cleared", async () => {
  const db = await memdb();
  try {
    const device = await paired(db, "pixel-free");
    assert.deepEqual(await pushTargets(db), [], "no token yet, so nothing to push to");

    const token = "ab".repeat(32);
    assert.equal(await setDevicePushToken(db, device.deviceId, token), true);
    assert.deepEqual(await pushTargets(db), [{ id: device.deviceId, apnsToken: token }]);

    // Registering again replaces rather than duplicating.
    const second = "cd".repeat(32);
    await setDevicePushToken(db, device.deviceId, second);
    assert.deepEqual(await pushTargets(db).then((t) => t.map((x) => x.apnsToken)), [second]);

    // A null token unsubscribes.
    await setDevicePushToken(db, device.deviceId, null);
    assert.deepEqual(await pushTargets(db), []);
  } finally {
    await db.destroy();
  }
});

test("push: a revoked device is not pushed to, and dead tokens are forgotten", async () => {
  const db = await memdb();
  try {
    const live = await paired(db, "live");
    const dead = await paired(db, "dead");
    await setDevicePushToken(db, live.deviceId, "11".repeat(32));
    await setDevicePushToken(db, dead.deviceId, "22".repeat(32));
    assert.equal((await pushTargets(db)).length, 2);

    // Revoking on the desktop stops the pushes too — the phone should not keep
    // receiving approval prompts for a wallet it no longer has access to.
    const { revokeDevice } = await import("../src/device.ts");
    await revokeDevice(db, dead.deviceId);
    const targets = await pushTargets(db);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].apnsToken, "11".repeat(32));

    // Apple's 410 means the token will never work; forget it.
    await forgetPushToken(db, "11".repeat(32));
    assert.deepEqual(await pushTargets(db), []);
  } finally {
    await db.destroy();
  }
});

test("push: a malformed token is refused rather than stored", async () => {
  const db = await memdb();
  try {
    const device = await paired(db);
    await assert.rejects(setDevicePushToken(db, device.deviceId, "not-hex"), (e) => {
      assert.equal(e.code, "BAD_PARAM");
      return true;
    });
    assert.deepEqual(await pushTargets(db), []);
  } finally {
    await db.destroy();
  }
});

test("push: the message says what is waiting, and collapses per origin", () => {
  const content = approvalPushContent({ origin: "pocketpets.entangleit.com", amountSats: 1200, action: "app-spend" });
  assert.equal(content.title, "Spend request waiting");
  assert.match(content.body, /pocketpets\.entangleit\.com wants 1200 sats/);
  assert.match(content.body, /app-spend/);
  assert.equal(content.userInfo.origin, "pocketpets.entangleit.com");
  assert.equal(content.userInfo.amountSats, 1200);
  assert.equal(content.userInfo.kind, "approval", "the app keys its actions off this");
  assert.equal(content.collapseId, "approval:pocketpets.entangleit.com", "one notification per origin");

  // A zero-amount ask reads sensibly rather than saying "0 sats".
  assert.match(approvalPushContent({ origin: "x.com", amountSats: 0, action: "anchor" }).body, /no fixed amount/);
});

test("push: delivery is per device and never throws", async () => {
  const { sent, transport } = recordingTransport();
  const devices = [
    { id: "a", apnsToken: "aa".repeat(32) },
    { id: "b", apnsToken: "bb".repeat(32) },
  ];
  const result = await sendToDevices(transport, "jwt-token", devices, approvalPushContent({ origin: "x", amountSats: 5, action: "send" }));
  assert.deepEqual({ sent: result.sent, failed: result.failed }, { sent: 2, failed: 0 });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].authorization, "jwt-token");
  assert.notEqual(sent[0].message.deviceToken, sent[1].message.deviceToken, "one push per device");

  // A transport that throws must not take the caller down with it.
  const exploded = { async send() { throw new Error("network down"); } };
  const survived = await sendToDevices(exploded, "jwt", devices, approvalPushContent({ origin: "x", amountSats: 1, action: "send" }));
  assert.equal(survived.failed, 2);
  assert.equal(survived.sent, 0);
});

test("push: Apple's rejection of a token is reported so it can be pruned", async () => {
  const { transport } = recordingTransport({ ok: false, status: 410, detail: "Unregistered" });
  const result = await sendToDevices(
    transport, "jwt",
    [{ id: "a", apnsToken: "aa".repeat(32) }],
    approvalPushContent({ origin: "x", amountSats: 1, action: "send" }),
  );
  assert.equal(result.failed, 1);
  assert.deepEqual(result.deadTokens, ["aa".repeat(32)], "the dead token is named");

  // A transient failure must NOT be treated as a dead token.
  const transient = recordingTransport({ ok: false, status: 503, detail: "Service Unavailable" });
  const retryable = await sendToDevices(
    transient.transport, "jwt",
    [{ id: "a", apnsToken: "aa".repeat(32) }],
    approvalPushContent({ origin: "x", amountSats: 1, action: "send" }),
  );
  assert.deepEqual(retryable.deadTokens, [], "a 503 is not a dead token");
});

test("push: the provider token is an ES256 JWT, cached rather than re-signed", () => {
  // A real P-256 key, so the signature is actually produced.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const config = { keyId: "KEYID12345", teamId: "TEAM123456", privateKey: pem, topic: "com.example.app" };

  let now = 1_700_000_000_000;
  const provider = new ApnsTokenProvider(config, () => now);
  const first = provider.token();

  const [header, claims, signature] = first.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "ES256");
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).kid, "KEYID12345");
  const claimSet = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(claimSet.iss, "TEAM123456");
  assert.equal(claimSet.iat, 1_700_000_000, "iat in seconds, not milliseconds");
  assert.equal(Buffer.from(signature, "base64url").length, 64, "ES256 signature is r||s, 64 bytes");

  // Apple throttles token regeneration, so it is cached...
  assert.equal(provider.token(), first, "reused while fresh");
  // ...but must be refreshed before the hour is out.
  now += 51 * 60 * 1000;
  assert.notEqual(provider.token(), first, "refreshed after 50 minutes");
});

test("push: an unconfigured environment disables push instead of failing", () => {
  assert.equal(apnsConfigFromEnv({}), null);
  assert.equal(apnsConfigFromEnv({ BSV_APNS_KEY_ID: "k", BSV_APNS_TEAM_ID: "t" }), null, "a partial config is no config");
  assert.equal(
    apnsConfigFromEnv({ BSV_APNS_KEY_ID: "k", BSV_APNS_TEAM_ID: "t", BSV_APNS_TOPIC: "b", BSV_APNS_KEY_P8: "/nope/missing.p8" }),
    null,
    "an unreadable key is no config"
  );
});

test("push: a queued approval reaches the listener, and a listener that throws does not", async () => {
  const db = await memdb();
  try {
    const seen = [];
    onRequestCreated((request) => seen.push(request));

    // An unknown origin asks: the policy engine queues a request.
    await setPolicy(db, "someapp.example", "ask");
    const { check } = await import("../src/policy.ts");
    await check(db, "someapp.example", 500, "app-spend");

    assert.equal(seen.length, 1, "the listener fired exactly once");
    assert.deepEqual(seen[0], { origin: "someapp.example", amountSats: 500, action: "app-spend" });

    // Asking again for the same origin+action must NOT re-notify: the request
    // already exists, and a push per attempt would be a nuisance, not a signal.
    await check(db, "someapp.example", 500, "app-spend");
    assert.equal(seen.length, 1, "no duplicate notification for an existing request");

    // A listener that throws must not break the spend path.
    onRequestCreated(() => { throw new Error("push exploded"); });
    await setPolicy(db, "another.example", "ask");
    await check(db, "another.example", 100, "app-spend");
  } finally {
    onRequestCreated(null);
    await db.destroy();
  }
});

test("push: sendToDevices with no devices is a no-op, not an error", async () => {
  const { sent, transport } = recordingTransport();
  const result = await sendToDevices(transport, "jwt", [], approvalPushContent({ origin: "x", amountSats: 1, action: "send" }));
  assert.deepEqual({ sent: result.sent, failed: result.failed }, { sent: 0, failed: 0 });
  assert.equal(sent.length, 0);
});

// A signing sanity check that does not depend on Apple: the JWT our provider
// makes must verify against the public key.
test("push: the provider token verifies against the public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const provider = new ApnsTokenProvider({ keyId: "k", teamId: "t", privateKey: pem, topic: "b" });
  const [header, claims, signature] = provider.token().split(".");

  const verifier = createVerify("SHA256");
  verifier.update(`${header}.${claims}`);
  verifier.end();
  const ok = verifier.verify({ key: publicKey.export({ type: "spki", format: "pem" }).toString(), dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"));
  assert.equal(ok, true, "Apple can verify what we signed");
});
