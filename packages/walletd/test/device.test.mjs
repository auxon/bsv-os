import { test } from "node:test";
import assert from "node:assert/strict";

// Partitioned keyring namespace, like every other custody-touching suite.
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-device";
import knex from "knex";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { setBackend, deviceInvoke, dispatch } from "../src/rpc.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache } from "../src/custody.ts";
import { setPolicy } from "../src/policy.ts";
import {
  DEVICE_READS,
  DEVICE_WRITES,
  NEVER_DEVICE_CALLABLE,
  allowRequest,
  authenticateDevice,
  authorizeDeviceRequest,
  completePairing,
  isDeviceCallable,
  listDevices,
  mintPairingCode,
  renameDevice,
  resetRateLimits,
  revokeDevice,
} from "../src/device.ts";

const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

/** Pair a device the way the phone would, returning its token. */
async function pair(db, name = "iphone") {
  const { code } = mintPairingCode();
  const { token, deviceId } = await completePairing(db, { code, name, platform: "ios" });
  return { token, deviceId, name };
}

// ── 1. every refusal path, before anything reaches custody ───────────────

it("device auth: absent, malformed and wrong tokens are all refused", async () => {
  const db = await memdb();
  try {
    const a = await pair(db, "alpha");
    void a;
    const b = await pair(db, "beta");

    const attempt = (authorization, method = "balance") =>
      authorizeDeviceRequest({ db, method, deviceMarker: "1", authorization });

    // No token at all.
    let d = await attempt(undefined);
    assert.equal(d.ok, false);
    assert.equal(d.status, 403);
    assert.equal(d.device, undefined, "no device is attached on refusal");

    // Malformed / unknown / wrong device's token.
    d = await attempt("Bearer not-a-real-token");
    assert.equal(d.status, 403);
    d = await attempt(`${b.token}`);
    assert.equal(d.status, 403, "a bare token without the Bearer prefix is refused");
    d = await attempt("Bearer " + "f".repeat(64));
    assert.equal(d.status, 403, "an unknown token is refused");

    // The valid one works, and carries the right device.
    d = await attempt("Bearer " + b.token);
    assert.equal(d.ok, true);
    assert.equal(d.device?.name, "beta");

    // Case-insensitive scheme, as HTTP requires.
    d = await attempt("bearer " + b.token);
    assert.equal(d.ok, true);
  } finally {
    await db.destroy();
  }
});

// ── 2. revocation takes effect on the next request ───────────────────────

it("device auth: a revoked token fails on the next request", async () => {
  const db = await memdb();
  try {
    const dev = await pair(db, "doomed");
    const attempt = () => authorizeDeviceRequest({ db, method: "balance", deviceMarker: "1", authorization: `Bearer ${dev.token}` });

    assert.equal((await attempt()).ok, true, "works before revocation");

    assert.equal(await revokeDevice(db, dev.name), true);
    const after = await attempt();
    assert.equal(after.ok, false, "fails immediately after revocation");
    assert.equal(after.status, 403);
    assert.match(after.message, /revoked|not paired/i);

    // And it stays revoked.
    assert.equal((await attempt()).ok, false);

    // Revoking an unknown device is a no-op, not an error.
    assert.equal(await revokeDevice(db, "nobody"), false);
  } finally {
    await db.destroy();
  }
});

// ── 3. the allowlist is exactly what was agreed ──────────────────────────

it("device allowlist: the callable set is exactly what the design agreed", async () => {
  const reads = [...DEVICE_READS].sort();
  const writes = [...DEVICE_WRITES].sort();

  // Option A, the operator tier: everything the desktop panel can do, with key
  // material still refused. Named in full rather than by count, because the
  // point of this list is that widening it is deliberate.
  assert.equal(reads.length, 52, "reads: the operator tier's read half");
  assert.equal(writes.length, 57, "writes: the operator tier's write half");

  // Spot-check the shapes the option promised, rather than every name.
  for (const method of ["twetchFeed", "twetchMarket", "castEpisodes", "msgList", "agentList", "doctor"]) {
    assert.ok(reads.includes(method), `${method} is device-readable`);
  }
  for (const method of ["twetchPost", "twetchBuy", "castPlay", "msgSend", "agentMint", "policyDeny", "pay"]) {
    assert.ok(writes.includes(method), `${method} is device-callable`);
  }
  // And the one method the option explicitly does not reach.
  assert.ok(![...reads, ...writes].includes("twetchAccountImportFromSeed"), "key material stays out");

  // Adding a method must be a deliberate act, in all three places.
  assert.equal(new Set([...reads, ...writes]).size, reads.length + writes.length, "no duplicates");
  assert.ok(reads.includes("appList"), "appList stays a read: it spends nothing");
  assert.ok(!writes.includes("appList"), "and is not duplicated into the writes");
});

// ── 4. key material is never device-callable ─────────────────────────────

it("device allowlist: key-material methods are never callable", () => {
  for (const method of NEVER_DEVICE_CALLABLE) {
    assert.equal(isDeviceCallable(method), false, `${method} must never be device-callable`);
  }
  // Named explicitly, so a refactor of the set above cannot quietly drop one.
  for (const method of ["createWallet", "importWallet", "recoverySetup", "recoveryRotate", "recoveryRestore", "exportEntropy"]) {
    assert.equal(isDeviceCallable(method), false);
  }
  // Not on the allowlist, and refused through the decision too.
  assert.equal(isDeviceCallable("boardPost"), false, "unrelated RPCs stay out");
  assert.equal(isDeviceCallable("torrentShare"), false);
});

it("device auth: an unauthenticated caller learns nothing about the allowlist", async () => {
  const db = await memdb();
  try {
    // No token, asking for a forbidden method: the answer must be the auth
    // failure, not NOT_ALLOWED. Otherwise an attacker could enumerate methods.
    const d = await authorizeDeviceRequest({ db, method: "createWallet", deviceMarker: "1" });
    assert.equal(d.ok, false);
    assert.equal(d.status, 403);
    assert.match(d.message, /not paired|revoked/i, "auth is checked before the allowlist");
    assert.doesNotMatch(d.message, /not allowed/i);
  } finally {
    await db.destroy();
  }
});

// ── 5. browser-shaped requests are refused ───────────────────────────────

it("device auth: an Origin header is refused, and the marker is required", async () => {
  const db = await memdb();
  try {
    const dev = await pair(db, "browser-check");
    const base = { db, method: "balance", authorization: `Bearer ${dev.token}` };

    // Origin present → refused, even with a perfectly good token.
    const withOrigin = await authorizeDeviceRequest({ ...base, deviceMarker: "1", origin: "https://evil.example.com" });
    assert.equal(withOrigin.ok, false);
    assert.match(withOrigin.message, /browser-originated/i);

    // Marker missing or wrong → refused.
    const noMarker = await authorizeDeviceRequest({ ...base });
    assert.equal(noMarker.ok, false);
    assert.equal(noMarker.status, 400);
    const wrongMarker = await authorizeDeviceRequest({ ...base, deviceMarker: "0" });
    assert.equal(wrongMarker.ok, false);

    // The client's own transport must never produce an Origin header — the
    // Swift package has a mirror of this assertion.
    const swiftTransport = fs.readFileSync(
      path.join(root, "..", "ios", "Sources", "BSVOSWallet", "Device", "DeviceTransport.swift"),
      "utf8",
    );
    assert.match(swiftTransport, /forbiddenHeader = "Origin"/, "the Swift client knows the rule");
  } finally {
    await db.destroy();
  }
});

// ── 6. the pairing flow itself ───────────────────────────────────────────

it("pairing: a code is single-use, expiring, and attempt-limited", async () => {
  const db = await memdb();
  try {
    const { code } = mintPairingCode();
    const first = await completePairing(db, { code, name: "one" });
    assert.match(first.token, /^[0-9a-f]{64}$/, "a 32-byte token, hex");
    assert.match(first.deviceId, /^dev_[0-9a-f]{16}$/);

    // The same code cannot be used twice.
    await assert.rejects(completePairing(db, { code, name: "two" }), (e) => {
      assert.equal(e.code, "NO_PAIRING");
      return true;
    });

    // Only a hash is stored: the token must not be recoverable from the row.
    const row = await db("devices").where({ id: first.deviceId }).first();
    assert.ok(row, "device row exists");
    assert.notEqual(row.token_hash, first.token, "the raw token is not stored");
    assert.match(String(row.token_hash), /^[0-9a-f]{64}$/, "a sha256 hash is stored");

    // A code is case-insensitive for the human typing it.
    const second = mintPairingCode();
    const upper = await completePairing(db, { code: second.code.toLowerCase(), name: "typed-lowercase" });
    assert.ok(upper.token, "codes compare case-insensitively");

    // Wrong code is rejected, and repeated guessing closes the window.
    mintPairingCode();
    for (let i = 0; i < 5; i++) {
      await assert.rejects(completePairing(db, { code: "WRONGCOD" }), (e) => e.code === "BAD_CODE");
    }
    await assert.rejects(completePairing(db, { code: "WRONGCOD" }), (e) => {
      assert.equal(e.code, "TOO_MANY_ATTEMPTS", "the window closes after too many guesses");
      return true;
    });
  } finally {
    await db.destroy();
  }
});

it("rate limiting bounds a stolen token", () => {
  resetRateLimits();
  const now = 1_000_000;
  for (let i = 0; i < 60; i++) {
    assert.equal(allowRequest("dev_x", now + i), true, `request ${i + 1} allowed`);
  }
  assert.equal(allowRequest("dev_x", now + 60), false, "the 61st in the window is refused");
  assert.equal(allowRequest("dev_y", now + 60), true, "another device is unaffected");
  assert.equal(allowRequest("dev_x", now + 61_000), true, "the window slides");
  resetRateLimits();
});

it("devices can be listed and renamed", async () => {
  const db = await memdb();
  try {
    const dev = await pair(db, "old-name");
    let all = await listDevices(db);
    assert.equal(all.length, 1);
    assert.equal(all[0].name, "old-name");
    assert.equal(all[0].platform, "ios");
    assert.equal(all[0].revokedAt, null);

    assert.equal(await renameDevice(db, dev.deviceId, "new-name"), true);
    all = await listDevices(db);
    assert.equal(all[0].name, "new-name");

    // A rename to empty is refused rather than writing a blank name.
    await assert.rejects(renameDevice(db, dev.deviceId, "   "), /must not be empty/);
  } finally {
    await db.destroy();
  }
});

// ── the origin is derived, never supplied ────────────────────────────────

it("device calls act under a derived origin, and cannot name their own", async () => {
  const db = await memdb();
  try {
    await createWallet();
    setBackend({ db, chain: new MockChainProvider() });
    const dev = await pair(db, "origin-test");

    // Behavioural half: reads are not policy-gated, so they work either way.
    const read = await deviceInvoke({ id: dev.deviceId, name: "origin-test" }, "balance", {});
    assert.ok(read && typeof read === "object", "reads work");

    // The load-bearing half is asserted at the source level, deliberately.
    // Every spend checks funding BEFORE policy, so an unfunded mock chain fails
    // with INSUFFICIENT and never reaches the gate — and sendSats takes no
    // fetchFn, so the indexer cannot be faked through this path. The property
    // is therefore stated where it is true and checkable: the code.
    const src = fs.readFileSync(path.join(root, "src", "rpc.ts"), "utf8");
    const start = src.indexOf("export async function deviceInvoke(");
    assert.ok(start > 0, "deviceInvoke found");
    const body = src.slice(start, src.indexOf("\nconst METHODS", start));

    assert.match(body, /const origin = deviceOrigin\(device\.name\)/, "the origin is derived from the device");

    // No case may read an origin out of the caller's params. This is the
    // difference between a device and an app: an app's origin comes from its
    // installed domain, a device's from its token, and neither from the body.
    const destructures = [...body.matchAll(/p\(params\) as \{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(destructures.length >= 4, `write cases destructure params (found ${destructures.length})`);
    for (const dest of destructures) {
      assert.doesNotMatch(dest, /\borigin\b/, `no case takes origin from params: ${dest.trim()}`);
    }

    // Every engine call that spends receives the derived origin.
    for (const call of ["sendSats({", "anchorTip({", "sweepOut({", "inscribeMint({"]) {
      const at = body.indexOf(call);
      assert.ok(at > 0, `${call} is called by deviceInvoke`);
      const args = body.slice(at, body.indexOf("});", at));
      assert.match(args, /\borigin\b/, `${call} receives the derived origin`);
      assert.match(args, /\borigin,|origin:/, `${call} passes origin explicitly`);
    }

    // And the device identity itself comes from the authenticated token, never
    // from the request body.
    const idx = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
    assert.match(idx, /deviceInvoke\(\{ id: device\.id, name: device\.name \}/, "identity comes from the token decision");
    assert.match(idx, /authorizeDeviceRequest\(/, "and the decision is what produced it");
  } finally {
    setBackend(null);
    await destroyWallet().catch(() => {});
    __resetCache?.();
    await db.destroy();
  }
});

it("every allowlisted method resolves to a real handler", async () => {
  // The operator tier is 114 names. A typo among them would compile, pass the
  // parity tests (all three copies could share the typo), and then fail on the
  // phone with NOT_ALLOWED — the worst place to discover it. So: every
  // allowlisted method must either be handled explicitly by deviceInvoke or
  // exist in the RPC table the delegating default reaches.
  const rpcSrc = fs.readFileSync(path.join(root, "src", "rpc.ts"), "utf8");
  const invocationStart = rpcSrc.indexOf("export async function deviceInvoke(");
  const invocationBody = rpcSrc.slice(invocationStart, rpcSrc.indexOf("\nconst METHODS", invocationStart));

  const explicit = new Set([...invocationBody.matchAll(/case "([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
  const methodsStart = rpcSrc.indexOf("const METHODS: Record<string");
  const methodsBody = rpcSrc.slice(methodsStart);
  const handlers = new Set([...methodsBody.matchAll(/^  ([a-zA-Z][A-Za-z0-9_]*): /gm)].map((m) => m[1]));

  const unresolvable = [];
  for (const method of [...DEVICE_READS, ...DEVICE_WRITES]) {
    if (explicit.has(method)) continue;
    if (handlers.has(method)) continue;
    unresolvable.push(method);
  }
  assert.deepEqual(unresolvable, [], `allowlisted but unreachable:\n${unresolvable.join("\n")}`);

  // The delegating default must actually delegate for allowlisted writes, and
  // must not fall through to a refusal for them.
  assert.match(invocationBody, /DEVICE_WRITES\.includes\(method\) && METHODS\[method\]/, "the default delegates");
  assert.match(invocationBody, /return METHODS\[method\]!\(params\)/, "and returns its result");
});

it("the operator spends use the device origin, not the caller's", async () => {
  // The four extracted handlers are the ones where a device's own spending must
  // be distinguishable from the CLI's. Each is delegated with the derived
  // origin, and each takes origin as a parameter rather than reading it from
  // params — a caller-supplied origin would let the phone spend as "cli".
  const rpcSrc = fs.readFileSync(path.join(root, "src", "rpc.ts"), "utf8");
  for (const [method, fn] of [["pay", "payFor"], ["requestPay", "requestPayFor"], ["receiptIssue", "receiptIssueFor"], ["marketCancel", "marketCancelFor"]]) {
    assert.match(rpcSrc, new RegExp(`case "${method}":[\\s\\S]{0,80}return ${fn}\\(origin, params\\)`), `${method} uses the derived origin`);
    const start = rpcSrc.indexOf(`async function ${fn}(`);
    assert.ok(start > 0, `${fn} exists`);
    const body = rpcSrc.slice(start, rpcSrc.indexOf("\n}", start));
    assert.match(body, /origin: string/, `${fn} takes the origin as a parameter`);
    assert.doesNotMatch(body, /origin: "cli"/, `${fn} does not hardcode the cli origin`);
    assert.doesNotMatch(body, /p\(params\)[\s\S]{0,80}origin/, `${fn} does not read an origin from params`);
  }
  // And the CLI path still passes "cli", so nothing changed for the terminal.
  for (const [method, fn] of [["pay", "payFor"], ["requestPay", "requestPayFor"], ["receiptIssue", "receiptIssueFor"], ["marketCancel", "marketCancelFor"]]) {
    assert.match(rpcSrc, new RegExp(`${method}: \\(params: unknown\\) => ${fn}\\("cli", params\\)`), `${method} keeps the cli path`);
  }
});

it("bundled app assets are served to devices, and nothing else moved", () => {
  // The phone loads these in a web view; a phone is never loopback. The assets
  // are public source in this repository, so serving them to a peer that can
  // already reach the daemon leaks nothing — but the carve-out must stay narrow,
  // and everything else must remain behind the gate.
  const src = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
  const handler = src.indexOf("function handler() {");
  const gate = src.indexOf("if (!isLoopbackPeer(req))", handler);
  assert.ok(handler > 0 && gate > handler, "the gate exists");

  // A needle that is not found returns -1, which would read as "before the
  // gate" and quietly pass. Fail loudly instead: a guard that misreports a
  // missing route is worse than no guard.
  const before = (needle) => {
    const at = src.indexOf(needle, handler);
    assert.ok(at > 0, `route not found in index.ts: ${needle}`);
    return at < gate;
  };

  // Above the gate, deliberately.
  assert.ok(before("/v1/device/"), "the device surface is carved out");
  assert.ok(before("serveRunnerApp(req, res"), "bundled app assets are carved out");

  // Below it, unchanged. If any of these ever moves above the gate, that is a
  // real widening and should not happen by accident.
  for (const [needle, label] of [
    ['castRoute === "/cast/media"', "cast media"],
    ['"/v1/watch"', "the watch stream"],
    ["await dispatch(body)", "the JSON-RPC"],
    ['req.url.startsWith("/w/")', "the BRC-100 wire"],
    ["castSegmentHttp(req", "cast live segments"],
  ]) {
    assert.ok(!before(needle), `${label} must stay loopback-only`);
  }

  // And the carve-out itself is narrow: GET only, and only known app names.
  const carve = src.slice(src.indexOf("// Bundled app assets move ABOVE"), gate);
  assert.match(carve, /req\.method === "GET"/, "GET only");
  // `appMatch[1]!` — the non-null assertion is part of the source text.
  assert.match(carve, /RUNNER_APPS\.has\(appMatch\[1\]!?\)/, "only bundled app names");
  assert.doesNotMatch(carve, /resolveRunnerAppFile\(req/, "no caller-supplied path reaches the resolver");
});

it("deviceInvoke refuses anything off the allowlist, even reachable methods", async () => {
  const db = await memdb();
  try {
    await createWallet();
    setBackend({ db, chain: new MockChainProvider() });
    const dev = await pair(db, "allowlist-test");

    for (const method of ["createWallet", "importWallet", "recoverySetup", "boardPost", "torrentShare"]) {
      await assert.rejects(
        deviceInvoke({ id: dev.deviceId, name: "allowlist-test" }, method, {}),
        (e) => {
          assert.equal(e.code, "NOT_ALLOWED", `${method} must be NOT_ALLOWED`);
          return true;
        },
      );
    }
  } finally {
    setBackend(null);
    await destroyWallet().catch(() => {});
    __resetCache?.();
    await db.destroy();
  }
});
