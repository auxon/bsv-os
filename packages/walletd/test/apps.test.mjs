import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import {
  appIdFor, getApp, installApp, listApps, removeApp, validateManifest,
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
      { fetchManifest: async () => GOOD },
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
