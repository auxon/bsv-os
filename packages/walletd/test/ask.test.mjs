import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { BSM, PrivateKey } from "@bsv/sdk";
import { migrate } from "../src/storage.ts";
import {
  ASK_BOARD,
  MIN_AMOUNT_SATS,
  amountFromRefs,
  amountRef,
  decodeQuestion,
  ensureAskBoard,
  gradeAnswer,
  openQuestions,
  payToFromRefs,
  payToRef,
  titleFromRefs,
  titleRef,
  triageQuestion,
  validateAnswer,
  validateQuestion,
} from "../src/ask.ts";
import {
  buildPost,
  createBoard,
  getBoard,
  getPosts,
  newBoardKeyHex,
  publishPost,
} from "../src/boards.ts";

const ADDR = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

const fakeRelay = {
  send: async () => {},
  list: async () => [],
  ack: async () => {},
  status: async () => ({}),
  register: async () => ({}),
};

/** A foreign signer that does not need the daemon wallet. */
function foreignSigner() {
  const priv = PrivateKey.fromRandom();
  return {
    pub: priv.toPublicKey().toString().toLowerCase(),
    sign: (m) => BSM.sign(Array.from(Buffer.from(m, "utf8")), priv, "base64"),
  };
}

async function postAs(db, board, keyHex, signer, { text, kind, refs = [], replyTo = "" }) {
  const env = buildPost({
    board: board.name, from: signer.pub, agent: "test", keyHex,
    epoch: board.epoch, text, kind, refs, replyTo,
    sign: (m) => signer.sign(m),
  });
  await publishPost(db, fakeRelay, null, env);
  return env.id;
}

test("validateQuestion enforces the 5000-sat floor and text caps", () => {
  const good = validateQuestion({ title: "Why is the sky blue?", details: "For a five-year-old.", amountSats: 5000 });
  assert.deepEqual(good, { title: "Why is the sky blue?", details: "For a five-year-old.", amountSats: 5000 });
  assert.throws(() => validateQuestion({ title: "", details: "x", amountSats: 5000 }), /title required/);
  assert.throws(() => validateQuestion({ title: "x".repeat(121), details: "x", amountSats: 5000 }), /120/);
  assert.throws(() => validateQuestion({ title: "a\nb", details: "x", amountSats: 5000 }), /single line/);
  assert.throws(() => validateQuestion({ title: "x", details: "", amountSats: 5000 }), /details required/);
  assert.throws(() => validateQuestion({ title: "x", details: "y", amountSats: 4999 }), /at least 5000/);
  assert.throws(() => validateQuestion({ title: "x", details: "y", amountSats: "much" }), /at least 5000/);
});

test("validateAnswer requires text and a real P2PKH address", () => {
  assert.deepEqual(validateAnswer({ text: "Because air.", payTo: ADDR }), { text: "Because air.", payTo: ADDR });
  assert.throws(() => validateAnswer({ text: "", payTo: ADDR }), /text required/);
  assert.throws(() => validateAnswer({ text: "x", payTo: "not-an-address" }), /valid BSV address/);
  assert.throws(() => validateAnswer({ text: "x", payTo: "" }), /valid BSV address/);
});

test("title travels in refs (board text cannot keep newlines)", () => {
  // cleanText flattens control chars on publish, so structure lives in refs.
  assert.equal(titleRef("T?"), "title:T?");
  assert.equal(titleFromRefs(["amount:5000", "title:T?"]), "T?");
  assert.equal(titleFromRefs([]), null);
  assert.deepEqual(
    decodeQuestion({ text: "Line one. Line two.", refs: ["title:T?"] }),
    { title: "T?", details: "Line one. Line two." },
  );
  assert.deepEqual(
    decodeQuestion({ text: "lonely title", refs: [] }),
    { title: "lonely title", details: "lonely title" },
    "foreign posts without a title ref fall back to text",
  );
});

test("refs carry the pledge and the payout address", () => {
  assert.equal(amountRef(5000), "amount:5000");
  assert.equal(payToRef(ADDR), `payto:${ADDR}`);
  assert.equal(amountFromRefs(["amount:5000", "payto:x"]), 5000);
  assert.equal(amountFromRefs(["nope"]), null);
  assert.equal(amountFromRefs(null), null);
  assert.equal(payToFromRefs([`payto:${ADDR}`]), ADDR);
  assert.equal(payToFromRefs(["payto:garbage"]), null, "invalid addresses do not parse");
  assert.equal(payToFromRefs([]), null);
});

test("ensureAskBoard creates the dedicated board once", async () => {
  const db = await memdb();
  try {
    assert.equal(await getBoard(db, ASK_BOARD), null);
    const first = await ensureAskBoard(db);
    assert.equal(first.name, ASK_BOARD);
    assert.equal(first.mode, "members");
    const second = await ensureAskBoard(db);
    assert.equal(second.name, ASK_BOARD);
  } finally {
    await db.destroy();
  }
});

test("openQuestions reads kind=request posts, decoded, skipping locked and notes", async () => {
  const db = await memdb();
  try {
    const signer = foreignSigner();
    const keyHex = newBoardKeyHex();
    const board = await createBoard(db, { name: ASK_BOARD, mode: "members", keyHex, members: [signer.pub] });
    await postAs(db, board, keyHex, signer, {
      text: "D1", kind: "request", refs: [amountRef(6000), titleRef("Q1?")],
    });
    await postAs(db, board, keyHex, signer, { text: "just chatting", kind: "note" });
    const open = await openQuestions(db, ASK_BOARD);
    assert.equal(open.length, 1);
    assert.equal(open[0].title, "Q1?");
    assert.equal(open[0].details, "D1");
    assert.equal(open[0].amountSats, 6000);
    assert.deepEqual(await openQuestions(db, "no-such-board"), [], "missing board reads empty, never throws");
  } finally {
    await db.destroy();
  }
});

test("answers thread under questions with payout refs", async () => {
  const db = await memdb();
  try {
    const signer = foreignSigner();
    const keyHex = newBoardKeyHex();
    const board = await createBoard(db, { name: ASK_BOARD, mode: "members", keyHex, members: [signer.pub] });
    const qid = await postAs(db, board, keyHex, signer, {
      text: "D", kind: "request", refs: [amountRef(5000), titleRef("Q?")],
    });
    await postAs(db, board, keyHex, signer, {
      text: "Because.", kind: "result", refs: [payToRef(ADDR)], replyTo: qid,
    });
    const open = await openQuestions(db, ASK_BOARD);
    assert.equal(open.length, 1, "answers are not questions");
    const { posts } = await getPosts(db, ASK_BOARD, { limit: 100, markRead: false });
    const answer = posts.find((x) => x.id !== qid);
    assert.ok(answer, "answer stored");
    assert.equal(answer.kind, "result");
    assert.equal(answer.replyTo, qid);
    assert.equal(payToFromRefs(answer.refs), ADDR);
  } finally {
    await db.destroy();
  }
});

/** Deterministic stand-in for a Jev decision call. */
function fakeDecide(answers) {
  return async () => ({ model: "fake", answers, elapsedMs: 1 });
}

test("triage scores clarity and names duplicates in one call", async () => {
  const seen = [];
  const decide = async (state, questions) => {
    seen.push({ state, questions: Object.keys(questions) });
    return fakeDecide({
      clarity: { type: "score", score: 2, confidence: 0.8 },
      duplicate: { type: "choice", choice: "q9", probabilities: { q9: 0.7 }, confidence: 0.7 },
    })();
  };
  const r = await triageQuestion(decide, {
    title: "Why blue?", details: "Sky reasons.", amountSats: 5000,
    open: [{ id: "q9", title: "Why is the sky blue?" }],
  });
  assert.equal(r.available, true);
  assert.deepEqual(r.clarity, { score: 2, level: "crisp", confidence: 0.8 });
  assert.deepEqual(r.duplicate, { matchId: "q9", matchTitle: "Why is the sky blue?", confidence: 0.7 });
  assert.deepEqual(seen[0].questions, ["clarity", "duplicate"], "one batched call");
  assert.equal(r.openCount, 1);
});

test("triage reports novel (not a match) and skips duplicates with no open list", async () => {
  const r = await triageQuestion(
    fakeDecide({
      clarity: { type: "score", score: 0, confidence: 0.5 },
      duplicate: { type: "choice", choice: "novel", probabilities: { novel: 0.9 }, confidence: 0.9 },
    }),
    { title: "T?", details: "D.", amountSats: 5000, open: [{ id: "q1", title: "Other" }] },
  );
  assert.deepEqual(r.duplicate, { matchId: null, matchTitle: null, confidence: 0.9 });
  let asked = null;
  await triageQuestion(async (state, questions) => {
    asked = Object.keys(questions);
    return fakeDecide({ clarity: { type: "score", score: 1, confidence: 0.6 } })();
  }, { title: "T?", details: "D.", amountSats: 5000, open: [] });
  assert.deepEqual(asked, ["clarity"], "no duplicate question without an open list");
});

test("triage fails open when Jev is down", async () => {
  const down = async () => {
    throw Object.assign(new Error("endpoint down"), { code: "JEV_UNAVAILABLE" });
  };
  const r = await triageQuestion(down, { title: "T?", details: "D.", amountSats: 5000, open: [] });
  assert.deepEqual(r, { available: false, clarity: null, duplicate: null, openCount: 0 });
});

test("gradeAnswer scores blind and rejects empty input loudly", async () => {
  const r = await gradeAnswer(
    fakeDecide({ quality: { type: "score", score: 3, confidence: 0.75 } }),
    { question: "Why blue?", submission: "Rayleigh scattering." },
  );
  assert.deepEqual(r, { available: true, score: 3, level: "strong", confidence: 0.75 });
  await assert.rejects(
    gradeAnswer(fakeDecide({}), { question: "", submission: "x" }),
    (e) => e.code === "BAD_PARAM",
    "empty input throws, never returns unavailable",
  );
  const down = async () => {
    throw new Error("down");
  };
  assert.deepEqual(
    await gradeAnswer(down, { question: "Q?", submission: "A." }),
    { available: false, score: null, level: null, confidence: 0 },
  );
});
