/**
 * F6 messaging v1: ECDH direct messages over the MessageBox relay.
 *
 * Envelope (BSV-OS-local, BRC-2-shaped): the BRC-42 DM key shared by a
 * peer pair encrypts the body; the sender is implicit in the key, so
 * `from` is authenticated by decryption itself. The relay sees routing
 * metadata + ciphertext only; the daemon stores ciphertext only and
 * decrypts on read — no plaintext at rest, ever.
 *
 * Out of v1 scope (documented): group threads, pay-to-message spam
 * pricing (→ F14), BSV21 sends. BSV21 transfers need protocol-aware
 * construction and are deferred.
 *
 * Relay status (2026-09-15): handshake, account registration, and sends
 * are proven live against messagebox.1sat.app, but inbox delivery is
 * UNCONFIRMED (self-sends never list back — possibly self-suppression or
 * unpaid storage quota). Treat delivery as experimental until a funded
 * inbox or second identity proves the round trip (→ F14 funds this).
 */
import type { Knex } from "knex";
import { randomBytes } from "node:crypto";
import { AuthFetch, type WalletInterface } from "@bsv/sdk";
import { dmDecrypt, dmEncrypt } from "./custody.ts";
import { msgWalletFull } from "./msgwallet.ts";

export const MESSAGE_BOX = "https://messagebox.1sat.app";
/** Overridable for probing relay box semantics (default: our own box). */
export const DM_BOX = process.env.BSV_MSG_BOX ?? "bsv-os-dm";

export interface DmEnvelope {
  v: 1;
  from: string;
  to: string;
  body: string;
  sentAt: number;
}

export interface StoredMessage {
  id: string;
  peer: string;
  direction: "in" | "out";
  envelope: string;
  createdAt: number;
  acked: number;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function packEnvelope(from: string, to: string, bodyHex: string): DmEnvelope {
  return { v: 1, from: from.toLowerCase(), to: to.toLowerCase(), body: bodyHex, sentAt: Date.now() };
}

export function parseEnvelope(raw: unknown): DmEnvelope {
  if (!raw || typeof raw !== "object") fail("BAD_ENVELOPE", "envelope must be an object");
  const e = raw as Record<string, unknown>;
  if (e.v !== 1) fail("BAD_ENVELOPE", "unsupported envelope version");
  for (const k of ["from", "to", "body"] as const) {
    if (typeof e[k] !== "string" || !(e[k] as string)) fail("BAD_ENVELOPE", `envelope.${k} required`);
  }
  if (!/^[0-9a-fA-F]{66}$/.test(e.from as string) || !/^[0-9a-fA-F]{66}$/.test(e.to as string)) {
    fail("BAD_ENVELOPE", "envelope parties must be compressed pubkeys");
  }
  if (!/^[0-9a-fA-F]+$/.test(e.body as string)) fail("BAD_ENVELOPE", "envelope body must be hex");
  return {
    v: 1,
    from: (e.from as string).toLowerCase(),
    to: (e.to as string).toLowerCase(),
    body: e.body as string,
    sentAt: Math.floor(Number(e.sentAt) || 0),
  };
}

export interface Relay {
  send(recipient: string, box: string, messageId: string, body: unknown): Promise<void>;
  list(box: string): Promise<Array<{ messageId: string; body: unknown }>>;
  ack(messageIds: string[]): Promise<void>;
  status(): Promise<unknown>;
  register(username: string): Promise<unknown>;
}

type FetchLike = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

/** MessageBox relay over an authenticated fetch (AuthFetch in prod). */
export function createMessageBoxRelay(authFetch: FetchLike, base = MESSAGE_BOX): Relay {
  const post = async (path: string, payload: unknown): Promise<unknown> => {
    // NOTE: no `accept` header — the SDK's SimplifiedFetchTransport only
    // allows content-type/authorization/x-bsv-*.
    const res = await authFetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      fail("RELAY", `relay ${res.status}: ${detail}`);
    }
    const body = (await res.json().catch(() => ({}))) as {
      status?: unknown; code?: unknown; description?: unknown;
    };
    // The relay answers 200 with {status:"error",...} for app-level
    // failures (e.g. recipient without storage) — like the reference
    // client, treat those as errors, not deliveries.
    if (body && typeof body === "object" && body.status === "error") {
      fail("RELAY", `relay refused: ${String(body.code ?? "?")}: ${String(body.description ?? "").slice(0, 200)}`);
    }
    return body;
  };
  return {
    send: async (recipient, box, messageId, body) => {
      await post("/messagebox/sendMessage", { message: { recipient, messageBox: box, messageId, body } });
    },
    list: async (box) => {
      // Mirror the reference client: explicit offset/limit pagination.
      const j = (await post("/messagebox/listMessages", { messageBox: box, offset: 0, limit: 100 })) as {
        messages?: unknown; data?: unknown; results?: unknown; items?: unknown;
      };
      const rows = Array.isArray(j)
        ? j
        : (Array.isArray(j.messages) ? j.messages
          : Array.isArray(j.data) ? j.data
          : Array.isArray(j.results) ? j.results
          : Array.isArray(j.items) ? j.items : []);
      return (rows as Array<Record<string, unknown>>).flatMap((m) => {
        const id = m.messageId ?? m.messageID ?? m.id ?? m.message_id;
        const body = (m.body ?? m.message ?? m.data ?? m.payload) as unknown;
        return typeof id === "string" && id ? [{ messageId: id, body }] : [];
      });
    },
    ack: async (messageIds) => {
      if (messageIds.length === 0) return;
      await post("/messagebox/acknowledgeMessage", { messageIds });
    },
    status: async () => {
      const res = await authFetch(`${base}/account/status`, { method: "GET" });
      if (!res.ok) fail("RELAY", `account status ${res.status}`);
      return res.json().catch(() => ({}));
    },
    register: async (username) => {
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(username)) {
        fail("BAD_PARAM", "username: 3-63 chars, lowercase/digits/hyphens");
      }
      return post("/account/register", { username });
    },
  };
}

export async function migrateMsgs(db: Knex): Promise<void> {
  if (await db.schema.hasTable("messages")) return;
  await db.schema.createTable("messages", (t) => {
    t.string("id", 128).primary();
    t.string("peer", 66).notNullable().defaultTo("");
    t.string("direction", 3).notNullable().defaultTo("in");
    t.text("envelope").notNullable();
    t.integer("created_at").notNullable();
    t.integer("acked").notNullable().defaultTo(0);
  });
}

export function newMessageId(): string {
  return randomBytes(16).toString("hex");
}

let cachedRelay: Relay | null = null;

/** Live relay (lazy AuthFetch session). Swappable in tests. */
export function liveRelay(): Relay {
  if (!cachedRelay) {
    const auth = new AuthFetch(msgWalletFull() as unknown as WalletInterface);
    cachedRelay = createMessageBoxRelay((url, init) => auth.fetch(url, init as never));
  }
  return cachedRelay;
}

export function __setRelay(relay: Relay | null): void {
  cachedRelay = relay;
}

function rowToStored(r: {
  id: string; peer: string; direction: string; envelope: string; created_at: number; acked: number;
}): StoredMessage {
  return {
    id: r.id, peer: r.peer,
    direction: r.direction === "out" ? "out" : "in",
    envelope: r.envelope, createdAt: r.created_at, acked: r.acked,
  };
}

/** Encrypt + deliver + store the out record. Needs the wallet unlocked. */
export async function sendDm(
  db: Knex,
  relay: Relay,
  selfHex: string,
  to: string,
  text: string,
): Promise<{ id: string }> {
  const body = dmEncrypt(to, text); // throws locked / bad peer / oversize
  const id = newMessageId();
  const envelope = packEnvelope(selfHex, to, body);
  await relay.send(to.toLowerCase(), DM_BOX, id, envelope);
  await db("messages").insert({
    id, peer: to.toLowerCase(), direction: "out",
    envelope: JSON.stringify(envelope), created_at: Date.now(), acked: 1,
  });
  return { id };
}

/** Pull the inbox; stores unknown envelopes (ciphertext only). */
export async function syncInbox(db: Knex, relay: Relay): Promise<{ fresh: number; total: number }> {
  const items = await relay.list(DM_BOX);
  let fresh = 0;
  for (const m of items) {
    const known = await db("messages").where({ id: m.messageId }).first();
    if (known) continue;
    let peer = "";
    try {
      peer = parseEnvelope(m.body).from;
    } catch {
      peer = "";
    }
    await db("messages").insert({
      id: m.messageId, peer, direction: "in",
      envelope: JSON.stringify(m.body), created_at: Date.now(), acked: 0,
    });
    fresh++;
  }
  const total = Number((await db("messages").where({ direction: "in" }).count({ n: "*" }).first() as { n: number })?.n ?? 0);
  return { fresh, total };
}

export async function listStored(db: Knex, direction?: "in" | "out"): Promise<StoredMessage[]> {
  let q = db("messages").select();
  if (direction) q = q.where({ direction });
  const rows = (await q.orderBy("created_at", "desc").limit(100)) as Array<{
    id: string; peer: string; direction: string; envelope: string; created_at: number; acked: number;
  }>;
  return rows.map(rowToStored);
}

/** Decrypt one message for display. Needs the wallet unlocked. */
export async function readDm(db: Knex, id: string): Promise<{ peer: string; text: string; sentAt: number; direction: string }> {
  const row = (await db("messages").where({ id }).first()) as {
    id: string; peer: string; direction: string; envelope: string;
  } | undefined;
  if (!row) fail("NOT_FOUND", `no message: ${String(id).slice(0, 12)}…`);
  const env = parseEnvelope(JSON.parse(row.envelope));
  const peer = row.peer || (row.direction === "out" ? env.to : env.from);
  const text = dmDecrypt(peer, env.body); // throws locked
  return { peer, text, sentAt: env.sentAt, direction: row.direction };
}

/** Acknowledge at the relay and mark stored. */
export async function ackDm(db: Knex, relay: Relay, id: string): Promise<{ id: string; acked: boolean }> {
  const row = (await db("messages").where({ id }).first()) as { id: string } | undefined;
  if (!row) fail("NOT_FOUND", `no message: ${String(id).slice(0, 12)}…`);
  await relay.ack([id]);
  await db("messages").where({ id }).update({ acked: 1 });
  return { id, acked: true };
}
