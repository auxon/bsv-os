-- tm_bsvos_apps / ls_bsvos_apps
-- One listing token type. Install payments are receipts, not a second token.

CREATE TABLE listings (
  outpoint TEXT PRIMARY KEY,
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  domain TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  blurb TEXT NOT NULL DEFAULT '',
  bundle_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  publisher_key TEXT NOT NULL,
  price_sats INTEGER NOT NULL,
  permissions_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX listings_domain ON listings (domain);
CREATE INDEX listings_publisher ON listings (publisher_key);
CREATE INDEX listings_name ON listings (name);
CREATE INDEX listings_category ON listings (category);
CREATE INDEX listings_live ON listings (spent, domain);

CREATE TABLE licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_outpoint TEXT NOT NULL,
  payment_txid TEXT NOT NULL,
  buyer_key TEXT,
  bundle_hash TEXT NOT NULL,
  publisher_sats INTEGER NOT NULL,
  store_sats INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (payment_txid)
);

CREATE INDEX licenses_listing ON licenses (listing_outpoint);
