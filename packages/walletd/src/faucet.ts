/**
 * Starter-sat faucet client. One claim per identity key, proven by a
 * Bitcoin Signed Message from the identity root (the remote faucet can
 * verify it; a BRC-42 signature could not, because that derivation needs
 * our private key on both sides). The faucet never sees a key.
 */
import { identityPubkeyHex, identitySignMessage, selfAddress } from "./custody.ts";

export const FAUCET_URL = process.env.BSV_FAUCET_URL ?? "https://entangleit.com/faucet";
export const FAUCET_DOMAIN = "bsvos-faucet-v1";

export function claimMessage(nonce: string, address: string, identityKey: string): string {
  return `${FAUCET_DOMAIN}|${nonce}|${address}|${identityKey.toLowerCase()}`;
}

export interface FaucetStatus {
  ok: boolean;
  funded: boolean;
  amount: number;
  address: string;
  claimed: boolean;
  detail: string;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function faucetStatus(base = FAUCET_URL, fetchFn: FetchLike = fetch, identityKey = ""): Promise<FaucetStatus> {
  const url = `${base.replace(/\/$/, "")}/v1/status${identityKey ? `?identity=${identityKey}` : ""}`;
  try {
    const res = await fetchFn(url, { method: "GET" });
    const j = await readJson(res);
    if (!res.ok) {
      return { ok: false, funded: false, amount: 0, address: "", claimed: false, detail: `faucet ${res.status}` };
    }
    return {
      ok: true,
      funded: j.funded === true,
      amount: Math.floor(Number(j.amount) || 0),
      address: typeof j.address === "string" ? j.address : "",
      claimed: j.claimed === true,
      detail: typeof j.detail === "string" ? j.detail : "",
    };
  } catch (err) {
    return { ok: false, funded: false, amount: 0, address: "", claimed: false, detail: err instanceof Error ? err.message : "faucet unreachable" };
  }
}

export async function faucetClaim(base = FAUCET_URL, fetchFn: FetchLike = fetch): Promise<{
  txid: string; amount: number; address: string; already: boolean;
}> {
  const root = base.replace(/\/$/, "");
  const identityKey = identityPubkeyHex();
  const address = selfAddress();
  const challenge = await fetchFn(`${root}/v1/challenge`, { method: "GET" });
  const ch = await readJson(challenge);
  if (!challenge.ok || typeof ch.nonce !== "string" || !ch.nonce) {
    const detail = typeof ch.detail === "string" ? ch.detail : `challenge ${challenge.status}`;
    throw Object.assign(new Error(detail), { code: "FAUCET" });
  }
  const sig = identitySignMessage(claimMessage(ch.nonce, address, identityKey));
  const res = await fetchFn(`${root}/v1/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityKey, address, nonce: ch.nonce, sig }),
  });
  const j = await readJson(res);
  if (!res.ok) {
    const detail = typeof j.detail === "string" ? j.detail : `claim ${res.status}`;
    const code = j.code === "ALREADY" ? "ALREADY" : "FAUCET";
    throw Object.assign(new Error(detail), { code });
  }
  return {
    txid: typeof j.txid === "string" ? j.txid : "",
    amount: Math.floor(Number(j.amount) || 0),
    address,
    already: j.already === true,
  };
}
