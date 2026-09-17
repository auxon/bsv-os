/**
 * F5 money views: 1Sat Ordinals gallery + BSV21 balances (read side).
 *
 * Reads come from the public 1Sat Stack (api.1sat.app, no keys):
 * - owner TXO stream (`/1sat/owner/{address}/txos`) for owned outpoints,
 * - ORDFS bulk metadata (`/1sat/ordfs/metadata`) to identify inscriptions,
 * - BSV21 token registry + per-token ordlock balances.
 *
 * Send side lives in engine.ts (ordinal + BSV21 transfers). BSV21 transfers
 * spend token UTXOs and recreate them per the bsv-20 protocol: every token
 * output carries its own `transfer` inscription (`OP_0 OP_IF "ord" OP_1
 * <"application/bsv-20"> OP_0 <json> OP_ENDIF`) appended to the owner's
 * P2PKH script, with conservation enforced (outputs ≤ inputs).
 */
import type { ChainProvider } from "./chain.ts";
import { p2pkhScript } from "./tx.ts";

export const ONESAT = "https://api.1sat.app";

export interface OwnerTxo {
  outpoint: string; // txid_vout (underscores; dots tolerated)
  satoshis: number;
}

export interface InscriptionRow {
  outpoint: string;
  txid: string;
  vout: number;
  satoshis: number;
  contentType: string;
  contentLength: number;
  origin: string;
  sequence: number;
  contentUrl: string;
}

export interface Bsv21Position {
  tokenId: string;
  symbol: string;
  decimals: number;
  icon: string | null;
  balance: number;
  utxoCount: number;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function aget(fetchFn: FetchFn, url: string, timeoutMs = 20000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
  } finally {
    clearTimeout(t);
  }
}

/** Split txid_vout or txid.vout (both circulate) into parts. */
export function splitOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const m = /^([0-9a-fA-F]{64})[_.](\d+)$/.exec((outpoint ?? "").trim());
  if (!m) return null;
  return { txid: m[1]!.toLowerCase(), vout: Number(m[2]) };
}

/**
 * Collect unspent owned TXOs from the SSE stream. Ports the SDK's event
 * protocol (sync → txo* → done/error) without the dependency.
 */
export async function fetchOwnerTxos(
  address: string,
  opts: { fetchFn?: FetchFn; base?: string; limit?: number } = {},
): Promise<OwnerTxo[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.base ?? ONESAT;
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const url = `${base}/1sat/owner/${encodeURIComponent(address)}/txos?unspent=true&sats=true&limit=${limit}`;
  const res = await aget(fetchFn, url, 45000);
  if (!res.ok || !res.body) throw new Error(`owner stream failed (${res.status})`);
  const out: OwnerTxo[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = !!chunk.done;
    buf += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !done });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = /^event:\s*(\w+)/m.exec(raw)?.[1] ?? "";
      const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (event === "txo") {
        try {
          const txo = JSON.parse(data) as { outpoint?: unknown; satoshis?: unknown };
          const parts = typeof txo.outpoint === "string" ? splitOutpoint(txo.outpoint) : null;
          if (parts) out.push({ outpoint: `${parts.txid}_${parts.vout}`, satoshis: Math.floor(Number(txo.satoshis) || 0) });
        } catch {
          /* skip malformed records */
        }
      } else if (event === "done") {
        done = true;
        break;
      } else if (event === "error") {
        throw new Error(`owner stream error: ${data.slice(0, 200)}`);
      }
    }
  }
  try {
    reader.releaseLock();
  } catch {
    /* ignore */
  }
  return out;
}

export interface OrdfsMeta {
  outpoint: string;
  origin?: string;
  sequence: number;
  contentType: string;
  contentLength: number;
}

/** Bulk ORDFS metadata for outpoints (txid_vout form). Missing → null. */
export async function fetchBulkMetadata(
  outpoints: string[],
  opts: { fetchFn?: FetchFn; base?: string } = {},
): Promise<Record<string, OrdfsMeta | null>> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.base ?? ONESAT;
  if (outpoints.length === 0) return {};
  // Bulk endpoint is POST { outpoints: [...] }.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetchFn(`${base}/1sat/ordfs/metadata`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ outpoints }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`ordfs metadata failed (${r.status})`);
    const j = (await r.json()) as Record<string, OrdfsMeta | null>;
    return j && typeof j === "object" ? j : {};
  } finally {
    clearTimeout(t);
  }
}

export function contentUrl(outpoint: string, base = ONESAT): string {
  return `${base}/content/${outpoint}`;
}

/**
 * Gallery: owned unspent TXOs joined to inscription metadata. Outpoints
 * without metadata are plain sats (already visible in baskets) and skipped.
 */
export async function galleryFor(
  address: string,
  opts: { fetchFn?: FetchFn; base?: string; chain?: ChainProvider } = {},
): Promise<InscriptionRow[]> {
  const base = opts.base ?? ONESAT;
  const txos = await fetchOwnerTxos(address, { fetchFn: opts.fetchFn, base });
  if (txos.length === 0) return [];
  const meta = await fetchBulkMetadata(
    txos.map((t) => t.outpoint),
    { fetchFn: opts.fetchFn, base },
  );
  const rows: InscriptionRow[] = [];
  for (const t of txos) {
    const m = meta[t.outpoint] ?? meta[t.outpoint.replace("_", ".")] ?? null;
    if (!m || !m.contentType) continue;
    const parts = splitOutpoint(t.outpoint)!;
    rows.push({
      outpoint: t.outpoint,
      txid: parts.txid,
      vout: parts.vout,
      satoshis: t.satoshis,
      contentType: String(m.contentType),
      contentLength: Math.floor(Number(m.contentLength) || 0),
      origin: typeof m.origin === "string" ? m.origin : t.outpoint,
      sequence: Math.floor(Number(m.sequence) || 0),
      contentUrl: contentUrl(t.outpoint, base),
    });
  }
  return rows;
}

interface TokenListEntry {
  token_id?: unknown;
  symbol?: unknown;
  decimals?: unknown;
  icon?: unknown;
}

/** BSV21 positions: registry fan-out, nonzero balances only. */
export async function bsv21For(
  address: string,
  opts: { fetchFn?: FetchFn; base?: string; maxTokens?: number } = {},
): Promise<Bsv21Position[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.base ?? ONESAT;
  const res = await aget(fetchFn, `${base}/1sat/bsv21/tokens`);
  if (!res.ok) throw new Error(`bsv21 registry failed (${res.status})`);
  const list = (await res.json()) as TokenListEntry[];
  if (!Array.isArray(list)) return [];
  const maxTokens = Math.min(Math.max(opts.maxTokens ?? 300, 1), 2000);
  const out: Bsv21Position[] = [];
  for (let i = 0; i < Math.min(list.length, maxTokens); i += 10) {
    const batch = list.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (t) => {
        const tokenId = typeof t.token_id === "string" ? t.token_id : "";
        if (!tokenId) return null;
        try {
          const r = await aget(
            fetchFn,
            `${base}/1sat/bsv21/${encodeURIComponent(tokenId)}/ordlock/${encodeURIComponent(address)}/balance`,
            15000,
          );
          if (!r.ok) return null;
          const j = (await r.json()) as { balance?: unknown; utxoCount?: unknown };
          const balance = Math.floor(Number(j.balance) || 0);
          if (!(balance > 0)) return null;
          return {
            tokenId,
            symbol: typeof t.symbol === "string" && t.symbol ? t.symbol : tokenId.slice(0, 12),
            decimals: Math.floor(Number(t.decimals) || 0),
            icon: typeof t.icon === "string" ? t.icon : null,
            balance,
            utxoCount: Math.floor(Number(j.utxoCount) || 0),
          } satisfies Bsv21Position;
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) if (r) out.push(r);
  }
  return out;
}

/**
 * F5 send side: BSV21 (bsv-20 protocol) transfer construction.
 *
 * Envelope bytes follow the 1Sat Ordinals standard, verified against the
 * 1sat-sdk reference (`packages/templates/src/inscription`):
 *   [owner P2PKH] OP_0 OP_IF "ord" OP_1 <content-type> OP_0 <json> OP_ENDIF
 * with content-type `application/bsv-20` and JSON
 * `{"p":"bsv-20","op":"transfer","id":"<txid>_<vout>","amt":"<uint64>"}`.
 * Amounts are base-unit strings everywhere — never floats.
 */
export const BSV20_PROTOCOL = "bsv-20";
export const BSV20_CONTENT_TYPE = "application/bsv-20";
const MAX_UINT64 = BigInt(2) ** BigInt(64) - BigInt(1);

/** Canonical `<txid>_<vout>` (lowercase); accepts dot separators. */
export function normalizeTokenId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^([0-9a-fA-F]{64})[_.](\d+)$/.exec(raw.trim());
  if (!m) return null;
  return `${m[1]!.toLowerCase()}_${Number(m[2])}`;
}

/** Canonical base-unit amount. Rejects floats, signs, zero, > uint64. */
export function parseTokenAmount(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  let n: bigint;
  try {
    n = BigInt(s);
  } catch {
    return null;
  }
  if (n <= BigInt(0) || n > MAX_UINT64) return null;
  return n.toString();
}

function pushBytes(bytes: Uint8Array): number[] {
  const arr = Array.from(bytes);
  if (arr.length <= 75) return [arr.length, ...arr];
  if (arr.length <= 255) return [0x4c, arr.length, ...arr];
  return [0x4d, arr.length & 0xff, (arr.length >> 8) & 0xff, ...arr];
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Owner P2PKH script with the transfer inscription appended. Returns hex. */
export function bsv21TransferScript(ownerAddress: string, tokenId: string, amt: string): string {
  const prefix = Buffer.from(p2pkhScript(ownerAddress).toHex(), "hex");
  const json = Buffer.from(JSON.stringify({ p: BSV20_PROTOCOL, op: "transfer", id: tokenId, amt }), "utf8");
  const body = Buffer.from([
    0x00, 0x63, // OP_0 OP_IF
    ...pushBytes(utf8("ord")),
    0x51, // OP_1
    ...pushBytes(utf8(BSV20_CONTENT_TYPE)),
    0x00, // OP_0
    ...pushBytes(new Uint8Array(json)),
    0x68, // OP_ENDIF
  ]);
  return Buffer.concat([prefix, body]).toString("hex");
}

function readPush(buf: Buffer, at: number): { data: Buffer; next: number } | null {
  if (at >= buf.length) return null;
  const op = buf[at]!;
  if (op <= 75) {
    if (at + 1 + op > buf.length) return null;
    return { data: buf.subarray(at + 1, at + 1 + op), next: at + 1 + op };
  }
  if (op === 0x4c) {
    if (at + 2 > buf.length) return null;
    const len = buf[at + 1]!;
    if (at + 2 + len > buf.length) return null;
    return { data: buf.subarray(at + 2, at + 2 + len), next: at + 2 + len };
  }
  if (op === 0x4d) {
    if (at + 3 > buf.length) return null;
    const len = buf[at + 1]! | (buf[at + 2]! << 8);
    if (at + 3 + len > buf.length) return null;
    return { data: buf.subarray(at + 3, at + 3 + len), next: at + 3 + len };
  }
  return null;
}

/** Byte offset just past `OP_0 OP_IF`, or -1 when no ord envelope. */
function ordEnvelopeStart(buf: Buffer): number {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x63) return i + 2;
  }
  return -1;
}

/** True when the script carries any `ord` inscription envelope. */
export function hasOrdEnvelope(scriptHex: string): boolean {
  let buf: Buffer;
  try {
    buf = Buffer.from(String(scriptHex), "hex");
  } catch {
    return false;
  }
  const start = ordEnvelopeStart(buf);
  if (start < 0) return false;
  const tag = readPush(buf, start);
  return !!tag && tag.data.toString("utf8") === "ord" && buf[tag.next] === 0x51;
}

export interface Bsv21Envelope {
  protocol: string;
  op: string;
  id: string;
  amt: string;
  contentType: string;
}

/** Parse the first `ord` envelope. Null on any deviation. */
export function parseBsv21Envelope(scriptHex: string): Bsv21Envelope | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(String(scriptHex), "hex");
  } catch {
    return null;
  }
  const start = ordEnvelopeStart(buf);
  if (start < 0) return null;
  const tag = readPush(buf, start);
  if (!tag || tag.data.toString("utf8") !== "ord") return null;
  if (buf[tag.next] !== 0x51) return null; // OP_1
  const ct = readPush(buf, tag.next + 1);
  if (!ct) return null;
  if (buf[ct.next] !== 0x00) return null; // OP_0
  const body = readPush(buf, ct.next + 1);
  if (!body) return null;
  if (buf[body.next] !== 0x68) return null; // OP_ENDIF
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.data.toString("utf8"));
  } catch {
    return null;
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  if (typeof o.p !== "string" || typeof o.op !== "string") return null;
  return {
    protocol: o.p,
    op: o.op,
    id: typeof o.id === "string" ? o.id : "",
    amt: typeof o.amt === "string" ? o.amt : "",
    contentType: ct.data.toString("utf8"),
  };
}

export interface TokenHolding {
  txid: string;
  vout: number;
  amt: string;
  op: string;
  id: string;
}

/**
 * Our unspent carriers of one token: bulk-validate outpoints against the
 * 1Sat indexer (`POST /1sat/bsv21/{id}/outputs`), keep unspent rows whose
 * inscription id matches and whose amount parses. Spent rows (`spend`
 * set) are skipped — the indexer is the arbiter of spend state, the
 * engine re-verifies scripts before signing.
 */
export async function tokenHoldings(
  tokenId: string,
  outpoints: string[],
  opts: { fetchFn?: FetchFn; base?: string } = {},
): Promise<TokenHolding[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.base ?? ONESAT;
  const mine = outpoints
    .map((o) => {
      const p = splitOutpoint(o);
      return p ? `${p.txid}_${p.vout}` : null;
    })
    .filter((o): o is string => o !== null);
  if (!mine.length) return [];
  let res: Response;
  try {
    res = await fetchFn(`${base}/1sat/bsv21/${encodeURIComponent(tokenId)}/outputs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mine),
    });
  } catch (e) {
    const err = new Error(`token lookup unreachable: ${e instanceof Error ? e.message : String(e)}`) as Error & { code: string };
    err.code = "RAILS";
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`token lookup failed (${res.status})`) as Error & { code: string };
    err.code = "RAILS";
    throw err;
  }
  const parsed: unknown = await res.json().catch(() => []);
  // the indexer answers JSON null (200) when none of the outpoints are
  // known token outputs — treat any non-array as "no holdings"
  const rows = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  const out: TokenHolding[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object" || r.spend) continue;
    const bsv21 = (r.data as Record<string, unknown> | undefined)?.bsv21 as Record<string, unknown> | undefined;
    if (!bsv21 || bsv21.id !== tokenId) continue;
    const amt = parseTokenAmount(bsv21.amt);
    if (!amt) continue;
    const p = splitOutpoint(String(r.outpoint ?? ""));
    if (!p) continue;
    out.push({ ...p, amt, op: String(bsv21.op ?? ""), id: String(bsv21.id) });
  }
  return out;
}
