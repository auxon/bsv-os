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
  layoutCaption,
} from "./caption.js";

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
const resultEl = $("result");
const pickedEl = $("picked");
const animNoteEl = $("anim-note");

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
  drawPreview();
  editorEl.scrollIntoView();
  refreshStatus();
}

function measure(text, px) {
  ctx.font = `bold ${px}px Impact, "Arial Black", "Liberation Sans", sans-serif`;
  return ctx.measureText(text).width;
}

function drawPreview() {
  if (!state.img || !state.selected) return;
  const img = state.img;
  const scale = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight));
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const layout = layoutCaption({
    top: topEl.value,
    bottom: bottomEl.value,
    width: canvas.width,
    height: canvas.height,
    measure,
  });
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#000";
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  const paint = (lines, endBaselineY, upward) => {
    ctx.font = `bold ${layout.size}px Impact, "Arial Black", "Liberation Sans", sans-serif`;
    ctx.lineWidth = Math.max(2, Math.floor(layout.size / 8));
    const ordered = upward ? [...lines].reverse() : lines;
    ordered.forEach((line, k) => {
      const y = upward ? endBaselineY - k * layout.lineHeight : endBaselineY + k * layout.lineHeight;
      ctx.strokeText(line, canvas.width / 2, y);
      ctx.fillText(line, canvas.width / 2, y);
    });
  };
  if (layout.top.lines.length) paint(layout.top.lines, layout.top.firstBaselineY, false);
  if (layout.bottom.lines.length) paint(layout.bottom.lines, layout.bottom.lastBaselineY, true);
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

async function download() {
  try {
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

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.q = $("q").value.trim();
  state.format = $("format").value;
  state.sort = $("sort").value;
  editorEl.classList.add("hidden");
  state.selected = null;
  state.img = null;
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
  renderGrid();
});
$("download-btn").addEventListener("click", () => void download());
postBtn.addEventListener("click", () => void post());

(async function boot() {
  $("q").value = state.q;
  await refreshStatus();
  await search(false);
})();
