// Predict: parimutuel markets over the wallet RPC. Same-origin RPC;
// the page never holds keys. Bets and settlements move sats on-chain
// through policy-gated RPCs; resolution is Jev + one dispute round.
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
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const fmtSats = (n) => `${Number(n || 0).toLocaleString("en-US")} sats`;
const pct = (p) => `${Math.round((Number(p) || 0) * 100)}%`;
const ago = (ts) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const until = (ts) => {
  const s = Math.floor((ts - Date.now()) / 1000);
  if (s <= 0) return "closed";
  if (s < 3600) return `${Math.floor(s / 60)}m left`;
  if (s < 86400) return `${Math.floor(s / 3600)}h left`;
  return `${Math.floor(s / 86400)}d left`;
};

const state = { markets: [], detail: null };

function setStatus(t) {
  $("status").textContent = t;
}

function poolBar(pools, total) {
  const names = Object.keys(pools);
  const cells = names.map((o) => {
    const p = total > 0 ? (pools[o] / total) * 100 : 100 / names.length;
    return `<div class="poolseg" style="flex:${Math.max(p, 2)}" title="${esc(o)} ${fmtSats(pools[o])}"></div>`;
  }).join("");
  return `<div class="poolbar">${cells}</div>`;
}

async function refresh() {
  try {
    const r = await rpc("predictList", {});
    state.markets = r?.markets ?? [];
    setStatus(`${state.markets.length} markets`);
    renderList();
  } catch (err) {
    setStatus(`daemon unreachable: ${err.message}`);
  }
}

function renderList() {
  const el = $("market-list");
  if (!state.markets.length) {
    el.innerHTML = `<p class="hint">no markets yet — create one below.</p>`;
    return;
  }
  el.innerHTML = state.markets.map((m) => `
    <div class="market" data-open="${esc(m.id)}">
      <b>${esc(m.question)}</b>
      <div class="meta">${esc(m.status)} · ${m.status === "open" ? until(m.closes_at) : `pool ${fmtSats(m.total)}`}</div>
      ${poolBar(m.pools, m.total)}
    </div>`).join("");
}

async function open(id) {
  try {
    const r = await rpc("predictShow", { id });
    state.detail = r;
    renderDetail();
    $("detail").classList.remove("hidden");
    $("detail").scrollIntoView();
  } catch (err) {
    setStatus(`open failed [${err.code ?? ""}]: ${err.message}`);
  }
}

function renderDetail() {
  const { market: m, bets } = state.detail;
  $("detail-q").textContent = m.question;
  const rows = m.outcomes.map((o) =>
    `<div class="outcome"><span>${esc(o)}</span><span>${fmtSats(m.pools[o] ?? 0)} · ${pct(m.odds[o])}</span></div>`).join("");
  const verdict = m.winning_outcome
    ? `<p>verdict: <b>${esc(m.winning_outcome)}</b> (conf ${m.verdict_confidence ?? "?"})${m.dispute_by ? ` · disputed by ${esc(m.dispute_by)}` : ""}${m.settle_txid ? ` · settled <span class="mono">${esc(m.settle_txid.slice(0, 12))}…</span>` : ""}</p>`
    : "";
  const recent = (bets ?? []).slice(-5).reverse().map((b) =>
    `<div class="meta">${esc(b.origin)} · ${fmtSats(b.sats)} on ${esc(b.outcome)} · ${ago(b.created_at)}</div>`).join("");
  $("detail-body").innerHTML =
    `<div class="meta">${esc(m.id)} · ${esc(m.status)} · fee ${m.fee_bps / 100}% · closes ${new Date(m.closes_at).toLocaleString()}</div>` +
    `<div class="meta">rule: ${esc(m.evidence)}</div>` +
    poolBar(m.pools, m.total) + rows + verdict +
    `<div class="actions">
      ${m.status === "open" ? `
        <label>Outcome <select id="b-outcome">${m.outcomes.map((o) => `<option>${esc(o)}</option>`).join("")}</select></label>
        <label>Sats <input id="b-sats" type="number" min="1000" placeholder="2000" /></label>
        <button id="bet-btn" type="button">Bet (policy-gated)</button>
        <button id="cancel-btn" type="button">Cancel market</button>` : ""}
      ${m.status === "locked" ? `<button id="resolve-btn" type="button">Resolve (Jev grades evidence)</button>` : ""}
      ${m.status === "resolving" ? `<button id="settle-btn" type="button">Settle (after dispute window)</button>` : ""}
    </div>
    <div id="detail-out"></div>
    <h3>Recent bets</h3>${recent || `<p class="hint">none yet.</p>`}`;
  const out = (html) => { $("detail-out").innerHTML = html; };
  const betBtn = $("bet-btn");
  if (betBtn) {
    betBtn.addEventListener("click", async () => {
      const outcome = $("b-outcome").value;
      const sats = Math.floor(Number($("b-sats").value) || 0);
      try {
        const r = await rpc("predictBet", { id: m.id, outcome, sats });
        out(`<div class="notice ok">bet recorded: ${fmtSats(sats)} on ${esc(outcome)} (tx <span class="mono">${esc((r.bet?.txid ?? "").slice(0, 12))}…</span>, fee ${fmtSats(r.fee)})</div>`);
        await refresh();
        await open(m.id);
      } catch (err) {
        out(`<div class="notice bad">[${esc(err.code ?? "")}] ${esc(err.message)}</div>`);
      }
    });
  }
  const cancelBtn = $("cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async () => {
      try {
        await rpc("predictCancel", { id: m.id });
        out(`<div class="notice ok">cancelled — run Settle for full refunds.</div>`);
        await refresh();
        await open(m.id);
      } catch (err) {
        out(`<div class="notice bad">[${esc(err.code ?? "")}] ${esc(err.message)}</div>`);
      }
    });
  }
  const resolveBtn = $("resolve-btn");
  if (resolveBtn) {
    resolveBtn.addEventListener("click", async () => {
      out(`<p class="hint">grading evidence…</p>`);
      try {
        const r = await rpc("predictResolve", { id: m.id });
        out(r.market?.status === "void"
          ? `<div class="notice ok">voided (below confidence) — run Settle for refunds.</div>`
          : `<div class="notice ok">verdict: <b>${esc(r.verdict)}</b> (conf ${r.confidence}). Dispute window open — then Settle.</div>`);
        await refresh();
        await open(m.id);
      } catch (err) {
        out(`<div class="notice bad">[${esc(err.code ?? "")}] ${esc(err.message)}</div>`);
      }
    });
  }
  const settleBtn = $("settle-btn");
  if (settleBtn) {
    settleBtn.addEventListener("click", async () => {
      out(`<p class="hint">settling…</p>`);
      try {
        const r = await rpc("predictSettle", { id: m.id });
        out(`<div class="notice ok">settled${r.txid ? ` (tx <span class="mono">${esc(r.txid.slice(0, 12))}…</span>)` : ""}.</div>`);
        await refresh();
        await open(m.id);
      } catch (err) {
        out(`<div class="notice bad">[${esc(err.code ?? "")}] ${esc(err.message)}</div>`);
      }
    });
  }
  // Dispute form lives under the verdict whenever one exists and unpaid.
  if (m.winning_outcome && (m.status === "resolving" || m.status === "disputed") && !m.settle_txid && !m.dispute_by) {
    const d = document.createElement("div");
    d.className = "actions";
    d.innerHTML = `<label>Dispute: winner should be
      <select id="d-outcome">${m.outcomes.filter((o) => o !== m.winning_outcome).map((o) => `<option>${esc(o)}</option>`).join("")}</select></label>
      <label>Evidence <input id="d-why" type="text" maxlength="500" placeholder="why the verdict is wrong" /></label>
      <button id="dispute-btn" type="button">Dispute (one round)</button>`;
    $("detail-body").appendChild(d);
    $("dispute-btn").addEventListener("click", async () => {
      try {
        await rpc("predictDispute", { id: m.id, outcome: $("d-outcome").value, why: $("d-why").value });
        out(`<div class="notice ok">disputed — settle re-grades with your evidence.</div>`);
        await refresh();
        await open(m.id);
      } catch (err) {
        out(`<div class="notice bad">[${esc(err.code ?? "")}] ${esc(err.message)}</div>`);
      }
    });
  }
}

$("market-list").addEventListener("click", (e) => {
  const el = e.target.closest("[data-open]");
  if (el) void open(el.dataset.open);
});
$("back-btn").addEventListener("click", () => {
  $("detail").classList.add("hidden");
  state.detail = null;
});
$("refresh-btn").addEventListener("click", () => void refresh());
$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const box = $("create-out");
  try {
    const r = await rpc("predictCreate", {
      question: $("c-q").value.trim(),
      outcomes: $("c-outcomes").value.split(",").map((s) => s.trim()).filter(Boolean),
      closesIn: $("c-closes").value.trim(),
      evidence: $("c-evidence").value.trim(),
    });
    box.innerHTML = `<div class="notice ok">market <b>${esc(r.market?.id)}</b> open.</div>`;
    await refresh();
  } catch (err) {
    box.innerHTML = `<div class="notice bad">[${esc(err.code ?? "")}] ${esc(err.message)}</div>`;
  }
});
$("pos-btn").addEventListener("click", async () => {
  const box = $("pos-out");
  const origin = $("pos-origin").value.trim();
  if (!origin) {
    box.innerHTML = `<div class="notice bad">origin required.</div>`;
    return;
  }
  try {
    const r = await rpc("predictPositions", { origin });
    const ps = r?.positions ?? [];
    box.innerHTML = ps.length ? ps.map((p) =>
      `<div class="market"><b>${esc(p.market.question)}</b><div class="meta">${esc(p.market.status)} · staked ${fmtSats(p.staked)} · ${Object.entries(p.on).map(([o, s]) => `${esc(o)} ${fmtSats(s)}`).join(" · ")}</div></div>`).join("")
      : `<p class="hint">no positions for ${esc(origin)}.</p>`;
  } catch (err) {
    box.innerHTML = `<div class="notice bad">[${esc(err.code ?? "")}] ${esc(err.message)}</div>`;
  }
});

void refresh();
