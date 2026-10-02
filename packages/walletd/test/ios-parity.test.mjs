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

test("the device allowlist in Swift matches the design doc exactly", () => {
  const block = /```\nread      ([\s\S]*?)```/.exec(iosDoc);
  assert.ok(block, "the allowlist code block exists in docs/ios.md");

  // Both sections wrap across lines, so accumulate continuation lines into
  // whichever section keyword came last rather than reading only the first line.
  const sections = {};
  // The block regex above consumes the literal "read      " prefix, so the
  // first line arrives without its keyword.
  let current = "read";
  for (const raw of block[1].split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const starts = /^(read|wallet)\s+(.*)$/.exec(line);
    if (starts) {
      current = starts[1];
      sections[current] = (sections[current] ?? []).concat(starts[2].split(/\s+/));
    } else if (current) {
      sections[current] = (sections[current] ?? []).concat(line.split(/\s+/));
    }
  }
  const readLine = sections.read ?? [];
  const walletLine = sections.wallet ?? [];
  assert.ok(readLine.length > 0 && walletLine.length > 0, "both sections parsed");

  const swiftSet = (name) => {
    const m = new RegExp(`static let ${name}: Set<String> = \\[([\\s\\S]*?)\\n    \\]`).exec(swiftAllowlist);
    assert.ok(m, `DeviceAllowlist.${name} found`);
    return new Set([...m[1].matchAll(/"([A-Za-z0-9]+)"/g)].map((x) => x[1]));
  };

  const docReads = new Set(readLine);
  const docWrites = new Set(walletLine);
  const swiftReads = swiftSet("reads");
  const swiftWrites = swiftSet("writes");

  assert.deepEqual([...docReads].sort(), [...swiftReads].sort(), "reads agree");
  assert.deepEqual([...docWrites].sort(), [...swiftWrites].sort(), "writes agree");
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

test("the Swift package contains no key material, mirroring the daemon's custody boundary", () => {
  // custody-boundary.test.mjs proves the daemon keeps keys in one module. The
  // iOS client is the opposite extreme: it must have none at all, because in
  // Phase 0 custody stays on the server. This fails the moment someone adds a
  // Swift key path by "helpfully" making the phone standalone.
  const swiftFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) swiftFiles.push(full);
    }
  })(path.join(root, "packages/ios/Sources"));
  assert.ok(swiftFiles.length > 0, "Swift sources found");

  const forbidden = /secp256k1|fromWif|privateKey|mnemonic|seed phrase|bip39|beginPrivateKey/i;
  for (const file of swiftFiles) {
    const src = fs.readFileSync(file, "utf8");
    // Comments may discuss custody; code may not implement it. Strip line
    // comments and doc-comment bodies before looking.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    assert.ok(!forbidden.test(code), `${path.relative(root, file)} must not implement a key path`);
  }
});
