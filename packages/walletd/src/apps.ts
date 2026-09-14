import type { Knex } from "knex";

/**
 * Metanet app runtime foundation: install web apps as native citizens.
 *
 * Model (BRC-116-shaped): an app is a domain serving `/manifest.json` with a
 * `metanet` namespace (permissions, baskets, protocols). Installing pins the
 * manifest, seeds its permission requests into the policy engine, and drops
 * a `.desktop` launcher — from then on it opens, prompts, and spends exactly
 * like a native app. The sandboxed webview shell that injects `window.bsv`
 * (BRC-100 bridge) is the P-next layer and talks to this same registry.
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
  const startUrl = absoluteUrl(origin, String(m.start_url ?? "/"));
  if (!startUrl) throw new Error("manifest.start_url must resolve to https");
  if (!startUrl.startsWith(`${origin}/`)) throw new Error("start_url escapes the app origin");
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
    });
  }
}

export async function listApps(db: Knex): Promise<AppRecord[]> {
  const rows = (await db("apps").select().orderBy("name")) as Array<{
    domain: string; name: string; start_url: string; icon: string | null;
    spend_cap_sats: number; installed_at: number;
  }>;
  return rows.map((r) => ({
    domain: r.domain, name: r.name, startUrl: r.start_url, icon: r.icon,
    spendCapSats: r.spend_cap_sats, installedAt: r.installed_at,
  }));
}

export async function getApp(db: Knex, domain: string): Promise<AppRecord | null> {
  const r = (await db("apps").where({ domain }).first()) as {
    domain: string; name: string; start_url: string; icon: string | null;
    spend_cap_sats: number; installed_at: number;
  } | undefined;
  if (!r) return null;
  return {
    domain: r.domain, name: r.name, startUrl: r.start_url, icon: r.icon,
    spendCapSats: r.spend_cap_sats, installedAt: r.installed_at,
  };
}

export async function saveApp(db: Knex, domain: string, v: Omit<AppRecord, "domain" | "installedAt">): Promise<void> {
  await db("apps")
    .insert({
      domain, name: v.name, start_url: v.startUrl, icon: v.icon,
      spend_cap_sats: v.spendCapSats, installed_at: Date.now(),
    })
    .onConflict("domain")
    .merge({
      name: v.name, start_url: v.startUrl, icon: v.icon,
      spend_cap_sats: v.spendCapSats, installed_at: Date.now(),
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
  opts: { fetchManifest?: (domain: string) => Promise<unknown> } = {},
): Promise<{ app: AppRecord; asked: { spendCapSats: number; protocols: number; baskets: number; certs: number } }> {
  const clean = domain.toLowerCase().trim().replace(/^https?:\/\//, "").split("/")[0]!;
  const manifest = await (opts.fetchManifest ?? fetchManifest)(clean);
  const v = validateManifest(clean, manifest);
  await saveApp(db, clean, {
    name: v.name, startUrl: v.startUrl, icon: v.icon, spendCapSats: v.spendCapSats,
  });
  await hooks.seedPolicyRequest(clean, v.spendCapSats, "app-install");
  const app = (await getApp(db, clean))!;
  return { app, asked: { spendCapSats: v.spendCapSats, protocols: v.protocols, baskets: v.baskets, certs: v.certs } };
}
