import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ABILITIES,
  advanceFloor,
  applyBoon,
  boonChoices,
  championMedal,
  createRun,
  deriveFighter,
  enemyForFloor,
  MAX_FLOOR,
  newBattle,
  sha256Hex,
  statTotal,
  takeTurn,
} from "../../runner/apps/colosseum/logic.js";

const FIGHTER = deriveFighter({
  origin: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_0",
  contentType: "image/png",
  contentLength: 4321,
});

test("sha256 matches Node's implementation", () => {
  const vectors = ["", "abc", "the quick brown fox", "Ünïcödé ✓", "x".repeat(1000)];
  for (const v of vectors) {
    assert.equal(sha256Hex(v), createHash("sha256").update(v).digest("hex"), JSON.stringify(v.slice(0, 20)));
  }
});

test("fighters are deterministic from on-chain metadata", () => {
  const a = deriveFighter({ origin: "tx1_0", contentType: "image/png", contentLength: 100 });
  const b = deriveFighter({ origin: "tx1_0", contentType: "image/png", contentLength: 100 });
  const c = deriveFighter({ origin: "tx1_1", contentType: "image/png", contentLength: 100 });
  assert.deepEqual(a, b, "same origin, same fighter");
  assert.notDeepEqual(a.stats, c.stats, "different origin, different stats");
  assert.match(a.seedHex, /^[0-9a-f]{64}$/);
  assert.ok(a.stats.hp >= 60 && a.stats.hp <= 100);
  assert.ok(a.stats.atk >= 8 && a.stats.atk <= 20);
  assert.ok(a.stats.def >= 3 && a.stats.def <= 11);
  assert.ok(a.stats.spd >= 5 && a.stats.spd <= 15);
  assert.ok(a.stats.luck >= 0 && a.stats.luck <= 6);
  assert.throws(() => deriveFighter({}), /origin/);
});

test("content types map to abilities and rarities are ordered", () => {
  assert.equal(deriveFighter({ origin: "x", contentType: "image/jpeg" }).klass, "image");
  assert.equal(deriveFighter({ origin: "x", contentType: "video/mp4" }).klass, "video");
  assert.equal(deriveFighter({ origin: "x", contentType: "audio/mpeg" }).klass, "audio");
  assert.equal(deriveFighter({ origin: "x", contentType: "text/plain" }).klass, "text");
  assert.equal(deriveFighter({ origin: "x", contentType: "application/json" }).klass, "data");
  assert.equal(deriveFighter({ origin: "x", contentType: "application/octet-stream" }).klass, "data");
  assert.equal(deriveFighter({ origin: "x", contentType: "" }).klass, "other");
  for (const [klass, ability] of Object.entries(ABILITIES)) {
    const fighter = deriveFighter({ origin: `origin-${klass}`, contentType: `${klass === "data" ? "application/json" : `${klass}/x`}` });
    assert.equal(fighter.ability.id, ability.id, klass);
  }
  const tiers = ["common", "rare", "epic", "legendary"];
  let seen = new Set();
  for (let i = 0; i < 200; i++) {
    const f = deriveFighter({ origin: `rarity-${i}`, contentType: "image/png" });
    assert.ok(tiers.includes(f.rarity));
    assert.equal(f.rarityLabel[0], f.rarity[0].toUpperCase());
    assert.ok(statTotal(f.stats) === f.total);
    seen.add(f.rarity);
  }
  assert.ok(seen.size >= 2, "200 fighters should span at least two rarities");
});

test("battles are deterministic and the input is not mutated", () => {
  const enemy = deriveFighter({ origin: "enemy-1", contentType: "video/mp4" });
  const battle = newBattle(FIGHTER, enemy, "run-seed-1");
  const before = JSON.stringify(battle);
  const first = takeTurn(battle, "strike");
  assert.equal(JSON.stringify(battle), before, "input battle untouched");
  assert.notEqual(first.battle, battle, "returns a new battle");
  assert.equal(first.events.length, 2, "player and enemy act");
  assert.match(first.events[0].text, /strikes/);

  const replay = newBattle(FIGHTER, enemy, "run-seed-1");
  const second = takeTurn(replay, "strike");
  assert.deepEqual(second.battle, first.battle, "same seed + same move = same battle");
  const otherSeed = takeTurn(newBattle(FIGHTER, enemy, "run-seed-2"), "strike");
  assert.notDeepEqual(otherSeed.battle, first.battle, "different seed diverges");
  assert.throws(() => takeTurn(battle, "dance"), /unknown move/);
});

test("guard, focus, and cooldowns behave", () => {
  const enemy = deriveFighter({ origin: "enemy-2", contentType: "text/plain" });
  const guarded = takeTurn(newBattle(FIGHTER, enemy, "mech-1"), "guard").battle;
  assert.equal(guarded.player.focus, 1, "guard builds focus");
  assert.equal(guarded.player.guardMult, 1, "guard consumed by the enemy hit");
  const guardedEvent = guarded.log.find((e) => e.side === "enemy");
  assert.ok(guardedEvent.damage <= Math.round(enemy.stats.atk * 2 * 1.15 * 0.5) + 1, "guarded hit is halved");

  const focused = takeTurn(newBattle(FIGHTER, enemy, "mech-2"), "focus").battle;
  assert.equal(focused.player.focus, 2, "focus adds two");
  const capped = takeTurn(focused, "focus").battle;
  assert.equal(capped.player.focus, 3, "focus caps at three");

  const abilityBattle = newBattle(FIGHTER, enemy, "mech-3");
  const used = takeTurn(abilityBattle, "ability").battle;
  assert.equal(used.player.cd, 3, "ability sets a three-turn cooldown");
  const again = takeTurn(used, "ability");
  assert.equal(again.battle.player.cd, 2, "cooldown ticks down at the start of the next turn");
  assert.match(again.events[0].text, /recharges|strikes/i, "ability on cooldown falls back to a strike");
});

test("battles end when a side is down", () => {
  const enemy = deriveFighter({ origin: "enemy-3", contentType: "audio/mpeg" });
  const battle = newBattle(FIGHTER, enemy, "end-1");
  battle.enemy.hp = 1;
  const { battle: after } = takeTurn(battle, "strike");
  assert.equal(after.over?.winner, "player");
  const { battle: done } = takeTurn(after, "strike");
  assert.deepEqual(done, after, "no turns after the battle is over");

  const losing = newBattle(FIGHTER, enemy, "end-2");
  losing.player.hp = 1;
  losing.player.stats.spd = 0;
  const result = takeTurn(losing, "guard");
  assert.equal(result.battle.over?.winner, "enemy");
});

test("the glitch ability can stun", () => {
  const glitcher = deriveFighter({ origin: "glitchy", contentType: "application/json" });
  let stunned = false;
  for (let seed = 0; seed < 60 && !stunned; seed++) {
    const enemy = deriveFighter({ origin: `stun-enemy-${seed}`, contentType: "text/plain" });
    let battle = newBattle(glitcher, enemy, `stun-${seed}`);
    for (let turn = 0; turn < 12 && !battle.over; turn++) {
      const step = takeTurn(battle, battle.player.cd === 0 ? "ability" : "strike");
      if (step.events.some((e) => e.kind === "stunned")) stunned = true;
      battle = step.battle;
    }
  }
  assert.equal(stunned, true, "some seed should land a stun");
});

test("gauntlet floors scale and boons are deterministic", () => {
  const run = createRun(FIGHTER, "gauntlet-1");
  assert.equal(run.floor, 1);
  assert.equal(run.hp, FIGHTER.stats.hp);
  const floor1 = enemyForFloor(run);
  const floor7 = enemyForFloor({ ...run, floor: MAX_FLOOR });
  assert.ok(floor7.stats.hp > floor1.stats.hp, "deeper floors are tougher");
  assert.ok(floor7.stats.atk > floor1.stats.atk);

  const picks = boonChoices("gauntlet-1", 1);
  assert.equal(picks.length, 3);
  assert.equal(new Set(picks.map((p) => p.id)).size, 3, "distinct choices");
  assert.deepEqual(picks, boonChoices("gauntlet-1", 1), "deterministic");

  const healed = applyBoon({ ...run, hp: 10 }, "heal");
  assert.equal(healed.hp, 10 + Math.round(FIGHTER.stats.hp * 0.4));
  const sharpened = applyBoon(run, "atk");
  assert.equal(sharpened.fighter.stats.atk, FIGHTER.stats.atk + 3);
  assert.deepEqual(run.fighter.stats, FIGHTER.stats, "applyBoon does not mutate the input");
  const vital = applyBoon({ ...run, hp: 5 }, "vitality");
  assert.equal(vital.fighter.stats.hp, FIGHTER.stats.hp + 10);
  assert.equal(vital.hp, 15);
  assert.throws(() => applyBoon(run, "nope"), /unknown boon/);
});

test("advanceFloor crowns the champion at the final floor", () => {
  const run = { ...createRun(FIGHTER, "gauntlet-2"), floor: MAX_FLOOR };
  const crowned = advanceFloor(run, 12);
  assert.equal(crowned.champion, true);
  assert.equal(crowned.hp, 12);
  const mid = advanceFloor(createRun(FIGHTER, "gauntlet-3"), 20);
  assert.equal(mid.floor, 2);
  assert.equal(mid.champion, false);
  assert.equal(mid.hp, 20);
  const medal = championMedal(crowned, { at: "2026-09-20T00:00:00.000Z" });
  assert.equal(medal.type, "champion-medal");
  assert.equal(medal.fighter, FIGHTER.origin);
  assert.equal(medal.floors, MAX_FLOOR);
  assert.equal(medal.cleared_at, "2026-09-20T00:00:00.000Z");
});

test("a full auto-battle replays identically", () => {
  const play = (seed) => {
    const enemy = enemyForFloor(createRun(FIGHTER, seed));
    let battle = newBattle(FIGHTER, enemy, seed);
    while (!battle.over) battle = takeTurn(battle, "strike").battle;
    return battle.log.map((e) => `${e.side}:${e.move}:${e.damage}`);
  };
  assert.deepEqual(play("replay-a"), play("replay-a"));
  assert.notDeepEqual(play("replay-a"), play("replay-b"));
});

test("a clearly stronger fighter beats floor 1 and a weaker one loses at floor 7", () => {
  const strong = { ...FIGHTER, stats: { hp: 400, atk: 90, def: 40, spd: 40, luck: 6 } };
  const weak = { ...FIGHTER, stats: { hp: 40, atk: 6, def: 1, spd: 2, luck: 0 } };
  const fight = (fighter, floor) => {
    let battle = newBattle(fighter, enemyForFloor({ ...createRun(fighter, "sim"), floor }), `sim-${floor}`);
    let turns = 0;
    while (!battle.over && turns++ < 100) battle = takeTurn(battle, "strike").battle;
    return battle.over?.winner;
  };
  assert.equal(fight(strong, 1), "player");
  assert.equal(fight(weak, MAX_FLOOR), "enemy");
});
