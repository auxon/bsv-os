// Atomic Market: browse the generic order book, buy atomically through OS
// custody, list your own ordinals and BSV21 tokens. Reads are keyless;
// every spend is policy-gated by the daemon under origin "market".

const MARKET_WORKER = "https://entangleit.com/atomic-market";

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

const state = { kind: "", listings: [], address: "", view: "browse" };

function fmtSats(n) {
  return `${Math.floor(Number(n) || 0).toLocaleString()} sats`;
}

function short(s, n = 14) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function parseOutpoint(op) {
  const m = /^([0-9a-fA-F]{64})[._](\d+)$/.exec(String(op ?? "").trim());
  return m ? { txid: m[1].toLowerCase(), vout: Number(m[2]) } : null;
}

async function marketFetch(path, body) {
  const res = await fetch(`${MARKET_WORKER}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `market ${res.status}`);
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

function setStatus(el, text, cls = "status") {
  el.className = cls;
  el.textContent = text;
}

// ── Browse ──────────────────────────────────────────────────────────

function listingCard(l) {
  const card = document.createElement("div");
  card.className = "card";
  if (l.image) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.loading = "lazy";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = l.image;
    img.onerror = () => img.remove();
    card.append(img);
  }
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = l.title || "untitled";
  const meta = document.createElement("div");
  meta.className = "meta";
  const kind = document.createElement("span");
  kind.className = `badge${l.assetKind === "bsv21" ? " token" : ""}`;
  kind.textContent = l.assetKind === "bsv21" ? "token" : "ordinal";
  const seller = document.createElement("span");
  seller.textContent = `seller ${short(l.seller, 10)}`;
  meta.append(kind, seller);
  const price = document.createElement("div");
  price.className = "price";
  price.textContent = fmtSats(l.priceSats);
  card.append(title, meta, price);

  const row = document.createElement("div");
  row.className = "row";
  const status = document.createElement("div");
  status.className = "status";

  if (l.status === "active") {
    const buy = document.createElement("button");
    buy.type = "button";
    buy.className = "chip";
    buy.textContent = l.sellerUnlock ? "Buy (atomic)" : "Buy (direct)";
    buy.addEventListener("click", () => buyListing(l, row, status));
    row.append(buy);
  } else {
    const st = document.createElement("span");
    st.className = "dim";
    st.textContent = l.status;
    row.append(st);
  }
  if (state.address && l.seller === state.address && l.status === "active") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "chip";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      try {
        await marketFetch("/v1/market/cancel", { origin: l.origin, seller: state.address });
        await loadListings();
      } catch (e) {
        cancel.disabled = false;
        setStatus(status, e.message || String(e), "status warn");
      }
    });
    row.append(cancel);
  }
  card.append(row, status);
  return card;
}

async function loadListings() {
  const meta = $("market-meta");
  setStatus(meta, "loading…");
  try {
    const q = state.kind ? `?kind=${state.kind}` : "";
    const { listings } = await marketFetch(`/v1/market${q}`);
    state.listings = listings ?? [];
    const grid = $("grid");
    grid.textContent = "";
    if (!state.listings.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No listings right now. Be the first — check the Sell tab.";
      grid.append(empty);
    }
    for (const l of state.listings) grid.append(listingCard(l));
    setStatus(meta, `${state.listings.length} listing${state.listings.length === 1 ? "" : "s"}`);
  } catch (e) {
    setStatus(meta, `market unreachable: ${e.message || e}`, "status warn");
  }
}

// ── Buy ─────────────────────────────────────────────────────────────

function offerFromListing(l) {
  const parts = parseOutpoint(l.origin);
  if (!parts || !l.sellerUnlock || !l.payScript || !l.inputScript) return null;
  return {
    input: { txid: parts.txid, vout: parts.vout, scriptHex: l.inputScript, sequence: 4294967295 },
    unlockHex: l.sellerUnlock,
    payScriptHex: l.payScript,
    priceSats: l.priceSats,
    version: l.assetKind === "bsv21" ? 3 : 2,
    lockTime: 0,
    ...(l.assetKind === "bsv21" ? { kind: "bsv21", tokenId: l.tokenId, tokenAmount: l.tokenAmount } : {}),
  };
}

function feeSatsFor(l) {
  const bps = Math.floor(Number(l.feeBps) || 0);
  if (bps <= 0) return 0;
  return Math.max(1, Math.floor((l.priceSats * bps) / 10000));
}

async function buyListing(listing, row, status) {
  row.textContent = "";
  const atomic = !!(listing.sellerUnlock && listing.payScript && listing.inputScript);
  setStatus(status, atomic
    ? `Atomic: ${fmtSats(listing.priceSats)} → seller. Payment + asset settle in one tx.`
    : `Direct: ${fmtSats(listing.priceSats)} → ${short(listing.seller, 12)}. Pay first — delivery by the seller.`);
  const go = document.createElement("button");
  go.type = "button";
  go.className = "chip";
  go.textContent = "Confirm";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "chip";
  no.textContent = "Cancel";
  no.addEventListener("click", () => loadListings());
  go.addEventListener("click", async () => {
    go.disabled = true;
    no.disabled = true;
    setStatus(status, "broadcasting…");
    try {
      // Fresh listing: offer fields can change between render and click.
      const { listing: fresh } = await marketFetch(`/v1/market/listing/${encodeURIComponent(listing.origin)}`);
      if (!fresh || fresh.status !== "active") throw new Error(`listing is ${fresh ? fresh.status : "gone"}`);
      const offer = offerFromListing(fresh);
      const fee = feeSatsFor(fresh);
      const res = await rpc("marketBuy", {
        outpoint: fresh.origin,
        priceSats: fresh.priceSats,
        sellerAddress: fresh.seller,
        ...(offer ? { offer } : {}),
        ...(fee > 0 ? { fee: { to: fresh.feeAddress, sats: fee } } : {}),
      });
      await marketFetch("/v1/market/buy", {
        origin: fresh.origin,
        buyTxid: res.txid,
        ...(state.address ? { buyerHandle: short(state.address, 24) } : {}),
      });
      if (res.atomic) {
        // The swap tx itself moved the asset: settle immediately.
        await marketFetch("/v1/market/settle", { origin: fresh.origin, transferTxid: res.txid }).catch(() => {});
      }
      setStatus(status, `bought · ${String(res.txid).slice(0, 12)}…${res.atomic ? " (atomic)" : ""}`, "status ok");
      setTimeout(loadListings, 1500);
    } catch (e) {
      setStatus(status, e && e.code === "POLICY_DENY"
        ? "needs approval first — run: bsv allow market (then retry)"
        : (e.message || String(e)), "status warn");
      go.disabled = false;
      no.disabled = false;
    }
  });
  row.append(go, no);
}

// ── Sell ────────────────────────────────────────────────────────────

function sellCard({ title, subtitle, outpoint, assetKind, tokenId, tokenAmount, image }) {
  const card = document.createElement("div");
  card.className = "card";
  if (image) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.loading = "lazy";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = image;
    img.onerror = () => img.remove();
    card.append(img);
  }
  const t = document.createElement("div");
  t.className = "title";
  t.textContent = title;
  const sub = document.createElement("div");
  sub.className = "meta";
  sub.textContent = subtitle;
  const row = document.createElement("div");
  row.className = "row";
  const price = document.createElement("input");
  price.placeholder = "price sats";
  price.inputMode = "numeric";
  const list = document.createElement("button");
  list.type = "button";
  list.className = "chip";
  list.textContent = "List";
  const status = document.createElement("div");
  status.className = "status";
  list.addEventListener("click", async () => {
    const priceSats = Math.floor(Number(price.value));
    if (!(priceSats >= 1)) {
      setStatus(status, "price must be ≥ 1 sat", "status warn");
      return;
    }
    list.disabled = true;
    setStatus(status, "signing offer…");
    try {
      const offer = await rpc("marketList", {
        outpoint,
        priceSats,
        ...(assetKind === "bsv21" ? { kind: "bsv21", tokenId, tokenAmount } : {}),
      });
      setStatus(status, "posting listing…");
      await marketFetch("/v1/market/list", {
        origin: outpoint.replace("_", "."),
        assetKind,
        title,
        ...(image ? { image } : {}),
        priceSats,
        seller: state.address,
        sellerUnlock: offer.unlockHex,
        payScript: offer.payScriptHex,
        ...(assetKind === "bsv21" ? { tokenId, tokenAmount } : {}),
        feeBps: 0,
        feeAddress: state.address,
        metadata: { source: "market-app" },
      });
      setStatus(status, `listed · ${outpoint}`, "status ok");
    } catch (e) {
      setStatus(status, e && e.code === "POLICY_DENY"
        ? "needs approval first — run: bsv allow market (then retry)"
        : (e.message || String(e)), "status warn");
      list.disabled = false;
    }
  });
  row.append(price, list);
  card.append(t, sub, row, status);
  return card;
}

async function loadHoldings() {
  const status = $("sell-status");
  setStatus(status, "loading holdings…");
  try {
    const ords = await rpc("ordList", {});
    const ordList = $("ord-list");
    ordList.textContent = "";
    const rows = ords.ordinals ?? [];
    $("ord-empty").classList.toggle("hidden", rows.length > 0);
    for (const o of rows) {
      ordList.append(sellCard({
        title: o.contentType || "inscription",
        subtitle: short(o.outpoint, 22),
        outpoint: o.outpoint,
        assetKind: "ordinal",
        image: typeof o.contentType === "string" && o.contentType.startsWith("image/") ? o.contentUrl : null,
      }));
    }
    const toks = await rpc("bsv21List", {});
    const tokList = $("tok-list");
    tokList.textContent = "";
    const positions = toks.tokens ?? [];
    $("tok-empty").classList.toggle("hidden", positions.length > 0);
    for (const p of positions) {
      // Exact-UTXO listing: fetch this token's UTXOs and list each piece.
      const { utxos } = await rpc("bsv21Utxos", { tokenId: p.tokenId });
      for (const u of utxos ?? []) {
        tokList.append(sellCard({
          title: `${p.symbol} · ${u.amount}`,
          subtitle: `${short(p.tokenId, 16)} · ${short(u.outpoint, 18)}`,
          outpoint: u.outpoint,
          assetKind: "bsv21",
          tokenId: p.tokenId,
          tokenAmount: u.amount,
          image: p.icon,
        }));
      }
    }
    setStatus(status, "");
  } catch (e) {
    setStatus(status, e && e.code === "POLICY_DENY"
      ? "needs approval first — run: bsv allow market (then retry)"
      : (e.message || String(e)), "status warn");
  }
}

// ── Boot ────────────────────────────────────────────────────────────

function setTab(next) {
  state.view = next;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === next);
  $("browse-view").classList.toggle("hidden", next !== "browse");
  $("sell-view").classList.toggle("hidden", next !== "sell");
  if (next === "browse") loadListings();
  else loadHoldings();
}

for (const b of document.querySelectorAll(".tab")) {
  b.addEventListener("click", () => setTab(b.dataset.tab));
}
for (const b of document.querySelectorAll(".filters .chip[data-kind]")) {
  b.addEventListener("click", () => {
    state.kind = b.dataset.kind;
    for (const c of document.querySelectorAll(".filters .chip[data-kind]")) c.classList.toggle("active", c === b);
    loadListings();
  });
}
$("refresh").addEventListener("click", () => {
  if (state.view === "browse") loadListings();
  else loadHoldings();
});

(async () => {
  try {
    const bal = await rpc("balance", {});
    state.address = bal?.address ?? "";
    $("wallet-line").textContent = state.address ? `wallet ${short(state.address, 16)}` : "wallet locked";
  } catch {
    $("wallet-line").textContent = "wallet locked";
  }
  loadListings();
})();
