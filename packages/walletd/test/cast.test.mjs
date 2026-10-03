import { test } from "node:test";
import assert from "node:assert/strict";

import knex from "knex";
import { migrate } from "../src/storage.ts";
import {
  addEpisode, getLive, getSession, listEpisodes, listSessions, parseSplits,
  sessionBeats, sessionsDue, setLiveMime, startLive, startSession, stopSession,
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
    const local = await addEpisode(db, {
      title: "Local upload", mediaUrl: "/cast/media/abcdefghijkl.webm",
      splits: [{ address: A1, pct: 100 }],
    });
    assert.equal(local.mediaUrl, "/cast/media/abcdefghijkl.webm");
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
  for (const f of ["index.html", "app.js", "mp4.js", "styles.css", "manifest.json", "hls.min.js"]) {
    assert.ok(fs.existsSync(new URL(f, dir)), f);
  }
  const html = fs.readFileSync(new URL("index.html", dir), "utf8");
  const js = fs.readFileSync(new URL("app.js", dir), "utf8");
  // Parse gate: a syntax error here kills the whole page silently (it did).
  assert.doesNotThrow(() => new Function(js), "app.js must parse");
  assert.doesNotThrow(
    () => new Function(fs.readFileSync(new URL("mp4.js", dir), "utf8")),
    "mp4.js must parse as a classic script",
  );
  // The recorder helper is loaded before app.js and reached by global name.
  assert.ok(html.indexOf('src="mp4.js"') > 0 && html.indexOf('src="mp4.js"') < html.indexOf('src="app.js"'), "mp4.js loads before app.js");
  assert.ok(js.includes("window.CastMp4"), "the duration repair is called by global");
  assert.doesNotThrow(() => new Function(fs.readFileSync(new URL("hls.min.js", dir), "utf8")), "hls.min.js must parse");
  // No remote scripts baked in — only same-directory assets.
  for (const src of [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(!/^https?:\/\//i.test(src), `remote script: ${src}`);
  }
  // Payment lifecycle is observed playback, never ambient.
  for (const token of ["castPlay", "castStop", "streamPause", "streamResume", "streamTicks", "castEpisodes", "castAdd"]) {
    assert.ok(js.includes(token), token);
  }
  // Our own broadcasts skip hls.js entirely (direct MSE append); third-party
  // m3u8s keep it.
  assert.ok(js.includes("\\/cast\\/live\\/"), "own-ingest routing marker present");
  assert.ok(js.includes("void msePlay(url)"), "own ingest goes to msePlay");
  assert.ok(js.includes("bufferSeekOverHole"), "hole clamp for foreign m3u8s");
  // The recorder reports its wall-clock length so the server can repair the
  // file too, and the panel says which pass applied.
  assert.ok(js.includes("x-cast-duration-ms"), "upload reports the reported duration");
  assert.ok(js.includes("inspectMp4"), "recorder panel inspects the recording's boxes");
  assert.ok(js.includes("platformHandlesDuration"), "the repair only runs when the platform needs it");
  assert.ok(js.includes("preview duration"), "the panel reports what the player measures");
  assert.ok(js.includes("no media data"), "an empty recording is called out, not implied successful");
  assert.ok(js.includes("video/mp4;codecs=avc1"), "mime probing prefers spellable mp4 first");
  assert.ok(js.includes("initFacts"), "init sniffing decides kind+container");
  assert.ok(js.includes("bytesHave"), "track bytes are scanned for video codecs");
  assert.ok(js.includes("elementError"), "async pipeline errors abort the attempt");
  const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", dir), "utf8"));
  assert.equal(manifest.start_url, "https://localhost:2121/cast/");
});

test("live ingest: ids, playlist shape, validators", async () => {
  const { default: cast } = await import("../src/cast.ts").catch(() => ({}));
  void cast;
  const {
    bumpLiveSegments, endLive, getLive, listLive, liveFileValid, liveIdValid,
    livePlaylist, mediaExt, mediaFileValid, newLiveId, newMediaId, startLive,
  } = await import("../src/cast.ts");
  // validators accept only server-shaped names
  assert.equal(liveIdValid("abc123"), true);
  assert.equal(liveIdValid("../x"), false);
  assert.equal(liveIdValid("ABC"), false);
  assert.equal(liveFileValid("index.m3u8"), true);
  assert.equal(liveFileValid("init.mp4"), true);
  assert.equal(liveFileValid("seg-12.m4s"), true);
  assert.equal(liveFileValid("seg-12.mp4"), false);
  assert.equal(liveFileValid("../../etc/passwd"), false);
  assert.equal(mediaFileValid("abcdefghijkl.mp4"), true);
  assert.equal(mediaFileValid("abc.mp4"), false);
  assert.equal(mediaExt("video/mp4"), ".mp4");
  assert.equal(mediaExt("video/mp4;codecs=avc1"), ".mp4");
  assert.equal(mediaExt("application/x-sh"), null);
  assert.match(newMediaId(), /^[a-z0-9]{12}$/);
  assert.match(newLiveId(), /^[a-z0-9]{12}$/);
  // playlist: windowed live, full + ENDLIST on stop
  const live = livePlaylist(25, false);
  assert.ok(live.includes("#EXT-X-MEDIA-SEQUENCE:5"));
  assert.ok(live.includes("seg-24.m4s"));
  assert.ok(!live.includes("seg-4.m4s"));
  assert.ok(!live.includes("ENDLIST"));
  const vod = livePlaylist(3, true);
  assert.ok(vod.includes("#EXT-X-MEDIA-SEQUENCE:0"));
  assert.ok(vod.includes("seg-2.m4s"));
  assert.ok(vod.includes("#EXT-X-ENDLIST"));

  const db = await memdb();
  try {
    const ep = await addEpisode(db, { title: "Live", splits: [{ address: A1, pct: 100 }] });
    const s = await startLive(db, ep.id, 1000);
    assert.match(s.id, /^[a-z0-9]{12}$/);
    assert.equal(s.status, "live");
    assert.equal(s.mime, "");
    assert.equal((await getLive(db, s.id)).episode, ep.id);
    assert.equal(await bumpLiveSegments(db, s.id), 0);
    assert.equal(await bumpLiveSegments(db, s.id), 1);
    assert.equal((await listLive(db)).length, 1);
    const ended = await endLive(db, s.id, 2000);
    assert.equal(ended.status, "ended");
    assert.equal(ended.stoppedAt, 2000);
    await assert.rejects(bumpLiveSegments(db, s.id), /ended/);
    await assert.rejects(startLive(db, "ep_missing"), /no episode/);
  } finally {
    await db.destroy();
  }
});

test("live mime is recorded for player choice", async () => {
  const db = await memdb();
  try {
    const ep = await addEpisode(db, { title: "M", splits: [{ address: A1, pct: 100 }] });
    const s = await startLive(db, ep.id, 1000);
    await setLiveMime(db, s.id, "video/webm;codecs=vp9,opus");
    assert.equal((await getLive(db, s.id)).mime, "video/webm");
    await assert.rejects(setLiveMime(db, s.id, "not a mime"), /bad mime/);
  } finally {
    await db.destroy();
  }
});

test("recorder UI talks to loopback ingest +observed beats only", async () => {
  const fs = await import("node:fs");
  const dir = new URL("../../runner/apps/cast/", import.meta.url);
  const js = fs.readFileSync(new URL("app.js", dir), "utf8");
  const html = fs.readFileSync(new URL("index.html", dir), "utf8");
  for (const token of ["getUserMedia", "getDisplayMedia", "MediaRecorder", "/cast/media", "/cast/live/", "castLiveStart", "castLiveStop", "castSetMedia", "?init=1", "MediaSource", "msePlay", "mseMimeCandidates", "codecs=opus", "fragParsingError", "castLiveGet", "screenPreview", "mixedAudio", "attachEndedWatch", "screen sharing stopped"]) {
    assert.ok(js.includes(token), token);
  }
  assert.ok(html.includes("Screen / window…"), "screen capture button present");
  assert.ok(html.includes("mic over screen"), "mic mixing toggle present");
  // upload endpoint is same-origin relative — never a remote host
  assert.ok(!/fetch\("https?:\/\/(?!localhost|127\.0\.0\.1)/.test(js.replace(/fetch\("\/cast\//g, "")), "remote POST");
});

test("the page boots without undeclared-variable failures", async () => {
  // The parse gate cannot see a missing top-level declaration: deleting
  // `let rpcId = 1` while editing the imports kept every syntax check green
  // and the page showed "Can't find variable: rpcId" on load and on adding an
  // episode. So execute the page against a permissive DOM and a fetch that
  // answers with a JSON-RPC error, then require that nothing surfaced a
  // ReferenceError.
  const fs = await import("node:fs");
  const vm = await import("node:vm");
  const dir = new URL("../../runner/apps/cast/", import.meta.url);
  const js = fs.readFileSync(new URL("app.js", dir), "utf8");

  const written = [];
  const anything = () => new Proxy(function () {}, {
    get: (_target, prop) => {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "then") return undefined; // not thenable: awaits resolve
      return anything();
    },
    set: (_target, prop, value) => {
      if (["textContent", "innerHTML", "value", "className"].includes(prop)) written.push(String(value));
      return true;
    },
    apply: () => anything(),
  });

  const context = {
    console,
    addEventListener: () => {},
    removeEventListener: () => {},
    document: {
      getElementById: () => anything(),
      createElement: () => anything(),
      addEventListener: () => {},
      documentElement: anything(),
      body: anything(),
    },
    navigator: anything(),
    location: anything(),
    localStorage: anything(),
    URL: { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: "TEST", message: "no daemon here" } }),
      text: async () => "",
    }),
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    MediaRecorder: undefined,
  };
  context.window = context; // classic script: window is the global
  vm.createContext(context);
  vm.runInContext(js, context);

  await context.boot();
  const reference = written.find((text) => /Can't find variable|is not defined|ReferenceError/.test(text));
  assert.equal(reference, undefined, `boot surfaced: ${reference}`);

  // And the RPC path itself must fail for the daemon's reason, not a
  // missing counter.
  await assert.rejects(
    () => context.rpc("isAuthenticated"),
    (error) => {
      assert.equal(error.message, "no daemon here");
      return true;
    },
    "rpc must reach fetch",
  );
});
