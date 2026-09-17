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
import { BigNumber, BSM, Hash, Script, Signature, Utils } from "@bsv/sdk";
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

export const MEDIA_MAX_BYTES = 1_000_000;

/** Twetch's B:// media output: OP_0 OP_RETURN <B prefix> <bytes> <mime>. */
export function buildMediaScript(bytes: number[], mime: string): string {
  const script = new Script();
  script.writeOpCode(0x00);
  script.writeOpCode(0x6a);
  script.writeBin(Utils.toArray(B_PREFIX, "utf8"));
  script.writeBin(bytes);
  script.writeBin(Utils.toArray(mime, "utf8"));
  return script.toHex();
}

export interface PostMedia {
  bytes: number[];
  mime: string;
}

export interface PostResult {
  txid: string;
  content: string;
  authorAddress: string;
  submitted: boolean;
  submitDetail: string;
  mediaBytes: number;
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
export async function postText(
  ctx: PostContext,
  content: string,
  opts: { userId?: number; media?: PostMedia } = {},
): Promise<PostResult> {
  const base = content.trim();
  if (base.length < 1) fail("BAD_PARAM", "post content required");

  let media: PostMedia | null = null;
  let mediaRef: string | null = null;
  if (opts.media) {
    const mime = String(opts.media.mime || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime)) {
      fail("BAD_PARAM", "media mime type required (e.g. image/jpeg)");
    }
    if (!Array.isArray(opts.media.bytes) || opts.media.bytes.length < 1) {
      fail("BAD_PARAM", "media bytes required");
    }
    if (opts.media.bytes.length > MEDIA_MAX_BYTES) {
      fail("BAD_PARAM", `media too large (${MEDIA_MAX_BYTES} byte cap)`);
    }
    media = { bytes: opts.media.bytes, mime };
    mediaRef = `b://${Utils.toHex(Hash.sha256(media.bytes))}`;
  }

  // Twetch's composer adds attached media to the post as an on-chain ref
  // ("added to your post as a link"): the ref is part of the signed text
  // and drives image rendering on twetch.com.
  const text = mediaRef ? `${base}\n\n${mediaRef}` : base;
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

  const outputs: Array<{ lockingScript: string; satoshis: number; outputDescription: string }> = [
    { lockingScript: scriptHex, satoshis: 0, outputDescription: "Twetch post" },
  ];
  if (media) {
    outputs.push({
      lockingScript: buildMediaScript(media.bytes, media.mime),
      satoshis: 0,
      outputDescription: "Twetch media",
    });
  }

  const facade = createBrc100Wallet({ db: ctx.db, chain: ctx.chain, fetchFn: ctx.fetchFn });
  const excerpt = text.replace(/\s+/g, " ").slice(0, 60);
  const action = (await facade.createAction(
    {
      description: `Twetch post: ${excerpt}`,
      outputs,
      labels: media ? ["twetch", "post", "photo"] : ["twetch", "post"],
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
        await submitPost(ctx, userId, text, txid, hex, mediaRef);
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
  return { txid, content: text, authorAddress: address, submitted, submitDetail, mediaBytes: media?.bytes.length ?? 0 };
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

async function submitPost(
  ctx: PostContext,
  userId: number,
  content: string,
  txid: string,
  txHexStr: string,
  mediaRef: string | null = null,
): Promise<void> {
  const path = "/v1/posts";
  const body = JSON.stringify({
    userId,
    content,
    metadataVersion: 2,
    txHex: txHexStr,
    ...(mediaRef ? { mediaRefs: [mediaRef] } : {}),
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
// ── Meme Library (Dank Rares) ─────────────────────────────────────────

export interface MemeItem {
  id: string;
  title: string;
  description: string;
  folder: string;
  folderSlug: string;
  format: string;
  mediaUrl: string;
  previewUrl: string;
  onchainRef: string;
  sha256: string;
  tags: string[];
  tokenNumber: number | null;
  ownerUserId: number | null;
  uploadedAtMs: number;
  bytes: number;
  url: string;
}

export interface MemePage {
  items: MemeItem[];
  nextCursor: string | null;
  total: number;
}

export interface MemeFolder {
  slug: string;
  label: string;
  name: string;
  count: number;
}

export interface MemeQuery {
  q?: string;
  folder?: string;
  tag?: string;
  format?: string;
  sort?: string;
  uploaderUserId?: number;
  cursor?: string;
  limit?: number;
}

function mediaUrlOf(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:/i, "https:");
  if (s.startsWith("/")) return `${TWETCH_API}${s}`;
  if (s.startsWith("b://")) {
    const m = s.slice(4).match(/[a-f0-9]{64}/i);
    return m ? `${TWETCH_API}/v1/media/${m[0].toLowerCase()}.jpg?v=4` : "";
  }
  if (/^[a-f0-9]{64}$/i.test(s)) return `${TWETCH_API}/v1/media/${s.toLowerCase()}.jpg?v=4`;
  if (/^[0-9a-f]{40,}$/i.test(s)) return `https://media.ordinalswallet.com/${s}`;
  return `https://media.ordinalswallet.com/${s}`;
}

function memeSlug(title: string): string {
  return (
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90)
      .replace(/-+$/g, "") || "meme"
  );
}

function asMeme(m: Record<string, unknown>): MemeItem {
  const sha256 = typeof m.sha256 === "string" ? m.sha256 : "";
  const title = typeof m.title === "string" ? m.title : "";
  const media = mediaUrlOf(m.mediaUrl);
  const preview = mediaUrlOf(m.previewUrl);
  return {
    id: typeof m.id === "string" ? m.id : "",
    title,
    description: typeof m.description === "string" ? m.description : "",
    folder: typeof m.folder === "string" ? m.folder : "",
    folderSlug: typeof m.folderSlug === "string" ? m.folderSlug : "",
    format: typeof m.format === "string" ? m.format : "",
    mediaUrl: media,
    previewUrl: preview || media,
    onchainRef: typeof m.onchainRef === "string" ? m.onchainRef : typeof m.path === "string" ? m.path : "",
    sha256,
    tags: Array.isArray(m.tags) ? (m.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
    tokenNumber: m.tokenNumber == null ? null : Math.floor(Number(m.tokenNumber) || 0),
    ownerUserId: m.ownerUserId == null ? null : Math.floor(Number(m.ownerUserId) || 0),
    uploadedAtMs: Math.floor(Number(m.uploadedAtMs) || 0),
    bytes: Math.floor(Number(m.bytes) || 0),
    url: sha256 ? `https://twetch.com/meme-library/meme/${sha256}/${memeSlug(title)}` : "https://twetch.com/meme-library",
  };
}

/** Read-only Meme Library (Dank Rares) browse/search. */
export async function memeLibrary(fetchFn: FetchFn, opts: MemeQuery = {}): Promise<MemePage> {
  const q = new URLSearchParams();
  if (opts.cursor) q.set("cursor", opts.cursor);
  if (opts.q && opts.q.trim()) q.set("q", opts.q.trim());
  if (opts.folder) q.set("folder", opts.folder);
  if (opts.tag) q.set("tag", opts.tag);
  if (opts.format && opts.format !== "all") q.set("format", opts.format);
  if (opts.sort) q.set("sort", opts.sort);
  if (opts.uploaderUserId && opts.uploaderUserId > 0) q.set("uploaderUserId", String(opts.uploaderUserId));
  q.set("limit", String(Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), 60)));
  const payload = (await jget(fetchFn, `/v1/dank-rares?${q.toString()}`)) as Record<string, unknown>;
  const items = Array.isArray(payload.items) ? (payload.items as Record<string, unknown>[]) : [];
  return {
    items: items.map(asMeme),
    nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null,
    total: Math.floor(Number(payload.total) || 0),
  };
}

/** Meme Library category chips (labels + counts). */
export async function memeFolders(fetchFn: FetchFn): Promise<MemeFolder[]> {
  const payload = (await jget(fetchFn, "/v1/dank-rares/folders")) as Record<string, unknown>;
  const cats = Array.isArray(payload.categories) ? (payload.categories as Record<string, unknown>[]) : [];
  return cats.map((c) => ({
    slug: typeof c.slug === "string" ? c.slug : "",
    label: typeof c.label === "string" ? c.label : typeof c.name === "string" ? c.name : "",
    name: typeof c.name === "string" ? c.name : "",
    count: Math.floor(Number(c.count) || 0),
  }));
}

// ── NFT Market ────────────────────────────────────────────────────────

export interface MarketListing {
  id: number;
  name: string;
  number: number | null;
  collection: string;
  collectionName: string | null;
  imageUrl: string;
  priceSats: number;
  rarity: string | null;
  outpoint: string;
  sellerAddress: string;
  sellerUserId: number | null;
  status: string;
  createdAtMs: number;
  url: string;
}

export interface MarketSale {
  txid: string;
  tokenName: string;
  number: number | null;
  collection: string;
  collectionName: string | null;
  imageUrl: string;
  priceSats: number;
  listPriceSats: number | null;
  rarity: string | null;
  outpoint: string;
  soldAtMs: number;
  url: string;
}

export interface MarketCollection {
  contractAddress: string;
  name: string;
  description: string;
  imageUrl: string;
  bannerUrl: string;
  floorSats: number;
  volumeSats: number;
  numListings: number;
  owners: number;
  salesCount: number;
  circulating: number;
  total: number;
  status: string;
  launchDateMs: number;
  url: string;
}

function marketItemUrl(collection: string, number: number | null): string {
  const base = `https://twetch.com/market/${encodeURIComponent(collection)}`;
  return number == null ? base : `${base}?token=${number}`;
}

function asListing(m: Record<string, unknown>): MarketListing {
  const collection = typeof m.collection === "string" ? m.collection : "";
  const number = m.number == null ? null : Math.floor(Number(m.number) || 0);
  return {
    id: Math.floor(Number(m.id) || 0),
    name: typeof m.name === "string" ? m.name : "",
    number,
    collection,
    collectionName: typeof m.collectionName === "string" ? m.collectionName : null,
    imageUrl: mediaUrlOf(m.image),
    priceSats: Math.floor(Number(m.priceSats) || 0),
    rarity: typeof m.rarity === "string" ? m.rarity : null,
    outpoint: typeof m.outpoint === "string" ? m.outpoint : "",
    sellerAddress: typeof m.sellerAddress === "string" ? m.sellerAddress : "",
    sellerUserId: m.sellerUserId == null ? null : Math.floor(Number(m.sellerUserId) || 0),
    status: typeof m.status === "string" ? m.status : "",
    createdAtMs: Math.floor(Number(m.createdAtMs) || 0),
    url: marketItemUrl(collection, number),
  };
}

function asSale(m: Record<string, unknown>): MarketSale {
  const collection = typeof m.collection === "string" ? m.collection : "";
  const number = m.number == null ? null : Math.floor(Number(m.number) || 0);
  return {
    txid: typeof m.txid === "string" ? m.txid : "",
    tokenName: typeof m.tokenName === "string" ? m.tokenName : "",
    number,
    collection,
    collectionName: typeof m.collectionName === "string" ? m.collectionName : null,
    imageUrl: mediaUrlOf(m.image),
    priceSats: Math.floor(Number(m.priceSats) || 0),
    listPriceSats: m.listPriceSats == null ? null : Math.floor(Number(m.listPriceSats) || 0),
    rarity: typeof m.rarity === "string" ? m.rarity : null,
    outpoint: typeof m.outpoint === "string" ? m.outpoint : "",
    soldAtMs: Math.floor(Number(m.timestampMs) || 0),
    url: marketItemUrl(collection, number),
  };
}

function asCollection(m: Record<string, unknown>): MarketCollection {
  const contractAddress = typeof m.contractAddress === "string" ? m.contractAddress : "";
  return {
    contractAddress,
    name: typeof m.name === "string" ? m.name : "",
    description: typeof m.description === "string" ? m.description : "",
    imageUrl: mediaUrlOf(m.profileImage ?? m.profileFallbackImage),
    bannerUrl: mediaUrlOf(m.bannerImage),
    floorSats: Math.floor(Number(m.floorSats) || 0),
    volumeSats: Math.floor(Number(m.volumeSats) || 0),
    numListings: Math.floor(Number(m.numListings) || 0),
    owners: Math.floor(Number(m.owners) || 0),
    salesCount: Math.floor(Number(m.salesCount) || 0),
    circulating: Math.floor(Number(m.circulating) || 0),
    total: Math.floor(Number(m.total) || 0),
    status: typeof m.status === "string" ? m.status : "",
    launchDateMs: Math.floor(Number(m.launchDateMs) || 0),
    url: contractAddress ? `https://twetch.com/market/${encodeURIComponent(contractAddress)}` : "https://twetch.com/market",
  };
}

interface MarketPage<T> {
  items: T[];
  nextCursor: string | null;
}

async function marketPage<T>(
  fetchFn: FetchFn,
  path: string,
  map: (m: Record<string, unknown>) => T,
  opts: { cursor?: string; limit?: number },
): Promise<MarketPage<T>> {
  const q = new URLSearchParams();
  if (opts.cursor) q.set("cursor", opts.cursor);
  q.set("limit", String(Math.min(Math.max(Math.floor(opts.limit ?? 24), 1), 50)));
  const payload = (await jget(fetchFn, `${path}?${q.toString()}`)) as Record<string, unknown>;
  const data = Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : [];
  return {
    items: data.map(map),
    nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null,
  };
}

export function marketListings(
  fetchFn: FetchFn,
  opts: { cursor?: string; limit?: number } = {},
): Promise<MarketPage<MarketListing>> {
  return marketPage(fetchFn, "/v1/market/listings", asListing, opts);
}

export function marketSales(
  fetchFn: FetchFn,
  opts: { cursor?: string; limit?: number } = {},
): Promise<MarketPage<MarketSale>> {
  return marketPage(fetchFn, "/v1/market/sales", asSale, opts);
}

export function marketCollections(
  fetchFn: FetchFn,
  opts: { cursor?: string; limit?: number } = {},
): Promise<MarketPage<MarketCollection>> {
  return marketPage(fetchFn, "/v1/market/collections", asCollection, opts);
}

// ── Profiles ──────────────────────────────────────────────────────────

export interface TwetchProfile {
  id: number;
  name: string;
  description: string;
  avatarUrl: string;
  bannerUrl: string;
  publicKey: string;
  isGreen: boolean;
  numFollowers: number;
  numFollowing: number;
  createdAtMs: number;
  url: string;
}

export async function userProfile(fetchFn: FetchFn, userId: number): Promise<TwetchProfile> {
  if (!Number.isInteger(userId) || userId <= 0) fail("BAD_PARAM", "userId required");
  const u = (await jget(fetchFn, `/v1/users/${userId}`)) as Record<string, unknown>;
  return {
    id: Math.floor(Number(u.id) || userId),
    name: typeof u.name === "string" ? u.name : "",
    description: typeof u.description === "string" ? u.description : "",
    avatarUrl: mediaUrlOf(u.icon),
    bannerUrl: mediaUrlOf(u.banner),
    publicKey: typeof u.publicKey === "string" ? u.publicKey : "",
    isGreen: u.isTwetchGreen === true,
    numFollowers: Math.floor(Number(u.numFollowers) || 0),
    numFollowing: Math.floor(Number(u.numFollowing) || 0),
    createdAtMs: Math.floor(Number(u.createdAtMs) || 0),
    url: `https://twetch.com/u/${userId}`,
  };
}

/** A user's posts (same shape as the public feed). */
export async function userPosts(
  fetchFn: FetchFn,
  userId: number,
  opts: { limit?: number; cursor?: string } = {},
): Promise<FeedPage> {
  if (!Number.isInteger(userId) || userId <= 0) fail("BAD_PARAM", "userId required");
  const q = new URLSearchParams();
  q.set("limit", String(Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100)));
  if (opts.cursor) q.set("cursor", opts.cursor);
  const payload = (await jget(fetchFn, `/v1/users/${userId}/posts?${q.toString()}`)) as Record<string, unknown>;
  const users = userMapOf(payload);
  const data = Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : [];
  return {
    posts: data.map((p) => asPost(p, users)),
    nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null,
  };
}
