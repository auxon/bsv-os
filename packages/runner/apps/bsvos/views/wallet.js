// Wallet core: overview (the pill's job, expanded), approvals, transactions,
// policy and agent sub-wallets. Everything here is reachable from the
// daemon's `history` call plus `isAuthenticated`/`balance`/`addressQr`/
// `policyPending`/`doctor`, so a full refresh is a handful of RPCs rather
// than the panel's 22 process spawns.
"use strict";

import { rpc, tryRpc, explain, isLocked } from "../lib/rpc.js";
import { esc, fmtInt, fmtBsv, fmtSats, short, timeAgo, when, copy, confirmDialog, promptDialog } from "../lib/ui.js";
import { empty, errorBox, lockedBox, kv, rows, chip, satsChip, confirmSpend } from "./common.js";

const VIEW = { id: "overview", title: "Overview", group: "Wallet" };

export const overview = {
  ...VIEW,
  note: "This machine's wallet. Reading works while locked; spending does not.",
  async load(ctx) {
    const [auth, bal, qr, pending, reqs, hist, doctor] = await Promise.all([
      tryRpc("isAuthenticated"),
      tryRpc("balance"),
      tryRpc("addressQr"),
      tryRpc("pending"),
      tryRpc("policyPending"),
      tryRpc("history"),
      tryRpc("doctor"),
    ]);
    ctx.data.auth = auth.ok ? auth.value : null;
    ctx.data.authError = auth.ok ? null : auth.error;
    ctx.data.balance = bal.ok ? bal.value : null;
    ctx.data.qr = qr.ok ? qr.value : null;
    ctx.data.pending = pending.ok ? pending.value?.tracked ?? [] : [];
    ctx.data.requests = reqs.ok ? reqs.value?.requests ?? [] : [];
    ctx.data.history = hist.ok ? hist.value : null;
    ctx.data.doctor = doctor.ok ? doctor.value : null;
  },
  render(ctx) {
    const { auth, balance, qr, pending, requests, history, doctor, authError } = ctx.data;
    if (authError) return errorBox(`Wallet daemon unreachable: ${explain(authError)}`);
    if (!auth?.hasWallet) {
      return (
        `<div class="card"><h3>No wallet on this machine</h3>` +
        `<p class="dim">Create one in a terminal so the recovery phrase never passes through a browser: <span class="mono">bsv create</span></p>` +
        `<p class="dim">Already have a phrase? <span class="mono">bsv import</span> restores it (hidden prompt, never argv).</p></div>`
      );
    }

    const s = history?.summary ?? {};
    const total = (balance?.confirmed ?? 0) + (balance?.unconfirmed ?? 0);
    const checks = doctor?.checks ?? [];

    return (
      `<div class="split">` +
        `<div class="card balance-hero">` +
          `<div class="stat-row">` +
            `<div class="stat"><div class="stat-label">Confirmed</div><div class="stat-value">${fmtBsv(balance?.confirmed ?? 0)}</div></div>` +
            `<div class="stat"><div class="stat-label">Unconfirmed</div><div class="stat-value">${fmtBsv(balance?.unconfirmed ?? 0)}</div></div>` +
          `</div>` +
          `<div class="card-actions">` +
            `<button class="btn primary" data-go="send">Send</button>` +
            `<button class="btn" data-go="pay">Pay someone</button>` +
            `<button class="btn" data-go="receive">Receive</button>` +
            `<button class="btn" data-go="requests">Request</button>` +
          `</div>` +
        `</div>` +
        `<div class="card">` +
          `<h3>Receive</h3>` +
          (qr?.dataUrl
            ? `<div class="qr"><img src="${esc(qr.dataUrl)}" alt="Address QR"></div>`
            : `<p class="dim">QR unavailable.</p>`) +
          `<div class="card-sub mono">${esc(balance?.address ?? "—")}</div>` +
          `<div class="card-actions"><button class="btn" data-copy="${esc(balance?.address ?? "")}">Copy address</button></div>` +
        `</div>` +
      `</div>` +

      `<h2 class="sec">Activity</h2>` +
      `<div class="grid">` +
        card("Spend requests", requests.length, requests.length ? "warn" : "ok",
          requests.length ? `${fmtSats(requests.reduce((n, r) => n + (Number(r.amount_sats) || 0), 0))} waiting for you` : "nothing needs approval", "approvals") +
        card("In flight", pending.length, pending.length ? "info" : "", pending.length ? "broadcast, awaiting confirmation" : "no broadcasts pending", "transactions") +
        card("Mined", s.mined ?? 0, "", "confirmed on chain", "transactions") +
        card("Failed", s.failed ?? 0, s.failed ? "bad" : "", s.failed ? "needs a look" : "all clean", "transactions") +
        card("Allowed origins", s.allowedOrigins ?? 0, "", "can spend within a cap", "policy") +
        card("Denied origins", s.deniedOrigins ?? 0, s.deniedOrigins ? "bad" : "", "hard blocked", "policy") +
      `</div>` +

      (auth.locked ? lockedBox() : "") +

      `<h2 class="sec">Health</h2>` +
      `<div class="grid">` +
        (checks.length
          ? checks
              .map(
                (c) =>
                  `<div class="card"><div class="card-top">${chip(c.status, c.status === "ok" ? "ok" : c.status === "fail" ? "bad" : "warn")}` +
                  `<h3>${esc(c.id)}</h3></div><p class="card-sub">${esc(c.detail ?? "")}</p></div>`,
              )
              .join("")
          : `<div class="card"><p class="dim">Diagnostics unavailable.</p></div>`) +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const go = e.target.closest("[data-go]");
      if (go) return ctx.go(go.dataset.go);
      const cp = e.target.closest("[data-copy]");
      if (cp) return copy(cp.dataset.copy, "Address copied");
    });
  },
};

function card(title, value, tone, sub, view) {
  return (
    `<div class="card"><div class="stat"><div class="stat-label">${esc(title)}</div>` +
    `<div class="stat-value">${chip(fmtInt(value), tone)}</div></div>` +
    `<p class="card-sub">${esc(sub)}</p>` +
    (view ? `<div class="card-actions"><button class="btn tiny" data-go="${esc(view)}">Open</button></div>` : "") +
    `</div>`
  );
}

export const approvals = {
  id: "approvals",
  title: "Approvals",
  group: "Wallet",
  note: "Origins asking to spend. Approve sets a cap you choose; Deny blocks the origin outright.",
  async load(ctx) {
    const r = await tryRpc("policyPending");
    ctx.data.requests = r.ok ? r.value?.requests ?? [] : [];
    ctx.data.loadError = r.ok ? null : r.error;
  },
  render(ctx) {
    const list = ctx.data.requests ?? [];
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    if (!list.length) return empty("No spend requests are waiting. New ones raise a macOS notification.");
    return (
      `<div class="grid">` +
      list
        .map((r) => {
          const jev = r.jev_verdict
            ? `<div class="card-meta">${chip(`Jev: ${r.jev_verdict}`, r.jev_verdict === "deny" ? "bad" : "")}` +
              (r.jev_prob != null ? chip(`p=${Number(r.jev_prob).toFixed(2)}`) : "") +
              (r.jev_risk_level ? chip(String(r.jev_risk_level), r.jev_risk === "high" ? "bad" : "") : "") +
              `</div>`
            : "";
          return (
            `<div class="card" data-id="${esc(r.id)}">` +
              `<div class="card-top"><div class="grow"><h3>${esc(r.origin)}</h3>` +
              `<div class="card-sub">${esc(r.action ?? "")} · ${timeAgo(Math.floor((r.created_at ?? 0) / 1000))}</div></div>` +
              `${chip(fmtSats(r.amount_sats), Number(r.amount_sats) ? "gold" : "")}</div>` +
              jev +
              `<div class="card-actions">` +
                `<button class="btn primary" data-approve="${esc(r.origin)}" data-amount="${Number(r.amount_sats) || 0}">Approve</button>` +
                `<button class="btn" data-budget="${esc(r.origin)}" data-amount="${Number(r.amount_sats) || 0}">Budget…</button>` +
                `<button class="btn danger" data-deny="${esc(r.origin)}">Deny</button>` +
              `</div>` +
            `</div>`
          );
        })
        .join("") +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const ap = e.target.closest("[data-approve]");
      if (ap) {
        const origin = ap.dataset.approve;
        const amount = Number(ap.dataset.amount) || 0;
        // Cap defaults to this ask, rounded up, so approving never silently
        // grants more than the origin is asking for right now.
        const suggested = amount ? Math.ceil((amount * 10) / 1000) * 1000 : 0;
        const capRaw = await promptDialog("Approve origin", {
          label: `Spend cap for ${origin} (sats)`,
          placeholder: String(suggested),
          value: String(suggested),
          confirmLabel: "Approve",
        });
        if (capRaw === null) return;
        const cap = Number.parseInt(String(capRaw).replace(/[^\d]/g, ""), 10);
        if (!Number.isFinite(cap) || cap < 0) return ctx.fail(new Error("cap must be a whole number of sats"));
        try {
          await rpc("policyApprove", { origin, capSats: cap, auto: false });
          ctx.toast(`${origin} approved up to ${fmtSats(cap)}`);
          await ctx.reload();
        } catch (err) {
          ctx.fail(err);
        }
        return;
      }
      const bg = e.target.closest("[data-budget]");
      if (bg) {
        const origin = bg.dataset.budget;
        const amount = Number(bg.dataset.amount) || 0;
        const base = amount || 1000;
        try {
          // Mirrors the panel's 10x/100x/1000x ladder, but as named agent
          // sub-wallets so the budget is a real capped identity.
          for (const mult of [10, 100, 1000]) {
            const budget = base * mult;
            const daily = Math.max(1, Math.floor(budget / 10));
            await rpc("agentMint", {
              name: origin,
              budgetSats: budget,
              dailySats: daily,
              expiryAt: Date.now() + 30 * 86400000,
            });
          }
          ctx.toast(`${origin} can now spend up to ${fmtSats(base * 1000)} (30 days)`);
          await ctx.reload();
        } catch (err) {
          ctx.fail(err);
        }
        return;
      }
      const dn = e.target.closest("[data-deny]");
      if (dn) {
        const origin = dn.dataset.deny;
        if (!(await confirmDialog("Deny origin", `Hard-block all spending from ${origin}?`, "Deny"))) return;
        try {
          await rpc("policyDeny", { origin });
          ctx.toast(`${origin} denied`);
          await ctx.reload();
        } catch (err) {
          ctx.fail(err);
        }
      }
    });
  },
};

const STATUS_HINT = {
  seen: "broadcast — waiting for a miner to pick it up",
  in_flight: "in the mempool",
  mined: "confirmed on chain",
  failed: "failed — safe to retry, nothing was spent",
};

export const transactions = {
  id: "transactions",
  title: "Transactions",
  group: "Wallet",
  note: "Every send this wallet has made. Losers of a double-spend race cost nothing.",
  async load(ctx) {
    const [h, p] = await Promise.all([tryRpc("history"), tryRpc("pending")]);
    ctx.data.history = h.ok ? h.value : null;
    ctx.data.pending = p.ok ? p.value?.tracked ?? [] : [];
  },
  render(ctx) {
    const txs = ctx.data.history?.transactions ?? [];
    const inflight = ctx.data.pending ?? [];
    if (!txs.length && !inflight.length) return empty("No transactions yet.");
    const body = (t) =>
      `<div class="row">` +
        `${chip(t.status, t.status === "mined" ? "ok" : t.status === "failed" ? "bad" : "info")}` +
        `<span class="grow ellipsis">${esc(t.label || "transaction")}</span>` +
        `<span class="mono dim">${esc(short(t.txid, 8))}</span>` +
        `<span class="dim">${timeAgo(Math.floor((t.created_at ?? 0) / 1000))}</span>` +
        `<span class="actions">` +
          `<button class="btn tiny" data-copy="${esc(t.txid)}">Copy txid</button>` +
          `<button class="btn tiny" data-explorer="${esc(t.txid)}">Explorer</button>` +
        `</span>` +
      `</div>`;
    return (
      (inflight.length
        ? `<h2 class="sec">In flight (${inflight.length})</h2>` + rows(inflight, (t) =>
            `<div class="row">${chip("broadcast", "info")}<span class="grow ellipsis">${esc(t.label || t.txid)}</span>` +
            `<span class="dim">${esc(STATUS_HINT.seen)}</span></div>`)
        : "") +
      `<h2 class="sec">History (${txs.length})</h2>` +
      (txs.length
        ? rows(txs, body)
        : empty("Nothing sent yet."))
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", (e) => {
      const cp = e.target.closest("[data-copy]");
      if (cp) return copy(cp.dataset.copy, "txid copied");
      const ex = e.target.closest("[data-explorer]");
      if (ex) return ctx.openExplorer(ex.dataset.explorer);
    });
  },
};

export const policy = {
  id: "policy",
  title: "Policy",
  group: "Wallet",
  note: "Which origins may spend, and up to how much. Revoke returns an origin to asking every time.",
  async load(ctx) {
    const r = await tryRpc("policyList");
    const h = await tryRpc("history");
    ctx.data.policies = r.ok ? r.value?.policies ?? [] : h.value?.policies ?? [];
    ctx.data.loadError = r.ok ? null : r.error;
  },
  render(ctx) {
    const list = ctx.data.policies ?? [];
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    if (!list.length) return empty("No policies set. Approving a request creates one.");
    return rows(list, (p) =>
      `<div class="row">` +
        `${chip(p.mode, p.mode === "deny" ? "bad" : p.mode === "allow" ? "ok" : "warn")}` +
        `<span class="grow mono ellipsis">${esc(p.origin)}</span>` +
        `${satsChip(p.cap_sats ?? p.spend_cap_sats ?? 0)}` +
        `<span class="actions">` +
          (p.mode === "deny"
            ? `<button class="btn tiny primary" data-allow="${esc(p.origin)}">Allow</button>`
            : `<button class="btn tiny danger" data-deny="${esc(p.origin)}">Revoke</button>`) +
        `</span>` +
      `</div>`);
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const a = e.target.closest("[data-allow]");
      if (a) {
        try {
          await rpc("policyApprove", { origin: a.dataset.allow, capSats: 0, auto: false });
          ctx.toast(`${a.dataset.allow} may now ask for money`);
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
        return;
      }
      const d = e.target.closest("[data-deny]");
      if (d) {
        if (!(await confirmDialog("Revoke", `Block all spending from ${d.dataset.deny}?`, "Revoke"))) return;
        try {
          await rpc("policyDeny", { origin: d.dataset.deny });
          ctx.toast(`${d.dataset.deny} revoked`);
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
      }
    });
  },
};

export const agents = {
  id: "agents",
  title: "Agents",
  group: "Wallet",
  note: "Capped sub-wallets. An agent can spend only its remaining budget, and only inside its daily window.",
  async load(ctx) {
    const r = await tryRpc("agentList");
    ctx.data.agents = r.ok ? r.value?.agents ?? [] : [];
    ctx.data.loadError = r.ok ? null : r.error;
  },
  render(ctx) {
    const list = ctx.data.agents ?? [];
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    if (!list.length) return empty("No agent sub-wallets. Mint one from an approval's Budget… action.");
    return `<div class="grid">` + list.map((a) => {
      const total = Number(a.budgetSats ?? a.budget_sats ?? 0);
      const used = total - Number(a.remainingSats ?? a.remaining_sats ?? 0);
      const pct = total ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;
      const active = a.active !== false;
      return (
        `<div class="card">` +
          `<div class="card-top"><div class="grow"><h3>${esc(a.name)}</h3>` +
          `<div class="card-sub">${active ? "active" : a.expired ? "expired" : "revoked"}</div></div>` +
          `${chip(fmtSats(a.remainingSats ?? a.remaining_sats ?? 0), "info")}</div>` +
          `<div class="bar ${pct > 80 ? "gold" : ""}"><i style="width:${pct}%"></i></div>` +
          kv([
            ["budget", fmtSats(total)],
            ["used", fmtSats(used)],
            ["daily window", fmtSats(a.dailySats ?? a.daily_sats ?? 0)],
            ["expires", when(a.expiresAt ?? a.expires_at)],
          ]) +
          (active
            ? `<div class="card-actions"><button class="btn danger" data-revoke="${esc(a.name)}">Revoke</button></div>`
            : "") +
        `</div>`
      );
    }).join("") + `</div>`;
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const r = e.target.closest("[data-revoke]");
      if (!r) return;
      if (!(await confirmDialog("Revoke agent", `${r.dataset.revoke} loses its remaining budget immediately.`, "Revoke"))) return;
      try {
        await rpc("agentRevoke", { name: r.dataset.revoke });
        ctx.toast(`${r.dataset.revoke} revoked`);
        await ctx.reload();
      } catch (err) { ctx.fail(err); }
    });
  },
};

export default [overview, approvals, transactions, policy, agents];
