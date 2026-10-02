// Meme Studio: search the Twetch Meme Library, caption on a canvas, post
// on-chain through the OS wallet. Same-origin RPC like the other bundled
// apps; the page never holds keys. Caption geometry lives in caption.js so
// it is unit-testable without a DOM.
import {
  EXPORT_TARGET_BYTES,
  MEDIA_MAX_BYTES,
  POST_TEXT_BUDGET,
  createPostConfirm,
  estimateFeeSats,
  hitField,
  layoutFields,
} from "./caption.js";
import { families, searchLibrary, toItem } from "./library.js";

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
const statusEl = $("status");
const gridEl = $("grid");
const moreBtn = $("more-btn");
const editorEl = $("editor");
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const topEl = $("top");
const bottomEl = $("bottom");
const postTextEl = $("post-text");
const fmtEl = $("export-fmt");
const qualityEl = $("quality");
const feeEl = $("fee-line");
const postBtn = $("post-btn");
const classifyBtn = $("classify-btn");
const visionEl = $("vision");
const resultEl = $("result");
const pickedEl = $("picked");
const animNoteEl = $("anim-note");

// AdFeed sponsored memes: the campaign pays viewers per click from a
// funder-provided budget. Public endpoints, no keys in the page.
const ADFEED_BASE = "https://adfeed.entangleit.com";
async function adfeed(path, body) {
  const res = await fetch(`${ADFEED_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `adfeed ${res.status}`);
  return data;
}

const state = {
  items: [],
  cursor: null,
  total: 0,
  q: "meme template",
  format: "",
  sort: "",
  selected: null,
  img: null,
  balance: null,
  account: null,
  identity: null,
  posting: false,
  feeEstimate: null,
  confirm: createPostConfirm(),
  confirmTimer: null,
  lastTxid: null,
  campaign: null, // { id, depositAddress, depositAmount }
  fundConfirm: createPostConfirm(),
  fundTimer: null,
  // Local library tab (library-index.json built by evals/library).
  lib: { index: null, loading: false, source: "twetch", family: "", moneyFirst: true },
  // Free-positioned captions: classic top/bottom (draggable) + extras.
  extras: [],
  pos: { top: null, bottom: null }, // {ax, ay} once dragged
  boxes: [],
  drag: null,
  fieldSeq: 1,
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const fmtSats = (n) => `${Number(n || 0).toLocaleString("en-US")} sats`;
const explorerTx = (txid) => `https://whatsonchain.com/tx/${txid}`;

function setStatus(text) {
  statusEl.textContent = text;
}

function thumb(item) {
  return item.previewUrl || item.mediaUrl || "";
}

function canPost() {
  return Boolean(state.account?.imported && state.identity && state.identity.stale !== true);
}

function postBlocker() {
  if (!state.identity) return "Sign in with Twetch first (Twetch app or shell Identity), then come back.";
  if (state.identity.stale === true) return "Twetch session expired — re-sign in, then come back.";
  if (!state.account?.imported) return "Import your Twetch posting key first (Twetch app), then come back.";
  return null;
}

async function refreshStatus() {
  try {
    const [status, balance] = await Promise.all([
      rpc("twetchStatus").catch(() => null),
      rpc("balance").catch(() => null),
    ]);
    state.account = status?.account ?? null;
    state.identity = status?.identity ?? null;
    state.balance = balance ?? null;
    const who = state.identity?.handle ? ` · ${state.identity.handle}` : "";
    const blocker = postBlocker();
    setStatus(blocker ? `browsing (posting unavailable: ${blocker})` : `ready${who}`);
  } catch (err) {
    setStatus(`daemon unreachable: ${err.message}`);
  }
  updateFeeLine();
}

async function search(more = false) {
  if (!more) {
    state.items = [];
    state.cursor = null;
    gridEl.innerHTML = `<p class="hint">searching…</p>`;
  }
  try {
    const res = await rpc("twetchMemes", {
      ...(state.q ? { q: state.q } : {}),
      ...(state.format ? { format: state.format } : {}),
      ...(state.sort ? { sort: state.sort } : {}),
      ...(more && state.cursor ? { cursor: state.cursor } : {}),
      limit: 24,
    });
    const items = res?.items ?? [];
    state.cursor = res?.nextCursor ?? null;
    state.total = res?.total ?? 0;
    state.items = more ? [...state.items, ...items] : items;
    renderGrid();
  } catch (err) {
    gridEl.innerHTML = `<div class="notice bad">search failed: ${esc(err.message)}</div>`;
  }
}

function renderGrid() {
  if (!state.items.length) {
    gridEl.innerHTML = `<p class="hint">no templates found — try “meme template”.</p>`;
    moreBtn.classList.add("hidden");
    return;
  }
  gridEl.innerHTML = state.items.map((m, i) => {
    const sel = state.selected?.id === m.id ? " sel" : "";
    return `<button type="button" class="tile${sel}" data-pick="${i}">` +
      `<img loading="lazy" src="${esc(thumb(m))}" alt="" />` +
      `<span>${esc(m.title || "untitled")}</span></button>`;
  }).join("");
  moreBtn.classList.toggle("hidden", !state.cursor);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // api.twetch.com sends ACAO:*, so the canvas stays clean
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not load the template image"));
    img.src = url;
  });
}

async function select(i) {
  const item = state.items[i];
  if (!item?.mediaUrl) return;
  state.selected = item;
  renderGrid();
  setStatus("loading template…");
  try {
    state.img = await loadImage(item.mediaUrl);
  } catch (err) {
    setStatus(`template failed: ${err.message}`);
    return;
  }
  pickedEl.innerHTML = `template: <b>${esc(item.title || "untitled")}</b>` +
    (item.url ? ` · <a href="${esc(item.url)}" target="_blank" rel="noopener">library page</a>` : "");
  animNoteEl.classList.toggle("hidden", item.format !== "gif" && item.format !== "mp4" && item.format !== "webm");
  editorEl.classList.remove("hidden");
  resultEl.innerHTML = "";
  visionEl.innerHTML = "";
  resetFields();
  drawPreview();
  editorEl.scrollIntoView();
  refreshStatus();
}

function measure(text, px) {
  ctx.font = `bold ${px}px Impact, "Arial Black", "Liberation Sans", sans-serif`;
  return ctx.measureText(text).width;
}

function currentFields() {
  return [
    { id: "top", text: topEl.value, ...(state.pos.top ?? { ax: 0.5, ay: 0.08 }) },
    { id: "bottom", text: bottomEl.value, ...(state.pos.bottom ?? { ax: 0.5, ay: 0.92 }) },
    ...state.extras.map((e) => ({ id: e.id, text: e.text, ax: e.ax, ay: e.ay })),
  ];
}

function drawPreview() {
  if (!state.img || !state.selected) return;
  const img = state.img;
  const scale = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight));
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const layouts = layoutFields(currentFields(), {
    width: canvas.width,
    height: canvas.height,
    measure,
  });
  state.boxes = layouts;
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#000";
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  for (const L of layouts) {
    if (!L.lines.length) continue;
    ctx.font = `bold ${L.size}px Impact, "Arial Black", "Liberation Sans", sans-serif`;
    ctx.lineWidth = Math.max(2, Math.floor(L.size / 8));
    const ordered = L.upward ? [...L.lines].reverse() : L.lines;
    ordered.forEach((line, k) => {
      const y = L.upward ? L.firstBaselineY - k * L.lineHeight : L.firstBaselineY + k * L.lineHeight;
      ctx.strokeText(line, L.cx, y);
      ctx.fillText(line, L.cx, y);
    });
  }
  updateFeeLine();
}

function canvasToBlob(mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("export failed"))),
      mime,
      quality,
    );
  });
}

/** Export under the daemon media cap, downscaling until it fits. */
async function exportMeme() {
  const wantPng = fmtEl.value === "png";
  const mime = wantPng ? "image/png" : "image/jpeg";
  const quality = wantPng ? undefined : Number(qualityEl.value);
  // Draw at progressively smaller sizes until the bytes fit with margin.
  let scale = 1;
  for (;;) {
    const blob = await canvasToBlob(mime, quality);
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (buf.length <= EXPORT_TARGET_BYTES || scale <= 0.35) {
      if (buf.length > MEDIA_MAX_BYTES) throw new Error("captioned image exceeds the 1 MB media cap");
      return { bytes: buf, mime };
    }
    scale *= 0.85;
    const w = Math.max(1, Math.floor(canvas.width * 0.85));
    const h = Math.max(1, Math.floor(canvas.height * 0.85));
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    tmp.getContext("2d").drawImage(canvas, 0, 0, w, h);
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(tmp, 0, 0);
  }
}

/** The Post button's disabled state and label live here, nowhere else. */
function paintPostBtn() {
  const blocker = postBlocker();
  const bal = state.balance?.confirmed;
  const fee = state.feeEstimate;
  postBtn.disabled = Boolean(blocker || state.posting || !state.img) ||
    (typeof bal === "number" && typeof fee === "number" && bal < fee);
  postBtn.textContent = state.confirm.armed() && typeof fee === "number"
    ? `Confirm post (~${fmtSats(fee)})`
    : "Post to Twetch";
}

function updateFeeLine() {
  if (!state.img) {
    state.feeEstimate = null;
    feeEl.textContent = "";
    paintPostBtn();
    return;
  }
  const blocker = postBlocker();
  // Rough size cue: current canvas pixels ≈ JPEG bytes within a factor of two.
  const guess = Math.floor((canvas.width * canvas.height) / 6);
  const fee = estimateFeeSats(Math.min(guess, EXPORT_TARGET_BYTES));
  state.feeEstimate = fee;
  const bal = state.balance?.confirmed;
  const balText = typeof bal === "number" ? ` · balance ${fmtSats(bal)}` : "";
  feeEl.textContent = `posting writes the image on-chain: roughly ${fmtSats(fee)} in fees${balText}.` +
    (blocker ? ` ${blocker}` : "");
  paintPostBtn();
}

/** Any edit re-arms: the confirm names the fee, so stale confirms die. */
function disarm() {
  state.confirm.reset();
  clearTimeout(state.confirmTimer);
  paintPostBtn();
}

/** Vision check: Clef classifies template + hook + caption QA.
 * Advisory only — warns, never blocks posting. */
async function classify() {
  if (!state.selected?.mediaUrl) return;
  visionEl.innerHTML = `<p class="hint">classifying…</p>`;
  const caption = [topEl.value, bottomEl.value, postTextEl.value].filter(Boolean).join(" / ").slice(0, 500);
  try {
    const r = await rpc("classifyMeme", { mediaUrl: state.selected.mediaUrl, caption });
    const t = r?.template;
    const libTitle = (state.selected.title || "").toLowerCase();
    const guess = (t?.choice || "").toLowerCase().replace(/-/g, " ");
    const match = t && guess && libTitle.includes(guess.split(" ")[0]);
    const hook = r?.hook;
    const qa = r?.qa;
    const qaLevel = typeof qa?.score === "number" ? (qa.score >= 1.5 ? "blocked" : qa.score >= 0.5 ? "minor" : "clean") : null;
    visionEl.innerHTML = `<div class="notice ${match === false ? "bad" : "ok"}">` +
      `template: <b>${esc(t?.choice ?? "?")}</b>` +
      (typeof t?.confidence === "number" ? ` (${Math.round(t.confidence * 100)}%)` : "") +
      (match === false ? ` — library says “${esc(state.selected.title || "untitled")}”, double-check the pick` : "") +
      (hook ? `<br>angle: <b>${esc(hook.choice ?? "?")}</b>` : "") +
      (qaLevel && qaLevel !== "clean" ? `<br>caption QA: <b>${esc(qaLevel)}</b> — review placement/contrast before posting` : "") +
      `</div>`;
  } catch (err) {
    const hint = err.code === "CLEF_NO_KEY"
      ? "vision not configured on the daemon (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN)."
      : err.message;
    visionEl.innerHTML = `<div class="notice bad">vision check unavailable: ${esc(hint)}</div>`;
  }
}

async function download() {  try {
    const { bytes, mime } = await exportMeme();
    const ext = mime === "image/png" ? "png" : "jpg";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
    a.download = `meme-${Date.now()}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) {
    setStatus(`download failed: ${err.message}`);
  }
}

async function post() {
  const blocker = postBlocker();
  if (blocker || state.posting || !state.selected) return;
  // Two-step spend: the first click arms and names the fee, the second
  // click within 10s fires. Matches the shell's "spending is confirmed".
  if (state.confirm.press() === "arm") {
    paintPostBtn();
    clearTimeout(state.confirmTimer);
    state.confirmTimer = setTimeout(disarm, 10000);
    return;
  }
  clearTimeout(state.confirmTimer);
  state.confirm.reset();
  const text = postTextEl.value.trim();
  if (text.length > POST_TEXT_BUDGET) {
    resultEl.innerHTML = `<div class="notice bad">post text is over the ${POST_TEXT_BUDGET}-char budget.</div>`;
    return;
  }
  state.posting = true;
  updateFeeLine();
  setStatus("rendering and posting…");
  try {
    const { bytes, mime } = await exportMeme();
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const res = await rpc("twetchPost", {
      content: text || state.selected.title || "meme",
      mediaBase64: btoa(binary),
      mediaMime: mime,
      origin: "memestudio",
    });
    const txid = res?.txid ?? "";
    resultEl.innerHTML = `<div class="notice ok">posted` +
      (txid ? ` <span class="mono">${esc(txid)}</span><br><a href="${explorerTx(txid)}" target="_blank" rel="noopener">chain</a> · <a href="https://twetch.com/t/${esc(txid)}" target="_blank" rel="noopener">twetch</a>` : "") +
      (res?.submitted === false ? `<br>on-chain only: ${esc(res?.submitDetail ?? "")}` : "") +
      `</div>`;
    setStatus("posted — nice.");
    state.lastTxid = txid || null;
    showSponsor();
    refreshStatus();
  } catch (err) {
    resultEl.innerHTML = `<div class="notice bad">post failed [${esc(err.code ?? "")}]: ${esc(err.message)}</div>`;
    setStatus("post failed.");
  } finally {
    state.posting = false;
    updateFeeLine();
    paintPostBtn();
  }
}

function canvasPos(ev) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - r.left) * (canvas.width / Math.max(1, r.width)),
    y: (ev.clientY - r.top) * (canvas.height / Math.max(1, r.height)),
  };
}

function writeFieldPos(id, ax, ay) {
  ax = Math.min(1, Math.max(0, ax));
  ay = Math.min(1, Math.max(0, ay));
  if (id === "top") state.pos.top = { ax, ay };
  else if (id === "bottom") state.pos.bottom = { ax, ay };
  else {
    const e = state.extras.find((x) => x.id === id);
    if (e) {
      e.ax = ax;
      e.ay = ay;
    }
  }
}

canvas.addEventListener("pointerdown", (ev) => {
  if (!state.img || !state.boxes.length) return;
  const p = canvasPos(ev);
  const id = hitField(state.boxes, p.x, p.y);
  if (!id) return;
  ev.preventDefault();
  const L = state.boxes.find((l) => l.id === id);
  state.drag = { id, dx: p.x - L.cx, dy: p.y - L.firstBaselineY };
  try {
    canvas.setPointerCapture(ev.pointerId);
  } catch { /* ignore */ }
  canvas.style.cursor = "grabbing";
});

canvas.addEventListener("pointermove", (ev) => {
  if (!state.drag) return;
  ev.preventDefault();
  const p = canvasPos(ev);
  writeFieldPos(state.drag.id, (p.x - state.drag.dx) / canvas.width, (p.y - state.drag.dy) / canvas.height);
  drawPreview();
});

for (const ev of ["pointerup", "pointercancel"]) {
  canvas.addEventListener(ev, () => {
    state.drag = null;
    canvas.style.cursor = "";
  });
}

const extrasEl = $("extra-fields");

function renderExtras() {
  extrasEl.innerHTML = state.extras.map((e) =>
    `<label>Text <input data-extra="${e.id}" type="text" maxlength="160" value="${esc(e.text)}" placeholder="MORE TEXT" autocomplete="off" /></label>` +
    `<button type="button" data-unextra="${e.id}">✕</button>`).join("");
}

$("add-field-btn").addEventListener("click", () => {
  if (state.extras.length >= 5) return;
  state.extras.push({ id: `x${state.fieldSeq++}`, text: "", ax: 0.5, ay: Math.min(0.85, 0.25 + 0.12 * state.extras.length) });
  renderExtras();
  drawPreview();
  const inp = extrasEl.querySelector("input[data-extra]");
  if (inp) inp.focus();
});

extrasEl.addEventListener("input", (e) => {
  const inp = e.target.closest("[data-extra]");
  if (!inp) return;
  const f = state.extras.find((x) => x.id === inp.dataset.extra);
  if (f) {
    f.text = inp.value;
    drawPreview();
  }
});

extrasEl.addEventListener("click", (e) => {
  const b = e.target.closest("[data-unextra]");
  if (!b) return;
  state.extras = state.extras.filter((x) => x.id !== b.dataset.unextra);
  renderExtras();
  drawPreview();
});

function resetFields() {
  state.extras = [];
  state.pos = { top: null, bottom: null };
  state.boxes = [];
  state.drag = null;
  renderExtras();
}

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.q = $("q").value.trim();
  state.format = $("format").value;
  state.sort = $("sort").value;
  editorEl.classList.add("hidden");
  state.selected = null;
  state.img = null;
  resetFields();
  void search(false);
});
moreBtn.addEventListener("click", () => void search(true));
gridEl.addEventListener("click", (e) => {
  const t = e.target.closest("[data-pick]");
  if (t) void select(Number(t.dataset.pick));
});
for (const el of [topEl, bottomEl, postTextEl]) {
  el.addEventListener("input", () => {
    disarm();
    drawPreview();
  });
}
for (const el of [fmtEl, qualityEl]) {
  el.addEventListener("change", () => {
    disarm();
    updateFeeLine();
  });
}
$("back-btn").addEventListener("click", () => {
  editorEl.classList.add("hidden");
  state.selected = null;
  state.img = null;
  resetFields();
  renderGrid();
});
const libBarEl = $("library-bar");
const libChipsEl = $("lib-chips");
const libCountEl = $("lib-count");

function setSource(source) {
  state.lib.source = source;
  $("src-twetch").classList.toggle("active", source === "twetch");
  $("src-library").classList.toggle("active", source === "library");
  libBarEl.classList.toggle("hidden", source !== "library");
  state.selected = null;
  state.img = null;
  editorEl.classList.add("hidden");
  resetFields();
  if (source === "library") void libSearch();
  else void search(false);
}

async function libIndex() {
  if (state.lib.index) return state.lib.index;
  if (state.lib.loading) return null;
  state.lib.loading = true;
  try {
    const res = await fetch("library-index.json");
    if (!res.ok) throw new Error(`library index unavailable (${res.status})`);
    state.lib.index = await res.json();
    renderChips();
    return state.lib.index;
  } catch (err) {
    gridEl.innerHTML = `<div class="notice bad">local library unavailable: ${esc(err.message)} — rebuild it with evals/library/build-index.mjs.</div>`;
    return null;
  } finally {
    state.lib.loading = false;
  }
}

function renderChips() {
  const fams = families(state.lib.index).slice(0, 24);
  libChipsEl.innerHTML = `<button type="button" data-fam="" class="${state.lib.family ? "" : "active"}">all</button>` +
    fams.map(({ family, n }) =>
      `<button type="button" data-fam="${esc(family)}" class="${state.lib.family === family ? "active" : ""}">${esc(family)} · ${n}</button>`).join("");
}

async function libSearch() {
  const idx = await libIndex();
  if (!idx) return;
  const q = $("lib-q").value.trim();
  const hookFirst = $("lib-money-first").checked ? "money" : "";
  const rows = searchLibrary(idx, { q, family: state.lib.family, hookFirst, limit: 60 });
  state.items = rows.map(toItem);
  state.cursor = null;
  libCountEl.textContent = `${rows.length} shown · ${idx.n ?? idx.rows?.length ?? "?"} indexed` +
    (hookFirst ? " · money angle first" : "") +
    (state.lib.family ? ` · family: ${state.lib.family}` : "");
  renderGrid();
}

$("src-twetch").addEventListener("click", () => setSource("twetch"));
$("src-library").addEventListener("click", () => setSource("library"));
$("lib-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void libSearch();
});
$("lib-money-first").addEventListener("change", () => void libSearch());
libChipsEl.addEventListener("click", (e) => {
  const b = e.target.closest("[data-fam]");
  if (!b) return;
  state.lib.family = b.dataset.fam;
  renderChips();
  void libSearch();
});
$("download-btn").addEventListener("click", () => void download());
classifyBtn.addEventListener("click", () => void classify());
postBtn.addEventListener("click", () => void post());

function showSponsor() {
  if (!state.lastTxid || !state.selected) return;
  $("sponsor").classList.remove("hidden");
  if (!$("s-url").value) $("s-url").value = `https://twetch.com/t/${state.lastTxid}`;
  $("sponsor-out").innerHTML = "";
  state.campaign = null;
  document.querySelector("#sponsor button").textContent = "Create campaign";
  $("sponsor").scrollIntoView();
}

async function createCampaign() {
  const box = $("sponsor-out");
  if (!state.lastTxid) return;
  const payout = Math.floor(Number($("s-payout").value) || 0);
  const budget = Math.floor(Number($("s-budget").value) || 0);
  const fee = Math.floor(Number($("s-fee").value) || 0);
  const url = $("s-url").value.trim();
  if (!/^https?:\/\//i.test(url)) {
    box.innerHTML = `<div class="notice bad">destination link must be an http(s) URL.</div>`;
    return;
  }
  box.innerHTML = `<p class="hint">creating campaign…</p>`;
  try {
    const title = `Meme: ${(state.selected.title || "untitled").slice(0, 70)}`;
    const r = await adfeed("/api/ads", {
      title,
      body: postTextEl.value.trim().slice(0, 300) || title,
      url,
      type: "click",
      minSeconds: 5,
      payoutSats: payout,
      feeSats: fee,
      budgetSats: budget,
      memeTxid: state.lastTxid,
    });
    if (!r.deposit) throw new Error("no deposit address returned");
    // manageToken lives in page memory only: it authorizes pause + status.
    state.campaign = { id: r.id, manageToken: r.manageToken, depositAddress: r.deposit.address, depositAmount: r.deposit.amount };
    box.innerHTML = `<div class="notice ok">campaign <b>${esc(r.id)}</b> pending — fund it to go live (${esc(r.actions ?? "?")} actions).` +
      `<div class="card-sub mono" style="margin-top:6px">${esc(r.deposit.address)}</div>` +
      `<div class="card-actions"><button class="btn tiny" data-copy="${esc(r.deposit.address)}">Copy address</button> ` +
      `<button class="btn tiny primary" data-fund="${esc(String(r.deposit.amount))}">Fund ${esc(fmtSats(r.deposit.amount))} from wallet</button> ` +
      `<button class="btn tiny" data-status="${esc(r.id)}">Check status</button></div></div>` +
      `<p class="hint">Keep the manage token the API returned in-terminal if you need pause later; funding is a plain wallet send.</p>`;
  } catch (err) {
    box.innerHTML = `<div class="notice bad">campaign failed: ${esc(err.message)}</div>`;
  }
}

async function fundCampaign(amount) {
  const c = state.campaign;
  if (!c) return;
  // Two-step, naming amount + destination like the Post button.
  if (state.fundConfirm.press() === "arm") {
    const btn = document.querySelector("[data-fund]");
    if (btn) btn.textContent = `Confirm fund ${fmtSats(amount)}`;
    clearTimeout(state.fundTimer);
    state.fundTimer = setTimeout(() => {
      state.fundConfirm.reset();
      const b = document.querySelector("[data-fund]");
      if (b) b.textContent = `Fund ${fmtSats(amount)} from wallet`;
    }, 10000);
    return;
  }
  clearTimeout(state.fundTimer);
  state.fundConfirm.reset();
  setStatus(`funding campaign ${c.id}…`);
  try {
    const res = await rpc("pay", { to: c.depositAddress, sats: amount, note: `adfeed ${c.id}` });
    setStatus(`funded — polling for activation. ${res?.txid ?? ""}`);
    await checkCampaign();
  } catch (err) {
    setStatus(`fund failed [${err.code ?? ""}]: ${err.message}`);
  }
}

async function checkCampaign() {
  const box = $("sponsor-out");
  const c = state.campaign;
  if (!c?.id) return;
  try {
    if (!c.manageToken) throw new Error("no manage token for this campaign");
    const r = await adfeed("/api/ads/status", { id: c.id, manageToken: c.manageToken });
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = `campaign ${r.state ?? "?"} — received ${r.depositSats ?? 0} of ${r.budgetSats ?? "?"} sats (${r.actions ?? "?"} actions).`;
    box.appendChild(note);
    if (r.state === "active") setStatus("campaign live — viewers earn per click.");
  } catch (err) {
    setStatus(`status check failed: ${err.message}`);
  }
}

$("sponsor-btn").addEventListener("click", () => void createCampaign());
$("sponsor-out").addEventListener("click", (e) => {
  const cp = e.target.closest("[data-copy]");
  if (cp && navigator.clipboard) {
    navigator.clipboard.writeText(cp.dataset.copy).catch(() => {});
    return;
  }
  const f = e.target.closest("[data-fund]");
  if (f) {
    void fundCampaign(Number(f.dataset.fund));
    return;
  }
  const s = e.target.closest("[data-status]");
  if (s) void checkCampaign();
});

(async function boot() {
  $("q").value = state.q;
  await refreshStatus();
  await search(false);
})();
