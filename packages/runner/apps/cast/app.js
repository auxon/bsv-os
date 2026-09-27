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
  try {
    if (state.hls) state.hls.destroy();
  } catch { /* ignore */ }
  state.hls = null;
  player.removeAttribute("src");
  player.load();
}

function loadMedia(url) {
  teardownMedia();
  if (!url) return;
  const isHls = /\.m3u8(\?|#|$)/i.test(url);
  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ maxBufferLength: 30 });
    hls.on(window.Hls.Events.ERROR, (_ev, data) => {
      if (data && data.fatal) hintEl.textContent = `stream error: ${data.type} ${data.details}`;
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
