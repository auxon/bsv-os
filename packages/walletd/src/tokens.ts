/**
 * F5 money views: 1Sat Ordinals gallery + BSV21 balances (read side).
 *
 * Reads come from the public 1Sat Stack (api.1sat.app, no keys):
 * - owner TXO stream (`/1sat/owner/{address}/txos`) for owned outpoints,
 * - ORDFS bulk metadata (`/1sat/ordfs/metadata`) to identify inscriptions,
 * - BSV21 token registry + per-token ordlock balances.
 *
 * Send side lives in engine.ts (ordinal transfers only). BSV21 transfers
 * need protocol-aware tx building and are explicitly deferred (see
 * engine.ts) — the spec's "read-only-first" half is this module.
 */
import type { ChainProvider } from "./chain.ts";

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
