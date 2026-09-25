/**
 * F6.4 Boards — agent-to-agent shared logs.
 *
 * A board is a named, signed, replicated log. Every node keeps the posts it
 * has seen; `get` is served locally, so boards survive peers going offline.
 * Posts carry small payloads (text, kind, refs) encrypted with a shared
 * board key, so content is ciphertext at rest and on the wire; routing
 * metadata (board, sender, agent, timestamp) stays visible, and the BSM
 * signature over the ciphertext proves authorship.
 *
 * Delivery is p2p-first: subscribed online peers get the post over the
 * authenticated channel in milliseconds; members also receive the same
 * signed post as a relay DM, so an offline member files it on the next
 * sync. Duplicate posts are deduped by id, which makes that fan-out safe.
 */
import type { Knex } from "knex";
import { SymmetricKey } from "@bsv/sdk";
import { identityPubkeyHex, identitySignMessage, verifyIdentitySignature } from "./custody.ts";
import { readDm, sendDmPreferred, type Relay } from "./msgs.ts";
import type { P2PChannel } from "./p2p.ts";

export const BOARD_POST_PREFIX = "bsvboard1:";
export const BOARD_KEY_PREFIX = "bsvboardkey1:";
const POST_DOMAIN = "bsvos-board-v1";
const KEY_DOMAIN = "bsvos-board-key-v1";
const MAX_CODE_CHARS = 64 * 1024;
const MAX_TEXT = 8 * 1024;
const MAX_REFS = 16;
const MAX_REF = 300;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const KEY_RE = /^[0-9a-fA-F]{66}$/;
const ID_RE = /^[0-9a-f]{32}$/;

export type BoardMode = "open" | "members";
export type PostKind = "note" | "request" | "result" | "artifact";

export interface BoardRow {
  name: string;
  mode: BoardMode;
  members: string[];
  posters: string[];
  keyHex: string;
  /** Active key epoch; bumps on every membership change. */
  epoch: number;
  createdAt: number;
  lastReadTs: number;
}

export interface BoardEnvelope {
  v: 1;
  id: string;
  board: string;
  from: string;
  agent: string;
  ts: number;
  /** AES-GCM ciphertext (hex) of BoardContent under the board key. */
  ct: string;
  sig: string;
  /** Key epoch; absent on posts written before rotation existed (epoch 1). */
  ke?: number;
}

export interface BoardContent {
  text: string;
  kind: PostKind;
  refs: string[];
  replyTo: string;
}

export interface BoardPostView extends BoardContent {
  id: string;
  board: string;
  from: string;
  agent: string;
  ts: number;
  direction: "in" | "out";
  /** true when this node cannot decrypt the payload (key not held yet). */
  locked: boolean;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function validBoardName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name);
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function boardKey(keyHex: string): SymmetricKey {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) fail("BAD_KEY", "board key must be 32 hex bytes");
  return new SymmetricKey(Array.from(Buffer.from(keyHex, "hex")), "be");
}

export function newBoardKeyHex(): string {
  return Buffer.from(SymmetricKey.fromRandom().toArray("be", 32)).toString("hex");
}

// ── post codec ─────────────────────────────────────────────────────────────

export function postCanonical(e: Omit<BoardEnvelope, "sig">): string {
  const base = [POST_DOMAIN, e.id, e.board, e.from.toLowerCase(), e.agent, String(e.ts), e.ct];
  // Epoch is part of the signed payload for new posts; legacy posts (no ke)
  // keep the original canonical so their signatures still verify.
  if (e.ke !== undefined) base.push(String(e.ke));
  return base.join("|");
}

export function cleanText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT);
}

function cleanRefs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is string => typeof r === "string" && r.length > 0)
    .map((r) => r.slice(0, MAX_REF))
    .slice(0, MAX_REFS);
}

export function buildPost(input: {
  board: string;
  from: string;
  agent?: string;
  keyHex: string;
  epoch?: number;
  text: string;
  kind?: PostKind;
  refs?: string[];
  replyTo?: string;
  id?: string;
  ts?: number;
  sign?: (message: string) => string;
}): BoardEnvelope {
  if (!validBoardName(input.board)) fail("BAD_PARAM", "board: 2-32 lowercase letters, digits, hyphens");
  const text = cleanText(input.text);
  if (!text) fail("BAD_PARAM", "text required");
  const agent = cleanText(input.agent ?? "cli").slice(0, 64) || "cli";
  const kind = (["note", "request", "result", "artifact"] as const).includes(input.kind as never)
    ? (input.kind as PostKind)
    : "note";
  const content: BoardContent = {
    text,
    kind,
    refs: cleanRefs(input.refs),
    replyTo: ID_RE.test(input.replyTo ?? "") ? (input.replyTo as string) : "",
  };
  const epoch = Math.max(1, Math.floor(Number(input.epoch) || 1));
  const payload = { v: 1 as const, id: input.id ?? randomId(), board: input.board, from: input.from.toLowerCase(), agent, ts: input.ts ?? Date.now(), ke: epoch };
  const ct = Buffer.from(boardKey(input.keyHex).encrypt(JSON.stringify(content))).toString("hex");
  const sign = input.sign ?? identitySignMessage;
  return { ...payload, ct, sig: sign(postCanonical({ ...payload, ct })) };
}

function randomId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function envelopeShape(raw: unknown): BoardEnvelope | null {
  let o = raw;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o) as unknown;
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const e = o as Record<string, unknown>;
  if (e.v !== 1) return null;
  if (typeof e.id !== "string" || !ID_RE.test(e.id)) return null;
  if (!validBoardName(e.board)) return null;
  if (typeof e.from !== "string" || !KEY_RE.test(e.from)) return null;
  if (typeof e.agent !== "string" || !e.agent) return null;
  if (!(Number(e.ts) > 0)) return null;
  if (typeof e.ct !== "string" || !/^[0-9a-fA-F]+$/.test(e.ct)) return null;
  if (typeof e.sig !== "string" || !e.sig) return null;
  let ke: number | undefined;
  if (e.ke !== undefined) {
    const n = Math.floor(Number(e.ke));
    if (!Number.isInteger(n) || n < 1) return null;
    ke = n;
  }
  return {
    v: 1,
    id: e.id,
    board: e.board,
    from: e.from.toLowerCase(),
    agent: e.agent.slice(0, 64),
    ts: Math.floor(Number(e.ts)),
    ct: e.ct,
    sig: e.sig,
    ...(ke !== undefined ? { ke } : {}),
  };
}

export function verifyPost(env: BoardEnvelope): boolean {
  return verifyIdentitySignature(env.from, postCanonical(env), env.sig);
}

/** Key for a post's epoch, falling back to the active key. */
export function keyForEpoch(keys: Map<number, string>, env: BoardEnvelope): string {
  return keys.get(env.ke ?? 1) ?? [...keys.entries()].sort((a, b) => b[0] - a[0])[0]?.[1] ?? "";
}

export function decodeContent(env: BoardEnvelope, keyHex: string): BoardContent | null {
  try {
    const plain = boardKey(keyHex).decrypt(Array.from(Buffer.from(env.ct, "hex")), "utf8");
    const content = JSON.parse(typeof plain === "string" ? plain : Buffer.from(plain as number[]).toString("utf8")) as BoardContent;
    if (!content || typeof content !== "object") return null;
    return {
      text: cleanText(content.text),
      kind: (["note", "request", "result", "artifact"] as const).includes(content.kind as never) ? content.kind : "note",
      refs: cleanRefs(content.refs),
      replyTo: ID_RE.test(content.replyTo ?? "") ? content.replyTo : "",
    };
  } catch {
    return null;
  }
}

export function encodePostCode(env: BoardEnvelope): string {
  return `${BOARD_POST_PREFIX}${base64url(Buffer.from(JSON.stringify(env), "utf8"))}`;
}

export function parsePostCode(code: string): BoardEnvelope | null {
  const text = String(code ?? "").trim();
  if (!text.startsWith(BOARD_POST_PREFIX) || text.length > MAX_CODE_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64url(text.slice(BOARD_POST_PREFIX.length)).toString("utf8"));
  } catch {
    return null;
  }
  const env = envelopeShape(raw);
  return env && verifyPost(env) ? env : null;
}

// ── key codec (shared out-of-band or by authenticated DM) ──────────────────

export interface BoardKeyCode {
  v: 1;
  board: string;
  keyHex: string;
  from: string;
  sig: string;
  epoch: number;
}

function keyCanonical(board: string, keyHex: string, from: string, epoch: number | undefined): string {
  const base = [KEY_DOMAIN, board, keyHex, from.toLowerCase()];
  if (epoch !== undefined) base.push(String(epoch));
  return base.join("|");
}

export function encodeBoardKey(board: string, keyHex: string, from: string, epoch = 1): string {
  if (!validBoardName(board)) fail("BAD_PARAM", "bad board name");
  const ep = Math.max(1, Math.floor(epoch));
  const payload = { v: 1 as const, board, keyHex, from: from.toLowerCase(), epoch: ep };
  const sig = identitySignMessage(keyCanonical(board, keyHex, payload.from, ep));
  return `${BOARD_KEY_PREFIX}${base64url(Buffer.from(JSON.stringify({ ...payload, sig }), "utf8"))}`;
}

export function parseBoardKey(code: string): BoardKeyCode | null {
  const text = String(code ?? "").trim();
  if (!text.startsWith(BOARD_KEY_PREFIX) || text.length > 4096) return null;
  try {
    const raw = JSON.parse(fromBase64url(text.slice(BOARD_KEY_PREFIX.length)).toString("utf8")) as Partial<BoardKeyCode>;
    if (raw.v !== 1 || typeof raw.board !== "string" || !validBoardName(raw.board) || typeof raw.keyHex !== "string" || !/^[0-9a-f]{64}$/.test(raw.keyHex)) return null;
    if (typeof raw.from !== "string" || !KEY_RE.test(raw.from)) return null;
    const from = raw.from.toLowerCase();
    const epoch = raw.epoch === undefined ? 1 : Math.floor(Number(raw.epoch));
    if (!Number.isInteger(epoch) || epoch < 1) return null;
    const ok = verifyIdentitySignature(from, keyCanonical(raw.board, raw.keyHex, from, raw.epoch === undefined ? undefined : epoch), String(raw.sig ?? ""));
    return ok ? { v: 1, board: raw.board, keyHex: raw.keyHex, from, sig: String(raw.sig), epoch } : null;
  } catch {
    return null;
  }
}

// ── storage ────────────────────────────────────────────────────────────────

export async function migrateBoards(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("boards"))) {
    await db.schema.createTable("boards", (t) => {
      t.string("name", 32).primary();
      t.string("mode", 8).notNullable().defaultTo("members");
      t.text("members").notNullable().defaultTo("[]");
      t.text("posters").notNullable().defaultTo("[]");
      t.string("key_hex", 64).notNullable().defaultTo("");
      t.integer("created_at").notNullable();
      t.integer("last_read_ts").notNullable().defaultTo(0);
    });
  }
  if (!(await db.schema.hasTable("board_keys"))) {
    await db.schema.createTable("board_keys", (t) => {
      t.string("board", 32).notNullable();
      t.integer("epoch").notNullable();
      t.string("key_hex", 64).notNullable();
      t.integer("created_at").notNullable();
      t.primary(["board", "epoch"]);
    });
  }
  if (!(await db.schema.hasTable("board_posts"))) {
    await db.schema.createTable("board_posts", (t) => {
      t.string("id", 32).primary();
      t.string("board", 32).notNullable();
      t.string("direction", 3).notNullable().defaultTo("in");
      t.string("from_key", 66).notNullable().defaultTo("");
      t.string("agent", 64).notNullable().defaultTo("");
      t.integer("ts").notNullable();
      t.integer("received_at").notNullable();
      t.text("envelope").notNullable();
      t.integer("sig_ok").notNullable().defaultTo(1);
    });
  }
}

function rowToBoard(r: {
  name: string; mode: string; members: string; posters: string; key_hex: string; created_at: number; last_read_ts: number;
}, epoch = 1): BoardRow {
  return {
    name: r.name,
    mode: r.mode === "open" ? "open" : "members",
    members: (JSON.parse(r.members || "[]") as string[]).filter((k) => KEY_RE.test(k)),
    posters: (JSON.parse(r.posters || "[]") as string[]).filter((p) => typeof p === "string"),
    keyHex: r.key_hex,
    epoch,
    createdAt: r.created_at,
    lastReadTs: r.last_read_ts,
  };
}

/** All key epochs ever used on a board (old posts keep reading). */
export async function keysFor(db: Knex, name: string): Promise<Map<number, string>> {
  const rows = (await db("board_keys").where({ board: name }).orderBy("epoch")) as Array<{ epoch: number; key_hex: string }>;
  return new Map(rows.map((r) => [Number(r.epoch), r.key_hex]));
}

async function activeEpoch(db: Knex, name: string): Promise<number> {
  const row = (await db("board_keys").where({ board: name }).max({ e: "epoch" }).first()) as { e?: number } | undefined;
  return Math.max(1, Number(row?.e) || 1);
}

/** Rotate a board's key: new epoch for future posts, history retained. */
export async function rotateBoardKey(db: Knex, name: string, now = Date.now()): Promise<{ epoch: number; keyHex: string }> {
  const board = await getBoard(db, name);
  if (!board) fail("NOT_FOUND", `no board ${name}`);
  const epoch = (await activeEpoch(db, name)) + 1;
  const keyHex = newBoardKeyHex();
  await db("board_keys").insert({ board: name, epoch, key_hex: keyHex, created_at: now });
  await db("boards").where({ name }).update({ key_hex: keyHex });
  return { epoch, keyHex };
}

export async function getBoard(db: Knex, name: string): Promise<BoardRow | null> {
  const row = (await db("boards").where({ name }).first()) as {
    name: string; mode: string; members: string; posters: string; key_hex: string; created_at: number; last_read_ts: number;
  } | undefined;
  return row ? rowToBoard(row, await activeEpoch(db, name)) : null;
}

export async function listBoards(db: Knex): Promise<Array<BoardRow & { unread: number; posts: number }>> {
  const rows = (await db("boards").select().orderBy("created_at")) as Array<{
    name: string; mode: string; members: string; posters: string; key_hex: string; created_at: number; last_read_ts: number;
  }>;
  const out: Array<BoardRow & { unread: number; posts: number }> = [];
  for (const row of rows) {
    const board = rowToBoard(row, await activeEpoch(db, row.name));
    const total = Number((await db("board_posts").where({ board: board.name }).count({ n: "*" }).first() as { n: number })?.n ?? 0);
    const unread = Number(
      (await db("board_posts").where({ board: board.name, direction: "in" }).where("received_at", ">", board.lastReadTs).count({ n: "*" }).first() as { n: number })?.n ?? 0,
    );
    out.push({ ...board, posts: total, unread });
  }
  return out;
}

export async function createBoard(
  db: Knex,
  input: { name: string; mode?: BoardMode; members?: string[]; posters?: string[]; keyHex?: string; epoch?: number; now?: number },
): Promise<BoardRow> {
  if (!validBoardName(input.name)) fail("BAD_PARAM", "name: 2-32 lowercase letters, digits, hyphens");
  const mode: BoardMode = input.mode === "open" ? "open" : "members";
  const members = (input.members ?? []).filter((k) => KEY_RE.test(k)).map((k) => k.toLowerCase());
  const posters = (input.posters ?? []).filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim());
  const keyHex = input.keyHex && /^[0-9a-f]{64}$/.test(input.keyHex) ? input.keyHex : newBoardKeyHex();
  const epoch = Math.max(1, Math.floor(Number(input.epoch) || 1));
  const now = input.now ?? Date.now();
  const existing = await getBoard(db, input.name);
  if (existing) {
    await db("boards").where({ name: input.name }).update({
      mode,
      members: JSON.stringify([...new Set([...existing.members, ...members])]),
      posters: JSON.stringify([...new Set([...existing.posters, ...posters])]),
    });
    if (input.keyHex) {
      // A key code we have not seen before becomes a new epoch.
      const known = await db("board_keys").where({ board: input.name, epoch }).first();
      if (!known) {
        await db("board_keys").insert({ board: input.name, epoch, key_hex: keyHex, created_at: now });
        const active = await activeEpoch(db, input.name);
        if (epoch >= active) await db("boards").where({ name: input.name }).update({ key_hex: keyHex });
      }
    }
    return (await getBoard(db, input.name)) as BoardRow;
  }
  await db("boards").insert({
    name: input.name,
    mode,
    members: JSON.stringify(members),
    posters: JSON.stringify(posters),
    key_hex: keyHex,
    created_at: now,
    last_read_ts: 0,
  });
  await db("board_keys").insert({ board: input.name, epoch, key_hex: keyHex, created_at: now });
  return (await getBoard(db, input.name)) as BoardRow;
}

/** Drop a member and rotate the key so future posts stay out of reach. */
export async function removeMember(db: Knex, name: string, identityKey: string): Promise<BoardRow | null> {
  const board = await getBoard(db, name);
  if (!board) return null;
  const key = identityKey.toLowerCase();
  if (!board.members.includes(key)) return board;
  board.members = board.members.filter((m) => m !== key);
  await db("boards").where({ name }).update({ members: JSON.stringify(board.members) });
  await rotateBoardKey(db, name);
  return (await getBoard(db, name)) as BoardRow;
}

/** Decrypt a post with the key for its epoch (for waiters and threads). */
export async function postContent(db: Knex, name: string, env: BoardEnvelope): Promise<BoardContent | null> {
  const keys = await keysFor(db, name);
  const keyHex = keyForEpoch(keys, env);
  return keyHex ? decodeContent(env, keyHex) : null;
}

export async function removeBoard(db: Knex, name: string): Promise<{ removed: boolean }> {
  const board = await getBoard(db, name);
  if (!board) return { removed: false };
  await db("board_posts").where({ board: name }).delete();
  await db("boards").where({ name }).delete();
  return { removed: true };
}

export async function addMember(db: Knex, name: string, identityKey: string): Promise<BoardRow | null> {
  const board = await getBoard(db, name);
  if (!board) return null;
  if (!board.members.includes(identityKey.toLowerCase())) {
    board.members.push(identityKey.toLowerCase());
    await db("boards").where({ name }).update({ members: JSON.stringify(board.members) });
  }
  return board;
}

/** Accept a post: signature, membership, dedupe. Returns the stored board or null. */
export async function ingestPost(db: Knex, raw: unknown, opts: { now?: number } = {}): Promise<{ fresh: boolean; board: string; env: BoardEnvelope } | null> {
  const env = envelopeShape(raw);
  if (!env || !verifyPost(env)) return null;
  let board = await getBoard(db, env.board);
  if (!board) {
    // Unknown board: trust it only when it comes from a saved contact. The
    // ciphertext is kept locked until the board key arrives by DM.
    if (!(await isKnownContact(db, env.from))) return null;
    await createBoard(db, { name: env.board, mode: "members", members: [env.from] });
    board = await getBoard(db, env.board);
    if (!board) return null;
  }
  const self = safeSelf();
  const sender = env.from;
  const isSelf = sender === self;
  if (!isSelf) {
    if (board.mode === "members" && !board.members.includes(sender)) return null;
    if (board.posters.length > 0 && !board.posters.includes(env.agent)) return null;
  }
  const known = await db("board_posts").where({ id: env.id }).first();
  if (known) return { fresh: false, board: env.board, env };
  await db("board_posts").insert({
    id: env.id,
    board: env.board,
    direction: isSelf ? "out" : "in",
    from_key: sender,
    agent: env.agent,
    ts: env.ts,
    received_at: opts.now ?? Date.now(),
    envelope: JSON.stringify(env),
    sig_ok: 1,
  });
  return { fresh: true, board: env.board, env };
}

async function isKnownContact(db: Knex, identityKey: string): Promise<boolean> {
  try {
    const row = await db("contacts").where({ identity_key: identityKey.toLowerCase() }).first();
    return !!row;
  } catch {
    return false;
  }
}

function safeSelf(): string {
  try {
    return identityPubkeyHex().toLowerCase();
  } catch {
    return "";
  }
}

async function decryptRow(
  keys: Map<number, string>,
  r: { id: string; board: string; direction: string; from_key: string; agent: string; ts: number; envelope: string },
): Promise<BoardPostView | null> {
  const env = envelopeShape(r.envelope);
  if (!env) return null;
  const keyHex = keyForEpoch(keys, env);
  const content = keyHex ? decodeContent(env, keyHex) : null;
  return {
    id: r.id,
    board: r.board,
    from: r.from_key || env.from,
    agent: r.agent || env.agent,
    ts: r.ts,
    direction: r.direction === "out" ? "out" : "in",
    locked: !content,
    text: content?.text ?? "",
    kind: content?.kind ?? "note",
    refs: content?.refs ?? [],
    replyTo: content?.replyTo ?? "",
  };
}

export async function getPosts(
  db: Knex,
  board: string,
  opts: { since?: number; limit?: number; markRead?: boolean; now?: number } = {},
): Promise<{ posts: BoardPostView[]; locked: number; board: BoardRow | null }> {
  const row = await getBoard(db, board);
  if (!row) return { posts: [], locked: 0, board: null };
  let q = db("board_posts").where({ board }).orderBy("ts", "asc").limit(Math.max(1, Math.min(500, opts.limit ?? 100)));
  if (opts.since) q = q.where("ts", ">", Math.floor(opts.since));
  const rows = (await q) as Array<{
    id: string; board: string; direction: string; from_key: string; agent: string; ts: number; envelope: string;
  }>;
  const keys = await keysFor(db, board);
  let locked = 0;
  const posts: BoardPostView[] = [];
  for (const r of rows) {
    const view = await decryptRow(keys, r);
    if (!view) continue;
    if (view.locked) locked++;
    posts.push(view);
  }
  if (opts.markRead !== false) await markRead(db, board, opts.now);
  return { posts, locked, board: row };
}

/** A whole thread: the root post and every descendant, oldest first. */
export async function getThread(
  db: Knex,
  rootId: string,
): Promise<{ board: string; posts: BoardPostView[]; locked: number } | null> {
  const rootRow = (await db("board_posts").where({ id: rootId }).first()) as { board?: string } | undefined;
  if (!rootRow?.board) return null;
  const board = rootRow.board;
  const rows = (await db("board_posts").where({ board }).orderBy("ts", "asc").limit(1000)) as Array<{
    id: string; board: string; direction: string; from_key: string; agent: string; ts: number; envelope: string;
  }>;
  const keys = await keysFor(db, board);
  const byId = new Map<string, BoardPostView>();
  for (const r of rows) {
    const view = await decryptRow(keys, r);
    if (view) byId.set(view.id, view);
  }
  const children = new Map<string, BoardPostView[]>();
  for (const view of byId.values()) {
    if (!view.replyTo || !byId.has(view.replyTo)) continue;
    const list = children.get(view.replyTo) ?? [];
    list.push(view);
    children.set(view.replyTo, list);
  }
  const ordered: BoardPostView[] = [];
  const walk = (id: string): void => {
    const view = byId.get(id);
    if (!view || ordered.includes(view)) return;
    ordered.push(view);
    for (const child of (children.get(id) ?? []).sort((a, b) => a.ts - b.ts)) walk(child.id);
  };
  walk(rootId);
  const locked = ordered.filter((p) => p.locked).length;
  return { board, posts: ordered, locked };
}

export async function markRead(db: Knex, board: string, now = Date.now()): Promise<void> {
  await db("boards").where({ name: board }).update({ last_read_ts: now });
}

/** Relay-encode a post to every member (excluding self). Direct fan-out is separate. */
export async function relayToMembers(
  db: Knex,
  relay: Relay,
  p2p: P2PChannel | null,
  env: BoardEnvelope,
  board: BoardRow,
): Promise<number> {
  const self = safeSelf();
  const code = encodePostCode(env);
  let sent = 0;
  for (const member of board.members) {
    if (member === self) continue;
    try {
      await sendDmPreferred(db, relay, p2p, identityPubkeyHex(), member, code);
      sent++;
    } catch {
      /* offline relay hiccups must not fail the post */
    }
  }
  return sent;
}

/** Send the active board key (with its epoch) to one member, best effort. */
export async function deliverBoardKey(
  db: Knex,
  relay: Relay,
  p2p: P2PChannel | null,
  name: string,
  member: string,
): Promise<boolean> {
  const board = await getBoard(db, name);
  if (!board) return false;
  try {
    const code = encodeBoardKey(board.name, board.keyHex, identityPubkeyHex(), board.epoch);
    const sent = await sendDmPreferred(db, relay, p2p, identityPubkeyHex(), member, code);
    return sent.transport === "p2p" || sent.transport === "relay";
  } catch {
    return false;
  }
}

export async function publishPost(
  db: Knex,
  relay: Relay,
  p2p: P2PChannel | null,
  env: BoardEnvelope,
): Promise<{ accepted: boolean; direct: string[]; relayed: number }> {
  const stored = await ingestPost(db, env);
  const board = await getBoard(db, env.board);
  const direct = p2p?.boardPost ? await p2p.boardPost(env).catch(() => []) : [];
  const relayed = board ? await relayToMembers(db, relay, p2p, env, board) : 0;
  emitPost(env);
  return { accepted: stored !== null, direct, relayed };
}

// ── inbound relay sync (posts + key delivery) ──────────────────────────────

export async function scanBoardInbox(
  db: Knex,
  relay: Relay,
  opts: { limit?: number } = {},
): Promise<{ scanned: number; posts: number; keys: number }> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const rows = (await db("messages").where({ direction: "in" }).orderBy("created_at", "desc").limit(limit)) as Array<{ id: string }>;
  const result = { scanned: 0, posts: 0, keys: 0 };
  for (const row of rows) {
    result.scanned++;
    let text = "";
    try {
      text = (await readDm(db, row.id)).text;
    } catch {
      break; // locked wallet: stop, retry later
    }
    const trimmed = text.trim();
    if (trimmed.startsWith(BOARD_KEY_PREFIX)) {
      const key = parseBoardKey(trimmed.split(/\s+/)[0]);
      if (key) {
        await createBoard(db, { name: key.board, keyHex: key.keyHex, epoch: key.epoch, members: [key.from] });
        result.keys++;
      }
    } else if (trimmed.startsWith(BOARD_POST_PREFIX)) {
      const env = parsePostCode(trimmed.split(/\s+/)[0]);
      if (env) {
        const stored = await ingestPost(db, env);
        if (stored?.fresh) result.posts++;
      }
    } else {
      continue;
    }
    try {
      await relay.ack([row.id]);
    } catch {
      /* relay may be unreachable; the post is already filed */
    }
    await db("messages").where({ id: row.id }).update({ acked: 1 });
  }
  return result;
}

// ── waiters (subscribe returns fast, wait blocks for the answer) ───────────

type PostListener = (env: BoardEnvelope) => void;
const listeners = new Set<PostListener>();

export function onBoardPost(listener: PostListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitPost(env: BoardEnvelope): void {
  for (const listener of listeners) {
    try {
      listener(env);
    } catch {
      /* a broken listener must not break delivery */
    }
  }
}

export function waitForPost(opts: {
  board: string;
  timeoutMs: number;
  from?: string;
  agent?: string;
  /** Optional content-aware filter (e.g. "this is a reply to post X"). */
  matches?: (env: BoardEnvelope) => boolean | Promise<boolean>;
}): Promise<BoardEnvelope | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (env: BoardEnvelope | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(env);
    };
    const timer = setTimeout(() => finish(null), Math.max(1000, Math.min(120_000, opts.timeoutMs)));
    const off = onBoardPost((env) => {
      if (settled || env.board !== opts.board) return;
      if (opts.from && env.from !== opts.from.toLowerCase()) return;
      if (opts.agent && env.agent !== opts.agent) return;
      if (!opts.matches) {
        finish(env);
        return;
      }
      void Promise.resolve(opts.matches(env))
        .then((ok) => {
          if (ok) finish(env);
        })
        .catch(() => {});
    });
  });
}
