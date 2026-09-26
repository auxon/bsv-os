import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_BOARD, USENET_GROUP, cleanTag, contentHash, forgetRefs, forgottenIds,
  isForgetRefs, isMemoryRefs, memoryRefs, mergeUsenetHits, normalizeMemoryText,
  parseUsenetBody, recallFromPosts, refHash, refTag, usenetPayload,
} from "../src/memory.ts";

test("memory codec: normalize, hash, refs round-trip", () => {
  assert.equal(normalizeMemoryText("  hello world  "), "hello world");
  assert.equal(normalizeMemoryText(42), "");
  const h = contentHash("hello world");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(contentHash("hello world"), h);
  const refs = memoryRefs(h, "rsog");
  assert.deepEqual(refs, ["#memory", `sha256:${h}`, "tag:rsog"]);
  assert.equal(isMemoryRefs(refs), true);
  assert.equal(isForgetRefs(refs), false);
  assert.equal(refHash(refs), h);
  assert.equal(refTag(refs), "rsog");
  assert.equal(cleanTag(" RSOG-Coach "), "rsog-coach");
  assert.equal(cleanTag("no good!"), "");
  const f = forgetRefs(h);
  assert.equal(isForgetRefs(f), true);
  assert.equal(refHash(f), h);
});

test("recall: tag filter, keyword rank, forget tombstones strike", () => {
  const posts = [
    { id: "a1", text: "YIN pitch validation passed 10/10 on guitar tones", refs: ["#memory", `sha256:${"a".repeat(64)}`, "tag:rsog"], replyTo: "", ts: 3, from: "k1", locked: false },
    { id: "b2", text: "grocery list: milk and eggs", refs: ["#memory", `sha256:${"b".repeat(64)}`], replyTo: "", ts: 2, from: "k1", locked: false },
    { id: "c3", text: "ciphertext without key", refs: ["#memory", `sha256:${"c".repeat(64)}`], replyTo: "", ts: 4, from: "k1", locked: true },
    { id: "d4", text: "not a memory", refs: [], replyTo: "", ts: 5, from: "k1", locked: false },
  ];
  const all = recallFromPosts(posts, {});
  assert.deepEqual(all.map((h) => h.id), ["a1", "b2"]);

  const tagged = recallFromPosts(posts, { tag: "rsog" });
  assert.deepEqual(tagged.map((h) => h.id), ["a1"]);

  const ranked = recallFromPosts(posts, { query: "guitar pitch" });
  assert.deepEqual(ranked.map((h) => h.id), ["a1"]);

  const struck = recallFromPosts([
    ...posts,
    { id: "e5", text: "forget a1", refs: ["#memory-forget", `sha256:${"a".repeat(64)}`], replyTo: "a1", ts: 6, from: "k1", locked: false },
  ], {});
  assert.deepEqual(struck.map((h) => h.id), ["b2"]);
  assert.deepEqual([...forgottenIds([
    { id: "e5", text: "", refs: ["#memory-forget", `sha256:${"a".repeat(64)}`], replyTo: "a1", ts: 6, from: "k", locked: false },
  ])], ["a1"]);
});

test("usenet payload carries the hash footer; merge dedupes by hash", () => {
  const text = "practice coach spec lives in the patch";
  const hash = contentHash(text);
  const p = usenetPayload(text, "rsog", hash);
  assert.match(p.subject, /^\[memory:rsog\]/);
  assert.ok(p.body.includes(`sha256:${hash}`));
  assert.ok(p.body.includes("tag:rsog"));
  assert.deepEqual(parseUsenetBody(p.body), { hash, tag: "rsog" });

  const board = [{
    id: "a1", text, tag: "rsog", hash, backend: "board", ts: 3, from: "k1", ref: `board:${MEMORY_BOARD}:a1`,
  }];
  const merged = mergeUsenetHits(board, [
    { id: "ua_dup", body: p.body, subject: p.subject, from: "x", createdAt: 4 },
    { id: "ua_new", body: "unrelated public note\n\n— bsvOS memory sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", subject: "[memory] unrelated", from: "y", createdAt: 5 },
  ], {});
  assert.deepEqual(merged.map((h) => h.id), ["a1", "ua_new"]);
  assert.equal(merged[1].backend, "usenet");
  assert.equal(merged[1].ref, `usenet:${USENET_GROUP}:ua_new`);
});
