// bsvOS — the system shell for this machine.
//
// Replaces the Omarchy Quickshell wallet UX (bar pill + 3,240-line panel) for
// macOS. Where the panel shelled out to the `bsv` CLI 51 times per refresh and
// branched on process exit codes, this page calls the daemon's JSON-RPC
// directly over its own origin: structured errors instead of "see the
// terminal", and a handful of round trips instead of 22 process spawns.
//
// Trust: this page is served by the daemon from its own HTTPS origin, so it
// is loopback-gated and has the same authority as the CLI — it is the
// operator surface, not a sandboxed third-party app. Every spend still goes
// through the daemon's policy engine.
"use strict";

import { rpc, tryRpc, explain, isLocked } from "./lib/rpc.js";
import { $, esc, toast, openExternal, confirmDialog } from "./lib/ui.js";
import { statusLine, watchRequests, notificationsEnabled, setNotificationsEnabled, requestNotificationPermission, notify } from "./lib/notify.js";

// The registry lives in views/index.js so the tests can import the exact array
// the app runs. It used to be assembled here, and one entry silently lost its
// spread operator — see the note in that file.
import { VIEWS, BY_ID, GROUP_ORDER } from "./views/index.js";

const state = {
  viewId: location.hash.replace(/^#\/?/, "") || "overview",
  data: {},
  params: {},
  auth: null,
  requestCount: 0,
  daemonVersion: null,
};

// ── context handed to every view ─────────────────────────────────────────
const ctx = {
  get data() {
    return state.data;
  },
  get params() {
    return state.params;
  },
  get auth() {
    return state.auth;
  },
  go(id, params = {}) {
    state.params = params;
    location.hash = `#/${id}`;
  },
  toast,
  fail(err) {
    const msg = explain(err);
    toast(msg, true);
    // A locked wallet is the one failure worth pointing at the fix for.
    if (isLocked(err)) setTimeout(() => toast("Unlock from the sidebar, or run bsv unlock", true), 400);
    console.warn("[bsvos]", err?.code ?? "", msg);
  },
  run(fn) {
    return fn().catch((e) => ctx.fail(e));
  },
  async reload() {
    await loadView(state.viewId, true);
    await refreshStatus();
  },
  openExternal,
  openExplorer(txid) {
    if (txid) openExternal(`https://whatsonchain.com/tx/${txid}`);
  },
};

// ── nav ──────────────────────────────────────────────────────────────────
function buildNav() {
  const groups = new Map(GROUP_ORDER.map((g) => [g, []]));
  for (const v of VIEWS) {
    if (!groups.has(v.group)) groups.set(v.group, []);
    groups.get(v.group).push(v);
  }
  $("#nav").innerHTML = [...groups.entries()]
    .filter(([, list]) => list.length)
    .map(
      ([group, list]) =>
        `<div class="nav-group">${esc(group)}</div>` +
        list
          .map(
            (v) =>
              `<a href="#/${esc(v.id)}" data-nav="${esc(v.id)}">${esc(v.title)}` +
              `<span class="badge" data-badge="${esc(v.id)}" hidden></span></a>`,
          )
          .join(""),
    )
    .join("");
}

function markActive() {
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === state.viewId));
  const view = BY_ID.get(state.viewId);
  $("#view-title").textContent = view?.title ?? "bsvOS";
  $("#view-note").textContent = view?.note ?? "";
}

// ── status pill (the bar widget's job) ───────────────────────────────────
async function refreshStatus() {
  const auth = await tryRpc("isAuthenticated");
  state.auth = auth.ok ? auth.value : null;
  if (!state.daemonVersion) {
    const v = await tryRpc("getVersion");
    if (v.ok) state.daemonVersion = v.value?.version ?? null;
  }

  const line = await statusLine();
  const pill = $("#pill");
  pill.className = `pill ${line.tone}`;
  $("#pill-text").textContent = line.text;
  pill.title = state.auth?.hasWallet ? `identity ${state.auth.identityKey?.slice(0, 16) ?? "—"}…` : "";

  // The pill's right-click equivalent: an explicit lock, never an auto-unlock.
  const unlock = $("#btn-unlock");
  const lock = $("#btn-lock");
  if (!auth.ok || !state.auth?.hasWallet) {
    unlock.hidden = true;
    lock.hidden = true;
  } else {
    unlock.hidden = !state.auth.locked;
    lock.hidden = state.auth.locked;
  }

  const notifyBtn = $("#btn-notify");
  notifyBtn.textContent = notificationsEnabled() ? "Alerts on" : "Alerts off";
  notifyBtn.classList.toggle("primary", notificationsEnabled());
}

function setRequestBadge(count) {
  state.requestCount = count;
  const badge = document.querySelector('[data-badge="approvals"]');
  if (!badge) return;
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.hidden = count === 0;
  badge.classList.toggle("quiet", false);
}

// ── view loading ─────────────────────────────────────────────────────────
async function loadView(id, silent = false) {
  const view = BY_ID.get(id);
  if (!view) {
    state.viewId = "overview";
    return loadView("overview");
  }
  state.viewId = id;
  state.data = {};
  markActive();

  const host = $("#view");
  if (!silent) host.innerHTML = `<p class="dim">Loading…</p>`;
  try {
    await view.load?.(ctx);
  } catch (err) {
    host.innerHTML = `<div class="error-box">${esc(explain(err))}</div>`;
    return;
  }
  host.innerHTML = view.render(ctx);
  view.bind?.(host, ctx);
}

// ── chrome wiring ────────────────────────────────────────────────────────
function wire() {
  window.addEventListener("hashchange", () => {
    const next = location.hash.replace(/^#\/?/, "") || "overview";
    if (next !== state.viewId) {
      state.params = {};
      void loadView(next);
    }
  });

  $("#btn-refresh").addEventListener("click", () => ctx.reload());

  $("#btn-lock").addEventListener("click", async () => {
    if (!(await confirmDialog("Lock wallet", "Lock now? Anything mid-flight finishes, but new spends will be refused.", "Lock"))) return;
    try {
      await rpc("lock", {});
      ctx.toast("Locked");
      await ctx.reload();
    } catch (err) { ctx.fail(err); }
  });

  // The daemon reads the seed from the OS keyring, so unlock needs no
  // passphrase and no TTY — it is a plain RPC and safe to offer here.
  $("#btn-unlock").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Unlocking…";
    try {
      await rpc("unlock", {});
      ctx.toast("Unlocked");
      await ctx.reload();
    } catch (err) {
      ctx.fail(err);
    } finally {
      btn.disabled = false;
    }
  });

  $("#btn-notify").addEventListener("click", async (e) => {
    if (notificationsEnabled()) {
      setNotificationsEnabled(false);
    } else {
      const result = await requestNotificationPermission();
      if (result === "granted") {
        setNotificationsEnabled(true);
        notify("bsvOS alerts on", "You will be notified when a spend request needs you.");
      } else {
        toast("macOS did not grant notification permission", true);
        return;
      }
    }
    await refreshStatus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "r" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      void ctx.reload();
    }
  });

  // Shown so a screenshot or a bug report carries which build was running.
  $("#build-tag").textContent = `bsvOS · v${state.daemonVersion ?? "?"} · loopback only`;
}

/**
 * Notice when the daemon is serving a different build of this app than the one
 * currently loaded. Cheap: one conditional GET of the bundle stamp, no body
 * read. The stamp covers every served file, not just app.js — a fix that lands
 * in views/ or lib/ must move it, or the window never learns to reload.
 */
async function watchForNewBuild() {
  const stamp = async () => {
    const res = await fetch("__build", { method: "GET", cache: "no-store", headers: { "if-none-match": loadedEtag ?? "" } });
    return res.headers.get("etag");
  };
  try {
    loadedEtag = await stamp();
  } catch {
    return; // no ETag support here; stay quiet rather than nag
  }
  if (!loadedEtag) return;

  setInterval(async () => {
    if (staleShown || document.hidden) return;
    try {
      const current = await stamp();
      if (current && current !== loadedEtag) showStaleBanner();
    } catch {
      /* daemon restarting; try again next tick */
    }
  }, 20000);
}

let loadedEtag = null;
let staleShown = false;

function showStaleBanner() {
  staleShown = true;
  if ($("#stale-banner")) return;
  const bar = document.createElement("div");
  bar.id = "stale-banner";
  bar.className = "stale-banner";
  bar.innerHTML =
    `<span>A newer version of bsvOS is installed. This window is running the previous build, so new views and fixes are missing.</span>` +
    `<button class="btn tiny primary" id="stale-reload">Reload</button>` +
    `<button class="btn tiny" id="stale-dismiss">Dismiss</button>`;
  document.body.appendChild(bar);
  $("#stale-reload").addEventListener("click", () => location.reload());
  $("#stale-dismiss").addEventListener("click", () => bar.remove());
}

// ── boot ─────────────────────────────────────────────────────────────────
async function boot() {
  buildNav();
  wire();
  await refreshStatus();

  // First run: a machine with no wallet has nothing useful to show, and every
  // view would just say "run bsv create". Send it to Setup once — then leave
  // the user alone, because bouncing them back would be hostile.
  if (state.auth && !state.auth.hasWallet && state.viewId !== "setup") {
    state.viewId = "setup";
    history.replaceState(null, "", "#/setup");
  }

  await loadView(state.viewId);
  await refreshStatus();

  // The pill's "summon me when a request arrives" behaviour. On a first load
  // this seeds from the open requests so nothing fires retroactively; after
  // that each new request raises a real macOS notification.
  watchRequests({
    onCount: (n) => {
      setRequestBadge(n);
      void refreshStatus();
    },
    onNew: (fresh) => {
      // Land the operator on the approvals list — the panel's reveal().
      if (!location.hash.startsWith("#/approvals")) ctx.toast(`${fresh.length} spend request(s) waiting`);
    },
  });

  // Keep the view fresh while it is open, like the panel's 10s tick, but
  // only when the tab is actually visible.
  setInterval(() => {
    if (!document.hidden) void loadView(state.viewId, true);
  }, 15000);

  // Staleness check. This window imports its modules once and then runs them
  // for as long as it stays open, so a `git pull` + daemon restart leaves it
  // quietly serving the previous build — the nav goes missing and there is no
  // clue why. Compare the entry point's ETag and offer a reload when it moves.
  watchForNewBuild();

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void ctx.reload();
  });
}

void boot();
