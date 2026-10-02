import { test } from "node:test";
import assert from "node:assert/strict";

// Hermetic: never let the vision client see real credentials.
delete process.env.CLOUDFLARE_ACCOUNT_ID;
delete process.env.CLOUDFLARE_API_TOKEN;

import { classifyMeme, clefEnabled, clefVariant, CLEF_MAX_IMAGE_BYTES } from "../src/clef.ts";

const IMG = Buffer.from("fake-jpeg-bytes").toString("base64");

function okFetch(answers, seen) {
  return async (url, init) => {
    if (seen) seen.body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ result: { model: "clef", answers, usage: { input_tokens: 400, output_tokens: 0 } } }),
      { status: 200 },
    );
  };
}

function withCreds() {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
  process.env.CLOUDFLARE_API_TOKEN = "tok";
}

test("classifyMeme posts the vision body and returns typed answers", async () => {
  withCreds();
  try {
    const seen = {};
    const r = await classifyMeme({ imageBase64: IMG, caption: "hi" }, {
      fetchFn: okFetch({
        template: { type: "choice", choice: "stonks", probabilities: { stonks: 0.9 }, confidence: 0.8 },
        hook: { type: "choice", choice: "money", probabilities: { money: 1 }, confidence: 0.9 },
        qa: { type: "score", score: 0.1, legend: {}, probabilities: {}, confidence: 0.9 },
      }, seen),
    });
    assert.equal(r.template.choice, "stonks");
    assert.equal(r.hook.choice, "money");
    assert.equal(r.qa.score, 0.1);
    assert.equal(r.usage.input_tokens, 400);
    assert.equal(typeof r.elapsedMs, "number");
    assert.equal(seen.body.model, "clef");
    assert.equal(seen.body.state.caption, "hi");
    assert.equal(seen.body.images[0].content_type, "image/jpeg");
    assert.equal(Object.keys(seen.body.questions.template.criteria).length > 5, true);
    assert.deepEqual(seen.body.questions.qa.criteria, ["clean", "minor", "blocked"]);
  } finally {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
  }
});

test("classifyMeme fails closed without credentials", async () => {
  let fetched = false;
  await assert.rejects(
    classifyMeme({ imageBase64: IMG }, { fetchFn: async () => { fetched = true; throw new Error("x"); } }),
    (e) => e.code === "CLEF_NO_KEY",
  );
  assert.equal(fetched, false);
});

test("classifyMeme rejects missing and oversize images", async () => {
  withCreds();
  try {
    await assert.rejects(classifyMeme({ imageBase64: "" }, { fetchFn: async () => { throw new Error("x"); } }),
      (e) => e.code === "BAD_PARAM");
    const big = Buffer.alloc(CLEF_MAX_IMAGE_BYTES + 1).toString("base64");
    await assert.rejects(classifyMeme({ imageBase64: big }, { fetchFn: async () => { throw new Error("x"); } }),
      (e) => e.code === "BAD_PARAM");
  } finally {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
  }
});

test("classifyMeme surfaces API errors with status codes", async () => {
  withCreds();
  try {
    const fetchFn = async () => new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 422 });
    await assert.rejects(classifyMeme({ imageBase64: IMG }, { fetchFn }), (e) => e.code === "CLEF_422");
  } finally {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
  }
});

test("clefEnabled and clefVariant read the environment", async () => {
  assert.equal(clefEnabled(), false);
  assert.equal(clefVariant(), "clef");
  process.env.CLOUDFLARE_ACCOUNT_ID = "a";
  process.env.CLOUDFLARE_API_TOKEN = "b";
  process.env.CLEF_VARIANT = "clef-flash";
  try {
    assert.equal(clefEnabled(), true);
    assert.equal(clefVariant(), "clef-flash");
  } finally {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLEF_VARIANT;
  }
});
