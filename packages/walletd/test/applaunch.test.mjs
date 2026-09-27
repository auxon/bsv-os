import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (f) => fs.readFileSync(path.join(srcDir, f), "utf8");

test("appLaunch is installed-only and never takes a bare URL", () => {
  const rpc = read("rpc.ts");
  const body = /appLaunch: async \(params\) => \{([\s\S]*?)\n  \},/.exec(rpc);
  assert.ok(body, "appLaunch handler found");

  // It must resolve through the installed-app registry, not a caller-supplied
  // URL — otherwise this RPC becomes a loopback open-redirector that hands a
  // bridged window to any site the caller names.
  assert.ok(/getApp\(b\.db, clean\)/.test(body[1]), "resolves via getApp");
  assert.ok(/NOT_FOUND/.test(body[1]), "uninstalled domains are refused");
  assert.ok(!/params[^\n]*url/i.test(body[1]), "no url parameter");
});

test("appLaunch starts a runner window without blocking the RPC", () => {
  const rpc = read("rpc.ts");
  const body = /appLaunch: async \(params\) => \{([\s\S]*?)\n  \},/.exec(rpc);
  // wait:false — the bridge child watches the profile and exits with the
  // window, so a long-lived daemon never holds the request open.
  assert.ok(/wait: false/.test(body[1]), "launch is fire-and-forget");
  assert.ok(/bridgeEntry: bridgeEntryPath\(\)/.test(body[1]), "uses the daemon-spawnable bridge entry");
  // Failures must surface as a typed error, not a silent false.
  assert.ok(/RUNNER_UNAVAILABLE/.test(body[1]), "runner failure is a typed error");
});

test("the bridge entry the daemon spawns exists as its own module", () => {
  // bridge-main.ts is spawned as a child process; bridge-server.ts holds the
  // import-safe implementation shared with `bsv _bridge`. If these ever
  // merge, the CLI's _bridge import would re-run the entry's argv parsing.
  assert.ok(fs.existsSync(path.join(srcDir, "bridge-main.ts")), "bridge-main.ts exists");
  assert.ok(fs.existsSync(path.join(srcDir, "bridge-server.ts")), "bridge-server.ts exists");
  // The entry parses argv and delegates; the server (and its argv parsing)
  // must not be duplicated, or the CLI's `_bridge` import would re-run it.
  const main = read("bridge-main.ts");
  assert.ok(/await runBridge\(/.test(main), "entry delegates to runBridge");
  assert.ok(!/createBridgeHandler|createServer/.test(main), "entry does not implement the server");
  const server = read("bridge-server.ts");
  assert.ok(/export async function runBridge/.test(server), "server exports runBridge");
  assert.ok(/createBridgeHandler/.test(server), "server builds the handler");
  assert.ok(!/process\.argv/.test(server), "server never reads argv");
});

test("the shared runner is the single implementation for both callers", () => {
  const runner = read("runner.ts");
  assert.ok(/export async function openInRunner/.test(runner), "runner exports openInRunner");
  // The CLI must delegate rather than keep a second copy of the launch logic.
  const cli = read("cli.ts");
  assert.ok(/await import\("\.\/runner\.ts"\)/.test(cli), "cli delegates to the shared runner");
  assert.ok(!/--user-data-dir=/.test(cli), "cli holds no second copy of the launch args");
});
