import type { D1Database } from "./d1-types.ts";
import type { ListingPermissions } from "./listing.ts";
import type { ListingQuery, ListingStore, StoredLicense, StoredListing } from "./lookup.ts";

interface ListingRow {
  outpoint: string;
  txid: string;
  vout: number;
  name: string;
  version: string;
  domain: string;
  url: string;
  category: string;
  blurb: string;
  bundle_hash: string;
  manifest_hash: string;
  publisher_key: string;
  price_sats: number;
  permissions_json: string;
  signature: string;
  spent: number;
  created_at: number;
}

interface LicenseRow {
  listing_outpoint: string;
  payment_txid: string;
  buyer_key: string | null;
  bundle_hash: string;
  publisher_sats: number;
  store_sats: number;
  created_at: number;
}

function toListing(r: ListingRow): StoredListing {
  return {
    outpoint: r.outpoint,
    txid: r.txid,
    vout: r.vout,
    name: r.name,
    version: r.version,
    domain: r.domain,
    url: r.url,
    category: r.category,
    blurb: r.blurb,
    bundleHash: r.bundle_hash,
    manifestHash: r.manifest_hash,
    publisherKey: r.publisher_key,
    priceSats: r.price_sats,
    permissions: JSON.parse(r.permissions_json) as ListingPermissions,
    signature: r.signature,
    spent: r.spent === 1,
    createdAt: r.created_at,
  };
}

function toLicense(r: LicenseRow): StoredLicense {
  return {
    listingOutpoint: r.listing_outpoint,
    paymentTxid: r.payment_txid,
    buyerKey: r.buyer_key,
    bundleHash: r.bundle_hash,
    publisherSats: r.publisher_sats,
    storeSats: r.store_sats,
    createdAt: r.created_at,
  };
}

export class D1ListingStore implements ListingStore {
  db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }

  async get(outpoint: string): Promise<StoredListing | null> {
    const r = await this.db.prepare("SELECT * FROM listings WHERE outpoint = ?").bind(outpoint).first<ListingRow>();
    return r ? toListing(r) : null;
  }

  async liveByDomain(domain: string): Promise<StoredListing | null> {
    const r = await this.db
      .prepare("SELECT * FROM listings WHERE domain = ? AND spent = 0 ORDER BY created_at DESC LIMIT 1")
      .bind(domain.toLowerCase())
      .first<ListingRow>();
    return r ? toListing(r) : null;
  }

  async put(row: StoredListing): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO listings (
          outpoint, txid, vout, name, version, domain, url, category, blurb,
          bundle_hash, manifest_hash, publisher_key, price_sats, permissions_json,
          signature, spent, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.outpoint,
        row.txid,
        row.vout,
        row.name,
        row.version,
        row.domain,
        row.url,
        row.category,
        row.blurb,
        row.bundleHash,
        row.manifestHash,
        row.publisherKey,
        row.priceSats,
        JSON.stringify(row.permissions),
        row.signature,
        row.spent ? 1 : 0,
        row.createdAt,
      )
      .run();
  }

  async markSpent(outpoint: string): Promise<void> {
    await this.db.prepare("UPDATE listings SET spent = 1 WHERE outpoint = ?").bind(outpoint).run();
  }

  async search(q: ListingQuery): Promise<StoredListing[]> {
    const where: string[] = [];
    const bind: Array<string | number> = [];
    if (!q.includeSpent) where.push("spent = 0");
    if (q.domain) {
      where.push("domain = ?");
      bind.push(q.domain.toLowerCase());
    }
    if (q.publisher) {
      where.push("publisher_key = ?");
      bind.push(q.publisher.toLowerCase());
    }
    if (q.category) {
      where.push("category = ?");
      bind.push(q.category.toLowerCase());
    }
    if (q.name) {
      where.push("(LOWER(name) LIKE ? OR domain = ?)");
      const n = q.name.toLowerCase();
      bind.push(`%${n}%`, n);
    }
    const sql = `SELECT * FROM listings${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY name`;
    const res = await this.db
      .prepare(sql)
      .bind(...bind)
      .all<ListingRow>();
    return (res.results ?? []).map(toListing);
  }

  async putLicense(row: StoredLicense): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO licenses (
          listing_outpoint, payment_txid, buyer_key, bundle_hash, publisher_sats, store_sats, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.listingOutpoint,
        row.paymentTxid.toLowerCase(),
        row.buyerKey,
        row.bundleHash,
        row.publisherSats,
        row.storeSats,
        row.createdAt,
      )
      .run();
  }

  async licenseByPayment(txid: string): Promise<StoredLicense | null> {
    const r = await this.db
      .prepare("SELECT * FROM licenses WHERE payment_txid = ?")
      .bind(txid.toLowerCase())
      .first<LicenseRow>();
    return r ? toLicense(r) : null;
  }

  async licensesFor(listingOutpoint: string): Promise<StoredLicense[]> {
    const res = await this.db
      .prepare("SELECT * FROM licenses WHERE listing_outpoint = ? ORDER BY created_at DESC")
      .bind(listingOutpoint)
      .all<LicenseRow>();
    return (res.results ?? []).map(toLicense);
  }
}
