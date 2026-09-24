/**
 * People: local names for identity keys, plus the name this wallet announces.
 *
 * A contact is a name the human chose, bound to an identity key and (once
 * known) the peer's receive address. The address is never derived from the
 * identity key — that key is the HD root, not the m/0/0 spend key — so it
 * arrives from a handshake or from the human. `@name` in `bsv msg` and
 * `bsv pay` resolves here before it ever touches the wire.
 */
import type { Knex } from "knex";
import { p2pkhScript } from "./tx.ts";

const KEY_RE = /^[0-9a-fA-F]{66}$/;

export interface Contact {
  name: string;
  display: string;
  identityKey: string;
  address: string;
  note: string;
  createdAt: number;
}

export interface ResolvedPerson {
  name: string;
  display: string;
  identityKey: string;
  address: string;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Stable lookup key: `@Richard` and `richard` are the same person. */
export function slugName(raw: string): string {
  const s = raw.trim().replace(/^@+/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length < 2 || s.length > 32) fail("BAD_PARAM", "name: 2–32 letters or digits");
  return s;
}

export function validPayTo(address: string): boolean {
  if (!address) return false;
  try {
    p2pkhScript(address);
    return true;
  } catch {
    return false;
  }
}

/** Announce name: short, printable, no control characters. */
export function cleanAnnounceName(raw: string): string {
  return raw.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 24);
}

let announced = "";

/** Sync cache the beacon reads. Updated whenever the profile name changes. */
export function announcedName(): string {
  return announced;
}

export function rememberAnnouncedName(name: string): void {
  announced = cleanAnnounceName(name);
}

export async function migratePeople(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("contacts"))) {
    await db.schema.createTable("contacts", (t) => {
      t.string("name", 32).primary();
      t.string("display", 64).notNullable().defaultTo("");
      t.string("identity_key", 66).notNullable();
      t.string("address", 40).notNullable().defaultTo("");
      t.string("note", 200).notNullable().defaultTo("");
      t.integer("created_at").notNullable();
    });
  }
  if (!(await db.schema.hasTable("profile"))) {
    await db.schema.createTable("profile", (t) => {
      t.integer("id").primary();
      t.string("name", 24).notNullable().defaultTo("");
    });
  }
}

function rowToContact(r: {
  name: string; display: string; identity_key: string; address: string; note: string; created_at: number;
}): Contact {
  return {
    name: r.name,
    display: r.display || r.name,
    identityKey: r.identity_key,
    address: r.address || "",
    note: r.note || "",
    createdAt: r.created_at,
  };
}

export async function listContacts(db: Knex): Promise<Contact[]> {
  const rows = (await db("contacts").select().orderBy("name")) as Array<{
    name: string; display: string; identity_key: string; address: string; note: string; created_at: number;
  }>;
  return rows.map(rowToContact);
}

export async function getContact(db: Knex, name: string): Promise<Contact | null> {
  const slug = slugName(name);
  const row = (await db("contacts").where({ name: slug }).first()) as {
    name: string; display: string; identity_key: string; address: string; note: string; created_at: number;
  } | undefined;
  return row ? rowToContact(row) : null;
}

export async function addContact(
  db: Knex,
  input: { name: string; identityKey: string; address?: string; note?: string },
): Promise<Contact> {
  const name = slugName(input.name);
  const display = input.name.trim().replace(/^@+/, "").slice(0, 64) || name;
  if (!KEY_RE.test(input.identityKey)) fail("BAD_PARAM", "identityKey must be a 66-hex compressed pubkey");
  const address = (input.address ?? "").trim();
  if (address && !validPayTo(address)) fail("BAD_PARAM", "address must be a P2PKH receive address");
  const note = (input.note ?? "").slice(0, 200);
  const identityKey = input.identityKey.toLowerCase();
  const existing = await db("contacts").where({ name }).first();
  if (existing) {
    await db("contacts").where({ name }).update({
      display, identity_key: identityKey, address, note,
    });
  } else {
    await db("contacts").insert({
      name, display, identity_key: identityKey, address, note, created_at: Date.now(),
    });
  }
  return (await getContact(db, name)) as Contact;
}

export async function removeContact(db: Knex, name: string): Promise<{ removed: boolean }> {
  const slug = slugName(name);
  const n = await db("contacts").where({ name: slug }).delete();
  return { removed: n > 0 };
}

/** Fill a missing receive address once a handshake has proven it. */
export async function learnAddress(db: Knex, identityKey: string, address: string): Promise<void> {
  if (!KEY_RE.test(identityKey) || !validPayTo(address)) return;
  await db("contacts")
    .where({ identity_key: identityKey.toLowerCase() })
    .where({ address: "" })
    .update({ address });
}

export async function profileName(db: Knex): Promise<string> {
  const row = (await db("profile").where({ id: 1 }).first()) as { name?: string } | undefined;
  return cleanAnnounceName(row?.name ?? "");
}

export async function setProfileName(db: Knex, name: string): Promise<{ name: string }> {
  const clean = cleanAnnounceName(name);
  if (clean.length < 2) fail("BAD_PARAM", "name: 2–24 visible characters");
  const existing = await db("profile").where({ id: 1 }).first();
  if (existing) await db("profile").where({ id: 1 }).update({ name: clean });
  else await db("profile").insert({ id: 1, name: clean });
  rememberAnnouncedName(clean);
  return { name: clean };
}

export interface LivePerson {
  identityKey: string;
  name: string;
  payTo: string;
  nameVerified: boolean;
}

/**
 * Turn `@name`, a bare name, an identity key, or a raw address into someone
 * we can message or pay. Live peers fill gaps contacts don't have yet.
 */
export async function resolvePerson(
  db: Knex,
  raw: string,
  live: LivePerson[] = [],
): Promise<ResolvedPerson> {
  const token = raw.trim();
  if (!token) fail("BAD_PARAM", "who required");
  if (KEY_RE.test(token)) {
    const key = token.toLowerCase();
    const rows = (await db("contacts").where({ identity_key: key }).select()) as Array<{
      name: string; display: string; identity_key: string; address: string; note: string; created_at: number;
    }>;
    const saved = rows[0] ? rowToContact(rows[0]) : null;
    const seen = live.find((p) => p.identityKey === key);
    return {
      name: saved?.name ?? "",
      display: saved?.display ?? seen?.name ?? key.slice(0, 12),
      identityKey: key,
      address: saved?.address || seen?.payTo || "",
    };
  }
  if (/^1[1-9A-HJ-NP-Za-km-z]{24,33}$/.test(token) && validPayTo(token)) {
    return { name: "", display: token.slice(0, 8), identityKey: "", address: token };
  }
  const slug = slugName(token);
  const saved = await getContact(db, slug);
  if (saved) {
    return { name: saved.name, display: saved.display, identityKey: saved.identityKey, address: saved.address };
  }
  const seen = live.find((p) => p.nameVerified && slugName(p.name) === slug);
  if (seen) {
    return { name: slug, display: seen.name, identityKey: seen.identityKey, address: seen.payTo };
  }
  fail("NOT_FOUND", `no person named ${slug} — bsv contact add ${slug} <identityKey>`);
}
