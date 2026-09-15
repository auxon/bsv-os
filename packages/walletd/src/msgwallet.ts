/**
 * F6 wallet shim: the minimal WalletInterface surface AuthFetch + Peer need
 * for the BRC-104 mutual-auth handshake with the message relay.
 *
 * Every signing call is BRC-42 scoped to the caller's exact
 * protocolID/keyID/counterparty (derived inside custody.ts) — there is no
 * raw-sign oracle. Payments (BRC-105) throw: v1 has no paid relay, so a
 * 402 surfaces as a clean error instead of a half-built payment.
 */
import { brc42Hmac, brc42SignData, brc42SignHash, brc42Verify, brc42VerifyDigest, brc42VerifyHmac, identityPubkeyHex } from "./custody.ts";
import type { WalletProtocol } from "@bsv/sdk";

type Bytes = number[];
type ProtocolID = WalletProtocol;

export interface ShimWallet {
  getPublicKey: (args: { identityKey?: boolean }) => Promise<{ publicKey: string }>;
  createSignature: (args: {
    data?: Bytes; hashToDirectlySign?: Bytes;
    protocolID: ProtocolID; keyID: string; counterparty: string;
  }) => Promise<{ signature: Bytes }>;
  verifySignature: (args: {
    data?: Bytes; hashToDirectlyVerify?: Bytes;
    signature: Bytes; protocolID: ProtocolID; keyID: string;
    counterparty: string; forSelf?: boolean;
  }) => Promise<{ valid: true }>;
  createAction: (args: unknown) => Promise<never>;
}

function scoped(args: { protocolID?: unknown; keyID?: unknown; counterparty?: unknown }): {
  protocolID: ProtocolID; keyID: string; counterparty: string;
} {
  if (!args || !Array.isArray(args.protocolID) || typeof args.keyID !== "string" || typeof args.counterparty !== "string") {
    throw new Error("scoped crypto requires protocolID/keyID/counterparty");
  }
  return { protocolID: args.protocolID as ProtocolID, keyID: args.keyID, counterparty: args.counterparty };
}

export function msgWallet(): ShimWallet {
  return {
    getPublicKey: async (args) => {
      if (!args?.identityKey) throw new Error("only the identity key is exposed");
      return { publicKey: identityPubkeyHex() };
    },
    createSignature: async (args) => {
      const s = scoped(args);
      if (args.hashToDirectlySign) {
        return { signature: brc42SignHash(s.protocolID, s.keyID, s.counterparty, [...args.hashToDirectlySign]) };
      }
      return { signature: brc42SignData(s.protocolID, s.keyID, s.counterparty, [...(args.data ?? [])]) };
    },
    verifySignature: async (args) => {
      const s = scoped(args);
      const forSelf = args.forSelf === true;
      const ok = args.hashToDirectlyVerify
        ? brc42VerifyDigest(s.protocolID, s.keyID, s.counterparty, forSelf, [...args.hashToDirectlyVerify], [...args.signature])
        : brc42Verify(s.protocolID, s.keyID, s.counterparty, forSelf, [...(args.data ?? [])], [...args.signature]);
      if (!ok) throw new Error("signature invalid");
      return { valid: true as const };
    },
    createAction: async () => {
      throw new Error("BRC-105 payments unsupported in messaging v1 (relay must not 402)");
    },
  };
}

export interface HmacWallet extends ShimWallet {
  createHmac: (args: {
    data: Bytes; protocolID: ProtocolID; keyID: string; counterparty: string;
  }) => Promise<{ hmac: Bytes }>;
  verifyHmac: (args: {
    data: Bytes; hmac: Bytes; protocolID: ProtocolID; keyID: string; counterparty: string;
  }) => Promise<{ valid: boolean }>;
  listCertificates: (args: unknown) => Promise<{ certificates: [] }>;
  proveCertificate: (args: unknown) => Promise<never>;
}

/** Extended shim including HMAC (handshake nonces). */
export function msgWalletFull(): HmacWallet {
  const base = msgWallet();
  return {
    ...base,
    createHmac: async (args) => {
      if (!args || !Array.isArray(args.protocolID) || typeof args.keyID !== "string" || typeof args.counterparty !== "string") {
        throw new Error("scoped hmac requires protocolID/keyID/counterparty");
      }
      return {
        hmac: brc42Hmac(args.protocolID as ProtocolID, args.keyID, args.counterparty, [...(args.data ?? [])]),
      };
    },
    verifyHmac: async (args) => {
      if (!args || !Array.isArray(args.protocolID) || typeof args.keyID !== "string" || typeof args.counterparty !== "string") {
        throw new Error("scoped hmac verify requires protocolID/keyID/counterparty");
      }
      return {
        valid: brc42VerifyHmac(args.protocolID as ProtocolID, args.keyID, args.counterparty, [...(args.data ?? [])], [...(args.hmac ?? [])]),
      };
    },
    listCertificates: async () => {
      // No BRC-format certificates held (the F3 cert wallet is a separate
      // local format) — the handshake continues without them.
      return { certificates: [] };
    },
    proveCertificate: async () => {
      throw new Error("no BRC certificates held to prove");
    },
  };
}
