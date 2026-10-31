// Matches wrangler.jsonc. Re-run `npx wrangler types` after the D1 database
// is created and the binding id is real.
interface Env {
  DB: D1Database;
  TOPIC: string;
  LOOKUP: string;
  STORE_ADDRESS: string;
  STORE_PUBKEY: string;
  PUBLISHING_FEE_SATS: string;
  STORE_CUT_BPS: string;
}
