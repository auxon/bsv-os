/**
 * Ordinal Colosseum — runner app controller.
 *
 * Reads the machine's 1Sat ordinals through the local wallet daemon (same
 * origin JSON-RPC: ordList), turns each one into a fighter with logic.js, and
 * runs deterministic battles. Champion medals are minted through the bsvOS
 * runner bridge (window.bsv.inscribe), so every spend still passes the
 * daemon's policy and approval flow.
 */
"use strict";

import {
  advanceFloor,
  applyBoon,
  boonChoices,
  championMedal,
  createRun,
  deriveFighter,
  enemyForFloor,
  MAX_FLOOR,
  newBattle,
  takeTurn,
} from "./logic.js";

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STORE = {
  address: "colosseum.address",
  scouts: "colosseum.scouts.v1",
  records: "colosseum.records.v1",
  medals: "colosseum.medals.v1",
};

const GLYPH = { image: "🖼️", video: "🎬", audio: "🎵", text: "📜", data: "🧬", other: "🪨" };
const CLASS_LABEL = { image: "Image", video: "Video", audio: "Audio", text: "Text", data: "Data", other: "Artifact" };

const state = {
  fighters: new Map(),
  ordinalsLoaded: false,
  wallet: { address: null, locked: null, error: null },
  run: null,
  battle: null,
  busy: false,
};

// ── storage ────────────────────────────────────────────────────────────────

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

// ── wallet ─────────────────────────────────────────────────────────────────

let rpcId = 1;
async function rpc(method, params = {}) {
  const res = await fetch("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params, id: rpcId++ }),
  });
  if (!res.ok) throw new Error(`wallet RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || body.error.code);
  return body.result;
}

function setWalletChip() {
  const chip = $("#wallet-chip");
  const { address, locked, error } = state.wallet;
  chip.classList.remove("ok", "warn");
  if (error) {
    chip.textContent = "wallet daemon unreachable — scout mode only";
    chip.classList.add("warn");
    return;
  }
  if (!address) {
    chip.textContent = locked ? "wallet locked — `bsv unlock` to load ordinals" : "no wallet address yet";
    chip.classList.add("warn");
    return;
  }
  chip.textContent = `${address.slice(0, 10)}…${address.slice(-6)}${locked ? " · locked (cached address)" : ""}`;
  chip.classList.add("ok");
}

async function refreshWallet() {
  state.wallet.error = null;
  try {
    const balance = await rpc("balance");
    if (balance?.address) {
      state.wallet.address = balance.address;
      state.wallet.locked = false;
      save(STORE.address, balance.address);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    state.wallet.locked = /locked/i.test(message);
    state.wallet.address = state.wallet.address ?? load(STORE.address, null);
    if (!state.wallet.address && !state.wallet.locked) state.wallet.error = message;
  }
  setWalletChip();
}

async function loadOrdinals() {
  const note = $("#roster-note");
  note.textContent = "loading ordinals…";
  await refreshWallet();
  if (!state.wallet.address) {
    note.textContent = state.wallet.locked
      ? "wallet locked: run `bsv unlock`, then Refresh — or scout a fighter to play now."
      : "no wallet address: unlock the wallet and Refresh — or scout a fighter.";
    return;
  }
  try {
    const { ordinals } = await rpc("ordList", { address: state.wallet.address });
    let added = 0;
    for (const o of ordinals ?? []) {
      const fighter = deriveFighter({
        origin: o.origin || `${o.txid}_${o.vout}`,
        contentType: o.contentType,
        contentLength: o.contentLength,
        sequence: o.sequence,
      });
      if (!state.fighters.has(fighter.id)) added += 1;
      state.fighters.set(fighter.id, {
        ...fighter,
        source: "wallet",
        preview: o.contentUrl ?? null,
        outpoint: o.outpoint ?? `${o.txid}_${o.vout}`,
      });
    }
    state.ordinalsLoaded = true;
    note.textContent = `${ordinals?.length ?? 0} ordinals on chain · ${state.fighters.size} fighters in the roster (${added} new)`;
  } catch (e) {
    note.textContent = `ordinal lookup failed: ${e instanceof Error ? e.message : e}`;
  }
}

// ── roster ─────────────────────────────────────────────────────────────────

function previewHtml(fighter) {
  const url = fighter.preview;
  if (url && fighter.klass === "image") return `<img loading="lazy" src="${esc(url)}" alt="">`;
  if (url && fighter.klass === "video") return `<video muted loop playsinline autoplay src="${esc(url)}"></video>`;
  return `<span class="glyph">${GLYPH[fighter.klass] ?? GLYPH.other}</span>`;
}

function fighterCard(fighter) {
  return `<article class="card">
    <div class="preview">${previewHtml(fighter)}
      <span class="class-tag">${CLASS_LABEL[fighter.klass] ?? fighter.klass}${fighter.source === "scout" ? " · scout" : ""}</span>
    </div>
    <div class="body">
      <div class="row"><h3>${esc(fighter.name)}</h3><span class="badge ${fighter.rarity}">${esc(fighter.rarityLabel)}</span></div>
      <div class="sub">${esc(fighter.origin.slice(0, 42))}${fighter.origin.length > 42 ? "…" : ""}</div>
      <div class="stats">
        <span>HP <b>${fighter.stats.hp}</b></span>
        <span>ATK <b>${fighter.stats.atk}</b></span>
        <span>DEF <b>${fighter.stats.def}</b></span>
        <span>SPD <b>${fighter.stats.spd}</b></span>
        <span>LUCK <b>${fighter.stats.luck}</b></span>
        <span>PWR <b>${fighter.total}</b></span>
      </div>
      <div class="sub">${esc(fighter.ability.name)} — ${esc(fighter.ability.desc)}</div>
      <div class="row">
        <button class="btn primary" data-fight="${fighter.id}">Enter the Colosseum</button>
      </div>
    </div>
  </article>`;
}

function renderRoster() {
  const fighters = [...state.fighters.values()].sort((a, b) => b.total - a.total);
  $("#roster").innerHTML = fighters.length
    ? fighters.map(fighterCard).join("")
    : `<p class="dim">No fighters yet. Unlock the wallet and Refresh to load your ordinals, or scout one.</p>`;
}

function scout() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const seed = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const scouts = load(STORE.scouts, []);
  scouts.push(seed);
  save(STORE.scouts, scouts);
  const fighter = deriveFighter({ origin: `scout:${seed}`, contentType: "image/svg+xml", contentLength: 1024 });
  state.fighters.set(fighter.id, { ...fighter, source: "scout", preview: null });
  renderRoster();
}

function loadScouts() {
  for (const seed of load(STORE.scouts, [])) {
    const fighter = deriveFighter({ origin: `scout:${seed}`, contentType: "image/svg+xml", contentLength: 1024 });
    state.fighters.set(fighter.id, { ...fighter, source: "scout", preview: null });
  }
}

// ── battle ─────────────────────────────────────────────────────────────────

function hpBar(c) {
  const pct = Math.max(0, Math.round((c.hp / c.maxHp) * 100));
  return `<div class="hpbar"><div style="width:${pct}%"></div></div>`;
}

function pips(n) {
  return `<span class="pips">${[1, 2, 3].map((i) => `<span class="pip ${i <= n ? "on" : ""}"></span>`).join("")}</span>`;
}

function combatantPanel(c, side) {
  return `<div class="combatant ${side}">
    <h2>${esc(c.name)}</h2>
    <div class="meta">
      <span class="badge ${c.rarity}">${esc(c.rarityLabel)}</span>
      <span>ATK ${c.stats.atk} · DEF ${c.stats.def} · SPD ${c.stats.spd}</span>
    </div>
    ${hpBar(c)}
    <div class="meta"><span>${c.hp}/${c.maxHp} HP</span> · <span>focus</span> ${pips(c.focus)} <span>· ${esc(c.ability.name)}${c.cd > 0 ? ` (cd ${c.cd})` : ""}</span></div>
  </div>`;
}

function moveButton(id, label, hint, battle) {
  const ready = id === "ability" && battle.player.cd === 0;
  const disabled = battle.over ? "disabled" : "";
  return `<button class="move ${ready ? "ready" : ""}" data-move="${id}" ${disabled}><b>${label}</b><span>${hint}</span></button>`;
}

function logHtml(events) {
  return events
    .slice(-60)
    .map((e) => `<p class="${e.side}"><b>${esc(e.side)}</b> · ${esc(e.text)}</p>`)
    .join("");
}

function renderBattle() {
  const { run, battle } = state;
  if (!run || !battle) return;
  const view = $("#view-battle");
  const over = battle.over;
  const header = over
    ? over.winner === "player"
      ? `<div class="banner win">Floor ${run.floor} cleared — ${esc(battle.enemy.name)} is down. HP ${battle.player.hp}/${battle.player.maxHp}.</div>`
      : `<div class="banner lose">You fell on floor ${run.floor}. The gauntlet ends here.</div>`
    : `<div class="banner">Floor ${run.floor} of ${MAX_FLOOR} · turn ${battle.turn} · run seed <code>${esc(run.seed.slice(0, 12))}</code>${run.boons.length ? ` · boons: ${run.boons.map(esc).join(", ")}` : ""}</div>`;

  view.innerHTML = `
    ${header}
    <div class="arena">
      ${combatantPanel(battle.player, "player")}
      <div class="vs">VS</div>
      ${combatantPanel(battle.enemy, "enemy")}
    </div>
    <div class="moves">
      ${moveButton("strike", "Strike", "ATK ×2 vs DEF, crits with luck and focus", battle)}
      ${moveButton("guard", "Guard", "Halve the next hit, +1 focus", battle)}
      ${moveButton("focus", "Focus", "+2 focus (spend for crits)", battle)}
      ${moveButton("ability", battle.player.ability.name, battle.player.ability.desc, battle)}
    </div>
    <div class="log">${logHtml(battle.log)}</div>
    <div class="actions" style="margin-top:12px"><button class="btn" id="abandon">Abandon run</button></div>`;

  const log = view.querySelector(".log");
  log.scrollTop = log.scrollHeight;
}

function recordRun(result) {
  const run = state.run;
  if (!run) return;
  const records = load(STORE.records, []);
  const existing = records.find((r) => r.origin === run.fighter.origin);
  const entry = {
    origin: run.fighter.origin,
    name: run.fighter.name,
    bestFloor: Math.max(run.floor, existing?.bestFloor ?? 0),
    champion: Boolean(existing?.champion || result === "champion"),
    at: new Date().toISOString(),
    seed: run.seed,
  };
  save(STORE.records, [existing ? records.map((r) => (r.origin === entry.origin ? entry : r)) : [...records, entry]]);
}

function startRun(fighter) {
  const seedBytes = crypto.getRandomValues(new Uint8Array(16));
  const seed = [...seedBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  state.run = createRun(fighter, seed);
  state.battle = newBattle(state.run.fighter, enemyForFloor(state.run), `${seed}:f1`);
  showView("battle");
  renderBattle();
}

function playerMove(move) {
  if (!state.battle || state.battle.over || state.busy) return;
  state.busy = true;
  const { battle } = takeTurn(state.battle, move);
  state.battle = battle;
  state.busy = false;
  if (!battle.over) {
    renderBattle();
    return;
  }
  if (battle.over.winner === "enemy") {
    recordRun("defeat");
    renderBattle();
    return;
  }
  if (state.run.floor < MAX_FLOOR) {
    renderBoons();
  } else {
    state.run = advanceFloor(state.run, battle.player.hp);
    recordRun("champion");
    renderBattle();
    renderChampion();
  }
}

function renderBoons() {
  const choices = boonChoices(state.run.seed, state.run.floor);
  const modal = $("#modal");
  modal.classList.remove("hidden");
  modal.innerHTML = `<div class="box">
    <h2>Floor ${state.run.floor} cleared</h2>
    <p class="dim">Choose a boon before descending. HP carries over.</p>
    <div class="boons">
      ${choices.map((b) => `<button class="boon" data-boon="${b.id}"><b>${esc(b.label)}</b><span>${esc(b.desc)}</span></button>`).join("")}
    </div>
  </div>`;
}

function pickBoon(id) {
  state.run = applyBoon(state.run, id);
  state.run = advanceFloor(state.run, state.battle.player.hp);
  state.battle = newBattle(state.run.fighter, enemyForFloor(state.run), `${state.run.seed}:f${state.run.floor}`);
  $("#modal").classList.add("hidden");
  renderBattle();
}

function renderChampion() {
  const run = state.run;
  const medal = championMedal(run);
  const modal = $("#modal");
  modal.classList.remove("hidden");
  modal.innerHTML = `<div class="box">
    <h2>🏆 Champion of the Colosseum</h2>
    <p><b>${esc(run.fighter.name)}</b> cleared all ${MAX_FLOOR} floors.</p>
    <pre>${esc(JSON.stringify(medal, null, 2))}</pre>
    <p class="dim">Minting is optional: it inscribes this JSON as a 1-sat ordinal from your wallet (policy approval + miner fee apply).</p>
    <div class="actions">
      <button class="btn" id="close-medal">Not now</button>
      <button class="btn gold" id="mint-medal">Mint champion medal</button>
    </div>
  </div>`;
  $("#close-medal").addEventListener("click", () => modal.classList.add("hidden"));
  $("#mint-medal").addEventListener("click", () => mintMedal(medal));
}

async function mintMedal(medal) {
  const box = $("#modal .box");
  const button = $("#mint-medal");
  if (button) button.disabled = true;
  const status = document.createElement("p");
  status.className = "dim";
  status.textContent = "asking the wallet…";
  box.appendChild(status);
  try {
    if (!window.bsv?.isBSVOS) {
      throw new Error("the wallet bridge is only available inside the bsvOS runner — open this app with `bsv app open localhost`");
    }
    const bytes = new TextEncoder().encode(JSON.stringify(medal));
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const result = await window.bsv.inscribe(hex, "application/json", undefined, undefined, `Colosseum champion: ${medal.fighter_name}`, "colosseum-medal");
    const medals = load(STORE.medals, []);
    medals.push({ txid: result.txid, at: new Date().toISOString(), fighter: medal.fighter_name, origin: medal.fighter });
    save(STORE.medals, medals);
    status.innerHTML = `Minted: <a href="https://whatsonchain.com/tx/${esc(result.txid)}" target="_blank" rel="noopener">${esc(result.txid)}</a> (fee ${esc(result.fee)} sats)`;
  } catch (e) {
    status.textContent = `Mint failed: ${e instanceof Error ? e.message : e}`;
  }
}

// ── hall of fame / about ───────────────────────────────────────────────────

function renderFame() {
  const records = load(STORE.records, []).sort((a, b) => b.bestFloor - a.bestFloor);
  const medals = load(STORE.medals, []);
  $("#view-fame").innerHTML = `
    <h2>Hall of Fame</h2>
    ${records.length
      ? `<table><thead><tr><th>Fighter</th><th>Best floor</th><th>Champion</th><th>When</th></tr></thead><tbody>
          ${records.map((r) => `<tr><td>${esc(r.name)}<div class="sub">${esc(r.origin.slice(0, 30))}…</div></td><td>${r.bestFloor}/${MAX_FLOOR}</td><td>${r.champion ? "🏆" : "—"}</td><td>${esc(r.at.slice(0, 16).replace("T", " "))}</td></tr>`).join("")}
        </tbody></table>`
      : `<p class="dim">No runs recorded yet. Fight something.</p>`}
    <h2 style="margin-top:24px">Champion medals</h2>
    ${medals.length
      ? `<table><thead><tr><th>Fighter</th><th>Txid</th><th>When</th></tr></thead><tbody>
          ${medals.map((m) => `<tr><td>${esc(m.fighter)}</td><td><a href="https://whatsonchain.com/tx/${esc(m.txid)}" target="_blank" rel="noopener">${esc(m.txid.slice(0, 20))}…</a></td><td>${esc(m.at.slice(0, 16).replace("T", " "))}</td></tr>`).join("")}
        </tbody></table>`
      : `<p class="dim">No medals minted yet.</p>`}`;
}

function renderAbout() {
  const sample = deriveFighter({ origin: "faf4daa0cbee35e603db9438e09f3c7d7cc458e3817efb9d4b3ea739ac0a1687_0", contentType: "image/png", contentLength: 42000 });
  $("#view-about").innerHTML = `
    <h2>How it works</h2>
    <p>Every ordinal you own becomes a fighter. The stats are not random and not stored anywhere — they are derived from the inscription's on-chain identity:</p>
    <pre>seed  = sha256(origin | contentType | contentLength | sequence)
HP    = 60 + byte0 % 41        ATK = 8 + byte1 % 13
DEF   = 3  + byte2 % 9         SPD = 5 + byte3 % 11
LUCK  = byte4 % 7              name/ability from later bytes</pre>
    <p><code>origin</code> is the inscription's origin outpoint, so the same ordinal always produces the same fighter, and anyone can re-derive it with a SHA-256 tool. Here is a live example:</p>
    <pre>${esc(JSON.stringify({ origin: sample.origin, seed: sample.seedHex, name: sample.name, rarity: sample.rarity, stats: sample.stats, ability: sample.ability.name }, null, 2))}</pre>
    <h3>Battles</h3>
    <p>Battles are turn-based and deterministic: the RNG is a hash chain seeded by the run seed, so the same fighter, seed, and moves always replay the same fight. Strike, guard (halve the next hit, build focus), focus (crit fuel), or use your class ability. Win a floor, pick a boon, descend seven floors.</p>
    <h3>The chain part</h3>
    <p>Reading ordinals is a local wallet call (<code>ordList</code>). Clearing the gauntlet offers an optional <b>champion medal</b>: a 1-sat inscription with the run's metadata, minted through the bsvOS runner bridge under your app policy (you approve every spend). Nothing else is written to the chain — no fees to play.</p>
    <h3>Scouts</h3>
    <p>No ordinals yet? Scout a fighter: a locally generated seed that behaves exactly like an on-chain one. When your collection grows, it joins the roster.</p>`;
}

// ── views / wiring ─────────────────────────────────────────────────────────

function showView(name) {
  for (const section of document.querySelectorAll(".view")) section.classList.remove("active");
  $(`#view-${name}`)?.classList.add("active");
  for (const button of document.querySelectorAll("nav button")) button.classList.toggle("active", button.dataset.view === name);
  if (name === "roster") renderRoster();
  if (name === "fame") renderFame();
  if (name === "about") renderAbout();
  if (name === "battle") renderBattle();
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("button, a");
  if (!target) return;
  if (target.dataset.view) showView(target.dataset.view);
  if (target.id === "refresh") loadOrdinals().then(renderRoster);
  if (target.id === "scout") scout();
  if (target.id === "abandon") {
    recordRun("abandon");
    showView("roster");
  }
  if (target.dataset.fight) {
    const fighter = state.fighters.get(target.dataset.fight);
    if (fighter) startRun(fighter);
  }
  if (target.dataset.move) playerMove(target.dataset.move);
  if (target.dataset.boon) pickBoon(target.dataset.boon);
});

loadScouts();
renderRoster();
loadOrdinals().then(renderRoster);
