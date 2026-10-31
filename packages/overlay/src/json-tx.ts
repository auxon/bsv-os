import type { OverlayTx } from "./topic-manager.ts";

/** Dev/test framing: a JSON overlay tx. Production submit is BEEF. */
export function overlayTxFromJson(raw: unknown): OverlayTx {
  if (!raw || typeof raw !== "object") throw new Error("tx is not an object");
  const o = raw as Record<string, unknown>;
  const txid = String(o.txid ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("txid must be 64 hex chars");
  const inputs = Array.isArray(o.inputs)
    ? o.inputs.map((i, n) => {
        const row = i as { txid?: unknown; vout?: unknown };
        const itxid = String(row.txid ?? "").toLowerCase();
        const vout = Math.floor(Number(row.vout));
        if (!/^[0-9a-f]{64}$/.test(itxid) || !Number.isFinite(vout) || vout < 0) {
          throw new Error(`inputs[${n}] invalid`);
        }
        return { txid: itxid, vout };
      })
    : [];
  const outputs = Array.isArray(o.outputs)
    ? o.outputs.map((out, n) => {
        const row = out as { satoshis?: unknown; address?: unknown; opReturn?: unknown };
        const satoshis = Math.floor(Number(row.satoshis ?? 0));
        if (!Number.isFinite(satoshis) || satoshis < 0) throw new Error(`outputs[${n}].satoshis invalid`);
        const next: OverlayTx["outputs"][number] = { satoshis };
        if (typeof row.address === "string" && row.address) next.address = row.address;
        if (Array.isArray(row.opReturn)) {
          next.opReturn = row.opReturn.map((p) => String(p));
        }
        return next;
      })
    : [];
  if (outputs.length === 0) throw new Error("tx has no outputs");
  return { txid, inputs, outputs };
}
