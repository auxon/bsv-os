import { test } from "node:test";
import assert from "node:assert/strict";

import knex from "knex";
import { migrate } from "../src/storage.ts";
import {
  contestRef, createContest, getContest, judgeRound, lineageRoot,
  listContests, parseRound, recordEntry, roundEntries, roundWindow, splitEntry,
} from "../src/evolve.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

test("parseRound bounds", () => {
  assert.equal(parseRound("1h"), 3_600_000);
  assert.equal(parseRound(60), 60_000);
  assert.throws(() => parseRound("1m"), /minimum round/);
  assert.throws(() => parseRound("31d"), /maximum round/);
  assert.throws(() => parseRound("soon"), /round like/);
});

test("splitEntry separates prompt from judged output", () => {
  const { prompt, output } = splitEntry("PROMPT:\nwrite haiku\n---OUTPUT---\nold pond...");
  assert.equal(prompt, "write haiku");
  assert.equal(output, "old pond...");
  assert.deepEqual(splitEntry("just output"), { prompt: "", output: "just output" });
  assert.equal(contestRef("ev_abc"), "evolve:ev_abc");
});

test("contest lifecycle: create, enter, judge, lineage", async () => {
  const db = await memdb();
  try {
    const c = await createContest(db, {
      task: "haiku about daemons", rubric: "5-7-5, seasonal word, no clichés",
      prize: 5000, rounds: 2, entryFee: 100, sponsor: "1abc", round: "5m", now: 1_000_000,
    });
    assert.match(c.id, /^ev_/);
    assert.equal((await listContests(db)).length, 1);
    assert.deepEqual(roundWindow(c, 1), { start: 1_000_000, end: 1_300_000 });

    // entering before open / after close is refused
    await assert.rejects(
      recordEntry(db, { contest: c.id, round: 1, author: "k", agent: "a", output: "x", payTo: "1p", now: 999_000 }),
      /not opened/,
    );
    const e1 = await recordEntry(db, {
      contest: c.id, round: 1, author: "k1", agent: "a1", output: "old pond / frog jumps in / sound of water",
      payTo: "1p1", feeOutpoint: "tx1:0", now: 1_100_000,
    });
    const e2 = await recordEntry(db, {
      contest: c.id, round: 1, author: "k2", agent: "a2", output: "server hums at midnight",
      payTo: "1p2", feeOutpoint: "tx2:0", parent: e1.id, now: 1_150_000,
    });
    // same fee outpoint cannot enter twice
    await assert.rejects(
      recordEntry(db, { contest: c.id, round: 1, author: "k3", agent: "a3", output: "y", payTo: "1p3", feeOutpoint: "tx1:0", now: 1_160_000 }),
      /already entered/,
    );
    // judging before close is refused
    await assert.rejects(judgeRound(db, c.id, 1, async () => ({ score: 4, confidence: 1 }), 1_100_000), /still open/);

    const judge = async (output) => output.includes("pond")
      ? { score: 4, confidence: 0.9 }
      : { score: 1, confidence: 0.8 };
    const { winner, ranking } = await judgeRound(db, c.id, 1, judge, 1_400_000);
    assert.equal(winner.id, e1.id);
    assert.deepEqual(ranking.map((e) => e.id), [e1.id, e2.id]);

    // lineage: e2 descends from e1
    const byId = new Map((await roundEntries(db, c.id, 1)).map((e) => [e.id, e]));
    assert.equal(lineageRoot(byId.get(e2.id), byId), e1.id);
    assert.equal(lineageRoot(byId.get(e1.id), byId), e1.id);

    // round 2 window follows round 1
    assert.deepEqual(roundWindow(await getContest(db, c.id), 2), { start: 1_300_000, end: 1_600_000 });
  } finally {
    await db.destroy();
  }
});

test("ties break to the earliest entry", async () => {
  const db = await memdb();
  try {
    const c = await createContest(db, {
      task: "t", rubric: "r", prize: 100, rounds: 1, entryFee: 0, sponsor: "1s", round: "5m", now: 5_000_000,
    });
    await recordEntry(db, { contest: c.id, round: 1, author: "a", agent: "a", output: "first", payTo: "1p", now: 5_050_000 });
    await recordEntry(db, { contest: c.id, round: 1, author: "b", agent: "b", output: "second", payTo: "1p", now: 5_060_000 });
    const { winner } = await judgeRound(db, c.id, 1, async () => ({ score: 3, confidence: 0.5 }), 5_400_000);
    assert.equal(winner.output, "first");
  } finally {
    await db.destroy();
  }
});
