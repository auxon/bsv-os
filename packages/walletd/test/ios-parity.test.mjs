import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Swift client must not drift from the wallet it talks to. Everything here
// is a cross-check between two artifacts that are edited by hand on different
// machines: the daemon's wire table, the iOS design doc, and the Swift source.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const indexTs = read("packages/walletd/src/index.ts");
const swiftCall = read("packages/ios/Sources/BSVOSWallet/BRC100/Call.swift");
const swiftAllowlist = read("packages/ios/Sources/BSVOSWallet/Device/DeviceAllowlist.swift");
const iosDoc = read("docs/ios.md");

test("the Swift call surface matches the daemon's WIRE_CALL_CODES exactly", () => {
  const table = /const WIRE_CALL_CODES: Record<string, number> = \{([\s\S]*?)\n\};/.exec(indexTs);
  assert.ok(table, "WIRE_CALL_CODES found in index.ts");
  const daemon = new Set([...table[1].matchAll(/^\s+([a-zA-Z]+):\s*\d+/gm)].map((m) => m[1]));

  const enumBody = /public enum BRC100Call: String[\s\S]*?\{\n([\s\S]*?)\n\n/.exec(swiftCall);
  assert.ok(enumBody, "BRC100Call enum found");
  const swift = new Set([...enumBody[1].matchAll(/^\s+case ([a-zA-Z]+)$/gm)].map((m) => m[1]));

  assert.ok(daemon.size >= 28, `daemon exposes ${daemon.size} calls`);
  const missingInSwift = [...daemon].filter((c) => !swift.has(c));
  const extraInSwift = [...swift].filter((c) => !daemon.has(c));
  assert.deepEqual(missingInSwift, [], "every daemon call must exist in Swift");
  assert.deepEqual(extraInSwift, [], "Swift must not invent calls the daemon lacks");
  assert.equal(swift.size, daemon.size, "call counts match");
});

test("the Swift wire codes match the daemon's numbers", () => {
  const table = /const WIRE_CALL_CODES: Record<string, number> = \{([\s\S]*?)\n\};/.exec(indexTs)[1];
  const daemon = new Map([...table.matchAll(/^\s+([a-zA-Z]+):\s*(\d+)/gm)].map((m) => [m[1], Number(m[2])]));

  // Parse the explicit switch in Call.swift: `case .name: return N`.
  const codes = new Map([...swiftCall.matchAll(/case \.([a-zA-Z]+): return (\d+)/g)].map((m) => [m[1], Number(m[2])]));
  assert.equal(codes.size, daemon.size, "every call has an explicit wire code");

  for (const [name, code] of daemon) {
    assert.equal(codes.get(name), code, `${name} must be wire code ${code}`);
  }
});

test("the device allowlist matches between the daemon and the Swift exactly", () => {
  // The doc used to carry the full list and was parsed here. At 109 names that
  // was duplication rather than documentation, so the two enforcement points are
  // compared directly and the doc is checked for its counts (below).
  const deviceTs = read("packages/walletd/src/device.ts");
  const daemonSet = (name) => {
    const m = new RegExp(`export const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\n\\];`).exec(deviceTs);
    assert.ok(m, `${name} found in device.ts`);
    const body = m[1].split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    return new Set([...body.matchAll(/"([A-Za-z0-9]+)"/g)].map((x) => x[1]));
  };
  const swiftSet = (name) => {
    const swift = read("packages/ios/Sources/BSVOSWallet/Device/DeviceAllowlist.swift");
    const m = new RegExp(`static let ${name}: Set<String> = \\[([\\s\\S]*?)\\n    \\]`).exec(swift);
    assert.ok(m, `DeviceAllowlist.${name} found`);
    return new Set([...m[1].matchAll(/"([A-Za-z0-9]+)"/g)].map((x) => x[1]));
  };

  for (const [daemonName, swiftName] of [
    ["DEVICE_READS", "reads"],
    ["DEVICE_WRITES", "writes"],
    ["NEVER_DEVICE_CALLABLE", "neverDeviceCallable"],
  ]) {
    const daemon = daemonSet(daemonName);
    const swift = swiftSet(swiftName);
    assert.deepEqual([...daemon].sort(), [...swift].sort(), `${daemonName}: daemon vs Swift`);
  }

  // The counts are what the doc states, so a doc that drifts is caught here.
  const reads = daemonSet("DEVICE_READS").size;
  const writes = daemonSet("DEVICE_WRITES").size;
  assert.ok(iosDoc.includes(`${reads} methods`) || iosDoc.includes(`**${reads}**`), `doc states the read count (${reads})`);
  assert.ok(iosDoc.includes(`**${reads + writes}**`) || iosDoc.includes(`${reads + writes} methods`), `doc states the total (${reads + writes})`);
});

test("the iOS window.bsv surface matches the desktop runner's exactly", () => {
  // Apps are written against window.bsv and must run unmodified on both hosts.
  // The iOS host injects its own shim (messageHandlers instead of the desktop's
  // content script + loopback relay), so the method list is the part that has
  // to agree — and a missing one would fail inside a web page, where it is
  // hardest to notice.
  const desktop = read("packages/runner/extension/page.js");
  const iosHost = read("packages/ios/Sources/BSVOSWallet/Apps/AppHostView.swift");

  const methodsOf = (source, opener) => {
    const start = source.indexOf(opener);
    assert.ok(start > 0, `found ${opener}`);
    // Up to the closing of the object literal.
    const body = source.slice(start, source.indexOf("});", start));
    return new Set([...body.matchAll(/^\s*([a-zA-Z]+):/gm)].map((m) => m[1]));
  };

  const desktopApi = methodsOf(desktop, "window.bsv = Object.freeze({");
  const iosApi = methodsOf(iosHost, "window.bsv = Object.freeze({");

  // The snapshots differ in transport but not in surface.
  const missingOnIOS = [...desktopApi].filter((m) => !iosApi.has(m));
  const extraOnIOS = [...iosApi].filter((m) => !desktopApi.has(m));
  assert.deepEqual(missingOnIOS, [], "every desktop method must exist on iOS");
  assert.deepEqual(extraOnIOS, [], "iOS must not add surface the desktop lacks");

  // The two markers an app uses to detect the runner.
  for (const [name, source] of [["desktop", desktop], ["ios", iosHost]]) {
    assert.match(source, /isBSVOS/, `${name} exposes isBSVOS`);
    assert.match(source, /version:/, `${name} exposes version`);
    assert.match(source, /data-bsvos/, `${name} sets the data-bsvos attribute`);
  }

  // The iOS host must NOT reintroduce the desktop's relay: there is no token in
  // a URL fragment and no loopback HTTP bridge to leak.
  assert.doesNotMatch(iosHost, /bsv-token/, "no fragment token on iOS");
  assert.doesNotMatch(iosHost, /127\.0\.0\.1/, "no loopback relay on iOS");
});

test("the iOS bridge refuses device-only powers to apps", () => {
  // unlock/send/policyApprove are device-callable (the phone may do them) but
  // must never be app-callable: an app asks to spend through its own origin
  // policy instead of moving sats itself.
  const appIntent = read("packages/ios/Sources/BSVOSWallet/Apps/AppIntent.swift");
  const cases = new Set([...appIntent.matchAll(/^\s*case ([a-zA-Z]+)$/gm)].map((m) => m[1]));

  const rpc = read("packages/walletd/src/rpc.ts");
  const start = rpc.indexOf("  appInvoke: async");
  const body = rpc.slice(start, rpc.indexOf("\n  },", start));
  const daemon = new Set([...body.matchAll(/case "([a-zA-Z]+)"/g)].map((m) => m[1]));

  assert.deepEqual([...cases].sort(), [...daemon].sort(), "the app intent list matches appInvoke exactly");

  for (const forbidden of ["unlock", "lock", "send", "sweepOut", "policyApprove", "policyDeny", "createWallet"]) {
    assert.ok(!cases.has(forbidden), `${forbidden} must not be an app intent`);
  }
});

test("key-material methods are excluded by name, in both the doc and the Swift", () => {
  // The doc names them explicitly in prose; the Swift holds them as data.
  // The bullet wraps across lines, so capture the whole paragraph.
  const neverLine = /- \*\*Key-material methods are never device-callable\*\*:([\s\S]*?)\n\n/.exec(iosDoc);
  assert.ok(neverLine, "the doc states the rule");
  const named = [...neverLine[1].matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1]);
  assert.ok(named.length >= 2, `the doc names key-material methods (found ${named.length})`);

  const never = /static let neverDeviceCallable: Set<String> = \[([\s\S]*?)\n    \]/.exec(swiftAllowlist)[1];
  const swiftNever = new Set([...never.matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]));
  for (const name of named) {
    // The doc writes "`recoverySetup`/`Rotate`/`Restore`" for brevity, so accept
    // either the literal name or its recovery-prefixed form.
    const ok = swiftNever.has(name) || swiftNever.has(`recovery${name}`);
    assert.ok(ok, `${name} must be in neverDeviceCallable`);
  }
  // And the two sets cannot overlap, whatever anyone adds later.
  const all = /static let reads: Set<String> = \[([\s\S]*?)\n    \]/.exec(swiftAllowlist)[1]
    + /static let writes: Set<String> = \[([\s\S]*?)\n    \]/.exec(swiftAllowlist)[1];
  const callable = new Set([...all.matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]));
  for (const name of swiftNever) {
    assert.ok(!callable.has(name), `${name} cannot be both callable and forbidden`);
  }
});

test("key material stays in the custody core and never reaches a page", () => {
  // The first version of this test forbade key material anywhere in the Swift
  // package, because Phase 0 kept custody on the daemon. That premise was
  // deliberately replaced: the iOS wallet is standalone now (S1-S3 in
  // docs/ios.md), so the boundary moved rather than vanished. Key material may
  // exist in the custody core; it must not exist anywhere else, and the hosted
  // app surface (window.bsv) must never see it. The daemon-side half of the old
  // test still holds: neverDeviceCallable keeps key-material methods off the
  // remote surface, checked above.
  const sources = path.join(root, "packages/ios/Sources");
  const swiftFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) swiftFiles.push(full);
    }
  })(sources);
  assert.ok(swiftFiles.length > 0, "Swift sources found");

  const stripComments = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

  // The custody core: seed derivation, the curve, and the transaction signer
  // that takes key bytes for the moment of signing.
  const custody = new Set([
    "BSVOSWallet/Core/BIP32.swift",
    "BSVOSWallet/Core/Secp256k1.swift",
    "BSVOSWallet/Core/Tx.swift",
  ]);

  const forbidden = /secp256k1|fromWif|privateKey|mnemonic|seed phrase|bip39|beginPrivateKey/i;
  for (const file of swiftFiles) {
    const relative = path.relative(sources, file);
    const code = stripComments(fs.readFileSync(file, "utf8"));
    if (custody.has(relative)) continue;
    assert.ok(!forbidden.test(code), `${relative} carries key material outside the custody core (${[...custody].join(", ")})`);
  }

  // The page-facing surface is stricter still: no key material of any spelling,
  // because window.bsv is exactly where a browser could read it.
  const pageFacing = swiftFiles.filter((file) => file.includes(`${path.sep}Apps${path.sep}`));
  assert.ok(pageFacing.length > 0, "the app host sources are present");
  for (const file of pageFacing) {
    const relative = path.relative(sources, file);
    const code = stripComments(fs.readFileSync(file, "utf8"));
    assert.ok(!/\b(privateKey|mnemonic|fromWif|wif|seed)\b/i.test(code), `${relative} must not carry key material — a page can read this surface`);
  }
});
