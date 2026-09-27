// bsvOS Launcher — the system app list.
//
// Served from the daemon's own origin, so every call below is a same-origin
// JSON-RPC to bsv-walletd (same as the Explorer and Twetch companions). It
// never touches keys: installing an app records a manifest and a spend cap,
// opening one asks the daemon to spawn a sandboxed runner window. Money
// movement still goes through the normal policy engine.
//
// It is installed under its own host identity (127.0.0.1) rather than
// localhost, so this slot never collides with the single localhost slot that
// the bundled feature apps (Cast, Twetch, Explorer, Colosseum) rotate
// through.
"use strict";

const $ = (sel) => document.querySelector(sel);

// ── same-origin daemon RPC ──────────────────────────────────────────────
let rpcId = 1;
async function rpc(method, params = {}) {
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
}

// ── tiny utils ──────────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtInt = (n) => Number(n ?? 0).toLocaleString("en-US");
const sats = (n) => (Number(n) ? `${fmtInt(n)} sats` : "no spend cap");

/** Stable, non-identicon glyph per domain — apps ship no icons by default. */
function glyph(domain) {
  const src = String(domain ?? "");
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) >>> 0;
  return ["◈", "⬡", "✦", "❖", "⬢", "✧", "◐", "△"][h % 8];
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 5200 : 2200);
}

// ── view state ──────────────────────────────────────────────────────────
const SELF_DOMAIN = new URL(location.origin).hostname;
const state = { apps: [], store: [] };

// ── installed view ──────────────────────────────────────────────────────
function appCard(app) {
  const isSelf = app.domain === SELF_DOMAIN;
  const intents = (app.intents ?? []).length;
  return (
    `<div class="card" data-domain="${esc(app.domain)}">` +
      `<div class="card-top">` +
        `<div class="icon">${app.icon ? `<img src="${esc(app.icon)}" alt="" onerror="this.remove()">` : esc(glyph(app.domain))}</div>` +
        `<div><div class="card-name">${esc(app.name)}</div>` +
        `<div class="card-domain">${esc(app.domain)}</div></div>` +
      `</div>` +
      `<div class="card-meta">` +
        `<span class="chip">${esc(sats(app.spendCapSats))}</span>` +
        (intents ? `<span class="chip">${intents} intent${intents === 1 ? "" : "s"}</span>` : "") +
        (isSelf ? `<span class="chip self">this app</span>` : "") +
      `</div>` +
      `<div class="card-actions">` +
        `<button class="btn primary" data-act="open" data-domain="${esc(app.domain)}">Open</button>` +
        (isSelf ? "" : `<button class="btn danger" data-act="remove" data-domain="${esc(app.domain)}">Remove</button>`) +
      `</div>` +
    `</div>`
  );
}

function renderInstalled() {
  const host = $("#installed");
  if (!state.apps.length) {
    host.innerHTML = `<div class="empty">No apps installed yet. Open the Store tab to add one.</div>`;
    return;
  }
  host.innerHTML = state.apps.map(appCard).join("");
  $("#installed-note").textContent = `${state.apps.length} installed`;
}

// ── store view ──────────────────────────────────────────────────────────
const STATUS_TEXT = {
  current: ["ok", "installed"],
  "not-installed": ["", "available"],
  unreachable: ["warn", "host unreachable"],
  update: ["warn", "update available"],
  widened: ["warn", "cap would widen"],
};

function storeCard(entry) {
  const [cls, label] = STATUS_TEXT[entry.status] ?? ["", entry.status ?? "unknown"];
  const isSelf = entry.domain === SELF_DOMAIN;
  const actions =
    entry.status === "current" && !isSelf
      ? `<button class="btn" data-act="open" data-domain="${esc(entry.domain)}">Open</button>`
      : entry.status === "current" && isSelf
        ? `<button class="btn primary" disabled>This app</button>`
        : `<button class="btn primary" data-act="install" data-domain="${esc(entry.domain)}">Install</button>`;
  return (
    `<div class="card">` +
      `<div class="card-top">` +
        `<div class="icon">${esc(glyph(entry.domain))}</div>` +
        `<div><div class="card-name">${esc(entry.name)}</div>` +
        `<div class="card-domain">${esc(entry.domain)}</div></div>` +
      `</div>` +
      `<div class="card-blurb">${esc(entry.blurb ?? "")}</div>` +
      `<div class="card-meta">` +
        `<span class="chip ${cls}">${esc(label)}</span>` +
        (entry.live?.spendCapSats ? `<span class="chip">${esc(sats(entry.live.spendCapSats))}</span>` : "") +
        (entry.devOnly ? `<span class="chip warn">dev only</span>` : "") +
      `</div>` +
      `<div class="card-actions">${actions}</div>` +
    `</div>`
  );
}

function renderStore() {
  const host = $("#store");
  if (!state.store.length) {
    host.innerHTML = `<div class="empty">Catalog unavailable — the daemon could not read the store.</div>`;
    return;
  }
  host.innerHTML = state.store.map(storeCard).join("");
}

// ── actions ─────────────────────────────────────────────────────────────
async function withBusy(btn, label, fn) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}

async function openApp(domain, btn) {
  await withBusy(btn, "Opening…", async () => {
    try {
      await rpc("appLaunch", { domain });
      toast(`${domain} opened in a new window`);
    } catch (e) {
      // No runner here (no browser, headless box, or a platform we do not
      // sandbox). Fall back to the plain browser so the app still opens —
      // it just has no window.bsv wallet access.
      const app = state.apps.find((a) => a.domain === domain);
      if (app?.startUrl) {
        window.open(app.startUrl, "_blank", "noopener");
        toast("runner unavailable — opened in your normal browser (no wallet access)", true);
      } else {
        toast(`could not open ${domain}: ${e.message}`, true);
      }
    }
  });
}

async function installApp(domain, btn) {
  await withBusy(btn, "Installing…", async () => {
    try {
      const res = await rpc("appInstall", { domain });
      toast(`${res?.app?.name ?? domain} installed`);
      await refresh();
      show("store");
    } catch (e) {
      toast(`install failed: ${e.message}`, true);
    }
  });
}

async function removeApp(domain, btn) {
  if (!window.confirm(`Remove ${domain}? Its browser profile and spend cap are deleted.`)) return;
  await withBusy(btn, "Removing…", async () => {
    try {
      await rpc("appRemove", { domain });
      toast(`${domain} removed`);
      await refresh();
    } catch (e) {
      toast(`remove failed: ${e.message}`, true);
    }
  });
}

const ACTIONS = { open: openApp, install: installApp, remove: removeApp };

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const fn = ACTIONS[btn.dataset.act];
  if (fn) void fn(btn.dataset.domain, btn);
});

// ── nav ─────────────────────────────────────────────────────────────────
function show(view) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === `view-${view}`));
}
document.querySelectorAll("nav button").forEach((b) => {
  b.addEventListener("click", () => show(b.dataset.view));
});

// ── wallet chip ─────────────────────────────────────────────────────────
async function loadWallet() {
  const chip = $("#wallet-chip");
  try {
    const st = await rpc("isAuthenticated");
    if (st?.authenticated && st?.hasWallet) {
      const bal = await rpc("balance").catch(() => null);
      chip.className = "wallet-chip ok";
      chip.textContent = `${fmtInt((bal?.confirmed ?? 0) + (bal?.unconfirmed ?? 0))} sats · unlocked`;
      chip.title = bal?.address ?? "";
    } else if (st?.hasWallet) {
      chip.className = "wallet-chip warn";
      chip.textContent = "wallet locked — bsv unlock";
    } else {
      chip.className = "wallet-chip bad";
      chip.textContent = "no wallet — bsv create";
    }
  } catch {
    chip.className = "wallet-chip bad";
    chip.textContent = "daemon unreachable";
  }
}

// ── data ────────────────────────────────────────────────────────────────
async function refresh() {
  const [apps, store] = await Promise.all([
    rpc("appList").catch(() => ({ apps: [] })),
    rpc("storeList").catch(() => ({ store: [] })),
  ]);
  state.apps = apps?.apps ?? [];
  state.store = store?.store ?? [];
  renderInstalled();
  renderStore();
  await loadWallet();
}

$("#refresh").addEventListener("click", () => void refresh());
$("#store-refresh").addEventListener("click", () => void refresh());

setInterval(() => {
  if (!document.hidden) void loadWallet();
}, 15_000);

void refresh();
