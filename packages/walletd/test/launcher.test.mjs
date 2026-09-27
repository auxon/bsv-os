import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appDataDir,
  buildLaunchPlan,
  chromiumCandidates,
  findChromium,
  findExtensionDir,
  isLoopbackUrl,
  openExternalCommand,
  profilePidsFromPs,
  withBridgeFragment,
} from "../src/launcher.ts";

test("bridge fragment appends without clobbering", () => {
  assert.equal(
    withBridgeFragment("https://demo.example/app", 1234, "tok"),
    "https://demo.example/app#bsv-port=1234&bsv-token=tok",
  );
  assert.equal(
    withBridgeFragment("https://demo.example/app#x=1", 1234, "tok"),
    "https://demo.example/app#x=1&bsv-port=1234&bsv-token=tok",
  );
});

test("loopback detection gates --ignore-certificate-errors", () => {
  assert.equal(isLoopbackUrl("https://127.0.0.1:8443/"), true);
  assert.equal(isLoopbackUrl("https://127.0.0.2:8790/"), true);
  assert.equal(isLoopbackUrl("https://localhost:8443/"), true);
  assert.equal(isLoopbackUrl("https://demo.example/"), false);
  assert.equal(isLoopbackUrl("not a url"), false);
});

test("launch plan sandboxes per app and cert-ignores loopback only", () => {
  const web = buildLaunchPlan({
    chromium: "/usr/bin/chromium", domain: "demo.example",
    startUrl: "https://demo.example/app", extensionDir: "/ext", port: 1, token: "t",
  });
  assert.ok(web.args.some((a) => a.startsWith("--app=https://demo.example/app#bsv-port=1")));
  assert.ok(web.args.some((a) => a.startsWith("--user-data-dir=") && a.endsWith("/apps/demo-example")));
  assert.ok(web.args.includes("--load-extension=/ext"));
  assert.equal(web.ignoreCert, false);
  assert.ok(!web.args.includes("--ignore-certificate-errors"));

  const loop = buildLaunchPlan({
    chromium: "/usr/bin/chromium", domain: "127.0.0.1",
    startUrl: "https://127.0.0.1:8443/", extensionDir: "/ext", port: 1, token: "t",
  });
  assert.equal(loop.ignoreCert, true);
  assert.ok(loop.args.includes("--ignore-certificate-errors"));
  assert.ok(loop.dataDir.endsWith("/apps/127-0-0-1"));
});

test("app data dir stays inside the wallet data home", () => {
  const dir = appDataDir("demo.example");
  assert.ok(dir.includes("bsv-os"));
  assert.ok(!dir.includes(".."));
});

test("environment resolves chromium and the repo extension", () => {
  assert.equal(typeof findChromium(), "string"); // present on the Linux box
  const ext = findExtensionDir();
  assert.ok(ext && fs.existsSync(path.join(ext, "manifest.json")));
  const here = path.dirname(fileURLToPath(import.meta.url));
  assert.ok(fs.existsSync(path.join(here, "..", "..", "runner", "extension", "manifest.json")));
});

test("chromium candidates cover macOS app bundles and honor the override", () => {
  const mac = chromiumCandidates("darwin", "/Users/rah", { BSV_RUNNER_CHROMIUM: "/opt/x/chrome" });
  assert.equal(mac[0], "/opt/x/chrome");
  assert.ok(mac.includes("/Users/rah/Google Chrome.app/Contents/MacOS/Google Chrome"));
  assert.ok(mac.includes("/Applications/Chromium.app/Contents/MacOS/Chromium"));
  assert.ok(mac.includes("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"));
  const lin = chromiumCandidates("linux", "/home/rah", {});
  assert.ok(lin.includes("/usr/bin/chromium"));
  assert.ok(lin.includes("/usr/bin/google-chrome"));
  assert.ok(!lin.some((c) => c.includes(".app/")));
});

test("ps-based profile detection parses pid/command lines", () => {
  const dir = "/home/rah/.local/share/bsv-os/apps/demo";
  const out = [
    "  123 /usr/bin/chromium --app=https://x/ --user-data-dir=/home/rah/.local/share/bsv-os/apps/demo",
    "  456 /usr/bin/chromium --user-data-dir=/other/profile",
    "  789 Chrome Helper --user-data-dir=/home/rah/.local/share/bsv-os/apps/demo (Renderer)",
    "not a ps line",
    "",
  ].join("\n");
  assert.deepEqual(profilePidsFromPs(out, dir), [123, 789]);
  assert.deepEqual(profilePidsFromPs("", dir), []);
});

test("external opener is platform-correct", () => {
  assert.deepEqual(openExternalCommand("darwin", "https://x/"), { cmd: "open", args: ["https://x/"] });
  assert.deepEqual(openExternalCommand("linux", "https://x/"), { cmd: "xdg-open", args: ["https://x/"] });
});
