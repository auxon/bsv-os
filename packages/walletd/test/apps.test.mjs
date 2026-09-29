import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import {
  appIdFor, applyAppUpdate, checkAppUpdates, diffPermissions, getApp, installApp,
  intentFromMemo, isLoopbackHost, listApps, manifestSha256, manifestUrlFor, readCatalog, removeApp,
  resolveRunnerAppFile, runnerAppStamp, stableStringify, storeList, validateIntents, validateManifest,
} from "../src/apps.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate } from "../src/storage.ts";
import { desktopFile } from "../src/desktop.ts";

const GOOD = {
  name: "Demo App",
  short_name: "Demo",
  start_url: "/app",
  icons: [{ src: "/icon.png" }],
  metanet: {
    schemaVersion: "1",
    groupPermissions: {
      description: "demo",
      spendingAuthorization: { amount: 50000, description: "tips" },
      protocolPermissions: [{ protocolID: [1, "x"] }],
      basketAccess: [{ basket: "default" }],
      certificateAccess: [],
    },
  },
};

test("validateManifest accepts a good manifest", () => {
  const v = validateManifest("demo.example", GOOD);
  assert.equal(v.name, "Demo App");
  assert.equal(v.startUrl, "https://demo.example/app");
  assert.equal(v.icon, "https://demo.example/icon.png");
  assert.equal(v.spendCapSats, 50000);
  assert.deepEqual([v.protocols, v.baskets, v.certs], [1, 1, 0]);
});

test("validateManifest rejects hostile shapes", () => {
  assert.throws(() => validateManifest("demo.example", null), /object/);
  assert.throws(() => validateManifest("demo.example", {}), /name/);
  assert.throws(() => validateManifest("demo.example", { name: "x", start_url: "http://evil.example/" }), /https/);
  assert.throws(
    () => validateManifest("demo.example", { name: "x", start_url: "https://evil.example/app" }),
    /escapes/,
  );
  assert.throws(() => validateManifest("demo.example", { name: "x".repeat(81) }), /too long/);
});

test("validateManifest allows an explicit port on the same host", () => {
  const v = validateManifest("127.0.0.1", { name: "Loopback Demo", start_url: "https://127.0.0.1:8443/" });
  assert.equal(v.startUrl, "https://127.0.0.1:8443/");
  assert.throws(
    () => validateManifest("127.0.0.1", { name: "x", start_url: "https://127.0.0.2:8443/" }),
    /escapes/,
  );
});

test("installApp accepts an https URL and fetches <dir>/manifest.json", async () => {
  const db = await memdb();
  try {
    const seen = [];
    const { app } = await installApp(
      db,
      "https://localhost:2121/explorer/",
      { seedPolicyRequest: async () => {} },
      {
        fetchUrl: async (url) => {
          seen.push(url);
          return {
            name: "bsvOS Explorer",
            start_url: "https://localhost:2121/explorer/",
            metanet: {
              schemaVersion: "1",
              groupPermissions: { description: "read-only", spendingAuthorization: { amount: 0 } },
            },
          };
        },
      },
    );
    assert.equal(seen[0], "https://localhost:2121/explorer/manifest.json");
    assert.equal(app.domain, "localhost");
    assert.equal(app.startUrl, "https://localhost:2121/explorer/");
    assert.equal(manifestUrlFor(app), "https://localhost:2121/explorer/manifest.json");
    assert.equal((await listApps(db)).length, 1);
  } finally {
    await db.destroy();
  }
});

test("appIdFor is a safe filename slug", () => {
  assert.equal(appIdFor("https://Demo.Example/path"), "demo-example");
  assert.equal(appIdFor("a"), "a");
});

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

test("install pins, seeds policy, lists, removes", async () => {
  const db = await memdb();
  try {
    const seeded = [];
    const { app, asked } = await installApp(
      db,
      "https://Demo.Example/extra",
      { seedPolicyRequest: async (o, a, act) => void seeded.push([o, a, act]) },
      {
        fetchUrl: async (url) => {
          assert.equal(url, "https://demo.example/extra/manifest.json");
          return GOOD;
        },
      },
    );
    assert.equal(app.domain, "demo.example");
    assert.equal(asked.spendCapSats, 50000);
    assert.deepEqual(seeded, [["demo.example", 50000, "app-install"]]);
    assert.equal((await listApps(db)).length, 1);
    assert.equal((await getApp(db, "demo.example"))?.startUrl, "https://demo.example/app");
    assert.equal(await removeApp(db, "demo.example"), true);
    assert.equal(await removeApp(db, "demo.example"), false);
    assert.equal((await listApps(db)).length, 0);
  } finally {
    await db.destroy();
  }
});

test("install from manifestJson skips the network but keeps validation", async () => {
  const db = await memdb();
  try {
    const boom = async () => {
      throw new Error("network must not be touched");
    };
    const { app } = await installApp(
      db,
      "127.0.0.1",
      { seedPolicyRequest: async () => {} },
      {
        fetchManifest: boom,
        manifestJson: { name: "Loopback Demo", start_url: "https://127.0.0.1:8443/" },
      },
    );
    assert.equal(app.startUrl, "https://127.0.0.1:8443/");
    assert.throws(
      () => validateManifest("127.0.0.1", { name: "x", start_url: "https://evil.example/" }),
      /escapes/,
    );
  } finally {
    await db.destroy();
  }
});

test("desktop file is a valid launcher", () => {
  const text = desktopFile({
    domain: "demo.example", name: "Demo App", startUrl: "https://demo.example/app",
    icon: null, spendCapSats: 0, installedAt: 0, intents: [],
  });
  assert.ok(text.includes("Exec=bsv app open demo.example"));
  assert.ok(text.startsWith("[Desktop Entry]"));
});

test("install pins a key-order-stable manifest hash", async () => {
  const db = await memdb();
  try {
    const a = { name: "Pin Demo", start_url: "/app", metanet: { groupPermissions: { spendingAuthorization: { amount: 7 } } } };
    const b = { metanet: { groupPermissions: { spendingAuthorization: { amount: 7 } } }, start_url: "/app", name: "Pin Demo" };
    assert.equal(stableStringify(a), stableStringify(b));
    const hooks = { seedPolicyRequest: async () => {} };
    await installApp(db, "pin.example", hooks, { manifestJson: a });
    const rec = await getApp(db, "pin.example");
    assert.equal(rec.manifestSha256, manifestSha256(b));
    assert.match(rec.manifestSha256, /^[0-9a-f]{64}$/);
  } finally {
    await db.destroy();
  }
});

test("diffPermissions spots widening and narrowing", () => {
  const base = { spendCapSats: 1000, protocols: 1, baskets: 1, certs: 0, intents: ["pull"] };
  assert.deepEqual(diffPermissions(base, { ...base }).widened, false);
  assert.deepEqual(diffPermissions(base, { ...base }).changes, []);
  const wide = diffPermissions(base, { spendCapSats: 2000, protocols: 1, baskets: 2, certs: 0, intents: ["pull"] });
  assert.equal(wide.widened, true);
  assert.ok(wide.changes.some((c) => c.includes("spend cap") && c.includes("1000 → 2000")));
  assert.ok(wide.changes.some((c) => c.includes("baskets")));
  const narrow = diffPermissions(base, { spendCapSats: 500, protocols: 1, baskets: 1, certs: 0, intents: ["pull"] });
  assert.equal(narrow.widened, false);
  assert.ok(narrow.changes.some((c) => c.includes("narrowed")));
  const intentWide = diffPermissions(base, { ...base, intents: ["pull", "stake"] });
  assert.equal(intentWide.widened, true);
  assert.ok(intentWide.changes.some((c) => c === "new spend intent: stake"));
  const intentNarrow = diffPermissions(base, { ...base, intents: [] });
  assert.equal(intentNarrow.widened, false);
  assert.ok(intentNarrow.changes.some((c) => c === "removed spend intent: pull"));
});

const V1 = { name: "Updatable", start_url: "/app", metanet: { groupPermissions: { spendingAuthorization: { amount: 1000 } } } };
const V2_NARROW = { name: "Updatable", start_url: "/app", metanet: { groupPermissions: { spendingAuthorization: { amount: 500 } } } };
const V3_WIDE = {
  name: "Updatable", start_url: "/app",
  metanet: { groupPermissions: { spendingAuthorization: { amount: 2000 }, protocolPermissions: [{ protocolID: [2, "y"] }] } },
};

test("narrower updates apply silently; widening needs explicit approval", async () => {
  const db = await memdb();
  try {
    const seeded = [];
    const hooks = { seedPolicyRequest: async (o, a, act) => void seeded.push([o, a, act]) };
    const live = { current: V1 };
    const fetch = async () => live.current;
    await installApp(db, "up.example", hooks, { manifestJson: V1 });
    assert.deepEqual(seeded, [["up.example", 1000, "app-install"]]);

    live.current = V2_NARROW;
    const narrowed = await applyAppUpdate(db, "up.example", hooks, { fetchManifest: fetch });
    assert.equal(narrowed.applied, true);
    assert.equal(narrowed.status, "available");
    assert.equal((await getApp(db, "up.example")).spendCapSats, 500);
    assert.equal(seeded.length, 1); // silent: no new request

    live.current = V3_WIDE;
    const widened = await applyAppUpdate(db, "up.example", hooks, { fetchManifest: fetch });
    assert.equal(widened.applied, false);
    assert.equal(widened.status, "widened");
    assert.ok(widened.changes.some((c) => c.includes("spend cap")));
    assert.equal((await getApp(db, "up.example")).spendCapSats, 500); // untouched
    assert.deepEqual(seeded[1], ["up.example", 2000, "app-update"]); // shell prompt seeded

    const approved = await applyAppUpdate(db, "up.example", hooks, { fetchManifest: fetch, approveWidening: true });
    assert.equal(approved.applied, true);
    assert.equal(approved.status, "widened");
    assert.equal((await getApp(db, "up.example")).spendCapSats, 2000);

    await assert.rejects(
      applyAppUpdate(db, "ghost.example", hooks, { fetchManifest: fetch }),
      (e) => e.code === "NOT_FOUND",
    );
  } finally {
    await db.destroy();
  }
});

test("checkAppUpdates reports current/unreachable/invalid/adopted", async () => {
  const db = await memdb();
  try {
    const hooks = { seedPolicyRequest: async () => {} };
    await installApp(db, "same.example", hooks, { manifestJson: V1 });
    await installApp(db, "dead.example", hooks, { manifestJson: V1 });
    await installApp(db, "junk.example", hooks, { manifestJson: V1 });
    await installApp(db, "legacy.example", hooks, { manifestJson: V1 });
    await db("apps").where({ domain: "legacy.example" }).update({ manifest_sha256: null, manifest_json: null });
    const fetch = async (domain) => {
      if (domain === "dead.example") throw new Error("down");
      if (domain === "junk.example") return { nope: true };
      return V1;
    };
    const rows = Object.fromEntries((await checkAppUpdates(db, { fetchManifest: fetch })).map((r) => [r.domain, r]));
    assert.equal(rows["same.example"].status, "current");
    assert.equal(rows["dead.example"].status, "unreachable");
    assert.equal(rows["junk.example"].status, "invalid");
    assert.equal(rows["legacy.example"].status, "adopted");
  } finally {
    await db.destroy();
  }
});

test("loopback trust stays scoped to loopback hosts", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.0.0.2"), true);
  assert.equal(isLoopbackHost("127.255.255.254"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("demo.example"), false);
  assert.equal(isLoopbackHost("127.0.0.1.evil.example"), false);
  assert.equal(isLoopbackHost(""), false);
});

test("storeList merges catalog, installed extras, and live caps", async () => {
  const db = await memdb();
  try {
    const catalog = readCatalog();
    assert.ok(Array.isArray(catalog.apps));
    const hooks = { seedPolicyRequest: async () => {} };
    await installApp(db, "storetest.example", hooks, { manifestJson: V1 });
    const fetch = async () => V1;
    const store = await storeList(db, { fetchManifest: fetch });
    const extra = store.find((e) => e.domain === "storetest.example");
    assert.ok(extra);
    assert.equal(extra.inCatalog, false);
    assert.equal(extra.installed, true);
    assert.equal(extra.status, "current");
    assert.equal(extra.live.spendCapSats, 1000);
    for (const e of store) {
      assert.equal(typeof e.domain, "string");
      assert.equal(typeof e.name, "string");
      assert.equal(typeof e.installed, "boolean");
    }
  } finally {
    await db.destroy();
  }
});

test("storeList lists every bundled app on a shared host and names the slot holder", async () => {
  const db = await memdb();
  try {
    const hooks = { seedPolicyRequest: async () => {} };
    const manifest = (startUrl, name) => ({
      name,
      start_url: startUrl,
      metanet: { groupPermissions: { spendingAuthorization: { amount: 0 } } },
    });
    const cast = manifest("https://localhost:2121/cast/", "Cast");
    const colosseum = manifest("https://localhost:2121/colosseum/", "Ordinal Colosseum");
    const catalog = {
      version: 1,
      apps: [
        { domain: "localhost", name: "Cast", blurb: "player", devOnly: false, url: "https://localhost:2121/cast/" },
        { domain: "localhost", name: "Ordinal Colosseum", blurb: "battles", devOnly: false, url: "https://localhost:2121/colosseum/" },
      ],
    };
    const fetch = async (domain, url) => (url.includes("colosseum") ? colosseum : cast);
    // Cast holds the shared localhost slot.
    await installApp(db, "https://localhost:2121/cast/", hooks, { fetchUrl: async () => cast });
    const store = await storeList(db, { fetchManifest: fetch, catalog });
    const castEntry = store.find((e) => e.name === "Cast");
    const colEntry = store.find((e) => e.name === "Ordinal Colosseum");
    assert.equal(castEntry.installed, true);
    assert.equal(castEntry.status, "current");
    assert.equal(castEntry.holder, null);
    assert.equal(castEntry.installUrl, "https://localhost:2121/cast/");
    assert.equal(colEntry.installed, false, "the slot-mate is not the installed variant");
    assert.equal(colEntry.status, "not-installed");
    assert.equal(colEntry.holder, "Cast", "names what a switch would replace");
    assert.equal(colEntry.installUrl, "https://localhost:2121/colosseum/");
    assert.equal(store.filter((e) => e.domain === "localhost" && e.inCatalog).length, 2, "both apps are listed, not deduped by domain");

    // Switching the slot replaces the holder — identity stays one app per host.
    await installApp(db, "https://localhost:2121/colosseum/", hooks, { fetchUrl: async () => colosseum });
    const after = await storeList(db, { fetchManifest: fetch, catalog });
    assert.equal(after.find((e) => e.name === "Ordinal Colosseum").installed, true);
    assert.equal(after.find((e) => e.name === "Cast").holder, "Ordinal Colosseum");
    assert.equal((await listApps(db)).filter((a) => a.domain === "localhost").length, 1);
  } finally {
    await db.destroy();
  }
});

test("an installed app that is not a catalog variant stays visible as an extra", async () => {
  const db = await memdb();
  try {
    const hooks = { seedPolicyRequest: async () => {} };
    const demo = { name: "BSV OS Runner Demo", start_url: "https://127.0.0.1:8443/" };
    const shell = { name: "bsvOS", start_url: "https://127.0.0.1:2121/bsvos/", metanet: { groupPermissions: { spendingAuthorization: { amount: 0 } } } };
    const catalog = {
      version: 1,
      apps: [{ domain: "127.0.0.1", name: "bsvOS", blurb: "shell", devOnly: false, url: "https://127.0.0.1:2121/bsvos/" }],
    };
    await installApp(db, "https://127.0.0.1:8443/", hooks, { fetchUrl: async () => demo });
    const store = await storeList(db, {
      fetchManifest: async (domain, url) => (url.includes("bsvos") ? shell : demo),
      catalog,
    });
    const shellEntry = store.find((e) => e.name === "bsvOS");
    assert.equal(shellEntry.installed, false);
    assert.equal(shellEntry.holder, "BSV OS Runner Demo");
    assert.equal(shellEntry.installUrl, "https://127.0.0.1:2121/bsvos/");
    const extra = store.find((e) => e.name === "BSV OS Runner Demo");
    assert.ok(extra, "the app actually installed on the host is still listed");
    assert.equal(extra.inCatalog, false);
    assert.equal(extra.installed, true);
  } finally {
    await db.destroy();
  }
});

test("the shipped catalog gives every bundled app its own URL", () => {
  const catalog = readCatalog();
  for (const [domain, name] of [
    ["127.0.0.1", "bsvOS"],
    ["localhost", "Cast"],
    ["localhost", "Twetch"],
    ["localhost", "bsvOS Explorer"],
    ["localhost", "Ordinal Colosseum"],
  ]) {
    const entry = catalog.apps.find((a) => a.domain === domain && a.name === name);
    assert.ok(entry, `catalog lists ${name}`);
    assert.ok(entry.url, `${name} has its own install URL`);
    const u = new URL(entry.url);
    assert.equal(u.protocol, "https:");
    assert.equal(u.hostname, domain, `${name} stays on its own host`);
    assert.ok(u.pathname.endsWith("/"), `${name} URL is a directory`);
  }
  const localhost = catalog.apps.filter((a) => a.domain === "localhost");
  assert.equal(localhost.length, 5, "all five localhost apps are listed");
  assert.equal(new Set(localhost.map((a) => a.url)).size, localhost.length, "each has its own entry");
});

test("readCatalog drops a URL that escapes its own domain", () => {
  const file = path.join(os.tmpdir(), `bsv-store-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    apps: [
      { domain: "localhost", name: "Good", url: "https://localhost:2121/cast" },
      { domain: "localhost", name: "Escapes", url: "https://evil.example/cast/" },
      { domain: "example.com", name: "Domain root" },
    ],
  }));
  try {
    const catalog = readCatalog(file);
    assert.deepEqual(catalog.apps.map((a) => a.name), ["Good", "Domain root"]);
    assert.equal(catalog.apps[0].url, "https://localhost:2121/cast/", "directories get a trailing slash");
    assert.equal(catalog.apps[1].url, null, "no URL means the domain root");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("validateManifest parses declared spend intents", () => {
  const v = validateManifest("game.example", {
    name: "Game",
    start_url: "/play",
    metanet: {
      groupPermissions: { spendingAuthorization: { amount: 1000 } },
      intents: [
        { action: "app-spend", label: "POCKETPETS-PULL", typical_sats: 264, description: "gacha pull" },
        { action: "app-inscribe" },
      ],
    },
  });
  assert.deepEqual(v.intents, [
    { action: "app-spend", label: "POCKETPETS-PULL", typicalSats: 264, description: "gacha pull" },
    { action: "app-inscribe" },
  ]);
  assert.deepEqual(validateManifest("game.example", { name: "Game", start_url: "/play" }).intents, []);
});

test("validateManifest rejects malformed intents", () => {
  const bad = (intents) => validateManifest("game.example", { name: "Game", start_url: "/play", metanet: { intents } });
  assert.throws(() => bad("pull"), /array/);
  assert.throws(() => bad([{}]), /action/);
  assert.throws(() => bad([{ action: "" }]), /action/);
  assert.throws(() => bad([{ action: "x", typical_sats: -1 }]), /typical_sats/);
  assert.throws(() => bad([{ action: "x", label: "y".repeat(81) }]), /label/);
  assert.throws(() => bad(new Array(33).fill({ action: "x" })), /at most 32/);
  assert.deepEqual(validateIntents(undefined), []);
});

test("installApp stores declared intents on the record and asked", async () => {
  const db = await memdb();
  try {
    const hooks = { seedPolicyRequest: async () => {} };
    const manifest = {
      name: "Intent Game", start_url: "/play",
      metanet: {
        groupPermissions: { spendingAuthorization: { amount: 1000 } },
        intents: [{ action: "app-spend", label: "PULL", typical_sats: 264 }],
      },
    };
    const { app, asked } = await installApp(db, "intent.example", hooks, { manifestJson: manifest });
    assert.deepEqual(asked.intents, ["app-spend"]);
    assert.deepEqual(app.intents, [{ action: "app-spend", label: "PULL", typicalSats: 264 }]);
    assert.deepEqual((await getApp(db, "intent.example")).intents, app.intents);
    // live manifest intents surface through the store listing
    const store = await storeList(db, { fetchManifest: async () => manifest });
    const entry = store.find((e) => e.domain === "intent.example");
    assert.deepEqual(entry.live.intents, ["app-spend"]);
  } finally {
    await db.destroy();
  }
});

test("intentFromMemo maps the action tag to label + description", () => {
  assert.deepEqual(intentFromMemo(["POCKETPETS-PULL", "pet-1", "torto"], undefined), {
    label: "POCKETPETS-PULL", description: "pet-1 torto",
  });
  // explicit labels win; the whole memo becomes the description
  assert.deepEqual(intentFromMemo(["POCKETPETS-PULL", "pet-1"], "custom"), {
    label: "custom", description: "POCKETPETS-PULL pet-1",
  });
  // silence stays silent: nothing invented
  assert.deepEqual(intentFromMemo(undefined, undefined), {});
  assert.deepEqual(intentFromMemo([], undefined), {});
  assert.deepEqual(intentFromMemo("not-an-array", undefined), {});
});

test("runnerAppStamp covers every file in the bundle, nested ones included", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-stamp-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
    fs.mkdirSync(path.join(dir, "views"));
    fs.writeFileSync(path.join(dir, "views", "apps.js"), "export default [];");
    const first = runnerAppStamp(dir);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(runnerAppStamp(dir), first, "stable while nothing changes");
    // The failure this guards: a fix in a view module did not move the old
    // app.js ETag, so no open window was ever told to reload.
    fs.writeFileSync(path.join(dir, "views", "apps.js"), "export default [1];");
    assert.notEqual(runnerAppStamp(dir), first, "a nested file change moves the bundle stamp");
    // mtime alone (a touch) must move it too, not only content changes.
    const newer = fs.statSync(path.join(dir, "views", "apps.js")).mtimeMs / 1000 + 10;
    fs.utimesSync(path.join(dir, "views", "apps.js"), newer, newer);
    const touched = runnerAppStamp(dir);
    assert.notEqual(touched, first, "a touch moves the bundle stamp");
    assert.equal(runnerAppStamp(dir), touched, "and it is stable again");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRunnerAppFile serves app assets and refuses traversal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-app-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "logic.js"), "export const x = 1;");
  fs.writeFileSync(path.join(dir, "icon.png"), "png");
  try {
    assert.deepEqual(resolveRunnerAppFile(dir, "/"), { file: path.join(dir, "index.html"), mime: "text/html; charset=utf-8" });
    assert.deepEqual(resolveRunnerAppFile(dir, ""), { file: path.join(dir, "index.html"), mime: "text/html; charset=utf-8" });
    assert.equal(resolveRunnerAppFile(dir, "/sub/logic.js").mime, "text/javascript; charset=utf-8");
    assert.equal(resolveRunnerAppFile(dir, "/icon.png").mime, "image/png");
    assert.equal(resolveRunnerAppFile(dir, "/manifest.json"), null, "missing files are null");
    assert.equal(resolveRunnerAppFile(dir, "/sub"), null, "directories are not served");
    assert.equal(resolveRunnerAppFile(dir, "/../outside.txt"), null, "plain traversal refused");
    assert.equal(resolveRunnerAppFile(dir, "/%2e%2e%2foutside.txt"), null, "encoded traversal refused");
    assert.equal(resolveRunnerAppFile(dir, "/%00.png"), null, "null bytes refused");
    assert.equal(resolveRunnerAppFile(dir, "/%2e%2e%2foutside.txt"), null, "encoded traversal refused");
    assert.equal(resolveRunnerAppFile(dir, "/nope%2F..%2Findex.html").file, path.join(dir, "index.html"), "decoded paths that stay inside are allowed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
