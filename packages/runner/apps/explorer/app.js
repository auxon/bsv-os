// bsvOS Explorer — local-only chain explorer with protocol decoding and a
// wallet lens. Reads WhatsOnChain for chain data and the local bsv-walletd
// RPC (same origin) for the machine's own transactions. No keys involved.
"use strict";

const API = "https://api.whatsonchain.com/v1/bsv/main";
const B_PREFIX = "19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut";
const MAP_PREFIX = "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5";
const AIP_PREFIX = "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva";
const EXPLORER = "https://whatsonchain.com";

const $ = (sel) => document.querySelector(sel);
const view = $("#view");
const input = $("#search-input");

// ── tiny utils ──────────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtInt = (n) => Number(n ?? 0).toLocaleString("en-US");
const fmtBytes = (n) => {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};
const fmtBsv = (sats) => {
  const v = Number(sats) / 1e8;
  return `${v.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} BSV`;
};
const timeAgo = (unixSec) => {
  if (!unixSec) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const short = (s, n = 10) => (String(s ?? "").length > n * 2 ? `${String(s).slice(0, n)}…${String(s).slice(-n)}` : String(s ?? ""));
const fmtDifficulty = (d) => {
  const n = Number(d) || 0;
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`;
  return fmtInt(Math.round(n));
};
const ts = (unixSec) => (unixSec ? new Date(unixSec * 1000).toLocaleString() : "—");

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 1800);
}

function copy(text) {
  navigator.clipboard?.writeText(String(text)).then(
    () => toast("copied"),
    () => toast("copy failed"),
  );
}

// ── fetch cache ─────────────────────────────────────────────────────────
// Cross-origin fetches are gated to a couple in flight with retries: some
// browsers/networks drop bursts of parallel requests to the same host.
const cache = new Map();
const gate = { active: 0, waiters: [] };
async function acquire() {
  if (gate.active < 2) {
    gate.active++;
    return;
  }
  await new Promise((r) => gate.waiters.push(r));
  gate.active++;
}
function release() {
  gate.active--;
  const next = gate.waiters.shift();
  if (next) next();
}

async function api(path, ttl = 30_000) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    await acquire();
    try {
      const res = await fetch(`${API}${path}`, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!res.ok) {
        const err = new Error(res.status === 404 ? "not found" : `WhatsOnChain ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      cache.set(path, { at: Date.now(), data });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      return data;
    } catch (e) {
      lastErr = e;
      if (e.status === 404) throw e;
    } finally {
      release();
    }
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  throw lastErr;
}

let rpcId = 1;
async function rpc(method, params = {}) {
  await acquire();
  try {
    const res = await fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params, id: rpcId++ }),
    });
    const body = await res.json();
    if (body?.error) {
      const err = new Error(body.error.message || body.error.code || "rpc error");
      err.code = body.error.code;
      throw err;
    }
    return body?.result ?? null;
  } finally {
    release();
  }
}

// ── script / protocol decoding ──────────────────────────────────────────
function hexToBytes(hex) {
  const clean = String(hex ?? "").replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function readPush(b, p) {
  const op = b[p];
  if (op === undefined) return null;
  if (op >= 0x01 && op <= 0x4b) return { data: b.subarray(p + 1, p + 1 + op), next: p + 1 + op };
  if (op === 0x4c) {
    const n = b[p + 1];
    return n === undefined ? null : { data: b.subarray(p + 2, p + 2 + n), next: p + 2 + n };
  }
  if (op === 0x4d) {
    if (p + 2 >= b.length) return null;
    const n = b[p + 1] | (b[p + 2] << 8);
    return { data: b.subarray(p + 3, p + 3 + n), next: p + 3 + n };
  }
  if (op === 0x4e) {
    if (p + 4 >= b.length) return null;
    const n = b[p + 1] | (b[p + 2] << 8) | (b[p + 3] << 16) | (b[p + 4] << 24);
    return { data: b.subarray(p + 5, p + 5 + n), next: p + 5 + n };
  }
  return null;
}

const decoder = new TextDecoder("utf-8", { fatal: false });
const asStr = (bytes) => (bytes ? decoder.decode(bytes) : "");
const isPrefix = (bytes, prefix) => bytes && bytes.length === prefix.length && asStr(bytes) === prefix;
const looksPrintable = (bytes) => {
  if (!bytes || !bytes.length) return true;
  let printable = 0;
  const n = Math.min(bytes.length, 200);
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
  }
  return printable / n > 0.9;
};

/** Decode an OP_RETURN script into B://, MAP, and AIP segments. */
function decodeOpReturn(scriptHex) {
  const b = hexToBytes(scriptHex);
  let p = 0;
  if (b[0] === 0x00 && b[1] === 0x6a) p = 2;
  else if (b[0] === 0x6a) p = 1;
  else return null;
  const pushes = [];
  while (p < b.length) {
    const push = readPush(b, p);
    if (!push) break;
    pushes.push(push.data);
    p = push.next;
  }
  const segs = [];
  let i = 0;
  while (i < pushes.length) {
    const d = pushes[i];
    if (isPrefix(d, B_PREFIX)) {
      const content = pushes[i + 1] ?? new Uint8Array();
      const mime = asStr(pushes[i + 2]);
      const maybeEnc = pushes[i + 3];
      const knownNext = maybeEnc && (isPrefix(maybeEnc, MAP_PREFIX) || isPrefix(maybeEnc, AIP_PREFIX) || isPrefix(maybeEnc, B_PREFIX) || asStr(maybeEnc) === "|");
      const encoding = maybeEnc && !knownNext ? asStr(maybeEnc) : "";
      const text = mime.startsWith("text/") || (!mime && looksPrintable(content));
      segs.push({ protocol: "B", content, mime, encoding, text });
      i += encoding ? 4 : 3;
      continue;
    }
    if (isPrefix(d, MAP_PREFIX)) {
      const fields = [];
      let command = "";
      i++;
      if (i < pushes.length) command = asStr(pushes[i++]);
      while (i + 1 < pushes.length) {
        const k = asStr(pushes[i]);
        if (k === "|" || isPrefix(pushes[i], AIP_PREFIX) || isPrefix(pushes[i], B_PREFIX) || isPrefix(pushes[i], MAP_PREFIX)) break;
        fields.push([k, asStr(pushes[i + 1])]);
        i += 2;
      }
      segs.push({ protocol: "MAP", command, fields });
      continue;
    }
    if (isPrefix(d, AIP_PREFIX)) {
      segs.push({ protocol: "AIP", algorithm: asStr(pushes[i + 1]), address: asStr(pushes[i + 2]), signature: asStr(pushes[i + 3]) });
      i += 4;
      continue;
    }
    if (asStr(d) === "|") {
      i++;
      continue;
    }
    segs.push({ protocol: "RAW", data: d });
    i++;
  }
  return segs.length ? segs : null;
}

async function sha256Hex(bytes) {
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

function renderSegments(segs, local) {
  const chips = [];
  const bodies = [];
  for (const seg of segs) {
    if (seg.protocol === "B") {
      if (seg.text) {
        chips.push(`<span class="chip b">B:// text</span>`);
        if (seg.mime) chips.push(`<span class="chip">${esc(seg.mime)}</span>`);
        bodies.push(`<div class="seg"><div class="seg-title">On-chain text${seg.encoding ? ` · ${esc(seg.encoding)}` : ""}</div><div class="op-text">${esc(asStr(seg.content))}</div></div>`);
      } else {
        chips.push(`<span class="chip b">B:// media</span>`);
        if (seg.mime) chips.push(`<span class="chip">${esc(seg.mime)}</span>`);
        chips.push(`<span class="chip">${fmtBytes(seg.content.length)}</span>`);
        const id = `m${Math.random().toString(36).slice(2, 9)}`;
        const isImage = /^image\//.test(seg.mime) && seg.content.length <= 2_000_000;
        bodies.push(
          `<div class="seg"><div class="seg-title">On-chain media</div><div class="op-media" id="${id}">` +
            (isImage ? `<div class="skeleton" style="width:200px;height:140px"></div>` : "") +
            `<div class="meta"><span>${esc(seg.mime || "application/octet-stream")}</span><span>${fmtBytes(seg.content.length)}</span><span class="sha"></span></div></div></div>`,
        );
        queueMicrotask(async () => {
          const host = document.getElementById(id);
          if (!host) return;
          if (isImage) {
            const blob = new Blob([seg.content], { type: seg.mime || "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            host.querySelector(".skeleton")?.replaceWith(Object.assign(document.createElement("img"), { src: url, alt: "on-chain media", loading: "lazy" }));
          }
          const sha = await sha256Hex(seg.content);
          const slot = host.querySelector(".sha");
          if (slot && sha) slot.innerHTML = `sha256 <span class="hash" data-copy="${sha}">${short(sha, 10)}</span>`;
        });
      }
    } else if (seg.protocol === "MAP") {
      chips.push(`<span class="chip map">MAP ${esc(seg.command || "SET")}</span>`);
      const rows = seg.fields.map(([k, v]) => `<div><span class="dim">${esc(k)}</span> <span>${esc(v)}</span></div>`).join("");
      bodies.push(`<div class="seg"><div class="seg-title">MAP metadata</div><div class="mono">${rows}</div></div>`);
    } else if (seg.protocol === "AIP") {
      chips.push(`<span class="chip aip">AIP ${esc(seg.algorithm || "signature")}</span>`);
      bodies.push(
        `<div class="seg"><div class="seg-title">Authorship</div><div class="mono">` +
          `<div><span class="dim">signer</span> ${esc(seg.address)}</div>` +
          `<div><span class="dim">signature</span> ${esc(short(seg.signature, 12))}</div></div></div>`,
      );
    } else {
      chips.push(`<span class="chip plain">OP_RETURN</span>`);
      const text = looksPrintable(seg.data) ? asStr(seg.data) : Array.from(seg.data).map((x) => x.toString(16).padStart(2, "0")).join("");
      bodies.push(`<div class="seg"><div class="seg-title">Data</div><div class="op-text">${esc(text)}</div></div>`);
    }
  }
  return `<div class="chips">${chips.join("")}</div>${bodies.join("")}`;
}

// ── local wallet lens ───────────────────────────────────────────────────
const local = { txs: new Map(), address: null, confirmed: 0, unconfirmed: 0, loaded: false };

async function loadLocal() {
  try {
    const [bal, hist] = await Promise.all([rpc("balance"), rpc("history")]);
    local.address = bal?.address ?? null;
    local.confirmed = bal?.confirmed ?? 0;
    local.unconfirmed = bal?.unconfirmed ?? 0;
    local.txs.clear();
    for (const t of hist?.transactions ?? []) local.txs.set(t.txid, t);
    local.loaded = true;
  } catch {
    local.loaded = false;
  }
}

const localBadge = (txid) => {
  const t = local.txs.get(txid);
  return t ? `<span class="chip mine" title="${esc(t.hint || "")}">your tx · ${esc(t.status)}</span>` : "";
};

// ── shared renderers ────────────────────────────────────────────────────
const addrLink = (a) => (a ? `<a class="hash" href="#/address/${esc(a)}">${esc(a)}</a>` : "—");
const txLink = (t) => (t ? `<a class="hash" href="#/tx/${esc(t)}">${esc(short(t))}</a>` : "—");

function ioCard(kind, n, valueSats, body, extra = "") {
  return (
    `<div class="io-card"><div class="top"><span class="io-label">${esc(kind)} ${n}</span>` +
    `<span class="io-value ${valueSats ? "" : "zero"}">${valueSats ? fmtBsv(valueSats) : "0 BSV"}</span></div>` +
    `<div class="io-body">${body}${extra}</div></div>`
  );
}

function skeletonGrid(n = 8) {
  return `<div class="grid blocks">${Array.from({ length: n }, () => `<div class="skeleton"></div>`).join("")}</div>`;
}

function errorBox(message, retry) {
  view.innerHTML = `<div class="error-box">${esc(message)}${retry ? ` <button class="btn" id="retry">retry</button>` : ""}</div>`;
  if (retry) $("#retry").onclick = retry;
}

// ── stats header ────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const [info, mempool] = await Promise.all([api("/chain/info", 10_000), api("/mempool/info", 10_000).catch(() => null)]);
    $("#chip-height").innerHTML = `height <b>${fmtInt(info.blocks)}</b>`;
    if (mempool) $("#chip-mempool").innerHTML = `mempool <b>${fmtInt(mempool.size)}</b> tx · <b>${fmtBytes(mempool.bytes)}</b>`;
    $("#chip-difficulty").innerHTML = `difficulty <b class="gold">${fmtDifficulty(info.difficulty)}</b>`;
    $("#chip-difficulty").classList.add("gold");
  } catch {
    /* stats are decoration; keep the last values */
  }
}

// ── blocks view ─────────────────────────────────────────────────────────
async function renderBlocks() {
  setActive("blocks");
  view.innerHTML = `<h1><span class="live-dot"></span>Latest blocks</h1><div class="dim" style="margin-bottom:14px">mainnet · auto-refreshing</div>${skeletonGrid(12)}`;
  let headers;
  try {
    headers = await api("/block/headers?limit=12", 12_000);
  } catch (e) {
    return errorBox(`Could not load blocks: ${e.message}`, renderBlocks);
  }
  const maxTx = Math.max(...headers.map((h) => Number(h.num_tx) || 0), 1);
  view.innerHTML =
    `<h1><span class="live-dot"></span>Latest blocks</h1>` +
    `<div class="dim" style="margin-bottom:14px">mainnet · auto-refreshing · click a block to inspect</div>` +
    `<div class="grid blocks">${headers
      .map(
        (h) => `<a class="block-card" href="#/block/${h.height}">
          <div class="h"><span class="block-height">#${fmtInt(h.height)}</span><span class="block-age">${timeAgo(h.time)}</span></div>
          <div class="block-meta"><span>${fmtInt(h.num_tx)} txs</span><span>${fmtBytes(h.size)}</span></div>
          <div class="block-bar"><i style="width:${Math.min(100, Math.round(((Number(h.num_tx) || 0) / maxTx) * 100))}%"></i></div>
        </a>`,
      )
      .join("")}</div>`;
}

// ── block view ──────────────────────────────────────────────────────────
async function renderBlock(idOrHeight) {
  setActive("blocks");
  const isHeight = /^\d+$/.test(idOrHeight);
  view.innerHTML = `<div class="crumbs"><a href="#/blocks">Blocks</a> / ${esc(idOrHeight)}</div>${skeletonGrid(6)}`;
  let block;
  try {
    block = await api(`/block/${isHeight ? `height/${idOrHeight}` : idOrHeight}`, 60_000);
  } catch (e) {
    return errorBox(`Block not found: ${esc(idOrHeight)}`, () => renderBlock(idOrHeight));
  }
  const txs = block.tx ?? [];
  const page = Math.max(1, Number(new URLSearchParams(location.hash.split("?")[1] || "").get("p") || 1));
  const per = 25;
  const slice = txs.slice((page - 1) * per, page * per);
  const pages = Math.max(1, Math.ceil(txs.length / per));
  view.innerHTML =
    `<div class="crumbs"><a href="#/blocks">Blocks</a> / #${fmtInt(block.height)}</div>` +
    `<div class="card hero"><h1>Block #${fmtInt(block.height)}</h1>` +
    `<dl class="kv" style="margin-top:12px">` +
    `<dt>hash</dt><dd><span class="hash" data-copy="${esc(block.hash)}">${esc(block.hash)}</span></dd>` +
    `<dt>time</dt><dd class="plain">${esc(ts(block.time))} <span class="dim">(${timeAgo(block.time)})</span></dd>` +
    `<dt>transactions</dt><dd>${fmtInt(txs.length || block.txcount || block.num_tx)}</dd>` +
    `<dt>size</dt><dd>${fmtBytes(block.size)}</dd>` +
    `<dt>difficulty</dt><dd>${fmtDifficulty(block.difficulty)}</dd>` +
    `<dt>merkle root</dt><dd><span class="hash" data-copy="${esc(block.merkleroot)}">${esc(short(block.merkleroot, 14))}</span></dd>` +
    `<dt>previous</dt><dd>${block.previousblockhash ? `<a class="hash" href="#/block/${esc(block.previousblockhash)}">${esc(short(block.previousblockhash, 14))}</a>` : "—"}</dd>` +
    `<dt>next</dt><dd>${block.nextblockhash ? `<a class="hash" href="#/block/${esc(block.nextblockhash)}">${esc(short(block.nextblockhash, 14))}</a>` : "—"}</dd>` +
    `</dl></div>` +
    `<h2>Transactions</h2>` +
    slice.map((t, i) => `<a class="row" href="#/tx/${esc(t)}"><span class="mono dim">${(page - 1) * per + i + 1}</span><span class="grow ellipsis mono">${esc(t)}</span>${localBadge(t)}</a>`).join("") +
    (pages > 1
      ? `<div class="pager">${Array.from({ length: Math.min(pages, 12) }, (_, i) => i + 1)
          .map((p) => `<a class="btn ${p === page ? "primary" : ""}" href="#/block/${esc(idOrHeight)}?p=${p}">${p}</a>`)
          .join("")}</div>`
      : "");
}

// ── tx view ─────────────────────────────────────────────────────────────
async function renderTx(txid) {
  setActive("blocks");
  view.innerHTML = `<div class="crumbs"><a href="#/blocks">Blocks</a> / tx</div>${skeletonGrid(4)}`;
  let tx;
  try {
    tx = await api(`/tx/${txid}`, 60_000);
  } catch (e) {
    return errorBox(`Transaction not found: ${esc(txid)}`, () => renderTx(txid));
  }
  const confirmed = Number(tx.confirmations) > 0;
  const localTx = local.txs.get(tx.txid);
  view.innerHTML =
    `<div class="crumbs"><a href="#/blocks">Blocks</a> / ${confirmed ? `<a href="#/block/${tx.blockheight}">block ${fmtInt(tx.blockheight)}</a>` : "mempool"} / tx</div>` +
    `<div class="card hero"><h1>Transaction</h1>` +
    `<div class="chips" style="margin-top:8px">` +
    `<span class="chip ${confirmed ? "aip" : ""}">${confirmed ? `${fmtInt(tx.confirmations)} confirmations` : "unconfirmed"}</span>` +
    localBadge(tx.txid) +
    `</div>` +
    `<dl class="kv" style="margin-top:12px">` +
    `<dt>txid</dt><dd><span class="hash" data-copy="${esc(tx.txid)}">${esc(tx.txid)}</span></dd>` +
    `<dt>size</dt><dd>${fmtBytes(tx.size)}</dd>` +
    `<dt>time</dt><dd class="plain">${esc(ts(tx.time || tx.blocktime))} <span class="dim">${timeAgo(tx.time || tx.blocktime)}</span></dd>` +
    (localTx ? `<dt>wallet label</dt><dd class="plain">${esc(localTx.label || "")} <span class="status ${esc(localTx.status)}">${esc(localTx.status)}</span></dd>` : "") +
    `<dt>explorer</dt><dd><a class="hash" target="_blank" rel="noopener noreferrer" href="${EXPLORER}/tx/${esc(tx.txid)}">whatsonchain.com ↗</a></dd>` +
    `</dl></div>` +
    `<div class="flow"><div><h2>Inputs (${tx.vin.length})</h2>${tx.vin.map((v, i) => inputCard(v, i)).join("")}</div>` +
    `<div><h2>Outputs (${tx.vout.length})</h2>${tx.vout.map((o) => outputCard(o)).join("")}</div></div>`;
  bindCopy();
}

function inputCard(v, i) {
  if (v.coinbase !== undefined && v.coinbase !== null && !v.txid) {
    return ioCard("coinbase", i, 0, `<span class="dim">newly mined coins</span>`);
  }
  return ioCard(
    "input",
    i,
    0,
    `${txLink(v.txid)}<span class="dim">:${v.vout}</span>` +
      (v.scriptSig?.asm ? `<div class="dim" style="margin-top:4px">${esc(short(v.scriptSig.asm, 30))}</div>` : ""),
  );
}

function outputCard(o) {
  const sp = o.scriptPubKey ?? {};
  const sats = Math.round((Number(o.value) || 0) * 1e8);
  if (sp.type === "nulldata") {
    const segs = sp.hex && !sp.isTruncated ? decodeOpReturn(sp.hex) : null;
    return ioCard("output", o.n, sats, segs ? renderSegments(segs) : `<span class="dim">OP_RETURN${sp.isTruncated ? " (truncated)" : ""}</span>`);
  }
  const addrs = (sp.addresses ?? []).map(addrLink).join(", ");
  const mine = local.address && (sp.addresses ?? []).includes(local.address) ? ` <span class="chip mine">your wallet</span>` : "";
  const typeChip = `<span class="chip">${esc(sp.type || "script")}</span>`;
  return ioCard("output", o.n, sats, `${addrs || `<span class="dim">${esc(short(sp.asm || sp.hex || "", 40))}</span>`} ${typeChip}${mine}`);
}

// ── address view ────────────────────────────────────────────────────────
async function renderAddress(addr) {
  setActive("blocks");
  view.innerHTML = `<div class="crumbs"><a href="#/blocks">Blocks</a> / address</div>${skeletonGrid(4)}`;
  let balance, history, unspent;
  try {
    [balance, history, unspent] = await Promise.all([
      api(`/address/${encodeURIComponent(addr)}/balance`, 30_000),
      api(`/address/${encodeURIComponent(addr)}/history`, 30_000).catch(() => []),
      api(`/address/${encodeURIComponent(addr)}/unspent`, 30_000).catch(() => []),
    ]);
  } catch (e) {
    return errorBox(`Address not found: ${esc(addr)}`, () => renderAddress(addr));
  }
  const confirmed = Number(balance.confirmed) || 0;
  const unconfirmed = Number(balance.unconfirmed) || 0;
  const mine = local.address === addr ? `<span class="chip mine">your wallet</span>` : "";
  const rows = (Array.isArray(history) ? history : []).slice(0, 40);
  view.innerHTML =
    `<div class="crumbs"><a href="#/blocks">Blocks</a> / address</div>` +
    `<div class="card hero"><div class="balance-hero"><span class="big">${fmtBsv(confirmed + unconfirmed)}</span>` +
    `<span class="sub">${fmtInt(confirmed + unconfirmed)} sats${unconfirmed ? ` · ${fmtInt(unconfirmed)} unconfirmed` : ""}</span>${mine}</div>` +
    `<dl class="kv" style="margin-top:14px">` +
    `<dt>address</dt><dd><span class="hash" data-copy="${esc(addr)}">${esc(addr)}</span></dd>` +
    `<dt>utxos</dt><dd>${fmtInt(Array.isArray(unspent) ? unspent.length : 0)}</dd>` +
    `<dt>transactions</dt><dd>${fmtInt(Array.isArray(history) ? history.length : 0)}${Array.isArray(history) && history.length > rows.length ? "+" : ""}</dd>` +
    `</dl></div>` +
    `<h2>Recent activity</h2>` +
    (rows.length
      ? rows
          .map((h) => {
            const txid = h.tx_hash || h.txid || h.hash;
            return `<a class="row" href="#/tx/${esc(txid)}"><span class="grow ellipsis mono">${esc(txid)}</span><span class="time">${h.height ? `#${fmtInt(h.height)}` : "mempool"}</span>${localBadge(txid)}</a>`;
          })
          .join("")
      : `<div class="empty">No transactions yet.</div>`);
  bindCopy();
}

// ── wallet view ─────────────────────────────────────────────────────────
async function renderWallet() {
  setActive("wallet");
  view.innerHTML = skeletonGrid(4);
  await loadLocal();
  if (!local.loaded) {
    return errorBox("Wallet daemon not reachable — is bsv-walletd running?");
  }
  const hist = await rpc("history").catch(() => null);
  const txs = hist?.transactions ?? [];
  const requests = hist?.requests ?? [];
  const policies = hist?.policies ?? [];
  view.innerHTML =
    `<h1>My wallet</h1><div class="dim" style="margin-bottom:14px">the machine's own transactions, from the local daemon</div>` +
    `<div class="card hero"><div class="balance-hero"><span class="big">${fmtBsv(local.confirmed + local.unconfirmed)}</span>` +
    `<span class="sub">${fmtInt(local.confirmed)} confirmed${local.unconfirmed ? ` · ${fmtInt(local.unconfirmed)} unconfirmed` : ""}</span></div>` +
    (local.address ? `<dl class="kv" style="margin-top:12px"><dt>address</dt><dd><a class="hash" href="#/address/${esc(local.address)}">${esc(local.address)}</a></dd></dl>` : "") +
    `</div>` +
    `<h2>Transactions (${txs.length})</h2>` +
    (txs.length
      ? txs
          .slice(0, 50)
          .map(
            (t) => `<a class="row" href="#/tx/${esc(t.txid)}">
              <span class="status ${esc(t.status)}">${esc(t.status)}</span>
              <span class="grow ellipsis">${esc(t.label || "transaction")}</span>
              <span class="time">${timeAgo(Math.floor((t.created_at || 0) / 1000))}</span></a>`,
          )
          .join("")
      : `<div class="empty">No transactions yet.</div>`) +
    (requests.length ? `<h2>Pending approvals (${requests.length})</h2>` + requests.map((r) => `<div class="row"><span class="status waiting">ask</span><span class="grow">${esc(r.origin)} · ${esc(r.action)}</span><span class="time">${fmtInt(r.amount_sats)} sats</span></div>`).join("") : "") +
    (policies.length ? `<h2>Spending policy (${policies.length})</h2>` + policies.map((p) => `<div class="row"><span class="status ${p.mode === "deny" ? "failed" : "mined"}">${esc(p.mode)}</span><span class="grow mono">${esc(p.origin)}</span><span class="time">${p.spend_cap_sats ? `${fmtInt(p.spend_cap_sats)} sats cap` : "uncapped"}</span></div>`).join("") : "");
}

// ── router ──────────────────────────────────────────────────────────────
function setActive(tab) {
  document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
}

function route() {
  const hash = location.hash || "#/blocks";
  const [pathPart] = hash.slice(1).split("?");
  const [, head, arg] = pathPart.split("/");
  window.scrollTo({ top: 0 });
  if (head === "tx" && arg) return renderTx(arg);
  if (head === "block" && arg) return renderBlock(arg);
  if (head === "address" && arg) return renderAddress(arg);
  if (head === "wallet") return renderWallet();
  return renderBlocks();
}

async function search(value) {
  const q = String(value || "").trim();
  if (!q) return;
  if (/^\d{1,9}$/.test(q)) return (location.hash = `#/block/${q}`);
  if (/^[0-9a-f]{64}$/i.test(q)) {
    try {
      await api(`/tx/${q}`, 0);
      return (location.hash = `#/tx/${q}`);
    } catch {
      return (location.hash = `#/block/${q}`);
    }
  }
  if (/^[13mn2][1-9A-HJ-NP-Za-km-z]{25,40}$/.test(q)) return (location.hash = `#/address/${q}`);
  toast("not a txid, block, height, or address");
}

function bindCopy() {
  document.querySelectorAll("[data-copy]").forEach((el) => {
    el.onclick = () => copy(el.dataset.copy);
  });
}

// ── boot ────────────────────────────────────────────────────────────────
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  search(input.value);
  input.blur();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== input) {
    e.preventDefault();
    input.focus();
    input.select();
  } else if (e.key === "Escape" && document.activeElement === input) {
    input.value = "";
    input.blur();
  }
});
window.addEventListener("hashchange", route);

setInterval(() => {
  $("#clock").textContent = new Date().toLocaleTimeString();
}, 1000);
setInterval(() => {
  if (document.hidden) return;
  loadStats();
  if ((location.hash || "#/blocks") === "#/blocks") renderBlocks();
}, 20_000);

bindCopy();
loadStats();
loadLocal().then(route);
