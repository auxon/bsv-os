# Ordinal Colosseum

A bsvOS-exclusive game: **every ordinal in your wallet becomes a fighter**.
Stats, rarity, name, and ability are derived deterministically from the
inscription's on-chain origin, so the same ordinal always fields the same
fighter and anyone can re-derive it. Run the 7-floor gauntlet, pick a boon
each floor, and optionally inscribe a 1-sat champion medal when you clear it.

## Run it

```bash
bsv unlock                                       # so the roster can load your ordinals
bsv app install https://localhost:2121/colosseum/
bsv app open localhost                           # opens in the sandboxed runner
```

No ordinals yet? Hit **Scout a fighter** — a local seed that behaves exactly
like an on-chain one. Reading is free; the only spend is the optional medal
inscription, which goes through the normal policy approval flow.

## How fighters are derived

```
seed  = sha256(origin | contentType | contentLength | sequence)
HP    = 60 + byte0 % 41      ATK = 8 + byte1 % 13
DEF   = 3  + byte2 % 9       SPD = 5 + byte3 % 11
LUCK  = byte4 % 7            name + ability from later bytes
```

`origin` is the inscription's origin outpoint (content hash lineage), so stats
survive transfers and can be recomputed by anyone with a SHA-256 tool. The
content type picks the class ability:

| Content type | Class | Ability |
| --- | --- | --- |
| `image/*` | Image | Prism Guard — brace for 40% damage, mend 6 |
| `video/*` | Video | Overclock — +50% speed for 3 turns |
| `audio/*` | Audio | Resonance — strike, heal 25% of damage |
| `text/*` | Text | Lore Strike — halves enemy DEF, crits more |
| `application/json` | Data | Glitch — 30% chance to stun |
| other | Artifact | Scrap Plating — +3 DEF for the battle |

Rarity is the power total (`HP + 2·ATK + DEF + SPD + 2·LUCK`): common, rare,
epic, legendary.

## How battles work

Turn-based and deterministic: the RNG is a hash chain seeded by the run seed,
so the same fighter, seed, and moves replay identically. Moves:

- **Strike** — `2·ATK` vs `0.8·DEF`, variance ±15%, crits scale with luck and
  banked focus.
- **Guard** — halves the next incoming hit, +1 focus.
- **Focus** — +2 focus (max 3); focus is spent to boost crit chance.
- **Ability** — class ability, 3-turn cooldown.

Seven floors, enemies scale with depth, HP carries over, and each cleared
floor offers three deterministic boons (mend, +ATK, +DEF, +SPD, +luck, or
vitality). Lose and the run ends; the Hall of Fame keeps your best floor per
fighter.

## Files

| File | Purpose |
| --- | --- |
| `logic.js` | Pure game logic: SHA-256, stat derivation, battle engine, gauntlet, boons (tested in `packages/walletd/test/colosseum.test.mjs`) |
| `app.js` | UI controller: roster via `ordList`, battle screens, local records, medal mint via `window.bsv.inscribe` |
| `index.html` / `styles.css` | Layout and theme |
| `manifest.json` | BRC-116-shaped manifest (read + optional inscribe) |

## Verification

`packages/walletd/test/colosseum.test.mjs` covers SHA-256 vectors against
Node's implementation, derivation determinism and bounds, ability mapping,
battle reproducibility, guard/focus/cooldown mechanics, stun behavior,
gauntlet scaling, boons, and the champion medal payload. Run it with
`npm test` in `packages/walletd`.
