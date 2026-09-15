import knex, { type Knex } from "knex";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateApps } from "./apps.ts";
import { migrateGigs } from "./gigs.ts";
import { migratePolicy } from "./policy.ts";
import { migrateAgents } from "./agents.ts";
import { migrateBaskets } from "./baskets.ts";
import { migrateCerts } from "./certs.ts";
import { migrateMsgs } from "./msgs.ts";
import { migrateRecovery } from "./recovery.ts";
import { migrateX402 } from "./x402.ts";

export function dataDir(): string {
  const dir =
    process.env.BSV_WALLETD_DATA ??
    path.join(os.homedir(), ".local/share/bsv-os");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function openDb(filename = "walletd.sqlite"): Knex {
  const db = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(dataDir(), filename) },
    useNullAsDefault: true,
  });
  return db;
}

export async function migrate(db: Knex): Promise<void> {
  const has = await db.schema.hasTable("pending_txs");
  if (!has) {
    await db.schema.createTable("pending_txs", (t) => {
      t.string("txid", 64).primary();
      t.text("label").notNullable().defaultTo("");
      t.string("status").notNullable().defaultTo("seen"); // seen|mined|failed
      t.integer("attempts").notNullable().defaultTo(0);
      t.integer("last_check").notNullable().defaultTo(0);
      t.integer("created_at").notNullable();
      t.text("detail").nullable();
      t.text("tx_hex").nullable();
    });
  } else if (!(await db.schema.hasColumn("pending_txs", "tx_hex"))) {
    await db.schema.alterTable("pending_txs", (t) => {
      t.text("tx_hex").nullable();
    });
  }
  await migratePolicy(db);
  await migrateGigs(db);
  await migrateAgents(db);
  await migrateBaskets(db);
  await migrateCerts(db);
  await migrateMsgs(db);
  await migrateRecovery(db);
  await migrateX402(db);
  await migrateApps(db);
}
