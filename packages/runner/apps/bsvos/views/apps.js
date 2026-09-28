// Apps: the store/launcher (the panel's F1 section, plus the app-opening
// work the standalone Launcher app used to do), the market, and file sharing.
"use strict";

import { rpc, tryRpc, explain } from "../lib/rpc.js";
import { esc, fmtInt, short, timeAgo, copy, confirmDialog, pickFile, sha256Hex, fmtSats } from "../lib/ui.js";
import { empty, errorBox, kv, rows, chip, satsChip } from "./common.js";

const SELF_DOMAIN = new URL(location.origin).hostname;

/** Stable glyph per domain so app cards are distinguishable without icons. */
function glyph(domain) {
  let h = 0;
  for (const ch of String(domain ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ["◈", "⬡", "✦", "❖", "⬢", "✧", "◐", "△"][h % 8];
}

const STATUS = {
  current: ["ok", "installed"],
  available: ["warn", "update"],
  widened: ["warn", "cap would widen"],
  adopted: ["warn", "update"],
  "not-installed": ["", "available"],
  unreachable: ["warn", "host unreachable"],
  invalid: ["bad", "bad manifest"],
};

export const apps = {
  id: "apps",
  title: "Apps",
  group: "Apps",
  note: "Installed apps and the catalog. Opening one launches a sandboxed window with wallet access.",
  async load(ctx) {
    const [a, s] = await Promise.all([tryRpc("appList"), tryRpc("storeList")]);
    ctx.data.installed = a.ok ? a.value?.apps ?? [] : [];
    ctx.data.store = s.ok ? a.value?.store ?? s.value?.store ?? [] : [];
    ctx.data.loadError = a.ok ? null : a.error;
  },
  render(ctx) {
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    const installed = ctx.data.installed ?? [];
    const store = ctx.data.store ?? [];

    const installedCard = (a) => {
      const isSelf = a.domain === SELF_DOMAIN;
      const intents = (a.intents ?? []).length;
      return (
        `<div class="card">` +
          `<div class="card-top"><div class="icon">${a.icon ? `<img src="${esc(a.icon)}" alt="" onerror="this.remove()">` : esc(glyph(a.domain))}</div>` +
          `<div class="grow"><h3>${esc(a.name)}</h3><div class="card-sub">${esc(a.domain)}</div></div></div>` +
          `<div class="card-meta">${satsChip(a.spendCapSats)}${intents ? chip(`${intents} intent${intents === 1 ? "" : "s"}`) : ""}` +
          `${isSelf ? chip("this app", "self") : ""}</div>` +
          `<div class="card-actions">` +
            `<button class="btn primary" data-launch="${esc(a.domain)}">Open</button>` +
            (isSelf ? "" : `<button class="btn danger" data-remove="${esc(a.domain)}">Remove</button>`) +
          `</div>` +
        `</div>`
      );
    };

    // The store is variant-aware: bundled apps share the `localhost` host at
    // different paths, so an entry that is not the installed variant is a
    // switch (installing it replaces whatever holds the host), never an update.
    const installUrlOf = (s) => s.installUrl ?? `https://${s.domain}/`;
    const storeCard = (s) => {
      const [tone, label] = STATUS[s.status] ?? ["", s.status ?? "unknown"];
      const isSelf = s.domain === SELF_DOMAIN;
      const installUrl = installUrlOf(s);
      let action;
      if (s.status === "current" && isSelf) action = `<button class="btn primary" disabled>This app</button>`;
      else if (s.status === "current") action = `<button class="btn primary" data-launch="${esc(s.domain)}">Open</button>`;
      else if (s.holder) action = `<button class="btn primary" data-install="${esc(installUrl)}">Switch to this app</button>`;
      else if (s.status === "available" || s.status === "widened" || s.status === "adopted")
        action =
          `<button class="btn" data-update="${esc(s.domain)}">Update</button>` +
          (s.status === "widened" ? `<button class="btn primary" data-widen="${esc(s.domain)}">Approve wider cap</button>` : "");
      else if (s.installed) action = `<button class="btn primary" data-launch="${esc(s.domain)}">Open</button>`;
      else action = `<button class="btn primary" data-install="${esc(installUrl)}">Install</button>`;
      return (
        `<div class="card">` +
          `<div class="card-top"><div class="icon">${esc(glyph(s.domain))}</div>` +
          `<div class="grow"><h3>${esc(s.name)}</h3><div class="card-sub">${esc(s.domain)}</div></div></div>` +
          `<p class="card-blurb">${esc(s.blurb ?? "")}</p>` +
          `<div class="card-meta">${chip(label, tone)}${s.holder ? chip(`replaces ${s.holder}`, "warn") : ""}${s.devOnly ? chip("dev only", "warn") : ""}</div>` +
          `<div class="card-actions">${action}</div>` +
        `</div>`
      );
    };

    // storeList is variant-aware: a bundled app that does not hold its host
    // slot is still shown (as a switch), so an app counts as cataloged when
    // its variant is listed as installed, not merely when its domain appears.
    const covered = new Set(store.filter((s) => s.installed).map((s) => s.domain));
    const extra = installed.filter((a) => !covered.has(a.domain));
    return (
      `<h2 class="sec">Installed (${installed.length})</h2>` +
      (installed.length ? `<div class="grid">${installed.map(installedCard).join("")}</div>` : empty("No apps installed.")) +
      `<h2 class="sec">Catalog</h2>` +
      `<div class="grid">${store.map(storeCard).join("")}</div>` +
      (extra.length
        ? `<p class="dim" style="margin-top:12px">${extra.length} installed app(s) are not in the catalog.</p>`
        : "")
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const l = e.target.closest("[data-launch]");
      if (l) return openApp(ctx, l.dataset.launch);
      const i = e.target.closest("[data-install]");
      if (i) {
        // The value is the entry's install URL (explicit for bundled apps on a
        // shared host, the domain root otherwise) — appInstall takes both.
        const domain = i.dataset.install;
        const entry = (ctx.data.store ?? []).find((s) => installUrlOf(s) === domain);
        const holder = entry?.holder;
        const why = `${entry?.name ?? domain} will be able to ask to spend up to the cap in its manifest.` +
          (holder ? ` This replaces ${holder} on ${entry.domain}.` : "") +
          " You approve each request.";
        if (!(await confirmDialog(holder ? `Switch to ${entry?.name ?? domain}` : "Install app", why, holder ? "Switch" : "Install"))) return;
        return ctx.run(async () => {
          const res = await rpc("appInstall", { domain });
          ctx.toast(`${res?.app?.name ?? domain} ${holder ? "switched in" : "installed"}`);
          await ctx.reload();
        });
      }
      const u = e.target.closest("[data-update]");
      if (u) return ctx.run(async () => {
        const res = await rpc("appUpdate", { domain: u.dataset.update, approveWidening: false });
        const r = res?.results?.[0] ?? res;
        ctx.toast(r?.widening ? "Update needs your approval to widen the cap" : "Updated");
        await ctx.reload();
      });
      const w = e.target.closest("[data-widen]");
      if (w) {
        if (!(await confirmDialog("Widen spend cap", `This update asks for a larger cap than ${w.dataset.widen} already has.`, "Approve"))) return;
        return ctx.run(async () => {
          await rpc("appUpdate", { domain: w.dataset.widen, approveWidening: true });
          ctx.toast("Cap widened and update applied");
          await ctx.reload();
        });
      }
      const rm = e.target.closest("[data-remove]");
      if (rm) {
        const domain = rm.dataset.remove;
        if (!(await confirmDialog("Remove app", `${domain}'s browser profile and spend cap are deleted.`, "Remove"))) return;
        return ctx.run(async () => {
          await rpc("appRemove", { domain });
          ctx.toast(`${domain} removed`);
          await ctx.reload();
        });
      }
    });
  },
};

/**
 * Launch through the daemon so the window gets the window.bsv bridge. A bare
 * window.open would open the app with no wallet access at all, which is the
 * one failure mode worth being loud about.
 */
export async function openApp(ctx, domain) {
  try {
    await rpc("appLaunch", { domain });
    ctx.toast(`${domain} opened in a new window`);
  } catch (err) {
    const res = await tryRpc("appOpen", { domain });
    const url = res.ok ? res.value?.startUrl : null;
    if (url) {
      ctx.openExternal(url);
      ctx.toast("No sandboxed browser here — opened in your normal browser (no wallet access)", true);
    } else {
      ctx.fail(err);
    }
  }
}

export const market = {
  id: "market",
  // Distinct from the Twetch group's NFT Market, so the sidebar never shows two
  // tabs with the same name.
  title: "Atomic Market",
  group: "Apps",
  note: "Browse and buy ordinals and BSV21 tokens with atomic swaps.",
  async load(ctx) {
    const r = await tryRpc("appList");
    const appsList = r.ok ? r.value?.apps ?? [] : [];
    ctx.data.market = appsList.find((a) => a.domain === "market.entangleit.com") ?? null;
  },
  render(ctx) {
    const installed = Boolean(ctx.data.market);
    return (
      `<div class="card" style="max-width:520px"><h3>Atomic Market</h3>` +
      `<p class="dim">A BRC-100 atomic-swap market: payment and asset settle in one transaction, so a failed purchase costs nothing.</p>` +
      (installed
        ? `<div class="card-actions"><button class="btn primary" data-launch="market.entangleit.com">Open market</button></div>`
        : `<div class="card-actions"><button class="btn primary" data-install-market>Install and open</button></div>`) +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      if (e.target.closest("[data-launch]")) return openApp(ctx, "market.entangleit.com");
      if (e.target.closest("[data-install-market]")) {
        try {
          await rpc("appInstall", { domain: "market.entangleit.com" });
        } catch (err) {
          return ctx.fail(err);
        }
        return openApp(ctx, "market.entangleit.com");
      }
    });
  },
};

export const share = {
  id: "share",
  title: "Share a file",
  group: "Apps",
  note: "Anchor a file on chain. The file is hashed in your browser; the daemon only ever sees the digest.",
  async load() {},
  render(ctx) {
    const r = ctx.data.result;
    return (
      `<div class="card" style="max-width:560px"><h3>Anchor a file</h3>` +
      `<p class="dim">The file itself is not uploaded — its SHA-256 digest and name go on chain, so anyone with the file can verify it.</p>` +
      `<div class="card-actions"><button class="btn primary" data-pick>Choose a file…</button></div>` +
      (r
        ? `<div class="notice ok" style="margin-top:12px">Anchored <b>${esc(r.filename)}</b> · ${fmtSats(r.size ?? 0)} worth of chain space` +
          `<div class="card-sub mono" style="margin-top:5px">${esc(r.txid ?? "")}</div>` +
          `<div class="card-actions">` +
            `<button class="btn tiny" data-copy="${esc(r.txid ?? "")}">Copy txid</button>` +
            (r.explorer ? `<button class="btn tiny" data-explorer="${esc(r.explorer)}">Open in explorer</button>` : "") +
          `</div></div>`
        : "") +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const p = e.target.closest("[data-pick]");
      if (p) {
        const file = await pickFile();
        if (!file) return;
        p.disabled = true;
        p.textContent = "Hashing…";
        try {
          const sha256 = await sha256Hex(file.bytes);
          // anchorFile takes the digest, not a path — nothing about the local
          // filesystem is exposed, and the label is sanitised daemon-side.
          ctx.data.result = await rpc("anchorFile", { sha256, filename: file.name, size: file.size, origin: "bsvos" });
          ctx.toast("Anchored on chain");
          root.innerHTML = share.render(ctx);
          share.bind(root, ctx);
        } catch (err) {
          ctx.fail(err);
        } finally {
          p.disabled = false;
          p.textContent = "Choose a file…";
        }
        return;
      }
      const cp = e.target.closest("[data-copy]");
      if (cp) return copy(cp.dataset.copy, "txid copied");
      const ex = e.target.closest("[data-explorer]");
      if (ex) return ctx.openExplorer(ex.dataset.explorer);
    });
  },
};

export default [apps, market, share];
