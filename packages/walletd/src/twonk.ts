/**
 * Twonk-protocol NFT minting — byte-compatible with Twetch's on-chain format.
 *
 * Reverse-engineered from confirmed mainnet Twonks (e.g. NOOGIES #7862 at
 * `a0d1fdf9…:17`, NOOGIES #2108 sale `059f0f61…`): every token is a 546-sat
 * UTXO with the locking script
 *
 *   OP_HASH160 <H1> OP_EQUALVERIFY
 *   OP_DUP OP_HASH160 <H2> OP_EQUALVERIFY OP_CHECKSIG
 *   OP_RETURN <metadata JSON>
 *
 * where H1 = HASH160(raw 32-byte collection id) — proven: HASH160 of the
 * NOOGIES contract bytes is exactly `20b42e73…7647` — and H2 is the owner's
 * pubkey hash. The collection id is a backend-issued random 32 bytes, NOT a
 * txid; there is no on-chain mint authority, so anyone can mint a new
 * collection. Twetch's marketplace recognition is a separate, off-chain gate.
 *
 * BSV executes this script with the pre-Genesis OP_RETURN semantics: after a
 * successful CHECKSIG the top stack item is true, so OP_RETURN succeeds and
 * the output stays spendable (while `OP_0 OP_RETURN …` data outputs stay
 * unspendable). Unlock order: <sig> <pubkey> <collection-id-bytes>.
 */
import { Hash, Script, Utils } from "@bsv/sdk";
import { createBrc100Wallet } from "./brc100.ts";
import { buildMediaScript } from "./twetch.ts";

/** Dust value every Twonk UTXO carries (also Twetch's `initialSatoshisPrice`). */
export const TWONK_DUST_SATS = 546;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** HASH160 = RIPEMD160(SHA256(x)), as raw bytes. */
export function hash160(bytes: number[]): number[] {
  return Array.from(Hash.ripemd160(Hash.sha256(bytes)));
}

/** H1 binding for a collection: HASH160 of the raw 32-byte collection id. */
export function twonkBindingHash(contractIdHex: string): number[] {
  const id = String(contractIdHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) fail("BAD_PARAM", "contractId must be 32 bytes hex");
  return hash160(Array.from(Utils.toArray(id, "hex")));
}

/** Owner H2 from a base58 P2PKH address. */
export function twonkOwnerPkh(ownerAddress: string): number[] {
  const addr = String(ownerAddress || "").trim();
  let data: number[];
  try {
    data = Array.from((Utils.fromBase58Check(addr) as { data: number[] }).data ?? []);
  } catch {
    fail("BAD_PARAM", "ownerAddress is not a valid address");
    throw new Error("unreachable");
  }
  if (data.length !== 20) fail("BAD_PARAM", "ownerAddress is not a P2PKH address");
  return data;
}

export interface TwonkAttribute {
  trait: string;
  value: string;
}

/** Canonical metadata body — key order matches observed mainnet tokens. */
export function twonkMetadata(opts: {
  attributes: TwonkAttribute[];
  imageSha256: string;
  number: number;
  title: string;
  description?: string;
}): string {
  const sha = String(opts.imageSha256 || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) fail("BAD_PARAM", "imageSha256 must be 64 hex chars");
  const body: Record<string, unknown> = {
    attributes: opts.attributes.map((a) => ({ trait: a.trait, value: a.value })),
    ...(opts.description ? { description: opts.description } : {}),
    image: `b://${sha}`,
    number: Math.floor(opts.number),
    title: opts.title,
  };
  return JSON.stringify(body);
}

/**
 * Full token locking script hex for one token UTXO.
 * Layout matches mainnet byte-for-byte (PUSHDATA2 for the metadata push).
 */
export function twonkTokenScript(contractIdHex: string, ownerAddress: string, metadataJson: string): string {
  const h1 = twonkBindingHash(contractIdHex);
  const h2 = twonkOwnerPkh(ownerAddress);
  const meta = Array.from(Utils.toArray(metadataJson, "utf8"));
  if (!meta.length || meta.length > 1000) fail("BAD_PARAM", "metadata must be 1..1000 bytes");
  const script = new Script();
  script.writeOpCode(0xa9); // OP_HASH160
  script.writeBin(h1);
  script.writeOpCode(0x88); // OP_EQUALVERIFY
  script.writeOpCode(0x76); // OP_DUP
  script.writeOpCode(0xa9);
  script.writeBin(h2);
  script.writeOpCode(0x88);
  script.writeOpCode(0xac); // OP_CHECKSIG
  script.writeOpCode(0x6a); // OP_RETURN
  script.writeBin(meta);
  return script.toHex();
}

export interface DecodedTwonk {
  bindingHash: string;
  ownerPkh: string;
  metadata: Record<string, unknown>;
}

/** Verify a script is a Twonk token and extract its parts; null otherwise. */
export function decodeTwonk(scriptHex: string): DecodedTwonk | null {
  try {
    // NOTE: @bsv/sdk folds each data push into its chunk (push chunks carry
    // op = byte length) and attaches the trailing metadata push to the
    // OP_RETURN chunk itself — 9 chunks, not 10.
    const chunks = Script.fromHex(scriptHex).chunks;
    if (chunks.length !== 9) return null;
    const op = (i: number): number | undefined => chunks[i]?.op;
    if (op(0) !== 0xa9 || op(1) !== 20 || op(2) !== 0x88 || op(3) !== 0x76 ||
        op(4) !== 0xa9 || op(5) !== 20 || op(6) !== 0x88 || op(7) !== 0xac ||
        op(8) !== 0x6a) return null;
    const h1 = chunks[1]?.data;
    const h2 = chunks[5]?.data;
    // The SDK folds the trailing push's opcode bytes into the RETURN chunk's
    // data (e.g. [0x4c, len, ...payload]) — strip the push header first.
    const raw = chunks[8]?.data;
    if (!h1 || h1.length !== 20 || !h2 || h2.length !== 20 || !raw || !raw.length) return null;
    const bytes = Array.from(raw);
    let payload: number[];
    const b0 = bytes[0] ?? 0;
    if (b0 >= 0x01 && b0 <= 0x4b) payload = bytes.slice(1, 1 + b0);
    else if (b0 === 0x4c && bytes.length >= 2) payload = bytes.slice(2, 2 + (bytes[1] ?? 0));
    else if (b0 === 0x4d && bytes.length >= 3) {
      payload = bytes.slice(3, 3 + ((bytes[1] ?? 0) | ((bytes[2] ?? 0) << 8)));
    } else return null;
    const metadata = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>;
    if (typeof metadata.title !== "string" || typeof metadata.image !== "string") return null;
    return {
      bindingHash: Buffer.from(h1).toString("hex"),
      ownerPkh: Buffer.from(h2).toString("hex"),
      metadata,
    };
  } catch {
    return null;
  }
}

export interface TwonkMintToken {
  title: string;
  number: number;
  attributes: TwonkAttribute[];
  imageSha256: string;
  description?: string;
}

export interface TwonkMintImage {
  bytes: number[];
  mime: string;
}

export interface TwonkMintResult {
  txid: string;
  contractId: string;
  tokens: Array<{ number: number; title: string; outpoint: string; imageSha256: string }>;
}

/**
 * Mint a Twonk collection in ONE transaction: B:// image outputs (0 sats,
 * exactly like Twetch media) followed by one 546-sat token UTXO per token.
 * Funding, fee and change flow through the BRC-100 facade like any post.
 */
export async function mintTwonks(
  ctx: { db: unknown; chain: unknown; fetchFn: typeof fetch; origin: string },
  opts: { contractId: string; ownerAddress: string; tokens: TwonkMintToken[]; images: TwonkMintImage[] },
): Promise<TwonkMintResult> {
  const contractId = String(opts.contractId || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(contractId)) fail("BAD_PARAM", "contractId must be 32 bytes hex");
  if (!Array.isArray(opts.tokens) || opts.tokens.length < 1 || opts.tokens.length > 50) {
    fail("BAD_PARAM", "tokens must list 1..50 tokens");
  }
  if (!Array.isArray(opts.images)) fail("BAD_PARAM", "images must be a list");
  // Owner must parse before any money moves.
  twonkOwnerPkh(opts.ownerAddress);

  const outputs: Array<{ lockingScript: string; satoshis: number; outputDescription: string }> = [];
  for (const [i, img] of opts.images.entries()) {
    if (!Array.isArray(img.bytes) || img.bytes.length < 1 || img.bytes.length > 1_000_000) {
      fail("BAD_PARAM", `images[${i}] must be 1..1000000 bytes`);
    }
    outputs.push({
      lockingScript: buildMediaScript(img.bytes, img.mime),
      satoshis: 0,
      outputDescription: `Twonk image ${i + 1}`,
    });
  }
  const minted: TwonkMintResult["tokens"] = [];
  for (const [i, t] of opts.tokens.entries()) {
    const meta = twonkMetadata({
      attributes: t.attributes,
      imageSha256: t.imageSha256,
      number: t.number,
      title: t.title,
      ...(t.description ? { description: t.description } : {}),
    });
    outputs.push({
      lockingScript: twonkTokenScript(contractId, opts.ownerAddress, meta),
      satoshis: TWONK_DUST_SATS,
      outputDescription: `Twonk ${t.title}`,
    });
    minted.push({ number: t.number, title: t.title, outpoint: "", imageSha256: t.imageSha256 });
    void i;
  }

  const facade = createBrc100Wallet({
    db: ctx.db as never,
    chain: ctx.chain as never,
    fetchFn: ctx.fetchFn,
  });
  const action = (await facade.createAction(
    {
      description: `Twonk mint ${contractId.slice(0, 12)} (${opts.tokens.length} tokens)`,
      outputs,
      labels: ["twonk", "mint"],
      options: { randomizeOutputs: false },
    },
    ctx.origin,
  )) as { txid?: string; rawTx?: string };
  const txid = action.txid;
  if (!txid) fail("RAILS", "mint transaction was not broadcast");
  // Output order is deterministic: images first, then tokens in order.
  minted.forEach((m, i) => {
    m.outpoint = `${txid}:${opts.images.length + i}`;
  });
  return { txid, contractId, tokens: minted };
}
