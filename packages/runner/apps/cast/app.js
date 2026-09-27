// Cast player: value-for-value listening with observed (not self-attested)
// beats. Playback element events drive payment directly:
//   media play   -> castPlay (or streamResume after a pause)
//   media pause  -> streamPause on every split stream
//   media ended  -> castStop (closes all splits)
//   unload       -> castStop, best effort (fetch keepalive)
// The daemon's minutely loop still posts the board beats; this page only
// opens, pauses, resumes, and closes the money.

let rpcId = 1;

async function rpc(method, params = {}) {
  const res = await fetch("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params, id: rpcId++ }),
  });
  const body = await res.json();
  if (body && body.error) {
    const err = new Error(body.error.message || body.error.code || "rpc error");
    err.code = body.error.code;
    throw err;
  }
  return body ? body.result : null;
}

const $ = (id) => document.getElementById(id);
const player = $("player");
const statusEl = $("status");
const meterEl = $("meter");
const hintEl = $("pay-hint");

const state = {
  episode: null,
  sessionId: null,
  streams: [],
  paying: false,
  meterTimer: null,
  hls: null,
};

function shortAddr(a) {
  const s = String(a ?? "");
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

function policyHint(err) {
  return err && err.code === "POLICY_DENY"
    ? "needs approval first — run: bsv allow stream (then press play again)"
    : (err instanceof Error ? err.message : String(err));
}

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}

// ── media loading (native + HLS livestreams) ─────────────────────────────

function teardownMedia() {
  state.mseGen = (state.mseGen || 0) + 1;
  try {
    if (state.hls) state.hls.destroy();
  } catch { /* ignore */ }
  state.hls = null;
  try {
    if (player.src && player.src.startsWith("blob:")) URL.revokeObjectURL(player.src);
  } catch { /* ignore */ }
  player.removeAttribute("src");
  player.load();
}

// MSE needs a full codec string — bare container types report unsupported.
function mseMimeCandidates(base) {
  const b = String(base || "").toLowerCase();
  if (b.startsWith("audio/webm")) return ["audio/webm;codecs=opus", "audio/webm;codecs=vorbis", "audio/webm"];
  if (b.startsWith("video/webm")) {
    return ['video/webm;codecs="vp9,opus"', 'video/webm;codecs="vp8,opus"', 'video/webm;codecs="vp9"', "video/webm"];
  }
  if (b.startsWith("audio/mp4")) return ['audio/mp4;codecs="mp4a.40.2"', "audio/mp4", 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"'];
  if (b.startsWith("video/mp4")) {
    return [
      'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      'video/mp4;codecs="avc1.4D401E,mp4a.40.2"',
      'video/mp4;codecs="avc1.64001f,mp4a.40.2"',
      "video/mp4",
    ];
  }
  return [base || "video/webm"];
}

// MSE playback for our own ingest: sequential append of the exact chunks
// the recorder produced. WebM recorders emit mid-stream clusters no HLS
// demuxer accepts; mp4 recorders can leave holes hls.js seeks over. Both
// classes vanish when we append init + fragments in arrival order.
//
// Codec negotiation is staged: the recorder's stored mime gives the kind
// (audio/video), the init bytes give the container (ftyp vs EBML) and the
// real track set (codec IDs) — appending with a mime that promises a track
// the bytes lack makes Chromium abort the whole media pipeline
// ("Initialization segment misses expected vp9 track"), so we try mimes in
// order, resetting the element between candidates.

function bytesHave(u8, needle) {
  const n = needle.length;
  outer: for (let i = 0; i + n <= u8.length && i < 65536; i++) {
    for (let j = 0; j < n; j++) {
      if (u8[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

function initFacts(initBuf, botMime) {
  let kind = botMime.startsWith("audio/") ? "audio" : botMime.startsWith("video/") ? "video" : "";
  let container = botMime.includes("mp4") ? "mp4" : botMime.includes("webm") ? "webm" : "";
  if (initBuf && initBuf.byteLength > 12) {
    const u8 = new Uint8Array(initBuf);
    if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) container = "mp4";
    else if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) container = "webm";
    const video = ["V_VP8", "V_VP9", "V_AV1", "avc1", "hvc1", "av01", "mp4v"].some((c) => bytesHave(u8, c));
    const audio = ["A_OPUS", "A_VORBIS", "Opus", "mp4a", "opus"].some((c) => bytesHave(u8, c));
    if (video) kind = "video";
    else if (audio) kind = "audio";
  }
  if (!kind) kind = "video";
  if (!container) container = "webm";
  return { kind, container };
}

async function msePlay(playlistUrl) {
  const gen = (state.mseGen || 0) + 1;
  state.mseGen = gen;
  const alive = () => (state.mseGen || 0) === gen;
  const m = /\/cast\/live\/([a-z0-9]{6,16})\/index\.m3u8/.exec(playlistUrl);
  let botMime = "";
  if (m) {
    try {
      const info = await rpc("castLiveGet", { id: m[1] });
      if (info && typeof info.mime === "string" && info.mime) botMime = info.mime.split(";")[0];
    } catch { /* fall back to bytes */ }
  }
  const base = playlistUrl.replace(/index\.m3u8.*$/, "");
  let initBuf = null;
  try {
    const res = await fetch(base + "init.mp4", { cache: "no-store" });
    if (res.ok) initBuf = await res.arrayBuffer();
  } catch { /* live may not have init yet */ }
  if (!alive()) return;

  const { kind, container } = initFacts(initBuf, botMime);
  const primary = `${kind}/${container}`;
  const cross = `${kind === "video" ? "audio" : "video"}/${container}`;
  const cands = [
    ...mseMimeCandidates(primary),
    ...mseMimeCandidates(cross),
  ].filter((c) => {
    try {
      return window.MediaSource && MediaSource.isTypeSupported(c);
    } catch {
      return false;
    }
  });
  if (!cands.length) {
    hintEl.textContent = `cannot play this broadcast here (${primary} unsupported)`;
    return;
  }
  hintEl.textContent = "playing broadcast (direct stream)…";

  const resetElement = () => {
    try {
      player.removeAttribute("src");
      player.load();
    } catch { /* ignore */ }
  };

  let lastError = null;
  for (const cand of cands.slice(0, 5)) {
    if (!alive()) return;
    resetElement();
    const ms = new MediaSource();
    const objUrl = URL.createObjectURL(ms);
    player.src = objUrl;
    const opened = await new Promise((res) => {
      ms.addEventListener("sourceopen", () => res(true), { once: true });
      setTimeout(() => res(false), 10000);
    });
    if (!alive()) return;
    if (!opened) {
      lastError = new Error("media source did not open");
      break;
    }
    let sb;
    try {
      sb = ms.addSourceBuffer(cand);
    } catch (e) {
      lastError = e;
      continue;
    }
    let elementError = null;
    const onErr = () => {
      elementError = player.error ? `media pipeline: ${player.error.message || player.error.code}` : "media error";
    };
    player.addEventListener("error", onErr);
    const attached = () => {
      try {
        return ms.readyState === "open" && ms.sourceBuffers.length > 0 && !elementError;
      } catch {
        return false;
      }
    };
    const append = (buf) => new Promise((res, rej) => {
      if (elementError) {
        rej(new Error(elementError));
        return;
      }
      if (!attached()) {
        rej(new Error("source buffer detached"));
        return;
      }
      const done = () => {
        sb.removeEventListener("updateend", done);
        res();
      };
      sb.addEventListener("updateend", done);
      try {
        sb.appendBuffer(buf);
      } catch (e) {
        sb.removeEventListener("updateend", done);
        rej(e);
      }
    });
    const seen = new Set();
    try {
      if (initBuf) {
        seen.add("init.mp4");
        await append(initBuf);
        await new Promise((r) => setTimeout(r, 250)); // let async demuxer errors surface
        if (elementError) throw new Error(elementError);
      }
      for (;;) {
        if (!alive()) return;
        if (elementError) throw new Error(elementError);
        const txt = await (await fetch(playlistUrl, { cache: "no-store" })).text();
        const files = [...txt.matchAll(/^(init\.mp4|seg-\d+\.m4s)$/gm)].map((x) => x[1]);
        for (const f of files) {
          if (!alive()) return;
          if (seen.has(f)) continue;
          seen.add(f);
          const buf = await (await fetch(base + f, { cache: "no-store" })).arrayBuffer();
          if (!alive()) return;
          await append(buf);
          if (elementError) throw new Error(elementError);
        }
        if (txt.includes("ENDLIST")) break;
        await new Promise((r) => setTimeout(r, 4000));
      }
      player.removeEventListener("error", onErr);
      if (alive() && attached()) {
        try {
          ms.endOfStream();
        } catch { /* ignore */ }
      }
      hintEl.textContent = "";
      await player.play().catch(() => {});
      return; // worked: done
    } catch (e) {
      lastError = e;
    }
    player.removeEventListener("error", onErr);
    if (!alive()) return; // teardown raced us — silent
    try {
      URL.revokeObjectURL(objUrl);
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!alive()) return;
  hintEl.textContent = `MSE stopped: ${lastError instanceof Error ? lastError.message : lastError ?? "no playable codec"}`;
}

function loadMedia(url) {
  teardownMedia();
  if (!url) return;
  const isHls = /\.m3u8(\?|#|$)/i.test(url);
  // Our own ingest URLs always go straight to MSE: sequential append of the
  // exact chunks the recorder produced can never have holes or mid-stream
  // clusters, which is precisely the failure class hls.js keeps tripping on
  // (fragParsingError, bufferSeekOverHole). Third-party .m3u8s keep hls.js.
  if (isHls && /\/cast\/live\/[a-z0-9]{6,16}\//.test(url)) {
    void msePlay(url);
    return;
  }
  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ maxBufferLength: 30 });
    // A dropped rolling-window segment can leave a buffer hole the player
    // seeks over; clamp to the live edge instead of surfacing the error.
    const seekToEdge = () => {
      try {
        const sk = player.seekable;
        if (sk.length) player.currentTime = Math.max(0, sk.end(sk.length - 1) - 0.5);
      } catch { /* ignore */ }
    };
    hls.on(window.Hls.Events.ERROR, (_ev, data) => {
      if (!data || !data.fatal) return;
      if (data.details === "fragParsingError") {
        try {
          hls.destroy();
        } catch { /* ignore */ }
        if (state.hls === hls) state.hls = null;
        void msePlay(url);
      } else if (data.details === "bufferSeekOverHole" || data.details === "bufferStalledError") {
        seekToEdge();
        hintEl.textContent = "caught up to the live edge…";
      } else {
        hintEl.textContent = `stream error: ${data.type} ${data.details}`;
      }
    });
    hls.loadSource(url);
    hls.attachMedia(player);
    state.hls = hls;
  } else if (isHls && player.canPlayType("application/vnd.apple.mpegurl")) {
    player.src = url;
  } else if (isHls) {
    hintEl.textContent = "HLS not supported in this browser build — use a direct mp4/webm URL.";
  } else {
    player.src = url;
  }
}

// ── episodes ─────────────────────────────────────────────────────────────

function renderEpisodes(items) {
  const box = $("episodes");
  box.textContent = "";
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No episodes yet — add one below.";
    box.append(p);
    return;
  }
  for (const ep of items) {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("h3");
    title.textContent = ep.title || "untitled";
    const badges = document.createElement("div");
    badges.className = "row";
    const b = document.createElement("span");
    if (!ep.mediaUrl) {
      b.className = "badge nomedia";
      b.textContent = "no media";
    } else {
      b.className = `badge ${ep.live ? "live" : "file"}`;
      b.textContent = ep.live ? "live" : "file";
    }
    badges.append(b);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = (ep.splits || []).map((s) => `${s.pct}% ${shortAddr(s.address)}`).join(" · ") || "no splits";
    const row = document.createElement("div");
    row.className = "row";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = ep.mediaUrl ? "Open" : "Pay only";
    open.addEventListener("click", () => selectEpisode(ep));
    row.append(open);
    card.append(title, badges, meta, row);
    box.append(card);
  }
}

async function loadEpisodes() {
  try {
    const res = await rpc("castEpisodes");
    renderEpisodes(res?.episodes ?? []);
    await refreshLiveEpisodes();
  } catch (e) {
    $("episodes").textContent = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = e instanceof Error ? e.message : String(e);
    $("episodes").append(p);
  }
}

function selectEpisode(ep) {
  void stopPaying();
  state.episode = ep;
  $("now-playing").classList.remove("hidden");
  $("np-title").textContent = `${ep.live ? "● LIVE · " : ""}${ep.title}`;
  $("stop-btn").classList.add("hidden");
  $("pay-btn").classList.remove("hidden");
  $("pay-btn").disabled = false;
  meterEl.textContent = "not paying";
  hintEl.textContent = "";
  loadMedia(ep.mediaUrl || "");
  if (!ep.mediaUrl) hintEl.textContent = "No media URL — payment only. Press Start paying while you listen elsewhere.";
  document.getElementById("now-playing").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── payment lifecycle (observed beats) ───────────────────────────────────

async function startPaying() {
  if (!state.episode || state.paying) return;
  const btn = $("pay-btn");
  btn.disabled = true;
  hintEl.textContent = "";
  try {
    const res = await rpc("castPlay", {
      episode: state.episode.id,
      rate: Math.floor(Number($("rate").value) || 0),
      max: Math.floor(Number($("maxcap").value) || 0),
    });
    state.sessionId = res.id;
    state.streams = res.streamIds ?? [];
    state.paying = true;
    btn.classList.add("hidden");
    $("stop-btn").classList.remove("hidden");
    setStatus(`paying · session ${state.sessionId.slice(0, 10)}…`, "ok");
    startMeter();
  } catch (e) {
    hintEl.textContent = policyHint(e);
    btn.disabled = false;
  }
}

async function pausePaying() {
  if (!state.paying) return;
  state.paying = false;
  stopMeter();
  for (const sid of state.streams) {
    try {
      await rpc("streamPause", { id: sid });
    } catch { /* one stuck stream never blocks the rest */ }
  }
  meterEl.innerHTML = "paused <small>· resume playback to resume payment</small>";
}

async function resumePaying() {
  if (!state.sessionId || state.paying) return;
  try {
    for (const sid of state.streams) {
      try {
        await rpc("streamResume", { id: sid });
      } catch { /* keep going */ }
    }
    state.paying = true;
    startMeter();
  } catch (e) {
    hintEl.textContent = policyHint(e);
  }
}

async function stopPaying() {
  if (!state.sessionId) return;
  const id = state.sessionId;
  state.sessionId = null;
  state.streams = [];
  state.paying = false;
  stopMeter();
  $("stop-btn").classList.add("hidden");
  $("pay-btn").classList.remove("hidden");
  $("pay-btn").disabled = false;
  meterEl.textContent = "not paying";
  try {
    await rpc("castStop", { id });
    setStatus("session closed — paid money stays paid", "");
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "warn");
  }
}

async function refreshMeter() {
  if (!state.sessionId || !state.streams.length) return;
  let total = 0;
  const parts = [];
  for (const sid of state.streams) {
    try {
      const res = await rpc("streamTicks", { id: sid, limit: 50 });
      const paid = (res?.ticks ?? []).filter((t) => t.status === "paid").reduce((a, t) => a + t.amount, 0);
      total += paid;
      parts.push(`${sid.slice(4, 10)}… ${paid}`);
    } catch { /* keep last reading */ }
  }
  meterEl.innerHTML = `${total} sats paid <small>· ${parts.join(" · ")}</small>`;
}

function startMeter() {
  stopMeter();
  void refreshMeter();
  state.meterTimer = setInterval(refreshMeter, 15000);
}

function stopMeter() {
  if (state.meterTimer) clearInterval(state.meterTimer);
  state.meterTimer = null;
}

$("pay-btn").addEventListener("click", () => {
  void player.play().catch(() => {});
  void startPaying();
});
$("stop-btn").addEventListener("click", () => {
  player.pause();
  void stopPaying();
});

player.addEventListener("pause", () => {
  // Media paused (or ended w/o ended event): pause money, keep session.
  if (!player.ended) void pausePaying();
});
player.addEventListener("play", () => {
  // Observed playback resumes: resume money, or start if never started.
  if (state.sessionId) void resumePaying();
});
player.addEventListener("ended", () => {
  void stopPaying();
});
window.addEventListener("beforeunload", () => {
  if (state.sessionId) {
    try {
      fetch("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "castStop", params: { id: state.sessionId }, id: 999 }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* leaving anyway */ }
  }
});

// ── add episode ──────────────────────────────────────────────────────────

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const st = $("add-status");
  st.className = "status";
  st.textContent = "adding…";
  try {
    await rpc("castAdd", {
      title: $("f-title").value.trim(),
      media: $("f-media").value.trim() || undefined,
      live: $("f-live").checked || undefined,
      splits: $("f-splits").value.trim(),
    });
    st.className = "status ok";
    st.textContent = "added";
    $("f-title").value = "";
    $("f-media").value = "";
    $("f-live").checked = false;
    $("f-splits").value = "";
    await loadEpisodes();
  } catch (err) {
    st.className = "status warn";
    st.textContent = err instanceof Error ? err.message : String(err);
  }
});

// ── record (camera/mic → file → wallet → episode) ────────────────────────

const rec = {
  stream: null,
  recorder: null,
  chunks: [],
  mime: "",
  startedAt: 0,
  clockTimer: null,
  blob: null,
  blobUrl: "",
  uploadedUrl: "",
  liveId: null,
  liveEpisode: null,
  liveCount: 0,
};

function pickMime(live) {
  // Live prefers fmp4 (HLS-compatible); WebM falls back to MSE playback.
  const cands = live
    ? ["video/mp4", 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', "video/webm;codecs=vp9,opus", "video/webm"]
    : ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm", "audio/webm"];
  if ($("r-miconly").checked) return "audio/webm";
  for (const c of cands) {
    try {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    } catch { /* ignore */ }
  }
  return "";
}

async function recPreview() {
  const btn = $("r-preview-btn");
  btn.disabled = true;
  try {
    if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
    const micOnly = $("r-miconly").checked;
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: micOnly ? false : { facingMode: $("r-camera").value },
    });
    const pv = $("rec-preview");
    pv.classList.remove("hidden");
    pv.srcObject = rec.stream;
    await pv.play().catch(() => {});
    $("r-record").disabled = false;
    setStatus("camera ready", "ok");
  } catch (e) {
    setStatus(`camera blocked: ${e instanceof Error ? e.message : e}`, "warn");
  } finally {
    btn.disabled = false;
  }
}

function recClock() {
  const s = Math.floor((Date.now() - rec.startedAt) / 1000);
  $("r-clock").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function recStart(live) {
  if (!rec.stream) return false;
  rec.mime = pickMime(live);
  if (!rec.mime) {
    setStatus("recording unsupported here", "warn");
    return false;
  }
  rec.chunks = [];
  rec.blob = null;
  rec.recorder = new MediaRecorder(rec.stream, { mimeType: rec.mime, videoBitsPerSecond: 2_500_000 });
  rec.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      if (live) void liveChunk(e.data);
      else rec.chunks.push(e.data);
    }
  };
  rec.recorder.onstop = () => {
    if (!live && rec.chunks.length) {
      rec.blob = new Blob(rec.chunks, { type: rec.mime });
      if (rec.blobUrl) URL.revokeObjectURL(rec.blobUrl);
      rec.blobUrl = URL.createObjectURL(rec.blob);
      const pb = $("r-playback");
      pb.src = rec.blobUrl;
      const dl = $("r-download");
      dl.href = rec.blobUrl;
      dl.download = `cast-${Date.now()}.${rec.mime.includes("mp4") ? "mp4" : "webm"}`;
      $("r-done").classList.remove("hidden");
    }
    clearInterval(rec.clockTimer);
    $("r-record").disabled = false;
    $("r-stop").disabled = true;
  };
  rec.startedAt = Date.now();
  rec.recorder.start(live ? 4000 : 1000);
  rec.clockTimer = setInterval(recClock, 500);
  $("r-record").disabled = true;
  $("r-stop").disabled = false;
  return true;
}

$("r-preview-btn").addEventListener("click", () => void recPreview());
$("r-record").addEventListener("click", () => void recStart(false));
$("r-stop").addEventListener("click", () => {
  try {
    rec.recorder && rec.recorder.state !== "inactive" && rec.recorder.stop();
  } catch { /* ignore */ }
});

$("r-download").addEventListener("click", () => {
  setStatus("downloaded — host it anywhere, or upload it to the wallet below", "");
});

$("r-upload").addEventListener("click", async () => {
  const st = $("r-up-status");
  if (!rec.blob) return;
  st.className = "status";
  st.textContent = "uploading…";
  try {
    const res = await fetch("/cast/media", {
      method: "POST",
      headers: { "content-type": rec.blob.type || "video/webm" },
      body: rec.blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `upload ${res.status}`);
    rec.uploadedUrl = data.url;
    st.className = "status ok";
    st.textContent = `stored · ${data.bytes} bytes`;
    $("r-publish").classList.remove("hidden");
    $("r-title").value = $("r-title").value || `Recording ${new Date().toLocaleString()}`;
  } catch (e) {
    st.className = "status warn";
    st.textContent = e instanceof Error ? e.message : String(e);
  }
});

$("r-add-ep").addEventListener("click", async () => {
  const st = $("r-ep-status");
  st.className = "status";
  st.textContent = "adding…";
  try {
    const splits = prompt("Value splits (address:pct,address:pct — must sum to 100):", "");
    if (!splits) {
      st.textContent = "";
      return;
    }
    const res = await rpc("castAdd", { title: $("r-title").value.trim(), media: rec.uploadedUrl, splits });
    st.className = "status ok";
    st.textContent = `episode ${res.id}`;
    await loadEpisodes();
    await refreshLiveEpisodes();
  } catch (e) {
    st.className = "status warn";
    st.textContent = e instanceof Error ? e.message : String(e);
  }
});

// ── go live (segments → HLS playlist → viewers pay) ───────────────────────

async function refreshLiveEpisodes() {
  const sel = $("r-live-ep");
  sel.textContent = "";
  try {
    const res = await rpc("castEpisodes");
    for (const ep of res?.episodes ?? []) {
      const o = document.createElement("option");
      o.value = ep.id;
      o.textContent = `${ep.live ? "● " : ""}${ep.title}`;
      sel.append(o);
    }
    $("r-golive").disabled = !sel.value;
  } catch { /* keep */ }
}

async function liveChunk(blob) {
  if (!rec.liveId) return;
  const first = rec.liveCount === 0;
  try {
    const qs = first ? `?init=1&mime=${encodeURIComponent(rec.mime)}` : "";
    const res = await fetch(`/cast/live/${rec.liveId}/segment${qs}`, {
      method: "POST",
      headers: { "content-type": "video/mp4" },
      body: blob,
    });
    if (!res.ok) throw new Error(`segment ${res.status}`);
    rec.liveCount++;
    const kind = rec.mime.includes("mp4") ? "HLS" : "MSE/WebM";
    $("r-live-status").textContent = `broadcasting (${kind}) · ${rec.liveCount} chunks — open the episode to watch + pay`;
  } catch (e) {
    $("r-live-status").textContent = `upload stalled: ${e instanceof Error ? e.message : e}`;
  }
}

$("r-golive").addEventListener("click", async () => {
  const epId = $("r-live-ep").value;
  if (!epId || !rec.stream) {
    $("r-live-status").textContent = !epId ? "pick an episode" : "preview the camera first";
    return;
  }
  $("r-golive").disabled = true;
  try {
    const live = await rpc("castLiveStart", { episode: epId });
    rec.liveId = live.id;
    rec.liveCount = 0;
    await rpc("castSetMedia", { episode: epId, mediaUrl: `${location.origin}/cast/live/${live.id}/index.m3u8` });
    await loadEpisodes();
    if (!recStart(true)) throw new Error("recorder failed to start");
    $("r-endlive").disabled = false;
    $("r-live-status").textContent = "broadcasting…";
  } catch (e) {
    $("r-live-status").textContent = e instanceof Error ? e.message : String(e);
    $("r-golive").disabled = false;
  }
});

$("r-endlive").addEventListener("click", async () => {
  try {
    rec.recorder && rec.recorder.state !== "inactive" && rec.recorder.stop();
  } catch { /* ignore */ }
  // let the final chunk flush before closing the playlist
  await new Promise((r) => setTimeout(r, 1500));
  if (rec.liveId) {
    try {
      await rpc("castLiveStop", { id: rec.liveId });
      $("r-live-status").textContent = "broadcast ended — replay saved as the episode media";
    } catch (e) {
      $("r-live-status").textContent = e instanceof Error ? e.message : String(e);
    }
    rec.liveId = null;
  }
  $("r-endlive").disabled = true;
  $("r-golive").disabled = false;
  await loadEpisodes();
});

// RPC note: castAdd takes the same "addr:pct,…" split string as the CLI;
// the daemon parses and re-validates it.

async function boot() {
  try {
    const status = await rpc("isAuthenticated").catch(() => null);
    if (status && status.locked) {
      setStatus("wallet locked — run: bsv unlock", "warn");
    } else {
      setStatus("wallet ready · payment starts only when you press play", "ok");
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "warn");
  }
  await loadEpisodes();
}

boot();
