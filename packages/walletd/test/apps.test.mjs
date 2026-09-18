import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import {
  appIdFor, applyAppUpdate, checkAppUpdates, diffPermissions, getApp, installApp,
  isLoopbackHost, listApps, manifestSha256, manifestUrlFor, readCatalog, removeApp,
  stableStringify, storeList, validateManifest,
} from "../src/apps.ts";
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
    icon: null, spendCapSats: 0, installedAt: 0,
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
  const base = { spendCapSats: 1000, protocols: 1, baskets: 1, certs: 0 };
  assert.deepEqual(diffPermissions(base, { ...base }).widened, false);
  assert.deepEqual(diffPermissions(base, { ...base }).changes, []);
  const wide = diffPermissions(base, { spendCapSats: 2000, protocols: 1, baskets: 2, certs: 0 });
  assert.equal(wide.widened, true);
  assert.ok(wide.changes.some((c) => c.includes("spend cap") && c.includes("1000 → 2000")));
  assert.ok(wide.changes.some((c) => c.includes("baskets")));
  const narrow = diffPermissions(base, { spendCapSats: 500, protocols: 1, baskets: 1, certs: 0 });
  assert.equal(narrow.widened, false);
  assert.ok(narrow.changes.some((c) => c.includes("narrowed")));
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
