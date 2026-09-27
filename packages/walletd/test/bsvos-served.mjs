// Reproduce the browser's module load from the SERVED bytes, and report the
// exact shape of VIEWS. Run with: node test/bsvos-served.mjs <baseUrl>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = process.argv[2] ?? "https://127.0.0.1:2121/bsvos/";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsvos-served-"));
const fetchTo = async (rel) => {
  const res = await fetch(new URL(rel, base));
  if (!res.ok) throw new Error(`${rel} -> HTTP ${res.status}`);
  const text = await res.text();
  const out = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  return out;
};

globalThis.location = { origin: new URL(base).origin, hash: "#/overview" };

// Fetch the whole bundle, exactly as a browser would request it.
for (const rel of [
  "index.html", "app.js", "styles.css",
  "lib/rpc.js", "lib/ui.js", "lib/notify.js",
  "views/common.js", "views/wallet.js", "views/money.js", "views/social.js",
  "views/apps.js", "views/work.js", "views/inscribe.js", "views/twetch.js",
  "views/setup.js",
]) {
  await fetchTo(rel);
}

// Mirror app.js's own construction, from the served module graph.
const wallet = await import(path.join(tmp, "views/wallet.js"));
const money = await import(path.join(tmp, "views/money.js"));
const social = await import(path.join(tmp, "views/social.js"));
const apps = await import(path.join(tmp, "views/apps.js"));
const work = await import(path.join(tmp, "views/work.js"));
const { inscribe } = await import(path.join(tmp, "views/inscribe.js"));
const { setup } = await import(path.join(tmp, "views/setup.js"));
const twetch = await import(path.join(tmp, "views/twetch.js"));

console.log("module default-export sizes as served:");
for (const [name, mod] of [
  ["wallet", wallet], ["money", money], ["social", social],
  ["apps", apps], ["work", work], ["twetch", twetch],
]) {
  const d = mod.default;
  console.log(`  ${name.padEnd(8)} default=${Array.isArray(d) ? `array(${d.length})` : typeof d}`);
  if (Array.isArray(d)) {
    d.forEach((v, i) => {
      if (!v) console.log(`     [${i}] UNDEFINED/EMPTY ENTRY`);
      else if (!v.id || !v.group) console.log(`     [${i}] id=${JSON.stringify(v.id)} group=${JSON.stringify(v.group)}`);
    });
  }
}

const VIEWS = [setup, ...wallet.default, ...money.default, inscribe, ...social.default, ...twetch.default, ...apps.default, ...work.default];
console.log(`\nVIEWS length: ${VIEWS.length}`);
const bad = VIEWS.map((v, i) => [i, v]).filter(([, v]) => !v || !v.id || !v.group);
if (bad.length) {
  console.log("PROBLEM ENTRIES (these render as an empty nav row):");
  for (const [i, v] of bad) console.log(`  [${i}]`, v === undefined ? "undefined" : JSON.stringify({ id: v.id, group: v.group }));
} else {
  console.log("all VIEWS entries have an id and a group");
}
const ids = VIEWS.map((v) => v?.id);
const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
console.log("duplicate ids:", dupes.length ? [...new Set(dupes)] : "none");
fs.rmSync(tmp, { recursive: true, force: true });
