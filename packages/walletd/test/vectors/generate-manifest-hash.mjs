// Manifest-hash vectors for the Swift port (P3 debt).
//
// The daemon hashes the canonical re-serialization of the *parsed* manifest
// (`stableStringify`, sorted keys) rather than the raw body bytes, so two
// servers that format the same manifest differently still produce one hash
// and a phone that re-serializes its own copy must agree. The Swift used to
// hash the raw body; these vectors pin the canonical form instead.
import { stableStringify, manifestSha256 } from "../../src/apps.ts";

const cases = [
  {
    name: "minimal",
    manifest: { name: "Meme Studio", startUrl: "https://memestudio.example/", intents: [] },
  },
  {
    name: "keys must sort",
    manifest: { zeta: 1, alpha: 2, middle: { b: true, a: null } },
  },
  {
    name: "numbers, booleans, null",
    manifest: { int: 25, float: 1.5, big: 1000000, yes: true, no: false, nothing: null },
  },
  {
    name: "unicode, quotes and slashes",
    manifest: { name: "Café ☕", url: "https://example.com/a/b?c=d&e=f", quote: 'say "hi"', newline: "a\nb" },
  },
  {
    name: "arrays keep order, objects do not",
    manifest: { items: [1, "two", false, null, { k: "v" }], empty: [], obj: {}, nested: [{ z: 1, a: 2 }] },
  },
];

const out = cases.map((c) => ({
  name: c.name,
  manifestJson: JSON.stringify(c.manifest),
  stable: stableStringify(c.manifest),
  sha256: manifestSha256(c.manifest),
}));

console.log(JSON.stringify(out, null, 2));
