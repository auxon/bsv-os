// Money: receive, send, pay, payment requests, receipts, baskets,
// collectibles and fungible tokens.
"use strict";

import { rpc, tryRpc, explain } from "../lib/rpc.js";
import { esc, fmtInt, fmtBsv, fmtSats, short, timeAgo, when, copy, confirmDialog, promptDialog, intOr } from "../lib/ui.js";
import { empty, errorBox, lockedBox, kv, rows, chip, satsChip, confirmSpend } from "./common.js";

export const receive = {
  id: "receive",
  title: "Receive",
  group: "Money",
  note: "Your address and QR. Works while the wallet is locked.",
  async load(ctx) {
    const r = await tryRpc("addressQr");
    ctx.data.qr = r.ok ? r.value : null;
    ctx.data.loadError = r.ok ? null : r.error;
  },
  render(ctx) {
    const qr = ctx.data.qr;
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    if (!qr) return empty("No address yet.");
    return (
      `<div class="card" style="max-width:420px">` +
        `<h3>Scan or share this address</h3>` +
        `<div class="qr"><img src="${esc(qr.dataUrl)}" alt="Address QR code"></div>` +
        `<div class="card-sub mono">${esc(qr.address)}</div>` +
        `<div class="card-actions">` +
          `<button class="btn primary" data-copy="${esc(qr.address)}">Copy address</button>` +
          `<button class="btn" data-copy="${esc(qr.address.toUpperCase())}">Copy (checksummed)</button>` +
        `</div>` +
        `<p class="dim">Only send BSV (mainnet) to this address. A memo is not required — this is a plain address, not an invoice.</p>` +
      `</div>`
    );
  },
  bind(root) {
    root.addEventListener("click", (e) => {
      const cp = e.target.closest("[data-copy]");
      if (cp) copy(cp.dataset.copy, "Address copied");
    });
  },
};

export const send = {
  id: "send",
  title: "Send",
  group: "Money",
  note: "Move your own sats to an address. The policy engine still gates it.",
  async load(ctx) {
    const b = await tryRpc("balance");
    ctx.data.balance = b.ok ? b.value : null;
    ctx.data.swept = null;
  },
  render(ctx) {
    const bal = ctx.data.balance;
    return (
      `<div class="card" style="max-width:520px">` +
        `<h3>Send sats</h3>` +
        (bal
          ? `<p class="dim">Available: ${fmtBsv(bal.confirmed ?? 0)} confirmed${bal.unconfirmed ? ` · ${fmtSats(bal.unconfirmed)} unconfirmed` : ""}</p>`
          : "") +
        `<form data-form="send">` +
          `<label class="field"><span>Destination address</span><input name="to" placeholder="1… address" autocomplete="off" spellcheck="false" required></label>` +
          `<label class="field"><span>Amount (sats)</span><input name="sats" inputmode="numeric" placeholder="1000" required></label>` +
          `<label class="field"><span>Note (local label only, not sent on chain)</span><input name="label" placeholder="optional"></label>` +
          `<div class="card-actions"><button class="btn primary" type="submit">Send</button></div>` +
        `</form>` +
        `<h3 style="margin-top:18px">Send everything</h3>` +
        `<p class="dim">Empties this wallet into one address — the amount is the balance minus the network fee, so there is no exact number to work out.</p>` +
        `<form data-form="sweepout">` +
          `<label class="field"><span>Destination address</span><input name="to" placeholder="1… address" autocomplete="off" spellcheck="false" required></label>` +
          `<div class="card-actions"><button class="btn" type="submit">Send everything</button></div>` +
        `</form>` +
        (ctx.data.swept
          ? `<div class="notice ok" style="margin-top:12px">Swept <b>${fmtSats(ctx.data.swept.sats ?? 0)}</b> · fee ${fmtSats(
              ctx.data.swept.fee ?? 0,
            )}<div class="card-sub mono" style="margin-top:4px">${esc(ctx.data.swept.txid ?? "")}</div>` +
            `<div class="card-actions"><button class="btn tiny" data-copy="${esc(ctx.data.swept.txid ?? "")}">Copy txid</button></div></div>`
          : "") +
        `<h3 style="margin-top:18px">Sweep in from another wallet</h3>` +
        `<p class="dim">Moving funds in from an old single-key wallet or a paper wallet takes a private key, so it stays in the terminal — a key must never pass through a page.</p>` +
        `<pre class="code">bsv sweep in</pre>` +
        `<p class="dim">It prompts with hidden input, derives the address, and pays everything to this wallet minus the fee. Inscriptions at the old address are held back rather than swept, so they cannot be burned into fees.</p>` +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("submit", async (e) => {
      if (!e.target.closest('[data-form="send"], [data-form="sweepout"]')) return;
      e.preventDefault();
      const sweep = e.target.closest('[data-form="sweepout"]');
      if (sweep) {
        e.preventDefault();
        const to = sweep.to.value.trim();
        if (!to) return ctx.fail(new Error("destination address required"));
        const bal = (ctx.data.balance?.confirmed ?? 0) + (ctx.data.balance?.unconfirmed ?? 0);
        if (
          !(await confirmDialog(
            "Send everything",
            `Empty this wallet into ${short(to, 14)}? The full balance of ${fmtSats(
              bal,
            )} minus the network fee will be sent, leaving nothing behind.`,
            "Send everything",
          ))
        )
          return;
        try {
          // Amount comes from the daemon: it owns the fee arithmetic.
          ctx.data.swept = await rpc("sweepOut", { to });
          ctx.toast(`Swept ${fmtSats(ctx.data.swept?.sats ?? 0)}`);
          sweep.reset();
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
        return;
      }
      const form = e.target.closest('[data-form="send"]');
      if (!form) return;
      const to = form.to.value.trim();
      const sats = intOr(form.sats.value, 0);
      if (!to) return ctx.fail(new Error("destination address required"));
      if (!(await confirmSpend({ verb: "Send", amountSats: sats, to: short(to, 14) }))) return;
      try {
        const res = await rpc("send", { to, sats, label: form.label.value.trim() || undefined });
        ctx.toast(`Sent · fee ${fmtSats(res?.fee ?? 0)}`);
        form.reset();
        await ctx.reload();
      } catch (err) { ctx.fail(err); }
    });
  },
};

export const pay = {
  id: "pay",
  title: "Pay someone",
  group: "Money",
  note: "Pay a contact by name, an identity key, or an address. A note travels as an encrypted message.",
  async load(ctx) {
    const c = await tryRpc("contactList");
    ctx.data.contacts = c.ok ? c.value?.contacts ?? [] : [];
  },
  render(ctx) {
    const contacts = ctx.data.contacts ?? [];
    return (
      `<div class="split">` +
        `<div class="card" style="max-width:520px">` +
          `<h3>Pay</h3>` +
          `<form data-form="pay">` +
            `<label class="field"><span>Who</span><input name="to" list="pay-known" placeholder="@name, identity key, or address" required></label>` +
            `<datalist id="pay-known">${contacts.map((c) => `<option value="@${esc(c.name)}">${esc(c.name)}</option>`).join("")}</datalist>` +
            `<label class="field"><span>Amount (sats)</span><input name="sats" inputmode="numeric" placeholder="1000" required></label>` +
            `<label class="field"><span>Note (encrypted, sent to them)</span><input name="note" placeholder="optional"></label>` +
            `<div class="card-actions"><button class="btn primary" type="submit">Pay</button></div>` +
          `</form>` +
        `</div>` +
        (contacts.length
          ? `<div class="card"><h3>Known contacts</h3>` +
            rows(contacts, (c) =>
              `<div class="row"><span class="grow">${esc(c.name ?? "—")}</span>` +
              `<span class="mono dim ellipsis">${esc(short(c.identityKey ?? "", 6))}</span>` +
              `<span class="actions"><button class="btn tiny" data-pay="${esc(c.name)}">Pay</button></span></div>`) +
            `</div>`
          : "") +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", (e) => {
      const p = e.target.closest("[data-pay]");
      if (p) {
        const input = root.querySelector('[data-form="pay"] [name="to"]');
        if (input) input.value = `@${p.dataset.pay}`;
      }
    });
    root.addEventListener("submit", async (e) => {
      const form = e.target.closest('[data-form="pay"]');
      if (!form) return;
      e.preventDefault();
      const to = form.to.value.trim();
      const sats = intOr(form.sats.value, 0);
      const note = form.note.value.trim();
      if (!(await confirmSpend({ verb: "Pay", amountSats: sats, to, extra: note || null }))) return;
      try {
        const res = await rpc("pay", { to, sats, note: note || undefined });
        ctx.toast(`Paid ${fmtSats(sats)}${res?.messageSent ? " · note delivered" : ""}`);
        form.reset();
        await ctx.reload();
      } catch (err) { ctx.fail(err); }
    });
  },
};

export const requests = {
  id: "requests",
  title: "Payment requests",
  group: "Money",
  note: "Signed asks for money. Settle with a click, or share a bsvpay1: code for someone else to pay.",
  async load(ctx) {
    const r = await tryRpc("requestList");
    ctx.data.list = r.ok ? r.value : null;
    ctx.data.loadError = r.ok ? null : r.error;
  },
  render(ctx) {
    const list = ctx.data.list;
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    if (!list) return empty("No requests yet.");
    const inc = list.incoming ?? [];
    const out = list.outgoing ?? [];
    const incRow = (r) =>
      `<div class="row">` +
        `${chip(r.status, r.status === "paid" ? "ok" : r.status === "pending" ? "warn" : "bad")}` +
        `<span class="grow">${esc(r.memo || "no memo")} · ${esc(r.to_name ?? r.to?.name ?? "—")}</span>` +
        `<span class="dim">${fmtSats(r.amount)}</span>` +
        `<span class="actions">` +
          (r.status === "pending"
            ? `<button class="btn tiny primary" data-pay-id="${esc(r.id)}">Approve</button>` +
              `<button class="btn tiny danger" data-decline="${esc(r.id)}">Decline</button>`
            : r.status === "paid"
              ? `<button class="btn tiny" data-receipt-for="${esc(r.id)}">Receipt</button>`
              : "") +
        `</span>` +
      `</div>`;
    const outRow = (r) =>
      `<div class="row">${chip(r.status, r.status === "paid" ? "ok" : "warn")}` +
        `<span class="grow">${esc(r.memo || "no memo")} · ${esc(r.to?.name ?? r.to_name ?? "—")}</span>` +
        `<span class="dim">${fmtSats(r.amount)}</span>` +
        `<span class="actions"><button class="btn tiny" data-code="${esc(r.id)}">Show code</button></span></div>`;

    return (
      `<div class="split">` +
        `<div class="card" style="max-width:520px"><h3>Ask for money</h3>` +
          `<form data-form="create">` +
            `<label class="field"><span>Who</span><input name="to" placeholder="@name, identity key, or address" required></label>` +
            `<div class="form-row">` +
              `<label class="field"><span>Amount (sats)</span><input name="sats" inputmode="numeric" required></label>` +
              `<label class="field"><span>Memo</span><input name="memo" placeholder="what for"></label>` +
            `</div>` +
            `<div class="card-actions"><button class="btn primary" type="submit">Request</button></div>` +
          `</form>` +
          `<h3 style="margin-top:16px">Import a code</h3>` +
          `<form data-form="import">` +
            `<label class="field"><span>Paste a bsvpay1:… code</span><input name="code" placeholder="bsvpay1:…" spellcheck="false"></label>` +
            `<div class="card-actions"><button class="btn" type="submit">Import</button></div>` +
          `</form>` +
        `</div>` +
        `<div class="card"><h3>Incoming (${inc.length})</h3>` +
          (inc.length ? rows(inc, incRow) : empty("Nobody has asked you for money.")) + `</div>` +
        `<div class="card"><h3>Outgoing (${out.length})</h3>` +
          (out.length ? rows(out, outRow) : empty("You have not asked anyone for money.")) + `</div>` +
      `</div>` +
      (ctx.data.code ? codeBlock(ctx.data.code) : "")
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const pay = e.target.closest("[data-pay-id]");
      if (pay) {
        try {
          const res = await rpc("requestPay", { id: pay.dataset.payId });
          ctx.toast(`Paid · fee ${fmtSats(res?.fee ?? 0)}`);
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
        return;
      }
      const dec = e.target.closest("[data-decline]");
      if (dec) {
        try {
          await rpc("requestDecline", { id: dec.dataset.decline });
          ctx.toast("Declined");
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
        return;
      }
      const code = e.target.closest("[data-code]");
      if (code) {
        try {
          // Direct RPC keeps dataUrl, which the CLI stripped — so the QR
          // below actually renders here (it never did in the panel).
          ctx.data.code = await rpc("requestCode", { id: code.dataset.code });
          root.innerHTML = requests.render(ctx);
          requests.bind(root, ctx);
        } catch (err) { ctx.fail(err); }
        return;
      }
      const rc = e.target.closest("[data-receipt-for]");
      if (rc) {
        try {
          const res = await rpc("receiptIssue", { request: rc.dataset.receiptFor });
          ctx.toast(`Receipt ${short(res?.outpoint ?? "", 10)} inscribed`);
        } catch (err) { ctx.fail(err); }
      }
    });
    root.addEventListener("submit", async (e) => {
      const create = e.target.closest('[data-form="create"]');
      if (create) {
        e.preventDefault();
        const sats = intOr(create.sats.value, 0);
        const memo = create.memo.value.trim();
        try {
          ctx.data.code = await rpc("requestCreate", {
            to: create.to.value.trim(),
            sats,
            memo: memo || undefined,
          });
          ctx.toast("Request created");
          create.reset();
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
        return;
      }
      const imp = e.target.closest('[data-form="import"]');
      if (imp) {
        e.preventDefault();
        const code = imp.code.value.trim();
        if (!code) return;
        try {
          const res = await rpc("requestImport", { code });
          ctx.toast(res?.fresh ? "Request imported" : "Already had this request");
          imp.reset();
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
      }
    });
  },
};

function codeBlock(code) {
  if (!code) return "";
  return (
    `<h2 class="sec">Payment code</h2>` +
    `<div class="split"><div class="card">` +
      (code.dataUrl ? `<div class="qr"><img src="${esc(code.dataUrl)}" alt="Payment request QR"></div>` : "") +
      `<pre class="code">${esc(code.code ?? "")}</pre>` +
      `<div class="card-actions"><button class="btn primary" data-copy-code="${esc(code.code ?? "")}">Copy code</button></div>` +
    `</div></div>`
  );
}

export const receipts = {
  id: "receipts",
  title: "Receipts",
  group: "Money",
  note: "Signed proofs of payment, inscribed on chain. Verify before you trust one.",
  async load(ctx) {
    const r = await tryRpc("receiptList");
    ctx.data.receipts = r.ok ? r.value?.receipts ?? [] : [];
    ctx.data.loadError = r.ok ? null : r.error;
  },
  render(ctx) {
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    const list = ctx.data.receipts ?? [];
    if (!list.length) return empty("No receipts yet. Settle an incoming request, or issue one against a payment.");
    const detail = ctx.data.detail;
    return (
      `<div class="split">` +
        `<div class="card"><h3>Receipts (${list.length})</h3>` +
          rows(list, (r) =>
            `<div class="row"><span class="grow">${esc(r.memo || "payment")}</span>` +
            `<span class="dim">${fmtSats(r.amount)}</span>` +
            `<span class="actions">` +
              `<button class="btn tiny" data-show="${esc(r.id)}">View</button>` +
              `<button class="btn tiny" data-copy-id="${esc(r.id)}:0">Copy id</button>` +
            `</span></div>`) +
        `</div>` +
        (detail ? receiptDetail(detail) : `<div class="card"><p class="dim">Select a receipt to see its payload and signature.</p></div>`) +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const show = e.target.closest("[data-show]");
      if (show) {
        try {
          ctx.data.detail = await rpc("receiptShow", { id: show.dataset.show });
          root.innerHTML = receipts.render(ctx);
          receipts.bind(root, ctx);
        } catch (err) { ctx.fail(err); }
        return;
      }
      const cp = e.target.closest("[data-copy-id]");
      if (cp) return copy(cp.dataset.copyId, "Receipt id copied");
      const cc = e.target.closest("[data-copy-code]");
      if (cc) return copy(cc.dataset.copyCode, "Code copied");
      const co = e.target.closest("[data-copy-outpoint]");
      if (co) return copy(co.dataset.copyOutpoint, "Outpoint copied");
      const ct = e.target.closest("[data-copy-paytx]");
      if (ct) return copy(ct.dataset.copyPaytx, "Payment txid copied");
      const ex = e.target.closest("[data-explorer]");
      if (ex) return ctx.openExplorer(ex.dataset.explorer);
      const ix = e.target.closest("[data-indexer]");
      if (ix) return ctx.openExternal(ix.dataset.indexer);
    });
  },
};

function receiptDetail(d) {
  const p = d.payload ?? {};
  return (
    `<div class="card"><h3>Receipt</h3>` +
    `<div class="card-meta">${chip(d.verified ? "signature valid" : "signature INVALID", d.verified ? "ok" : "bad")}</div>` +
    kv([
      ["amount", p.amount != null ? fmtSats(p.amount) : null],
      ["memo", p.memo],
      ["from", p.from ? short(p.from, 12) : null],
      ["to", p.to ? short(p.to, 12) : null],
      ["date", p.at ? when(p.at) : null],
      ["carrier", d.outpoint ? short(d.outpoint, 12) : null],
    ]) +
    `<div class="card-actions">` +
      (d.outpoint ? `<button class="btn tiny" data-copy-outpoint="${esc(d.outpoint)}">Copy outpoint</button>` : "") +
      (d.paymentTxid ? `<button class="btn tiny" data-copy-paytx="${esc(d.paymentTxid)}">Copy payment txid</button>` : "") +
      (d.explorer ? `<button class="btn tiny" data-explorer="${esc(d.explorer)}">Open on-chain</button>` : "") +
      (d.indexer ? `<button class="btn tiny" data-indexer="${esc(d.indexer)}">View in 1Sat Indexer</button>` : "") +
    `</div>` +
    `</div>`
  );
}

export const baskets = {
  id: "baskets",
  title: "Money baskets",
  group: "Money",
  note: " labelled pots of sats, split across the wallet.",
  async load(ctx) {
    const h = await tryRpc("history");
    ctx.data.baskets = h.ok ? h.value?.baskets ?? [] : [];
  },
  render(ctx) {
    const list = ctx.data.baskets ?? [];
    if (!list.length) return empty("No baskets. Baskets are labelled pots for part of your balance.");
    return `<div class="grid">` + list.map((b) =>
      `<div class="card"><div class="card-top"><h3 class="grow">${esc(b.name ?? b.id ?? "basket")}</h3>` +
      `${chip(fmtBsv(b.balance ?? 0), "info")}</div>` +
      kv([["utxos", fmtInt(b.utxos ?? b.memberCount ?? 0)]]) +
      `</div>`).join("") + `</div>`;
  },
  bind() {},
};

export const collectibles = {
  id: "collectibles",
  title: "Collectibles",
  group: "Money",
  note: "1Sat ordinal inscriptions held by this wallet. Read-only; sending stays deliberate.",
  async load(ctx) {
    const r = await tryRpc("ordList");
    ctx.data.ordinals = r.ok ? r.value?.ordinals ?? [] : [];
    ctx.data.loadError = r.ok ? null : r.error;
  },
  render(ctx) {
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    const list = ctx.data.ordinals ?? [];
    if (!list.length) return empty("No inscriptions held.");
    return `<div class="grid">` + list.map((o) =>
      `<div class="card"><div class="card-top"><h3 class="grow ellipsis">${esc(o.contentType ?? "binary")}</h3>` +
      `${chip(fmtInt(o.contentLength ?? 0) + " B")}</div>` +
      `<div class="card-sub mono">${esc(o.outpoint ?? "")}</div>` +
      (o.contentUrl ? `<div class="card-actions"><button class="btn tiny" data-view="${esc(o.contentUrl)}">View</button></div>` : "") +
      `</div>`).join("") + `</div>`;
  },
  bind(root, ctx) {
    root.addEventListener("click", (e) => {
      const v = e.target.closest("[data-view]");
      if (v) ctx.openExternal(v.dataset.view);
    });
  },
};

export const tokens = {
  id: "tokens",
  title: "Tokens",
  group: "Money",
  note: "BSV21 fungible token positions.",
  async load(ctx) {
    const r = await tryRpc("bsv21List");
    ctx.data.tokens = r.ok ? r.value?.tokens ?? [] : [];
    ctx.data.loadError = r.ok ? null : r.error;
  },
  render(ctx) {
    if (ctx.data.loadError) return errorBox(explain(ctx.data.loadError));
    const list = ctx.data.tokens ?? [];
    if (!list.length) return empty("No BSV21 tokens held.");
    return `<div class="grid">` + list.map((t) =>
      `<div class="card"><div class="card-top"><h3 class="grow">${esc(t.symbol ?? t.tokenId ?? "token")}</h3>` +
      `${chip(fmtInt(t.balance ?? 0), "info")}</div>` +
      kv([["utxos", fmtInt(t.utxoCount ?? 0)]]) +
      `</div>`).join("") + `</div>`;
  },
  bind() {},
};

export default [receive, send, pay, requests, receipts, baskets, collectibles, tokens];
