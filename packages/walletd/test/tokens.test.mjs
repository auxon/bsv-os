import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bsv21For,
  contentUrl,
  fetchBulkMetadata,
  fetchOwnerTxos,
  galleryFor,
  splitOutpoint,
} from "../src/tokens.ts";

const OUT_A = `${"a".repeat(64)}_0`;
const OUT_B = `${"b".repeat(64)}_1`;

function sseFetch(text, status = 200) {
  return async () => new Response(text, { status, headers: { "content-type": "text/event-stream" } });
}

test("splitOutpoint accepts underscores and dots, rejects garbage", () => {
  assert.deepEqual(splitOutpoint(`${"A".repeat(64)}_12`), { txid: "a".repeat(64), vout: 12 });
  assert.deepEqual(splitOutpoint(`${"b".repeat(64)}.0`), { txid: "b".repeat(64), vout: 0 });
  assert.equal(splitOutpoint("nope"), null);
  assert.equal(splitOutpoint(`${"c".repeat(63)}_0`), null);
  assert.equal(splitOutpoint(""), null);
});

test("owner stream collects txos and stops at done", async () => {
  const sse = [
    'event: sync\ndata: {"phase":"fetch"}\n\n',
    `event: txo\ndata: {"outpoint":"${OUT_A}","satoshis":1}\n\n`,
    'event: txo\ndata: {"outpoint":"broken","satoshis":5}\n\n',
    `event: txo\ndata: {"outpoint":"${OUT_B}","satoshis":500}\n\n`,
    "event: done\ndata: \n\n",
  ].join("");
  const txos = await fetchOwnerTxos("anywhere", { fetchFn: sseFetch(sse) });
  assert.deepEqual(txos, [
    { outpoint: OUT_A, satoshis: 1 },
    { outpoint: OUT_B, satoshis: 500 },
  ]);
});

test("owner stream surfaces server errors", async () => {
  const sse = 'event: error\ndata: indexer down\n\n';
  await assert.rejects(fetchOwnerTxos("anywhere", { fetchFn: sseFetch(sse) }), /indexer down/);
  await assert.rejects(fetchOwnerTxos("anywhere", { fetchFn: sseFetch("x", 500) }), /owner stream failed/);
});

test("gallery joins metadata; plain sats are skipped", async () => {
  const sse = [
    `event: txo\ndata: {"outpoint":"${OUT_A}","satoshis":1}\n\n`,
    `event: txo\ndata: {"outpoint":"${OUT_B}","satoshis":500}\n\n`,
    "event: done\ndata: \n\n",
  ].join("");
  const meta = {
    [OUT_A]: { outpoint: OUT_A, origin: `${"a".repeat(64)}.0`, sequence: 0, contentType: "image/png", contentLength: 2103 },
  };
  const fetchFn = async (url, init) => {
    if (init?.method === "POST") return new Response(JSON.stringify(meta), { status: 200 });
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const rows = await galleryFor("anywhere", { fetchFn });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outpoint, OUT_A);
  assert.equal(rows[0].contentType, "image/png");
  assert.equal(rows[0].contentLength, 2103);
  assert.equal(rows[0].contentUrl, contentUrl(OUT_A));
  assert.equal((await galleryFor("nobody", { fetchFn: sseFetch("event: done\ndata: \n\n") })).length, 0);
});

test("bulk metadata posts outpoints and tolerates misses", async () => {
  const seen = [];
  const fetchFn = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ [OUT_A]: null }), { status: 200 });
  };
  const out = await fetchBulkMetadata([OUT_A], { fetchFn });
  assert.deepEqual(seen, [{ outpoints: [OUT_A] }]);
  assert.deepEqual(out, { [OUT_A]: null });
  assert.deepEqual(await fetchBulkMetadata([], { fetchFn }), {});
});

test("bsv21 lists nonzero positions only", async () => {
  const registry = [
    { token_id: "AAA_0", symbol: "AAA", decimals: 2, icon: null },
    { token_id: "BBB_0", symbol: "", decimals: 8 },
    { garbage: true },
  ];
  const balances = { AAA_0: { balance: 150, utxoCount: 2 }, BBB_0: { balance: 0, utxoCount: 0 } };
  const fetchFn = async (url) => {
    if (url.endsWith("/1sat/bsv21/tokens")) return new Response(JSON.stringify(registry), { status: 200 });
    const m = /\/1sat\/bsv21\/([^/]+)\/ordlock\/[^/]+\/balance$/.exec(url);
    const b = m ? balances[m[1]] : null;
    return new Response(JSON.stringify(b ?? { balance: 0, utxoCount: 0 }), { status: 200 });
  };
  const positions = await bsv21For("anywhere", { fetchFn });
  assert.equal(positions.length, 1);
  assert.deepEqual(positions[0], {
    tokenId: "AAA_0", symbol: "AAA", decimals: 2, icon: null, balance: 150, utxoCount: 2,
  });
  await assert.rejects(bsv21For("anywhere", { fetchFn: async () => new Response("x", { status: 500 }) }), /registry failed/);
});
