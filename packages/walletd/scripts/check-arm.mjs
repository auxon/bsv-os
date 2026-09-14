#!/usr/bin/env node
/**
 * ARM-proofing guard: every native dependency must publish a linux-arm64
 * prebuild for its pinned version (fallback compile needs a toolchain the
 * installer may not have). Network-dependent — run in CI, not unit tests.
 *
 * Usage: node scripts/check-arm.mjs [--write]   (writes scripts/arm-known-good.json)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/package.json`);
const pkg = require("./package.json");
const NATIVE = ["better-sqlite3", "keytar"];
const REPO = {
  "better-sqlite3": "WiseLibs/better-sqlite3",
  "keytar": "atom/node-keytar",
};

function pinnedVersion(dep) {
  // Prefer the actually-installed version (caret ranges drift); fall back to the range floor.
  try {
    const installed = require(`${dep}/package.json`);
    if (installed?.version) return `v${installed.version}`;
  } catch {
    /* ignore */
  }
  const raw = { ...pkg.dependencies, ...pkg.devDependencies }[dep] ?? "";
  const m = raw.match(/(\d+\.\d+\.\d+)/);
  if (!m) throw new Error(`cannot parse pin for ${dep}: ${raw}`);
  return `v${m[1]}`;
}

const results = {};
for (const dep of NATIVE) {
  const tag = pinnedVersion(dep);
  const url = `https://api.github.com/repos/${REPO[dep]}/releases/tags/${tag}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) {
    results[dep] = { tag, ok: false, reason: `release lookup ${res.status}` };
    continue;
  }
  const names = ((await res.json()).assets ?? []).map((a) => a.name);
  const hit = names.find((n) => n.includes("linux-arm64") && !n.includes("electron"));
  results[dep] = hit ? { tag, ok: true, asset: hit } : { tag, ok: false, reason: "no linux-arm64 prebuild" };
}

console.log(JSON.stringify(results, null, 2));
if (process.argv.includes("--write")) {
  writeFileSync(new URL("./arm-known-good.json", import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
}
if (Object.values(results).some((r) => !r.ok)) process.exit(1);
