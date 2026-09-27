import { test } from "node:test";
import assert from "node:assert/strict";

import knex from "knex";
import { migrate } from "../src/storage.ts";
import {
  addEpisode, getSession, listEpisodes, listSessions, parseSplits,
  sessionBeats, sessionsDue, startSession, stopSession,
} from "../src/cast.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

const okAddr = (a) => /^1[A-Za-z0-9]{20,40}$/.test(a);
const A1 = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";
const A2 = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";

test("parseSplits validates shape and sums to 100", () => {
  assert.deepEqual(parseSplits(`${A1}:70,${A2}:30`, okAddr), [
    { address: A1, pct: 70 },
    { address: A2, pct: 30 },
  ]);
  assert.throws(() => parseSplits(`${A1}:70,${A2}:20`, okAddr), /sum to 100/);
  assert.throws(() => parseSplits(`${A1}:70,${A1}:30`, okAddr), /duplicate/);
  assert.throws(() => parseSplits(`nope:50`, okAddr), /bad address/);
  assert.throws(() => parseSplits(``, okAddr), /required/);
  assert.throws(() => parseSplits(`${A1}:0`, okAddr), /bad pct/);
});

test("episode + session lifecycle with per-split streams", async () => {
  const db = await memdb();
  try {
    const ep = await addEpisode(db, {
      title: "Pilot",
      splits: [{ address: A1, pct: 70 }, { address: A2, pct: 30 }],
    });
    assert.match(ep.id, /^ep_/);
    assert.equal((await listEpisodes(db)).length, 1);

    const created = [];
    const fakeStreams = {
      createStream: async (dbArg, opts) => {
        assert.equal(dbArg, db);
        const s = { id: `stm_${created.length}`, ...opts };
        created.push(s);
        return s;
      },
    };
    const s = await startSession(db, fakeStreams, {
      episode: ep.id, ratePerMin: 1000, every: "5m", maxTotal: 60_000,
      tickSecs: () => 300, now: 9_000_000,
    });
    assert.match(s.id, /^cs_/);
    assert.equal(s.status, "playing");
    assert.equal(s.streamIds.length, 2);
    // 70/30 of 1000/min, tick 300s, max split pro-rata
    assert.deepEqual(created.map((c) => [c.payee, c.ratePerMin, c.maxTotal]), [
      [A1, 700, 42000],
      [A2, 300, 18000],
    ]);
    assert.equal((await listSessions(db)).length, 1);
    assert.deepEqual((await sessionsDue(db)).map((x) => x.id), [s.id]);

    // beats: one per stream so every split keeps flowing
    const beats = sessionBeats(s, 12.7);
    assert.equal(beats.length, 2);
    assert.ok(beats.every((b) => b.refs[0].startsWith("stream:stm_")));
    assert.ok(beats[0].text.includes("+12m"));

    const stopped = await stopSession(db, s.id, 9_600_000);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.stoppedAt, 9_600_000);
    assert.deepEqual(await sessionsDue(db), []);
    assert.equal((await getSession(db, s.id)).status, "stopped");
  } finally {
    await db.destroy();
  }
});

test("startSession validates economics", async () => {
  const db = await memdb();
  try {
    const ep = await addEpisode(db, { title: "T", splits: [{ address: A1, pct: 100 }] });
    const fake = { createStream: async () => ({ id: "stm_x" }) };
    await assert.rejects(
      startSession(db, fake, { episode: ep.id, ratePerMin: 0, every: "5m", maxTotal: 60_000, tickSecs: () => 300 }),
      /rate must be positive/,
    );
    await assert.rejects(
      startSession(db, fake, { episode: ep.id, ratePerMin: 100, every: "5m", maxTotal: 10, tickSecs: () => 300 }),
      /at least 1000/,
    );
    await assert.rejects(
      startSession(db, fake, { episode: "ep_missing", ratePerMin: 100, every: "5m", maxTotal: 60_000, tickSecs: () => 300 }),
      /no episode/,
    );
  } finally {
    await db.destroy();
  }
});

test("episodes carry media URL + live flag", async () => {
  const db = await memdb();
  try {
    const live = await addEpisode(db, {
      title: "Live show", mediaUrl: "https://example.com/live.m3u8", live: true,
      splits: [{ address: A1, pct: 100 }],
    });
    assert.equal(live.mediaUrl, "https://example.com/live.m3u8");
    assert.equal(live.live, true);
    const file = await addEpisode(db, {
      title: "Recorded", mediaUrl: "https://example.com/ep.mp3",
      splits: [{ address: A1, pct: 100 }],
    });
    assert.equal(file.live, false);
    const bare = await addEpisode(db, { title: "Pay only", splits: [{ address: A1, pct: 100 }] });
    assert.equal(bare.mediaUrl, "");
    await assert.rejects(
      addEpisode(db, { title: "Bad", mediaUrl: "ftp://example.com/x.mp3", splits: [{ address: A1, pct: 100 }] }),
      /http\(s\)/,
    );
  } finally {
    await db.destroy();
  }
});

test("player app bundle: served files, no remote code", async () => {
  const fs = await import("node:fs");
  const dir = new URL("../../runner/apps/cast/", import.meta.url);
  for (const f of ["index.html", "app.js", "styles.css", "manifest.json", "hls.min.js"]) {
    assert.ok(fs.existsSync(new URL(f, dir)), f);
  }
  const html = fs.readFileSync(new URL("index.html", dir), "utf8");
  const js = fs.readFileSync(new URL("app.js", dir), "utf8");
  // No remote scripts baked in — only same-directory assets.
  for (const src of [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(!/^https?:\/\//i.test(src), `remote script: ${src}`);
  }
  // Payment lifecycle is observed playback, never ambient.
  for (const token of ["castPlay", "castStop", "streamPause", "streamResume", "streamTicks", "castEpisodes", "castAdd"]) {
    assert.ok(js.includes(token), token);
  }
  const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", dir), "utf8"));
  assert.equal(manifest.start_url, "https://localhost:2121/cast/");
});
