#!/usr/bin/env node
/**
 * Convert packages/runner/store.json into unsigned listing-token drafts.
 *
 * Does not broadcast. Real listings still need:
 *   - a publisher identity key (BRC-100) and signature
 *   - bundle hashes (computed here for bundled runner apps)
 *   - a store-controlled publishing-fee output
 *   - per-app hostnames (this script uses the catalog URL host; shared
 *     localhost / 127.0.0.1 rows are emitted as drafts and flagged)
 *
 * Usage:
 *   node --experimental-strip-types scripts/migrate-store.mjs
 *   node --experimental-strip-types scripts/migrate-store.mjs --out /tmp/listings.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleHash, manifestHash, sha256Hex } from "../src/hash.ts";
import { isSharedIdentityHost } from "../src/protocol.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const storePath = path.resolve(repo, "packages/runner/store.json");
const appsRoot = path.resolve(repo, "packages/runner/apps");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;

function walkFiles(dir, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(dir, next));
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

function slugFromUrl(url, domain) {
  try {
    const p = new URL(url ?? `https://${domain}/`).pathname.replace(/\/+$/, "");
    return p.split("/").filter(Boolean)[0] ?? domain.split(".")[0];
  } catch {
    return domain.split(".")[0];
  }
}

const catalog = JSON.parse(fs.readFileSync(storePath, "utf8"));
const drafts = [];

for (const app of catalog.apps ?? []) {
  const domain = String(app.domain ?? "").toLowerCase();
  const url = app.url ?? `https://${domain}/`;
  const slug = slugFromUrl(url, domain);
  const appDir = path.join(appsRoot, slug);
  let files = [];
  let bundle = null;
  let manifest = null;
  let manifestSha = null;
  if (fs.existsSync(path.join(appDir, "manifest.json"))) {
    const names = walkFiles(appDir);
    files = await Promise.all(names.map(async (rel) => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(appDir, rel)));
      return { path: rel, sha256: await sha256Hex(bytes) };
    }));
    bundle = await bundleHash(files);
    manifest = JSON.parse(fs.readFileSync(path.join(appDir, "manifest.json"), "utf8"));
    manifestSha = await manifestHash(manifest);
  }
  const shared = isSharedIdentityHost(domain);
  drafts.push({
    v: 1,
    type: "listing",
    name: app.name,
    version: "1.0.0",
    domain,
    url,
    category: "",
    blurb: app.blurb ?? "",
    bundleHash: bundle,
    manifestHash: manifestSha,
    publisherKey: null,
    priceSats: 0,
    permissions: {
      spendCapSats: manifest?.metanet?.groupPermissions?.spendingAuthorization?.amount ?? 0,
      protocols: manifest?.metanet?.groupPermissions?.protocolPermissions?.length ?? 0,
      baskets: manifest?.metanet?.groupPermissions?.basketAccess?.length ?? 0,
      certs: manifest?.metanet?.groupPermissions?.certificateAccess?.length ?? 0,
      intents: (manifest?.metanet?.intents ?? []).map((i) => i.action).filter(Boolean),
    },
    signature: null,
    files: files.length ? files : undefined,
    ready: Boolean(bundle && manifestSha && !shared),
    blockers: [
      shared ? "shared identity host — give this app its own subdomain before listing" : null,
      bundle ? null : "no local bundle to hash (remote catalog entry)",
      "publisherKey + signature required",
      "publishing-fee output to the store address required at submit",
    ].filter(Boolean),
  });
}

const report = {
  source: storePath,
  topic: "tm_bsvos_apps",
  note: "Unsigned drafts. Sign with the publisher BRC-100 identity key, then submit to tm_bsvos_apps with the publishing fee.",
  listings: drafts,
};

const text = JSON.stringify(report, null, 2);
if (outFile) fs.writeFileSync(outFile, `${text}\n`);
else console.log(text);
