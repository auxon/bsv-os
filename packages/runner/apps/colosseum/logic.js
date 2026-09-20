/**
 * Ordinal Colosseum — game logic (pure, deterministic, no DOM).
 *
 * Every fighter is derived from on-chain data: sha256(origin|contentType|
 * contentLength|sequence) seeds the stats, rarity, name, and ability. Anyone
 * can re-derive a fighter from the inscription's origin, and battles are
 * deterministic given the run seed and the moves you pick (the RNG is a hash
 * chain), so a run can be replayed and audited.
 *
 * The UI (app.js) owns rendering and wallet calls; this module owns the rules.
 */

export const MAX_FLOOR = 7;
export const VERSION = "1.0.0";

// ── sha256 (synchronous, so derivation is pure and testable) ───────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256 of a UTF-8 string, hex-encoded. */
export function sha256Hex(input) {
  const msg = new TextEncoder().encode(String(input));
  const len = msg.length;
  const padded = new Uint8Array((((len + 9) >> 6) + 1) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4);
    for (let j = 16; j < 64; j++) {
      const x = w[j - 15], y = w[j - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** First 4 bytes of sha256(`${seed}:${counter}`) as a float in [0, 1). */
function hashRand(seed, counter) {
  const hex = sha256Hex(`${seed}:${counter}`);
  return parseInt(hex.slice(0, 8), 16) / 0x100000000;
}

// ── fighters ───────────────────────────────────────────────────────────────

export const ABILITIES = {
  image: { id: "prism", name: "Prism Guard", desc: "Brace for 40% damage and mend 6 HP." },
  video: { id: "overclock", name: "Overclock", desc: "+50% speed for 3 turns." },
  audio: { id: "resonance", name: "Resonance", desc: "Strike and heal 25% of the damage dealt." },
  text: { id: "lore", name: "Lore Strike", desc: "Strike that halves enemy DEF and crits more often." },
  data: { id: "glitch", name: "Glitch", desc: "30% chance to stun the enemy instead of hitting." },
  other: { id: "scrap", name: "Scrap Plating", desc: "+3 DEF for the rest of the battle." },
};

export const RARITIES = [
  { id: "common", label: "Common", min: 0 },
  { id: "rare", label: "Rare", min: 120 },
  { id: "epic", label: "Epic", min: 142 },
  { id: "legendary", label: "Legendary", min: 162 },
];

const ADJECTIVES = [
  "Amber", "Bitter", "Cobalt", "Copper", "Crimson", "Dusty", "Ember", "Feral", "Frost", "Gilded",
  "Hollow", "Iron", "Jade", "Lunar", "Mossy", "Neon", "Onyx", "Pale", "Quartz", "Rust",
  "Silver", "Solar", "Thorned", "Violet",
];
const NOUNS = [
  "Aegis", "Basilisk", "Cinder", "Drifter", "Echo", "Fang", "Golem", "Harbinger", "Imp", "Jackal",
  "Kite", "Lantern", "Mirage", "Nomad", "Oracle", "Prowler", "Quill", "Revenant", "Sentinel", "Talon",
  "Urchin", "Vulture", "Warden", "Wyrm",
];

/** Which ability class a content type maps to. */
export function classForContentType(contentType) {
  const ct = String(contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("text/")) return "text";
  if (ct.includes("json") || ct.includes("application/")) return "data";
  return "other";
}

export function statTotal(stats) {
  return stats.hp + stats.atk * 2 + stats.def + stats.spd + stats.luck * 2;
}

export function rarityFor(total) {
  let out = RARITIES[0];
  for (const tier of RARITIES) if (total >= tier.min) out = tier;
  return out;
}

/**
 * Derive a fighter from on-chain identity. The same origin always produces the
 * same fighter; a different origin produces an unrelated one.
 */
export function deriveFighter(meta) {
  const origin = String(meta.origin ?? meta.outpoint ?? "").trim();
  if (!origin) throw new Error("deriveFighter needs an origin");
  const contentType = String(meta.contentType ?? "");
  const contentLength = Math.max(0, Math.floor(Number(meta.contentLength) || 0));
  const sequence = Math.max(0, Math.floor(Number(meta.sequence) || 0));
  const seedHex = sha256Hex(`${origin}|${contentType}|${contentLength}|${sequence}`);
  const b = (i) => parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);

  const stats = {
    hp: 60 + (b(0) % 41),
    atk: 8 + (b(1) % 13),
    def: 3 + (b(2) % 9),
    spd: 5 + (b(3) % 11),
    luck: b(4) % 7,
  };
  const klass = classForContentType(contentType);
  const total = statTotal(stats);
  return {
    id: seedHex.slice(0, 16),
    origin,
    contentType,
    contentLength,
    sequence,
    name: `${ADJECTIVES[b(5) % ADJECTIVES.length]} ${NOUNS[b(6) % NOUNS.length]}`,
    klass,
    ability: ABILITIES[klass],
    rarity: rarityFor(total).id,
    rarityLabel: rarityFor(total).label,
    stats,
    total,
    seedHex,
  };
}

// ── battles ────────────────────────────────────────────────────────────────

export const MOVES = ["strike", "guard", "focus", "ability"];

function combatant(fighter) {
  return {
    ...fighter,
    stats: { ...fighter.stats },
    maxHp: fighter.stats.hp,
    hp: fighter.stats.hp,
    focus: 0,
    cd: 0,
    guardMult: 1,
    spdTurns: 0,
    stunned: false,
  };
}

/** Start a battle between two derived fighters. Deterministic for a seed. */
export function newBattle(playerFighter, enemyFighter, seed) {
  return {
    seed: String(seed),
    turn: 0,
    rng: 0,
    player: combatant(playerFighter),
    enemy: combatant(enemyFighter),
    log: [],
    over: null,
  };
}

function cloneBattle(battle) {
  return JSON.parse(JSON.stringify(battle));
}

function rand(battle) {
  const value = hashRand(battle.seed, battle.rng);
  battle.rng += 1;
  return value;
}

function heal(actor, amount) {
  const before = actor.hp;
  actor.hp = Math.min(actor.maxHp, actor.hp + Math.round(amount));
  return actor.hp - before;
}

function strike(battle, attacker, defender, opts = {}) {
  const ignoreDef = opts.ignoreDef ?? 0;
  const critBonus = opts.critBonus ?? 0;
  let base = attacker.stats.atk * 2 - defender.stats.def * 0.8 * (1 - ignoreDef);
  base = Math.max(1, base);
  const variance = 0.85 + rand(battle) * 0.3;
  let damage = base * variance;
  const critChance = 0.08 + attacker.stats.luck * 0.02 + critBonus + (attacker.focus > 0 ? 0.25 : 0);
  const crit = rand(battle) < critChance;
  if (crit) {
    damage *= 1.75;
    if (attacker.focus > 0) attacker.focus -= 1;
  }
  const dodge = Math.max(0, Math.min(0.2, (defender.stats.spd - attacker.stats.spd) * 0.01));
  if (dodge > 0 && rand(battle) < dodge) {
    return { dodged: true, crit: false, damage: 0, healed: 0 };
  }
  damage = Math.max(1, Math.round(damage * defender.guardMult));
  defender.guardMult = 1;
  defender.hp = Math.max(0, defender.hp - damage);
  return { dodged: false, crit, damage, healed: 0 };
}

function useAbility(battle, actor, target) {
  actor.cd = 3;
  switch (actor.ability.id) {
    case "prism": {
      actor.guardMult = 0.4;
      const healed = heal(actor, 6);
      return { kind: "ability", move: "ability", text: `${actor.name} raises a Prism Guard (mends ${healed}).`, damage: 0, healed };
    }
    case "overclock":
      actor.spdTurns = 3;
      return { kind: "ability", move: "ability", text: `${actor.name} overclocks (+50% speed, 3 turns).`, damage: 0, healed: 0 };
    case "lore": {
      const hit = strike(battle, actor, target, { ignoreDef: 0.5, critBonus: 0.1 });
      return { kind: "ability", move: "ability", text: `${actor.name} recites a Lore Strike${hit.crit ? " — critical!" : ""}.`, ...hit };
    }
    case "resonance": {
      const hit = strike(battle, actor, target);
      const healed = hit.damage > 0 ? heal(actor, hit.damage * 0.25) : 0;
      return { kind: "ability", move: "ability", text: `${actor.name} resonates${hit.crit ? " — critical!" : ""}${healed ? ` (mends ${healed})` : ""}.`, ...hit, healed };
    }
    case "glitch": {
      if (rand(battle) < 0.3) {
        target.stunned = true;
        return { kind: "ability", move: "ability", text: `${actor.name} glitches — ${target.name} is stunned!`, damage: 0, healed: 0 };
      }
      const hit = strike(battle, actor, target);
      return { kind: "ability", move: "ability", text: `${actor.name} glitches${hit.crit ? " — critical!" : ""}.`, ...hit };
    }
    default: {
      actor.stats.def += 3;
      const hit = strike(battle, actor, target);
      return { kind: "ability", move: "ability", text: `${actor.name} plates up (+3 DEF)${hit.crit ? " — critical!" : ""}.`, ...hit };
    }
  }
}

function takeActorTurn(battle, side, move, events) {
  const actor = side === "player" ? battle.player : battle.enemy;
  const target = side === "player" ? battle.enemy : battle.player;
  if (actor.cd > 0) actor.cd -= 1;
  if (actor.spdTurns > 0) actor.spdTurns -= 1;

  if (actor.stunned) {
    actor.stunned = false;
    events.push({ side, kind: "stunned", move: "stunned", text: `${actor.name} is stunned and loses the turn.`, damage: 0, healed: 0 });
    return;
  }

  switch (move) {
    case "guard": {
      actor.guardMult = 0.5;
      actor.focus = Math.min(3, actor.focus + 1);
      events.push({ side, kind: "guard", move, text: `${actor.name} guards (focus ${actor.focus}).`, damage: 0, healed: 0 });
      return;
    }
    case "focus": {
      actor.focus = Math.min(3, actor.focus + 2);
      events.push({ side, kind: "focus", move, text: `${actor.name} focuses (focus ${actor.focus}).`, damage: 0, healed: 0 });
      return;
    }
    case "ability": {
      if (actor.cd > 0) {
        const hit = strike(battle, actor, target);
        events.push({ side, kind: "strike", move: "strike", text: `${actor.name} strikes while the ability recharges${hit.crit ? " — critical!" : ""}.`, ...hit });
        return;
      }
      events.push({ side, ...useAbility(battle, actor, target) });
      return;
    }
    default: {
      const hit = strike(battle, actor, target);
      const text = hit.dodged
        ? `${actor.name} strikes — ${target.name} dodges.`
        : `${actor.name} strikes${hit.crit ? " — critical!" : ""} for ${hit.damage}.`;
      events.push({ side, kind: "strike", move: "strike", text, ...hit });
    }
  }
}

function enemyMove(battle) {
  const enemy = battle.enemy;
  if (enemy.cd === 0 && rand(battle) < 0.4) return "ability";
  if (enemy.hp / enemy.maxHp < 0.3 && rand(battle) < 0.5) return "guard";
  if (enemy.focus < 2 && rand(battle) < 0.2) return "focus";
  return "strike";
}

/**
 * Resolve one round: the player's move, then the enemy's reply. Returns a new
 * battle (the input is not mutated) plus the events that happened.
 */
export function takeTurn(battle, move) {
  if (battle.over) return { battle, events: [] };
  if (!MOVES.includes(move)) throw new Error(`unknown move: ${move}`);
  const next = cloneBattle(battle);
  next.turn += 1;
  const events = [];
  takeActorTurn(next, "player", move, events);

  if (next.enemy.hp > 0) {
    const reply = enemyMove(next);
    takeActorTurn(next, "enemy", reply, events);
  }

  if (next.enemy.hp <= 0) next.over = { winner: "player", reason: "enemy down" };
  else if (next.player.hp <= 0) next.over = { winner: "enemy", reason: "player down" };
  next.log = [...battle.log, ...events];
  return { battle: next, events };
}

// ── runs ───────────────────────────────────────────────────────────────────

export const BOONS = [
  { id: "heal", label: "Mend", desc: "Restore 40% of max HP." },
  { id: "atk", label: "Sharpen", desc: "+3 ATK." },
  { id: "def", label: "Temper", desc: "+2 DEF." },
  { id: "spd", label: "Quicken", desc: "+2 SPD." },
  { id: "luck", label: "Charm", desc: "+2 Luck." },
  { id: "vitality", label: "Vitality", desc: "+10 max HP and heal 10." },
];

export function createRun(fighter, seed) {
  return {
    seed: String(seed),
    floor: 1,
    fighter: JSON.parse(JSON.stringify(fighter)),
    hp: fighter.stats.hp,
    boons: [],
    champion: false,
    over: false,
  };
}

const ENEMY_CLASSES = ["image", "video", "audio", "text", "data", "other"];
const ENEMY_CONTENT = { image: "image/png", video: "video/mp4", audio: "audio/mpeg", text: "text/plain", data: "application/json", other: "application/octet-stream" };

/** The enemy for the current floor: derived, then scaled by depth. */
export function enemyForFloor(run) {
  const klass = ENEMY_CLASSES[(run.floor - 1) % ENEMY_CLASSES.length];
  const enemy = deriveFighter({
    origin: `colosseum:${run.seed}:floor:${run.floor}`,
    contentType: ENEMY_CONTENT[klass],
    contentLength: run.floor * 137,
  });
  const n = run.floor - 1;
  enemy.stats.hp = Math.round(enemy.stats.hp * (1 + 0.16 * n));
  enemy.stats.atk = Math.round(enemy.stats.atk + n * 0.9);
  enemy.stats.def = Math.round(enemy.stats.def + n * 0.7);
  enemy.stats.spd = Math.round(enemy.stats.spd + n * 0.5);
  enemy.name = `${enemy.name} · F${run.floor}`;
  return enemy;
}

/** Three deterministic boon choices offered after a floor win. */
export function boonChoices(seed, floor) {
  const picks = [];
  let counter = 0;
  while (picks.length < 3 && counter < 50) {
    const index = parseInt(sha256Hex(`${seed}:boon:${floor}:${counter++}`).slice(0, 8), 16) % BOONS.length;
    const boon = BOONS[index];
    if (!picks.some((p) => p.id === boon.id)) picks.push(boon);
  }
  return picks;
}

/** Apply a boon to a run's fighter. Returns a new run. */
export function applyBoon(run, boonId) {
  const next = JSON.parse(JSON.stringify(run));
  const boon = BOONS.find((b) => b.id === boonId);
  if (!boon) throw new Error(`unknown boon: ${boonId}`);
  if (boon.id === "heal") next.hp = Math.min(next.fighter.stats.hp, next.hp + Math.round(next.fighter.stats.hp * 0.4));
  else if (boon.id === "vitality") {
    next.fighter.stats.hp += 10;
    next.hp = Math.min(next.fighter.stats.hp, next.hp + 10);
  } else if (boon.id === "atk") next.fighter.stats.atk += 3;
  else if (boon.id === "def") next.fighter.stats.def += 2;
  else if (boon.id === "spd") next.fighter.stats.spd += 2;
  else if (boon.id === "luck") next.fighter.stats.luck += 2;
  next.boons = [...next.boons, boon.id];
  return next;
}

/** Carry the post-battle HP into the next floor, or crown the champion. */
export function advanceFloor(run, hpAfterBattle) {
  const next = JSON.parse(JSON.stringify(run));
  next.hp = Math.max(1, hpAfterBattle);
  if (next.floor >= MAX_FLOOR) {
    next.champion = true;
    return next;
  }
  next.floor += 1;
  return next;
}

/** Fighter metadata for the optional champion-medal inscription. */
export function championMedal(run, meta = {}) {
  return {
    app: "ordinal-colosseum",
    type: "champion-medal",
    version: VERSION,
    fighter: run.fighter.origin,
    fighter_name: run.fighter.name,
    floors: MAX_FLOOR,
    boons: run.boons,
    run_seed: run.seed,
    cleared_at: meta.at ?? new Date().toISOString(),
  };
}
