/**
 * Chain access behind one interface. Production pairs ARC (writes) with
 * WhatsOnChain (reads); tests use the scriptable MockChainProvider.
 * Lesson from PocketPets: broadcast-accepted is NOT confirmed — every write
 * returns a txid that must be watched to a terminal state.
 */

export type TxStatus = "UNKNOWN" | "SEEN" | "MINED" | "REJECTED";

export interface ChainUtxo {
  txid: string;
  vout: number;
  value: number;
  height: number;
}

export interface ChainTx {
  confirmations: number;
  vin: Array<{ txid?: string; vout?: number }>;
  vout: Array<{ value?: number; addresses?: string[] }>;
}

export interface ChainProvider {
  readonly name: string;
  broadcast(txHex: string): Promise<{ txid: string; status: TxStatus; detail?: string }>;
  status(txid: string): Promise<{ status: TxStatus; blockHeight: number; competing?: string[] | null; detail?: string | null }>;
  utxos(address: string): Promise<{ confirmed: number; unconfirmed: number; utxos: ChainUtxo[] }>;
  tx(txid: string): Promise<ChainTx | null>;
}

const ARC = "https://arc.gorillapool.io/v1";
const WOC = "https://api.whatsonchain.com/v1/bsv/main";

async function jfetch(url: string, init?: RequestInit, timeoutMs = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function mapArcStatus(s: string | undefined): TxStatus {
  switch ((s ?? "").toUpperCase()) {
    case "MINED":
      return "MINED";
    case "SEEN_ON_NETWORK":
    case "SENT_TO_NETWORK":
    case "ACCEPTED":
      return "SEEN";
    case "REJECTED":
    case "DOUBLE_SPEND":
      return "REJECTED";
    default:
      return "UNKNOWN";
  }
}

/** Production writes: GorillaPool ARC. */
export class ArcProvider {
  readonly name = "arc-gorillapool";
  async broadcast(txHex: string): Promise<{ txid: string; status: TxStatus; detail?: string }> {
    const r = await jfetch(`${ARC}/tx`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawTx: txHex }),
    });
    const j = (await r.json().catch(() => ({}))) as { txid?: string; txStatus?: string; detail?: string; title?: string; extraInfo?: string };
    if (!r.ok || !j.txid) {
      throw new Error(`broadcast rejected: ${String(j.detail ?? j.extraInfo ?? j.title ?? r.status).slice(0, 200)}`);
    }
    return { txid: j.txid, status: mapArcStatus(j.txStatus), detail: j.extraInfo ?? undefined };
  }
  async status(txid: string) {
    const r = await jfetch(`${ARC}/tx/${txid}`);
    if (!r.ok) return { status: "UNKNOWN" as TxStatus, blockHeight: 0, competing: null, detail: null };
    const j = (await r.json()) as { txStatus?: string; blockHeight?: number; competingTxs?: string[] | null; extraInfo?: string };
    return {
      status: mapArcStatus(j.txStatus),
      blockHeight: j.blockHeight ?? 0,
      competing: j.competingTxs ?? null,
      detail: j.extraInfo ?? null,
    };
  }
}

/** Production reads: WhatsOnChain (keyless endpoints). */
export class WocProvider {
  readonly name = "woc";
  async utxos(address: string) {
    const [u, b] = await Promise.all([
      jfetch(`${WOC}/address/${address}/unspent`).then((r) => (r.ok ? r.json() : [])),
      jfetch(`${WOC}/address/${address}/balance`).then((r) => (r.ok ? r.json() : {})),
    ]);
    const list = (Array.isArray(u) ? u : []) as Array<{ height: number; tx_pos: number; tx_hash: string; value: number }>;
    const bal = (b ?? {}) as { confirmed?: number; unconfirmed?: number };
    return {
      confirmed: bal.confirmed ?? 0,
      unconfirmed: bal.unconfirmed ?? 0,
      utxos: list
        .filter((x) => typeof x.tx_hash === "string" && Number.isFinite(x.value))
        .map((x) => ({ txid: x.tx_hash, vout: x.tx_pos, value: x.value, height: x.height })),
    };
  }
  async tx(txid: string): Promise<ChainTx | null> {
    const r = await jfetch(`${WOC}/tx/hash/${txid}`);
    if (!r.ok) return null;
    const t = (await r.json()) as {
      confirmations?: number;
      vin?: Array<{ txid?: string; vout?: number }>;
      vout?: Array<{ value?: number; scriptPubKey?: { addresses?: string[] } }>;
    };
    return {
      confirmations: t.confirmations ?? 0,
      vin: (t.vin ?? []).map((i) => ({ txid: i.txid, vout: i.vout })),
      vout: (t.vout ?? []).map((o) => ({ value: o.value, addresses: o.scriptPubKey?.addresses })),
    };
  }
}

export interface ResolvedOutpoint {
  txid: string;
  vout: number;
  value: number;
  unconfirmed: boolean;
  /** false when resolved via parent tx (index-blind scripts like envelopes). */
  indexed: boolean;
}

/**
 * Locate a live outpoint. Address UTXO indexes cannot see scripts that map
 * to no address (e.g. inscription envelopes) — absence there means nothing.
 * The parent tx is the source of truth: missing → not yet visible; 0-conf →
 * safe to chain behind; confirmed → resolve (only the key holder can move it;
 * callers must track their own spends, which the monitor does).
 */
export async function resolveOutpoint(
  chain: ChainProvider,
  address: string,
  txid: string,
  vout: number,
): Promise<ResolvedOutpoint> {
  let utx: { utxos: ChainUtxo[] } | null = null;
  try {
    utx = await chain.utxos(address);
  } catch {
    utx = null;
  }
  const live = utx?.utxos.find((u) => u.txid === txid && u.vout === vout);
  if (live) return { txid, vout, value: live.value, unconfirmed: live.height <= 0, indexed: true };
  const parent = await chain.tx(txid).catch(() => null);
  if (!parent) throw new Error("NOT_FOUND: parent tx not visible yet — wait and retry");
  if (parent.confirmations <= 0) {
    return { txid, vout, value: 1, unconfirmed: true, indexed: false };
  }
  return { txid, vout, value: 1, unconfirmed: false, indexed: false };
}
/** Production pair: ARC writes, WhatsOnChain reads. */
export class CombinedProvider implements ChainProvider {
  readonly name = "arc+woc";
  private write: Pick<ChainProvider, "broadcast" | "status">;
  private read: Pick<ChainProvider, "utxos" | "tx">;
  constructor(
    write: Pick<ChainProvider, "broadcast" | "status"> = new ArcProvider(),
    read: Pick<ChainProvider, "utxos" | "tx"> = new WocProvider(),
  ) {
    this.write = write;
    this.read = read;
  }
  broadcast(txHex: string) {
    return this.write.broadcast(txHex);
  }
  status(txid: string) {
    return this.write.status(txid);
  }
  utxos(address: string) {
    return this.read.utxos(address);
  }
  tx(txid: string) {
    return this.read.tx(txid);
  }
}
export class MockChainProvider implements ChainProvider {
  readonly name = "mock";
  private mempool = new Map<string, { hex: string; inputs: Array<{ txid: string; vout: number }> }>();
  private confirmed = new Map<string, { height: number; inputs: Array<{ txid: string; vout: number }> }>();
  private rejected = new Map<string, { competing: string[]; detail: string }>();
  private balances = new Map<string, ChainUtxo[]>();
  height = 1000;

  constructor(seed: Array<{ address: string; utxos: ChainUtxo[] }> = []) {
    for (const s of seed) this.balances.set(s.address, [...s.utxos]);
  }

  private static fakeTxid(hex: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < hex.length; i++) {
      h1 = Math.imul(h1 ^ hex.charCodeAt(i), 16777619);
      h2 = Math.imul(h2 + hex.charCodeAt(i), 31);
    }
    return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")).repeat(4).slice(0, 64);
  }

  /** Test control: pre-seed a mempool tx (default when broadcasting). */
  async broadcast(txHex: string): Promise<{ txid: string; status: TxStatus; detail?: string }> {
    const txid = MockChainProvider.fakeTxid(txHex);
    this.mempool.set(txid, { hex: txHex, inputs: [] });
    return { txid, status: "SEEN" };
  }

  async status(txid: string) {
    if (this.rejected.has(txid)) {
      const r = this.rejected.get(txid)!;
      return { status: "REJECTED" as TxStatus, blockHeight: 0, competing: r.competing, detail: r.detail };
    }
    const c = this.confirmed.get(txid);
    if (c) return { status: "MINED" as TxStatus, blockHeight: c.height, competing: null, detail: null };
    if (this.mempool.has(txid)) return { status: "SEEN" as TxStatus, blockHeight: 0, competing: null, detail: null };
    return { status: "UNKNOWN" as TxStatus, blockHeight: 0, competing: null, detail: null };
  }

  async utxos(address: string) {
    const list = this.balances.get(address) ?? [];
    const confirmed = list.filter((u) => u.height > 0).reduce((a, u) => a + u.value, 0);
    const unconfirmed = list.filter((u) => u.height <= 0).reduce((a, u) => a + u.value, 0);
    return { confirmed, unconfirmed, utxos: [...list] };
  }

  private parents = new Map<string, { confirmations: number }>();

  /** Test control: script what tx() reports for a parent. */
  seedParent(txid: string, confirmations: number): void {
    this.parents.set(txid, { confirmations });
  }

  async tx(txid: string): Promise<ChainTx | null> {
    const p = this.parents.get(txid);
    if (!p) return null;
    return { confirmations: p.confirmations, vin: [], vout: [] };
  }

  // --- test controls ---
  mine(count = 1): void {
    for (let i = 0; i < count; i++) {
      this.height += 1;
      for (const [txid, m] of this.mempool) this.confirmed.set(txid, { height: this.height, inputs: m.inputs });
      this.mempool.clear();
    }
  }
  reject(txid: string, competing: string[] = [], detail = "double spend attempted"): void {
    this.mempool.delete(txid);
    this.rejected.set(txid, { competing, detail });
  }
  /** Simulate a reorg: confirmed tx drops back out of the chain. */
  reorg(txid: string): boolean {
    const c = this.confirmed.get(txid);
    if (!c) return false;
    this.confirmed.delete(txid);
    return true;
  }
  credit(address: string, utxo: ChainUtxo): void {
    this.balances.set(address, [...(this.balances.get(address) ?? []), utxo]);
  }
  spend(address: string, txid: string, vout: number): void {
    this.balances.set(
      address,
      (this.balances.get(address) ?? []).filter((u) => !(u.txid === txid && u.vout === vout)),
    );
  }
}
