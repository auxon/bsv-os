// Work: gig board, NightShift standing orders, overlays, file sharing,
// starter sats, and recovery status.
"use strict";

import { rpc, tryRpc, explain } from "../lib/rpc.js";
import { esc, fmtInt, fmtSats, short, timeAgo, when, copy, confirmDialog, promptDialog, intOr } from "../lib/ui.js";
import { empty, errorBox, kv, rows, chip, confirmSpend } from "./common.js";

export const gigs = {
  id: "gigs",
  title: "Gigs",
  group: "Work",
  note: "Paid work on the board. Track what you want, claim what you finish.",
  async load(ctx) {
    const [b, mine] = await Promise.all([tryRpc("gigBoard"), tryRpc("gigList")]);
    ctx.data.board = b.ok ? b.value?.gigs ?? [] : [];
    ctx.data.mine = mine.ok ? mine.value?.gigs ?? [] : [];
    ctx.data.loadError = b.ok ? null : b.error;
  },
  render(ctx) {
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    const board = ctx.data.board ?? [];
    const mine = ctx.data.mine ?? [];
    const mineIds = new Set(mine.map((g) => g.id));
    const row = (g) => {
      const tracked = mineIds.has(g.id);
      return (
        `<div class="row" style="align-items:flex-start;flex-direction:column;gap:5px">` +
          `<div style="display:flex;align-items:center;gap:9px;width:100%">` +
            `${chip(g.status ?? "open", g.status === "open" ? "ok" : "warn")}` +
            `<span class="grow">${esc(g.title ?? "gig")}</span>` +
            `${chip(fmtSats(g.amountSats ?? 0), "gold")}` +
            `<span class="actions">` +
              (tracked
                ? `<button class="btn tiny primary" data-claim="${esc(g.id)}">Claim</button>` +
                  `<button class="btn tiny" data-untrack="${esc(g.id)}">Untrack</button>`
                : `<button class="btn tiny" data-track="${esc(g.id)}">Track</button>`) +
            `</span>` +
          `</div>` +
          (tracked ? `<div class="dim">${esc(g.lifecycle ?? "tracked")}</div>` : "") +
        `</div>`
      );
    };
    return (
      `<h2 class="sec">Tracked (${mine.length})</h2>` +
      (mine.length ? rows(mine, row) : empty("You are not tracking any gigs.")) +
      `<h2 class="sec">Board (${board.length})</h2>` +
      (board.length ? rows(board, row) : empty("No open gigs."))
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-track]");
      if (t) return ctx.run(async () => {
        await rpc("gigTrack", { id: t.dataset.track });
        ctx.toast("Tracking");
        await ctx.reload();
      });
      const u = e.target.closest("[data-untrack]");
      if (u) return ctx.run(async () => {
        await rpc("gigUntrack", { id: u.dataset.untrack });
        ctx.toast("Untracked");
        await ctx.reload();
      });
      const c = e.target.closest("[data-claim]");
      if (c) {
        if (!(await confirmDialog("Claim gig", "Claiming commits you to delivering. Payout settles on chain when marked paid.", "Claim"))) return;
        return ctx.run(async () => {
          const res = await rpc("gigClaim", { id: c.dataset.claim });
          if (res?.guided) ctx.toast(res.guided, true);
          else ctx.toast("Claimed");
          await ctx.reload();
        });
      }
    });
  },
};

export const nightshift = {
  id: "nightshift",
  title: "NightShift",
  group: "Work",
  note: "Standing orders that run on a cycle, with the budget escrowed up front.",
  async load(ctx) {
    const [o, r] = await Promise.all([tryRpc("shiftList"), tryRpc("shiftRuns")]);
    ctx.data.orders = o.ok ? o.value?.orders ?? [] : [];
    ctx.data.runs = r.ok ? r.value?.runs ?? [] : [];
  },
  render(ctx) {
    const orders = ctx.data.orders ?? [];
    const runs = ctx.data.runs ?? [];
    return (
      `<h2 class="sec">Orders (${orders.length})</h2>` +
      (orders.length
        ? rows(orders, (o) => {
            const paused = o.status === "paused" || o.paused === true;
            return (
              `<div class="row"><span class="grow">${esc(o.name ?? o.id)} <span class="dim">· ${esc(o.agent ?? "")}</span></span>` +
              `${chip(fmtSats(o.cycleSats ?? 0), "info")}${chip(o.status ?? (paused ? "paused" : "active"), paused ? "warn" : "ok")}` +
              `<span class="actions">` +
                (paused
                  ? `<button class="btn tiny primary" data-resume="${esc(o.id)}">Resume</button>`
                  : `<button class="btn tiny" data-pause="${esc(o.id)}">Pause</button>`) +
              `</span></div>`
            );
          })
        : empty("No standing orders.")) +
      `<h2 class="sec">Runs (${runs.length})</h2>` +
      (runs.length
        ? rows(runs, (r) => {
            const due = r.status === "due";
            const submitted = r.status === "submitted";
            return (
              `<div class="row" style="align-items:flex-start;flex-direction:column;gap:5px">` +
                `<div style="display:flex;align-items:center;gap:9px;width:100%">` +
                  `${chip(r.status, due ? "warn" : submitted ? "info" : "ok")}` +
                  `<span class="grow">run #${esc(r.id)} · ${esc(r.agent ?? "")}</span>` +
                  `${chip(fmtSats(r.cycleSats ?? 0))}` +
                  `<span class="actions">` +
                    (due ? `<button class="btn tiny primary" data-shift-claim="${esc(r.id)}">Claim</button>` : "") +
                    (submitted ? `<button class="btn tiny primary" data-shift-approve="${esc(r.id)}">Approve</button>` : "") +
                    (due || submitted ? `<button class="btn tiny danger" data-shift-fail="${esc(r.id)}">Fail</button>` : "") +
                  `</span>` +
                `</div>` +
                (submitted
                  ? `<div class="form-row" style="width:100%">` +
                    `<input name="proof-${esc(r.id)}" placeholder="proof text, then submit">` +
                    `<button class="btn tiny" data-shift-submit="${esc(r.id)}">Submit</button></div>`
                  : "") +
              `</div>`
            );
          })
        : empty("No runs yet."))
    );
  },
  bind(root, ctx) {
    const call = (method, params, msg) =>
      ctx.run(async () => {
        await rpc(method, params);
        ctx.toast(msg);
        await ctx.reload();
      });
    root.addEventListener("click", async (e) => {
      const map = {
        "[data-pause]": ["shiftPause", "Paused"],
        "[data-resume]": ["shiftResume", "Resumed"],
        "[data-shift-claim]": ["shiftClaim", "Claimed"],
        "[data-shift-approve]": ["shiftApprove", "Approved"],
        "[data-shift-fail]": ["shiftFail", "Marked failed"],
      };
      for (const [sel, [method, msg]] of Object.entries(map)) {
        const btn = e.target.closest(sel);
        if (btn) {
          const key = sel.includes("shift-") ? "run" : "id";
          return call(method, { [key]: Number(btn.dataset[sel.replace(/[\[\]=-]/g, "")] ?? btn.getAttribute(sel)) }, msg);
        }
      }
      const sub = e.target.closest("[data-shift-submit]");
      if (sub) {
        const id = sub.dataset.shiftSubmit;
        const input = root.querySelector(`[name="proof-${id}"]`);
        const proof = input?.value.trim();
        if (!proof) return ctx.fail(new Error("proof text required"));
        return call("shiftSubmit", { run: Number(id), proof }, "Submitted");
      }
    });
  },
};

export const overlays = {
  id: "overlays",
  title: "Overlays",
  group: "Work",
  note: "Topic overlays and their live status.",
  async load(ctx) {
    const r = await tryRpc("overlayHealth");
    ctx.data.overlays = r.ok ? r.value?.overlays ?? [] : [];
    ctx.data.lookup = null;
  },
  render(ctx) {
    const list = ctx.data.overlays ?? [];
    return (
      `<div class="split">` +
        `<div class="card" style="max-width:460px"><h3>Look up a topic</h3>` +
          `<form data-form="lookup">` +
            `<label class="field"><span>Topic</span><input name="topic" placeholder="tm_&lt;64 hex&gt;_&lt;index&gt;" spellcheck="false" required></label>` +
            `<label class="field"><span>Address (optional)</span><input name="address" spellcheck="false"></label>` +
            `<div class="card-actions"><button class="btn" type="submit">Look up</button></div>` +
          `</form>` +
          (ctx.data.lookup
            ? `<div class="notice" style="margin-top:12px">${esc(ctx.data.lookup.topic)} · ${esc(ctx.data.lookup.what ?? "")}: ${fmtInt(
                (ctx.data.lookup.rows ?? []).length,
              )} rows</div>`
            : "") +
        `</div>` +
        `<div class="card"><h3>Health (${list.length})</h3>` +
          (list.length
            ? rows(list, (o) =>
                `<div class="row">${chip(o.live ? "live" : "down", o.live ? "ok" : "bad")}` +
                `<span class="grow">${esc(o.name ?? "?")}</span>` +
                `<span class="dim">${o.live ? `${fmtInt(o.latencyMs ?? 0)} ms` : "unreachable"}</span></div>`)
            : empty("No overlays configured.")) +
        `</div>` +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("submit", async (e) => {
      const form = e.target.closest('[data-form="lookup"]');
      if (!form) return;
      e.preventDefault();
      const topic = form.topic.value.trim();
      const address = form.address.value.trim();
      try {
        ctx.data.lookup = await rpc("overlayLookup", { topic, address: address || undefined });
        root.innerHTML = overlays.render(ctx);
        overlays.bind(root, ctx);
      } catch (err) { ctx.fail(err); }
    });
  },
};

export const files = {
  id: "files",
  title: "Files",
  group: "Work",
  note: "Trackerless BitTorrent sharing over bsvOS discovery. Fetching works here; seeding a local path stays in the terminal.",
  async load(ctx) {
    const r = await tryRpc("torrentList");
    ctx.data.torrents = r.ok ? r.value : null;
  },
  render(ctx) {
    const t = ctx.data.torrents;
    if (!t) return errorBox("File sharing service unavailable.");
    const list = t.torrents ?? [];
    return (
      `<div class="card" style="max-width:560px"><h3>Fetch a torrent</h3>` +
        `<form data-form="fetch">` +
          `<label class="field"><span>Infohash</span><input name="infoHash" placeholder="40 hex chars" spellcheck="false" required></label>` +
          `<label class="field"><span>Peer host:port (optional)</span><input name="peer" placeholder="127.0.0.1:6881"></label>` +
          `<div class="card-actions"><button class="btn primary" type="submit">Fetch</button></div>` +
        `</form>` +
        `<div class="notice" style="margin-top:12px">Seeding a file from disk needs a filesystem path, which a browser cannot supply. Use <span class="mono">bsv torrent seed &lt;path&gt;</span> in a terminal for that.</div>` +
        (t.port ? `<p class="dim" style="margin-top:8px">Serving on port ${esc(t.port)}.</p>` : "") +
      `</div>` +
      `<h2 class="sec">Transfers (${list.length})</h2>` +
      (list.length
        ? rows(list, (x) =>
            `<div class="row"><span class="grow mono ellipsis">${esc(x.name ?? x.infoHash)}</span>` +
            `<span class="actions">` +
              `<button class="btn tiny" data-copy="${esc(x.infoHash)}">Copy infohash</button>` +
              `<button class="btn tiny danger" data-stop="${esc(x.infoHash)}">Stop</button>` +
            `</span></div>`)
        : empty("No transfers."))
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const cp = e.target.closest("[data-copy]");
      if (cp) return copy(cp.dataset.copy, "Infohash copied");
      const st = e.target.closest("[data-stop]");
      if (st) {
        if (!(await confirmDialog("Stop transfer", "Stop fetching this torrent?", "Stop"))) return;
        return ctx.run(async () => {
          await rpc("torrentRemove", { infoHash: st.dataset.stop });
          ctx.toast("Stopped");
          await ctx.reload();
        });
      }
    });
    root.addEventListener("submit", async (e) => {
      const form = e.target.closest('[data-form="fetch"]');
      if (!form) return;
      e.preventDefault();
      const infoHash = form.infoHash.value.trim();
      const peer = form.peer.value.trim();
      if (!/^[0-9a-fA-F]{40}$/.test(infoHash)) return ctx.fail(new Error("infohash must be 40 hex characters"));
      try {
        const res = await rpc("torrentFetch", { infoHash, peer: peer || undefined });
        ctx.toast(`Fetching ${res?.name ?? infoHash.slice(0, 8)}…`);
        await ctx.reload();
      } catch (err) { ctx.fail(err); }
    });
  },
};

export const faucet = {
  id: "faucet",
  title: "Starter sats",
  group: "Work",
  note: "Claim a small one-off grant to get started.",
  async load(ctx) {
    const r = await tryRpc("faucetStatus");
    ctx.data.faucet = r.ok ? r.value : null;
    ctx.data.loadError = r.ok ? null : r.error;
  },
  render(ctx) {
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    const f = ctx.data.faucet;
    if (!f) return empty("Faucet status unavailable.");
    return (
      `<div class="card" style="max-width:460px"><h3>Starter sats</h3>` +
      kv([
        ["eligible", f.funded ? "yes" : "no"],
        ["amount", f.amount ? fmtSats(f.amount) : null],
        ["claimed", f.claimed ? "yes" : "not yet"],
      ]) +
      `<div class="card-actions">` +
        (f.funded && !f.claimed
          ? `<button class="btn primary" data-claim>Claim ${fmtSats(f.amount ?? 0)}</button>`
          : `<button class="btn" disabled>${f.claimed ? "Claimed" : "Not eligible"}</button>`) +
      `</div>` +
      (ctx.data.claimed ? `<p class="dim" style="margin-top:10px">Sent to ${esc(ctx.data.claimed.address ?? "")}.</p>` : "") +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      if (!e.target.closest("[data-claim]")) return;
      if (!(await confirmDialog("Claim starter sats", "This sends a small one-off grant to this wallet. Only once.", "Claim"))) return;
      try {
        ctx.data.claimed = await rpc("faucetClaim", {});
        ctx.toast("Starter sats sent");
        root.innerHTML = faucet.render(ctx);
        faucet.bind(root, ctx);
      } catch (err) { ctx.fail(err); }
    });
  },
};

export const recovery = {
  id: "recovery",
  title: "Recovery",
  group: "Work",
  note: "Guardian card status. Setup and restore ceremonies stay in the terminal on purpose — they move key material.",
  async load(ctx) {
    const r = await tryRpc("recoveryStatus");
    ctx.data.recovery = r.ok ? r.value : null;
    ctx.data.loadError = r.ok ? null : r.error;
  },
  render(ctx) {
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    const rec = ctx.data.recovery;
    if (!rec) return empty("No recovery status.");
    const sets = rec.sets ?? [];
    return (
      `<div class="card" style="max-width:620px">` +
        `<div class="card-meta">${chip(rec.protected ? "guarded" : "unprotected", rec.protected ? "ok" : "warn")}</div>` +
        `<p class="dim">${
          rec.protected
            ? "A guardian set can restore this wallet if the seed is lost."
            : "No guardian set is enrolled. If you lose the recovery phrase, the wallet is gone."
        }</p>` +
        (sets.length
          ? rows(sets, (s) =>
              `<div class="row"><span class="grow mono ellipsis">${esc(s.setId ?? s.id ?? "set")}</span>` +
              `<span class="dim">${esc((s.guardians ?? []).join(", ") || "—")}</span>` +
              `<span class="chip">${esc(`${s.have ?? 0}/${s.need ?? s.total ?? 0}`)}</span>` +
              (s.superseded ? chip("superseded", "warn") : "") +
              `</div>`)
          : empty("No guardian sets enrolled.")) +
        `<div class="notice" style="margin-top:12px">Setup, rotation and restore are terminal-only by policy — they read and write key material, and a browser should not be in that path. Use <span class="mono">bsv recovery setup</span>.</div>` +
      `</div>`
    );
  },
  bind() {},
};

export default [gigs, nightshift, overlays, files, faucet, recovery];
