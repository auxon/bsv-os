/**
 * Twetch companion surface (feed, notifications, posting).
 *
 * Reads are keyless against the public API (`https://api.twetch.com`):
 * `/v1/feed/latest`, `/v1/users/:id/notifications`,
 * `/v1/feed/post-notifications`. Posting is a standard BSV transaction
 * carrying B:// content + MAP metadata + AIP authorship, exactly as
 * Twetch's own client builds it:
 *
 *   OP_0 OP_RETURN
 *     <B prefix> <content> <media type> <encoding> "|"
 *     <MAP prefix> SET app twetch type post "|"
 *     <AIP prefix> BITCOIN_ECDSA <signer address> <BSM signature>
 *
 * The AIP signature covers `0x6a || concat(field bytes before AIP)`, BSM
 * (Bitcoin Signed Message) with the Twetch account key. Funding comes
 * from the bsvOS wallet through the BRC-100 facade, so policy gates the
 * network fee; the Twetch key only ever signs (custody boundary).
 */
import type { Knex } from "knex";
import { BigNumber, BSM, Script, Signature, Utils } from "@bsv/sdk";
import type { ChainProvider } from "./chain.ts";
import { createBrc100Wallet } from "./brc100.ts";
import { twetchAddress, twetchPublicKey, twetchSignBytes } from "./custody.ts";

export const TWETCH_API = "https://api.twetch.com";
export const B_PREFIX = "19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut";
export const MAP_PREFIX = "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5";
export const AIP_PREFIX = "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva";

type FetchFn = typeof fetch;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

async function jget(fetchFn: FetchFn, path: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetchFn(`${TWETCH_API}${path}`, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      fail("RAILS", `twetch api ${res.status}: ${detail}`);
    }
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(t);
  }
}

interface TwetchUser {
  id: number;
  name?: string;
  handle?: string;
  avatarUrl?: string;
  followerCount?: number;
}

export interface FeedPost {
  id: number;
  txid: string | null;
  userId: number;
  content: string;
  contentType: string;
  postedAtMs: number;
  numLikes: number;
  numReplies: number;
  numBranches: number;
  replyPostId: number | null;
  user: TwetchUser | null;
}

function userMapOf(payload: Record<string, unknown>): Record<string, TwetchUser> {
  const users = payload.users;
  return users && typeof users === "object" ? (users as Record<string, TwetchUser>) : {};
}

function asPost(p: Record<string, unknown>, users: Record<string, TwetchUser>): FeedPost {
  const userId = Number(p.userId ?? 0);
  return {
    id: Number(p.id ?? 0),
    txid: typeof p.txid === "string" ? p.txid : null,
    userId,
    content: typeof p.content === "string" ? p.content : "",
    contentType: typeof p.contentType === "string" ? p.contentType : "text/plain",
    postedAtMs: Number(p.postedAtMs ?? p.createdAtMs ?? 0),
    numLikes: Number(p.numLikes ?? 0),
    numReplies: Number(p.numReplies ?? 0),
    numBranches: Number(p.numBranches ?? 0),
    replyPostId: p.replyPostId == null ? null : Number(p.replyPostId),
    user: users[String(userId)] ?? null,
  };
}

export interface FeedPage {
  posts: FeedPost[];
  nextCursor: string | null;
}

export async function feedLatest(fetchFn: FetchFn, opts: { limit?: number; cursor?: string } = {}): Promise<FeedPage> {
  const q = new URLSearchParams();
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), 100);
  q.set("limit", String(limit));
  if (opts.cursor) q.set("cursor", opts.cursor);
  const payload = (await jget(fetchFn, `/v1/feed/latest?${q.toString()}`)) as Record<string, unknown>;
  const users = userMapOf(payload);
  const data = Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : [];
  const next = typeof payload.nextCursor === "string" ? payload.nextCursor : null;
  return { posts: data.map((p) => asPost(p, users)), nextCursor: next };
}

export interface TwetchNotification {
  id: number;
  type: string;
  actorUserId: number;
  postId: number | null;
  description: string;
  createdAtMs: number;
  actor: TwetchUser | null;
}

export interface NotificationsPage {
  notifications: TwetchNotification[];
  nextCursor: string | null;
}

export async function notifications(
  fetchFn: FetchFn,
  userId: number,
  opts: { limit?: number; cursor?: string } = {},
): Promise<NotificationsPage> {
  if (!Number.isInteger(userId) || userId <= 0) fail("BAD_PARAM", "userId required");
  const q = new URLSearchParams();
  q.set("limit", String(Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), 100)));
  if (opts.cursor) q.set("cursor", opts.cursor);
  const payload = (await jget(
    fetchFn,
    `/v1/users/${userId}/notifications?${q.toString()}`,
  )) as Record<string, unknown>;
  const users = userMapOf(payload);
  const data = Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : [];
  const next = typeof payload.nextCursor === "string" ? payload.nextCursor : null;
  return {
    notifications: data.map((n) => {
      const actorUserId = Number(n.actorUserId ?? 0);
      return {
        id: Number(n.id ?? 0),
        type: typeof n.type === "string" ? n.type : "",
        actorUserId,
        postId: n.postId == null ? null : Number(n.postId),
        description: typeof n.description === "string" ? n.description : "",
        createdAtMs: Number(n.createdAtMs ?? 0),
        actor: users[String(actorUserId)] ?? null,
      };
    }),
    nextCursor: next,
  };
}

/** New posts from accounts the user bell'd (userId-keyed, keyless read). */
export async function postNotifications(
  fetchFn: FetchFn,
  userId: number,
  opts: { limit?: number; cursor?: string } = {},
): Promise<FeedPage> {
  if (!Number.isInteger(userId) || userId <= 0) fail("BAD_PARAM", "userId required");
  const q = new URLSearchParams();
  q.set("userId", String(userId));
  q.set("limit", String(Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100)));
  if (opts.cursor) q.set("cursor", opts.cursor);
  const payload = (await jget(fetchFn, `/v1/feed/post-notifications?${q.toString()}`)) as Record<string, unknown>;
  const users = userMapOf(payload);
  const data = Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : [];
  const next = typeof payload.nextCursor === "string" ? payload.nextCursor : null;
  return { posts: data.map((p) => asPost(p, users)), nextCursor: next };
}

/**
 * Which Twetch account owns a public key (the key-linkage check Twetch's own
 * client uses). Null when the key is not linked to any account.
 */
export async function userByPubkey(fetchFn: FetchFn, pubkey: string): Promise<number | null> {
  if (!/^[0-9a-fA-F]{66}$/.test(pubkey)) fail("BAD_PARAM", "pubkey must be 33-byte compressed hex");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetchFn(`${TWETCH_API}/v1/auth/user-by-pubkey/${pubkey}`, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      fail("RAILS", `twetch api ${res.status}: ${detail}`);
    }
    const body = (await res.json().catch(() => ({}))) as { userId?: unknown };
    const id = Math.floor(Number(body.userId ?? 0));
    return id > 0 ? id : null;
  } finally {
    clearTimeout(t);
  }
}

// ── Post building ────────────────────────────────────────────────────

export const POST_CONTENT_TYPE = "text/markdown";
export const POST_ENCODING = "UTF-8";

/** Fields pushed before the AIP record, in Twetch's exact order. */
export function postFields(content: string): string[] {
  return [
    B_PREFIX, content, POST_CONTENT_TYPE, POST_ENCODING, "|",
    MAP_PREFIX, "SET", "app", "twetch", "type", "post", "|",
  ];
}

/** The bytes AIP signs: OP_RETURN (0x6a) then the concatenated fields. */
export function aipMessage(fields: string[]): number[] {
  const out: number[] = [0x6a];
  for (const f of fields) out.push(...Utils.toArray(f, "utf8"));
  return out;
}

/** Full OP_RETURN locking script for a text post. */
export function buildPostScript(content: string, aip: { address: string; signature: string }): string {
  const script = new Script();
  script.writeOpCode(0x00);
  script.writeOpCode(0x6a);
  for (const f of postFields(content)) script.writeBin(Utils.toArray(f, "utf8"));
  script.writeBin(Utils.toArray(AIP_PREFIX, "utf8"));
  script.writeBin(Utils.toArray("BITCOIN_ECDSA", "utf8"));
  script.writeBin(Utils.toArray(aip.address, "utf8"));
  script.writeBin(Utils.toArray(aip.signature, "utf8"));
  return script.toHex();
}

export interface PostResult {
  txid: string;
  content: string;
  authorAddress: string;
  submitted: boolean;
  submitDetail: string;
}

export interface PostContext {
  db: Knex;
  chain: ChainProvider;
  fetchFn: FetchFn;
  origin: string;
  /**
   * Signed-in account id. When set, posting refuses unless the imported
   * Twetch key is linked to that account — an unlinked key produces
   * transactions Twetch cannot attribute (and a 401 from its indexer).
   */
  expectUserId?: number;
}

/**
 * Post text to Twetch: build the B://+MAP+AIP output, fund and broadcast
 * through the BRC-100 facade (policy-gated), then best-effort register the
 * txid with Twetch's API for immediate indexing. A failed API submit does
 * not fail the post — the transaction is already on-chain.
 */
export async function postText(ctx: PostContext, content: string, opts: { userId?: number } = {}): Promise<PostResult> {
  const text = content.trim();
  if (text.length < 1) fail("BAD_PARAM", "post content required");
  if (Utils.toArray(text, "utf8").length > 2000) fail("BAD_PARAM", "post content too large");
  const address = await twetchAddress();
  if (!address) fail("NO_TWETCH_ACCOUNT", "no Twetch key imported — run: bsv twetch account import");
  const publicKey = await twetchPublicKey();
  if (ctx.expectUserId && ctx.expectUserId > 0 && publicKey) {
    const owner = await userByPubkey(ctx.fetchFn, publicKey);
    if (owner !== ctx.expectUserId) {
      fail(
        "TWETCH_KEY_MISMATCH",
        "the imported Twetch key is not linked to your account — re-run Import to Twetch (or import the account WIF), then try again",
      );
    }
  }

  const fields = postFields(text);
  const signature = await twetchSignBytes(aipMessage(fields));
  const scriptHex = buildPostScript(text, { address, signature });

  const facade = createBrc100Wallet({ db: ctx.db, chain: ctx.chain, fetchFn: ctx.fetchFn });
  const excerpt = text.replace(/\s+/g, " ").slice(0, 60);
  const action = (await facade.createAction(
    {
      description: `Twetch post: ${excerpt}`,
      outputs: [
        {
          lockingScript: scriptHex,
          satoshis: 0,
          outputDescription: "Twetch post",
        },
      ],
      labels: ["twetch", "post"],
      options: { randomizeOutputs: false },
    },
    ctx.origin,
  )) as { txid?: string };
  const txid = action.txid;
  if (!txid) fail("RAILS", "post transaction was not broadcast");

  let submitted = false;
  let submitDetail = "not submitted";
  try {
    const hex = await txHex(ctx.fetchFn, txid);
    if (hex) {
      const userId = opts.userId ?? 0;
      if (userId > 0) {
        await submitPost(ctx, userId, text, txid, hex);
        submitted = true;
        submitDetail = "indexed by twetch";
      } else {
        submitDetail = "no userId — on-chain only";
      }
    } else {
      submitDetail = "tx hex unavailable — on-chain only";
    }
  } catch (e) {
    submitDetail = e instanceof Error ? e.message.slice(0, 200) : String(e);
  }
  return { txid, content: text, authorAddress: address, submitted, submitDetail };
}

async function txHex(fetchFn: FetchFn, txid: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetchFn(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const hex = (await res.text()).trim();
    return /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0 ? hex : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** x-twetch-sig: BSM(`${method}\n${path}\n${userId}\n${ts}\n${body}`). */
export function authMessage(method: string, path: string, userId: number, ts: number, body: string): string {
  return `${method}\n${path}\n${userId}\n${ts}\n${body}`;
}

async function submitPost(ctx: PostContext, userId: number, content: string, txid: string, txHexStr: string): Promise<void> {
  const path = "/v1/posts";
  const body = JSON.stringify({
    userId,
    content,
    metadataVersion: 2,
    txHex: txHexStr,
  });
  const ts = Date.now();
  const sig = await twetchSignBytes(Utils.toArray(authMessage("POST", path, userId, ts, body), "utf8"));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await ctx.fetchFn(`${TWETCH_API}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-twetch-user": String(userId),
        "x-twetch-ts": String(ts),
        "x-twetch-sig": sig,
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      fail("RAILS", `twetch index ${res.status}: ${detail}`);
    }
  } finally {
    clearTimeout(t);
  }
}

/** Verify an AIP record the same way Twetch's indexer must. */
export function verifyAip(content: string, aip: { address: string; signature: string }): boolean {
  try {
    const message = aipMessage(postFields(content));
    const compact = Utils.toArray(aip.signature, "base64");
    if (compact.length !== 65) return false;
    const recid = compact[0]! - 31;
    if (recid < 0 || recid > 3) return false;
    const sig = Signature.fromCompact(compact);
    const e = new BigNumber(BSM.magicHash(message));
    const pub = sig.RecoverPublicKey(recid, e);
    return pub.toAddress("mainnet") === aip.address;
  } catch {
    return false;
  }
}