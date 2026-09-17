import type { Knex } from "knex";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { get as httpsGet } from "node:https";
import path from "node:path";

/**
 * Metanet app runtime foundation: install web apps as native citizens.
 *
 * Model (BRC-116-shaped): an app is a domain serving `/manifest.json` with a
 * `metanet` namespace (permissions, baskets, protocols). Installing pins the
 * manifest (sha256 + copy), seeds its permission requests into the policy
 * engine, and drops a `.desktop` launcher — from then on it opens in the
 * sandboxed runner, prompts, and spends exactly like a native app.
 *
 * F1 store: installs pin the manifest; `checkAppUpdates`/`applyAppUpdate`
 * re-pin against the live manifest. Narrower-or-equal updates apply
 * silently; permission widening needs explicit re-approval
 * (`bsv app update <domain> --approve-widening`) and otherwise seeds a
 * policy request so the shell can prompt — apps can never silently grant
 * themselves more.
 */

export interface AppManifest {
  name: string;
  short_name?: string;
  start_url: string;
  icons?: Array<{ src: string; sizes?: string; type?: string }>;
  metanet?: {
    schemaVersion?: string;
    groupPermissions?: {
      description?: string;
      spendingAuthorization?: { amount?: number; description?: string };
      protocolPermissions?: unknown[];
      basketAccess?: unknown[];
      certificateAccess?: unknown[];
    };
    counterpartyPermissions?: unknown;
  };
}

export interface AppRecord {
  domain: string;
  name: string;
  startUrl: string;
  icon: string | null;
  spendCapSats: number;
  installedAt: number;
  manifestSha256: string | null;
  updatedAt: number;
}

export interface AppAsked {
  spendCapSats: number;
  protocols: number;
  baskets: number;
  certs: number;
}

/** Canonical JSON for manifest pinning (key order must not affect the hash). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function manifestSha256(manifest: unknown): string {
  return createHash("sha256").update(stableStringify(manifest), "utf8").digest("hex");
}

export function appIdFor(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function absoluteUrl(base: string, ref: string): string | null {
  try {
    const u = new URL(ref, base);
    if (u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Validate a fetched manifest. Returns normalized record fields or throws. */
export function validateManifest(domain: string, manifest: unknown): {
  name: string;
  startUrl: string;
  icon: string | null;
  spendCapSats: number;
  protocols: number;
  baskets: number;
  certs: number;
} {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest is not an object");
  const m = manifest as Record<string, unknown>;
  const name = String(m.name ?? "").trim();
  if (!name) throw new Error("manifest.name is required");
  if (name.length > 80) throw new Error("manifest.name too long");
  const origin = `https://${domain}`;
  // Hostname comparison (not string prefix): apps may serve an explicit
  // port (e.g. loopback dev demos) but must never escape their own host.
  let startParsed: URL;
  try {
    startParsed = new URL(String(m.start_url ?? "/"), origin);
  } catch {
    throw new Error("manifest.start_url is not a URL");
  }
  if (startParsed.protocol !== "https:") throw new Error("manifest.start_url must resolve to https");
  if (startParsed.hostname.toLowerCase() !== domain.toLowerCase()) {
    throw new Error("start_url escapes the app origin");
  }
  const startUrl = startParsed.toString();
  let icon: string | null = null;
  if (Array.isArray(m.icons)) {
    for (const ic of m.icons as Array<Record<string, unknown>>) {
      const src = absoluteUrl(origin, String(ic?.src ?? ""));
      if (src) {
        icon = src;
        break;
      }
    }
  }
  const metanet = (m.metanet ?? {}) as NonNullable<AppManifest["metanet"]>;
  const gp = metanet.groupPermissions ?? {};
  const spendCapSats = Math.max(0, Math.floor(Number(gp.spendingAuthorization?.amount) || 0));
  return {
    name: name.slice(0, 80),
    startUrl,
    icon,
    spendCapSats,
    protocols: Array.isArray(gp.protocolPermissions) ? gp.protocolPermissions.length : 0,
    baskets: Array.isArray(gp.basketAccess) ? gp.basketAccess.length : 0,
    certs: Array.isArray(gp.certificateAccess) ? gp.certificateAccess.length : 0,
  };
}

export async function fetchManifestFrom(url: string): Promise<unknown> {
  // Loopback demos (serve.mjs) use throwaway self-signed certs. Trust is
  // scoped to loopback hosts only: 127.0.0.1 traffic never leaves the
  // machine, and anyone who can MITM it already owns the daemon socket —
  // the same trust domain. Everything else keeps full chain validation.
  if (isLoopbackHost(safeHostname(url))) return fetchLoopbackManifest(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Exported for tests. Any loopback address counts: 127.0.0.0/8, ::1, localhost. */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function fetchLoopbackManifest(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(
      url,
      { rejectUnauthorized: false, timeout: 15000, headers: { accept: "application/json" } },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`manifest fetch failed (${res.statusCode})`));
          res.resume();
          return;
        }
        let raw = "";
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
          if (raw.length > 1_000_000) req.destroy(new Error("manifest too large"));
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error("manifest is not JSON"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("manifest fetch timed out")));
    req.on("error", reject);
  });
}

export async function fetchManifest(domain: string): Promise<unknown> {
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(domain) || domain.length > 253) {
    throw new Error("invalid domain");
  }
  return fetchManifestFrom(`https://${domain}/manifest.json`);
}


export async function migrateApps(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("apps"))) {
    await db.schema.createTable("apps", (t) => {
      t.string("domain", 253).primary();
      t.string("name", 80).notNullable();
      t.text("start_url").notNullable();
      t.text("icon").nullable();
      t.integer("spend_cap_sats").notNullable().defaultTo(0);
      t.integer("installed_at").notNullable();
      t.string("manifest_sha256", 64).nullable();
      t.text("manifest_json").nullable();
      t.integer("updated_at").notNullable().defaultTo(0);
    });
    return;
  }
  for (const [col, ddl] of [
    ["manifest_sha256", (t: Knex.CreateTableBuilder) => t.string("manifest_sha256", 64).nullable()],
    ["manifest_json", (t: Knex.CreateTableBuilder) => t.text("manifest_json").nullable()],
    ["updated_at", (t: Knex.CreateTableBuilder) => t.integer("updated_at").notNullable().defaultTo(0)],
  ] as Array<[string, (t: Knex.CreateTableBuilder) => void]>) {
    if (!(await db.schema.hasColumn("apps", col))) {
      await db.schema.alterTable("apps", (t) => ddl(t));
    }
  }
}

interface AppRow {
  domain: string; name: string; start_url: string; icon: string | null;
  spend_cap_sats: number; installed_at: number;
  manifest_sha256: string | null; manifest_json: string | null; updated_at: number;
}

function toRecord(r: AppRow): AppRecord {
  return {
    domain: r.domain, name: r.name, startUrl: r.start_url, icon: r.icon,
    spendCapSats: r.spend_cap_sats, installedAt: r.installed_at,
    manifestSha256: r.manifest_sha256 ?? null, updatedAt: r.updated_at ?? 0,
  };
}

export async function listApps(db: Knex): Promise<AppRecord[]> {
  const rows = (await db("apps").select().orderBy("name")) as AppRow[];
  return rows.map(toRecord);
}

export async function getApp(db: Knex, domain: string): Promise<AppRecord | null> {
  const r = (await db("apps").where({ domain }).first()) as AppRow | undefined;
  if (!r) return null;
  return toRecord(r);
}

export async function saveApp(db: Knex, domain: string, v: Omit<AppRecord, "domain" | "installedAt" | "updatedAt"> & { manifestJson?: string | null }): Promise<void> {
  const now = Date.now();
  await db("apps")
    .insert({
      domain, name: v.name, start_url: v.startUrl, icon: v.icon,
      spend_cap_sats: v.spendCapSats, installed_at: now,
      manifest_sha256: v.manifestSha256 ?? null, manifest_json: v.manifestJson ?? null,
      updated_at: now,
    })
    .onConflict("domain")
    .merge({
      name: v.name, start_url: v.startUrl, icon: v.icon,
      spend_cap_sats: v.spendCapSats,
      manifest_sha256: v.manifestSha256 ?? null, manifest_json: v.manifestJson ?? null,
      updated_at: now,
    });
}

export async function removeApp(db: Knex, domain: string): Promise<boolean> {
  return (await db("apps").where({ domain }).delete()) > 0;
}

/**
 * Install: fetch + validate + pin + seed permission requests.
 * Returns the record plus a human summary of what the app asked for.
 */
export async function installApp(
  db: Knex,
  domain: string,
  hooks: {
    seedPolicyRequest(origin: string, amountSats: number, action: string): Promise<void>;
  },
  opts: { fetchManifest?: (domain: string) => Promise<unknown>; manifestJson?: unknown } = {},
): Promise<{ app: AppRecord; asked: AppAsked }> {
  const clean = domain.toLowerCase().trim().replace(/^https?:\/\//, "").split("/")[0]!;
  // manifestJson is the dev-install path (`bsv app install --manifest-file`):
  // same validation, network fetch skipped.
  const manifest = opts.manifestJson !== undefined
    ? opts.manifestJson
    : await (opts.fetchManifest ?? fetchManifest)(clean);
  const v = validateManifest(clean, manifest);
  await saveApp(db, clean, {
    name: v.name, startUrl: v.startUrl, icon: v.icon, spendCapSats: v.spendCapSats,
    manifestSha256: manifestSha256(manifest), manifestJson: stableStringify(manifest),
  });
  await hooks.seedPolicyRequest(clean, v.spendCapSats, "app-install");
  const app = (await getApp(db, clean))!;
  return { app, asked: { spendCapSats: v.spendCapSats, protocols: v.protocols, baskets: v.baskets, certs: v.certs } };
}

/** Compare live permissions against the pin. Any increase is a widening. */
export function diffPermissions(pinned: AppAsked, live: AppAsked): { widened: boolean; changes: string[] } {
  const changes: string[] = [];
  const bump = (label: string, a: number, b: number, unit: string) => {
    if (b > a) changes.push(`${label} widened: ${a} → ${b} ${unit}`);
    else if (b < a) changes.push(`${label} narrowed: ${a} → ${b} ${unit}`);
  };
  bump("spend cap", pinned.spendCapSats, live.spendCapSats, "sats");
  bump("protocols", pinned.protocols, live.protocols, "grants");
  bump("baskets", pinned.baskets, live.baskets, "grants");
  bump("certs", pinned.certs, live.certs, "grants");
  return {
    widened:
      live.spendCapSats > pinned.spendCapSats ||
      live.protocols > pinned.protocols ||
      live.baskets > pinned.baskets ||
      live.certs > pinned.certs,
    changes,
  };
}

export type UpdateStatus = "current" | "available" | "widened" | "unreachable" | "invalid" | "adopted";

export interface UpdateCheck {
  domain: string;
  name: string;
  status: UpdateStatus;
  live: AppAsked | null;
  changes: string[];
}

/** Manifest fetcher: domain for identity, url for transport. */
export type ManifestFetch = (domain: string, url?: string) => Promise<unknown>;

/** Manifest URL follows the installed start_url (host + explicit port). */
export function manifestUrlFor(app: Pick<AppRecord, "domain" | "startUrl">): string {
  try {
    const u = new URL(app.startUrl);
    if (u.protocol === "https:") return `${u.protocol}//${u.host}/manifest.json`;
  } catch {
    /* fall through to the default */
  }
  return `https://${app.domain}/manifest.json`;
}

const defaultFetch: ManifestFetch = (domain, url) => fetchManifestFrom(url ?? `https://${domain}/manifest.json`);

async function fetchValidated(
  fetchFn: ManifestFetch,
  domain: string,
  url: string,
): Promise<{ ok: true; manifest: unknown; asked: AppAsked } | { ok: false; status: "unreachable" | "invalid" }> {
  let manifest: unknown;
  try {
    manifest = await fetchFn(domain, url);
  } catch {
    return { ok: false, status: "unreachable" };
  }
  try {
    const v = validateManifest(domain, manifest);
    return {
      ok: true, manifest,
      asked: { spendCapSats: v.spendCapSats, protocols: v.protocols, baskets: v.baskets, certs: v.certs },
    };
  } catch {
    return { ok: false, status: "invalid" };
  }
}

/** Read-only re-pin check over every installed app. Never writes. */
export async function checkAppUpdates(
  db: Knex,
  opts: { fetchManifest?: ManifestFetch } = {},
): Promise<UpdateCheck[]> {
  const fetchFn = opts.fetchManifest ?? defaultFetch;
  const apps = await listApps(db);
  const out: UpdateCheck[] = [];
  for (const app of apps) {
    const live = await fetchValidated(fetchFn, app.domain, manifestUrlFor(app));
    if (!live.ok) {
      out.push({ domain: app.domain, name: app.name, status: live.status, live: null, changes: [] });
      continue;
    }
    const row = (await db("apps").where({ domain: app.domain }).first()) as AppRow | undefined;
    const cmp = comparePin(app, row, live.asked);
    out.push({ domain: app.domain, name: app.name, status: cmp.status, live: live.asked, changes: cmp.changes });
  }
  return out;
}

function askedFromManifest(manifest: unknown, fallback: AppRecord): AppAsked {
  try {
    const v = validateManifest(fallback.domain, manifest);
    return { spendCapSats: v.spendCapSats, protocols: v.protocols, baskets: v.baskets, certs: v.certs };
  } catch {
    return { spendCapSats: fallback.spendCapSats, protocols: 0, baskets: 0, certs: 0 };
  }
}

/** Shared pin comparison for the update check and the store listing. */function comparePin(
  app: AppRecord,
  row: AppRow | undefined,
  liveAsked: AppAsked,
): { status: UpdateStatus; changes: string[] } {
  const pinnedJson = row?.manifest_json ?? null;
  if (!pinnedJson || !row?.manifest_sha256) {
    return { status: "adopted", changes: ["no pin yet — first check adopts it"] };
  }
  const diff = diffPermissions(askedFromManifest(JSON.parse(pinnedJson), app), liveAsked);
  return {
    status: diff.changes.length === 0 ? "current" : diff.widened ? "widened" : "available",
    changes: diff.changes,
  };
}

export interface CatalogApp {
  domain: string;
  name: string;
  blurb: string;
  devOnly?: boolean;
}

export interface StoreEntry {
  domain: string;
  name: string;
  blurb: string;
  devOnly: boolean;
  inCatalog: boolean;
  installed: boolean;
  installedCapSats: number;
  status: UpdateStatus | "not-installed";
  live: AppAsked | null;
  changes: string[];
}

/** Curated catalog: packaged file first, repo checkout second, empty offline. */
export function readCatalog(): { version: number; apps: CatalogApp[] } {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    "/usr/share/bsv-os/runner/store.json",
    path.resolve(here, "..", "..", "runner", "store.json"),
    path.resolve(here, "..", "runner", "store.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        version?: unknown; apps?: Array<Record<string, unknown>>;
      };
      const apps = (Array.isArray(raw.apps) ? raw.apps : [])
        .filter((a) => typeof a?.domain === "string" && typeof a?.name === "string")
        .map((a) => ({
          domain: String(a.domain).toLowerCase(),
          name: String(a.name).slice(0, 80),
          blurb: typeof a.blurb === "string" ? String(a.blurb).slice(0, 280) : "",
          devOnly: a.devOnly === true,
        }));
      return { version: typeof raw.version === "number" ? raw.version : 1, apps };
    } catch {
      /* next candidate */
    }
  }
  return { version: 1, apps: [] };
}

/**
 * F1 store listing: curated catalog merged with installed records and
 * live permission data. Requested caps are shown pre-install; installed
 * apps carry their re-pin status so the shell can offer one-tap
 * install/remove/update.
 */
export async function storeList(
  db: Knex,
  opts: { fetchManifest?: ManifestFetch } = {},
): Promise<StoreEntry[]> {
  const fetchFn = opts.fetchManifest ?? defaultFetch;
  const catalog = readCatalog();
  const installed = new Map((await listApps(db)).map((a) => [a.domain, a]));
  const seen = new Set<string>();
  const out: StoreEntry[] = [];
  const entries: Array<CatalogApp & { inCatalog: boolean }> = [
    ...catalog.apps.map((a) => ({ ...a, inCatalog: true })),
    ...[...installed.values()]
      .filter((a) => !catalog.apps.some((c) => c.domain === a.domain))
      .map((a) => ({ domain: a.domain, name: a.name, blurb: "", devOnly: false, inCatalog: false })),
  ];
  for (const e of entries) {
    if (seen.has(e.domain)) continue;
    seen.add(e.domain);
    const rec = installed.get(e.domain);
    const url = rec ? manifestUrlFor(rec) : `https://${e.domain}/manifest.json`;
    const live = await fetchValidated(fetchFn, e.domain, url);
    if (!rec) {
      out.push({
        domain: e.domain, name: e.name, blurb: e.blurb, devOnly: e.devOnly === true,
        inCatalog: e.inCatalog, installed: false, installedCapSats: 0,
        status: live.ok ? "not-installed" : live.status,
        live: live.ok ? live.asked : null, changes: [],
      });
      continue;
    }
    const row = (await db("apps").where({ domain: e.domain }).first()) as AppRow | undefined;
    if (!live.ok) {
      out.push({
        domain: e.domain, name: rec.name, blurb: e.blurb, devOnly: e.devOnly === true,
        inCatalog: e.inCatalog, installed: true, installedCapSats: rec.spendCapSats,
        status: live.status, live: null, changes: [],
      });
      continue;
    }
    const cmp = comparePin(rec, row, live.asked);
    out.push({
      domain: e.domain, name: rec.name, blurb: e.blurb, devOnly: e.devOnly === true,
      inCatalog: e.inCatalog, installed: true, installedCapSats: rec.spendCapSats,
      status: cmp.status, live: live.asked, changes: cmp.changes,
    });
  }
  return out;
}

/**
 * Apply one re-pin. Narrower-or-equal updates (and first-time adoptions)
 * apply silently; widening needs `approveWidening` and otherwise seeds an
 * `app-update` policy request so the shell prompts — the diff, not just a
 * version bump, is what the human approves.
 */
export async function applyAppUpdate(
  db: Knex,
  domain: string,
  hooks: {
    seedPolicyRequest(origin: string, amountSats: number, action: string): Promise<void>;
  },
  opts: { fetchManifest?: ManifestFetch; approveWidening?: boolean } = {},
): Promise<{ domain: string; applied: boolean; status: UpdateStatus; changes: string[] }> {
  const clean = domain.toLowerCase().trim().replace(/^https?:\/\//, "").split("/")[0]!;
  const app = await getApp(db, clean);
  if (!app) throw Object.assign(new Error(`not installed: ${clean}`), { code: "NOT_FOUND" });
  const live = await fetchValidated(opts.fetchManifest ?? defaultFetch, clean, manifestUrlFor(app));
  if (!live.ok) return { domain: clean, applied: false, status: live.status, changes: [] };
  const v = validateManifest(clean, live.manifest);
  const row = (await db("apps").where({ domain: clean }).first()) as AppRow | undefined;
  const pinnedJson = row?.manifest_json ?? null;
  if (!pinnedJson || !row?.manifest_sha256) {
    await saveApp(db, clean, {
      name: v.name, startUrl: v.startUrl, icon: v.icon, spendCapSats: v.spendCapSats,
      manifestSha256: manifestSha256(live.manifest), manifestJson: stableStringify(live.manifest),
    });
    return { domain: clean, applied: true, status: "adopted", changes: ["no pin yet — adopted live manifest"] };
  }
  const diff = diffPermissions(askedFromManifest(JSON.parse(pinnedJson), app), {
    spendCapSats: v.spendCapSats, protocols: v.protocols, baskets: v.baskets, certs: v.certs,
  });
  if (diff.changes.length === 0) return { domain: clean, applied: false, status: "current", changes: [] };
  if (diff.widened && !opts.approveWidening) {
    await hooks.seedPolicyRequest(clean, v.spendCapSats, "app-update");
    return { domain: clean, applied: false, status: "widened", changes: diff.changes };
  }
  await saveApp(db, clean, {
    name: v.name, startUrl: v.startUrl, icon: v.icon, spendCapSats: v.spendCapSats,
    manifestSha256: manifestSha256(live.manifest), manifestJson: stableStringify(live.manifest),
  });
  return { domain: clean, applied: true, status: diff.widened ? "widened" : "available", changes: diff.changes };
}
