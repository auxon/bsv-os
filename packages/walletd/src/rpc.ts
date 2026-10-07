import { Transaction } from "@bsv/sdk";
import { createWallet, exportEntropy, getStatus, identityPubkeyHex, identitySignMessage, importWallet, lock, restoreFromEntropy, selfAddress, unlock } from "./custody.ts";
import {
  twetchAccountImport,
  twetchAccountImportFromPhrase,
  twetchAccountImportFromSeed,
  twetchAccountRemove,
  twetchAccountStatus,
} from "./custody.ts";
import type { Knex } from "knex";
import type { ChainProvider } from "./chain.ts";
import { listPolicies, pendingRequests, probe, seedRequest, setPolicy } from "./policy.ts";
import { qrDataUrl, qrDataUrlText } from "./qr.ts";
import { readEvents } from "./events.ts";
import { watchPoll, watchTailCursor, type WatchCursor } from "./watch.ts";
import { commitmentExposure, listCommitments } from "./commitment.ts";
import {
  canonicalStatement, createFundsAttestation, listFundsAttestations, proveFundsUtxo,
  recordFundsAttestation, sha256hex, verifyFundsAttestation, type FundsStatement,
} from "./attest.ts";
import { parseDurationMs } from "./watch.ts";
import { runDoctor } from "./doctor.ts";
import { autoThresholds, decide as jevDecideCall, jevEnabled, jevModel, type JevQuestion } from "./jev.ts";
import { classifyMeme, CLEF_MAX_IMAGE_BYTES } from "./clef.ts";
import {
  createMarket, disputeWindowOpen, getBets, getMarket, gradeEvidence, listMarkets, lockIfPastClose,
  betMemo, decodeOpReturnStrings, descriptorFor, parseBetMemo, parseDescriptor,
  creditScannedBet, marketBasket, marketView, PREDICT_BOARD, PREDICT_CONF_THRESHOLD, PREDICT_MIN_BET_SATS,
  PREDICT_MARKET_TAG, PREDICT_SETTLE_TAG, positionsFor, recordBet, recordDispute, recordSettlement, recordVerdict, splitPool, splitVoid,
  validateMarket, winnerFromChoice,
} from "./predict.ts";
import { WOC_TX } from "./engine.ts";
import { p2pkhScript } from "./tx.ts";
import { anchorTip, explorerTxUrl, getBalance, inscribeMint, safeLabel, sendBsv21, sendOrdinal, sendSats, spendTo, sweepIn, sweepOut } from "./engine.ts";
import { DEVICE_READS, DEVICE_WRITES, deviceOrigin, isDeviceCallable } from "./device.ts";
import { cancelPairing, listDevices, mintPairingCode, pendingPairingView, renameDevice, revokeDevice } from "./device.ts";
import { setDevicePushToken } from "./device.ts";
import { emptyHistory, getHistory } from "./history.ts";
import { getAgent, listAgents, mintAgent, revokeAgent } from "./agents.ts";
import { getApp, installApp, intentFromMemo, listApps, removeApp, storeList, applyAppUpdate } from "./apps.ts";
import { bridgeEntryPath } from "./launcher.ts";
import { getCert, listCerts, listDisclosures, putCert, revokeCert, showCert } from "./certs.ts";
import { assignUtxo, createBasket, labelOutputs, removeBasket, walletBaskets } from "./baskets.ts";
import { bsv21For, galleryFor, normalizeTokenId, splitOutpoint, tokenHoldings } from "./tokens.ts";
import {
  boardGet, boardList, claimGig, listGigs, paidGig, submitGig, trackGig, untrackGig,
} from "./gigs.ts";
import { overlayHealth, overlayLookup, overlayTopics, tagsFor, tagTransaction } from "./overlays.ts";
import {
  approveRun, claimRun, createOrder, failRun, listOrders, listRuns,
  removeOrder, setOrderStatus, submitRun,
} from "./nightshift.ts";
import { combineCards, listSets, recordSet, splitFor, supersedeSets } from "./recovery.ts";
import { attestSpend, listReceipts, verifyAttestation, x402Pay } from "./x402.ts";
import { ackDm, listStored, liveRelay, readDm, sendDmPreferred, syncInbox } from "./msgs.ts";
import type { P2PChannel } from "./p2p.ts";
import {
  addContact, learnAddress, listContacts, profileName, removeContact,
  resolvePerson, setProfileName, validPayTo, type LivePerson,
} from "./people.ts";
import { faucetClaim, faucetStatus } from "./faucet.ts";
import type { TorrentService } from "./torrents.ts";
import {
  buildRequest, encodeRequest, expireOld, getRequest, incomingPaymentVerifier, listRequests,
  markDeclined, markPaid, parseDuration, parseRequest, payableError, recordOutgoing,
  saveIncoming, scanInbound, sendReceipt, sendRequestCode,
} from "./requests.ts";
import { issueReceipt, listReceipts as listPaymentReceipts, getReceipt, receiptDetail } from "./receipts.ts";
import {
  addMember, buildPost, createBoard, deliverBoardKey, encodeBoardKey, envelopeShape, getBoard, getPosts, getThread,
  removeBoard, removeMember, rotateBoardKey, postContent, markRead,
  ingestPost, listBoards, parseBoardKey, publishPost, scanBoardInbox, waitForPost, type BoardRow, type PostKind,
} from "./boards.ts";
import {
  MEMORY_BOARD, USENET_BASE, USENET_GROUP, cleanTag, contentHash, forgetRefs, memoryRefs,
  normalizeMemoryText, recallMemories, refHash, usenetPayload,
} from "./memory.ts";
import {
  ASK_BOARD, amountFromRefs, amountRef, decodeQuestion,
  ensureAskBoard, gradeAnswer, openQuestions, payToFromRefs, payToRef, titleRef, triageQuestion,
  validateAnswer, validateQuestion,
} from "./ask.ts";
import {
  EVOLVE_BOARD, SCORE_LEVELS, contestRef, createContest, getContest,
  judgeRound, listContests, recordEntry, roundEntries, splitEntry,
} from "./evolve.ts";
import {
  cancelCapsule, claimCapsule, fetchChainTip, listCapsules,
  lockCapsule, remaining, tickCapsules,
} from "./capsule.ts";
import {
  CAST_BOARD, addEpisode, endLive, getLive, listEpisodes, listLive, listSessions,
  parseSplits, startLive, startSession, stopSession,
} from "./cast.ts";
import { checkSellerSurface, serveMenu, serveSales, serveSetPrice, serveStatus, setServeMeta } from "./serve.ts";
import {
  createStream, getStream, listStreams, listTicks, parseTick, setStreamStatus, streamBeatRef, tickStreams,
} from "./streams.ts";
import { removeDesktopEntry, writeDesktopEntry } from "./desktop.ts";
import { completeSwap, signSwapOffer, SWAP_VERSION, SWAP_VERSION_BSV21 } from "./swaps.ts";
import { buyOrdLock, cancelOrdLock, lockOrdinal } from "./ordlock.ts";
import {
  cancelListing,
  fetchListing,
  fetchListings,
  fetchOperatorFee,
  listingFeeSats,
  markBought,
  markSettled,
  marketUrl,
  postListing,
} from "./market.ts";
import {
  feedLatest,
  indexPost,
  marketCollections,
  marketListings,
  marketSales,
  memeFolders,
  memeLibrary,
  notifications,
  postNotifications,
  postText,
  userByPubkey,
  userPosts,
  userProfile,
} from "./twetch.ts";
import {
  cancelLogin,
  currentSession,
  identityConfig,
  loginStatus,
  logout as identityLogout,
  setIdentityConfig,
  startLogin,
} from "./identity.ts";
import { setTrustIdentityProvider, trustMode, trustState, trustUrl } from "./trust.ts";

export const VERSION = "0.1.0";

// Trust policy lookups use the wallet's identity key as the subject. Locked
// means no subject, so policy falls back to the base thresholds (fail closed).
setTrustIdentityProvider(() => {
  try {
    return identityPubkeyHex();
  } catch {
    return null;
  }
});

interface MonitorBackend {
  db: Knex;
  chain: ChainProvider;
}

let backend: MonitorBackend | null = null;

/** Wired by index.ts at boot; RPC stays usable without it. */
export function setBackend(b: MonitorBackend | null): void {
  backend = b;
}

let p2pChannel: P2PChannel | null = null;

/** Wired by index.ts when the F6.2 direct channel starts. */
export function setP2P(channel: P2PChannel | null): void {
  p2pChannel = channel;
}

/** Board helpers: agent label from the caller, and one publish path. */
function boardAgentLabel(agent: unknown, origin: unknown): string {
  if (typeof agent === "string" && agent.trim()) return agent.trim().slice(0, 64);
  const o = typeof origin === "string" ? origin : "cli";
  return (o.startsWith("agent:") ? o.slice("agent:".length) : o).slice(0, 64);
}

async function boardPublish(
  b: ReturnType<typeof needBackend>,
  row: BoardRow,
  input: { text: unknown; kind?: unknown; refs?: unknown; replyTo?: unknown; agent?: unknown; origin?: unknown },
): Promise<{ id: string; board: string; agent: string; accepted: boolean; direct: string[]; relayed: number }> {
  const env = buildPost({
    board: row.name,
    from: identityPubkeyHex(),
    agent: boardAgentLabel(input.agent, input.origin),
    keyHex: row.keyHex,
    epoch: row.epoch,
    text: typeof input.text === "string" ? input.text : "",
    kind: (typeof input.kind === "string" ? input.kind : "note") as PostKind,
    refs: Array.isArray(input.refs) ? input.refs.map((r) => String(r)) : [],
    replyTo: typeof input.replyTo === "string" ? input.replyTo : "",
  });
  const published = await publishPost(b.db, liveRelay(), p2pChannel, env);
  return { id: env.id, board: env.board, agent: env.agent, ...published };
}

let torrentService: TorrentService | null = null;

/** Wired by index.ts when the F6.3 BitTorrent listener starts. */
export function setTorrents(service: TorrentService | null): void {
  torrentService = service;
}

function needTorrents(): TorrentService {
  if (!torrentService) {
    const err = new Error("file sharing disabled (BSV_TORRENT=0 or BitTorrent port busy)") as Error & { code: string };
    err.code = "NO_TORRENTS";
    throw err;
  }
  return torrentService;
}

function livePeople(): LivePerson[] {
  if (!p2pChannel) return [];
  return p2pChannel.peers().map((p) => ({
    identityKey: p.identityKey, name: p.name, payTo: p.payTo, nameVerified: p.nameVerified,
  }));
}

function needBackend(): MonitorBackend {
  if (!backend) {
    const err = new Error("wallet engine offline (restart daemon)") as Error & { code: string };
    err.code = "NO_BACKEND";
    throw err;
  }
  return backend;
}

/** Signed-in Twetch account key (OIDC claim), used as the import scan target. */
function twetchTarget(session: { twetchPubkey?: string | null } | null): string | undefined {
  return typeof session?.twetchPubkey === "string" && session.twetchPubkey ? session.twetchPubkey : undefined;
}

/** Best-effort linkage check against Twetch's key index. */
async function verifyTwetchImport(
  imported: { publicKey: string },
  session: { sub?: string | null } | null,
): Promise<Record<string, unknown>> {
  let verifiedUserId: number | null = null;
  let matchesSession: boolean | null = null;
  try {
    verifiedUserId = await userByPubkey(fetch, imported.publicKey);
    const sub = Math.floor(Number(session?.sub ?? 0));
    matchesSession = verifiedUserId !== null && sub > 0 ? verifiedUserId === sub : null;
  } catch {
    verifiedUserId = null;
  }
  return { ...imported, verifiedUserId, matchesSession };
}

interface RpcRequest {
  method?: unknown;
  params?: unknown;
  id?: unknown;
}

interface RpcResponse {
  result?: unknown;
  error?: { code: string; message: string };
  id: unknown;
}

type Params = Record<string, unknown>;
const p = (params: unknown): Params => (params && typeof params === "object" ? (params as Params) : {});

/**
 * Shared swap buy/list for market origins (twetch app, bundled market app).
 * The origin is the policy principal; the memo tag is namespaced per
 * market so the ledger reads `TWETCH-BUY …` / `MARKET-BUY …`.
 */
async function swapBuyFor(origin: string, params: unknown): Promise<unknown> {
  const b = needBackend();
  const { outpoint, priceSats, sellerAddress, offer, fee } = p(params) as {
    outpoint?: unknown; priceSats?: unknown; sellerAddress?: unknown; offer?: unknown; fee?: unknown;
  };
  if (typeof outpoint !== "string" || !/^([0-9a-fA-F]{64})[._](\d+)$/.test(outpoint)) {
    throw Object.assign(new Error("outpoint must be <64-hex-txid>.<vout>"), { code: "BAD_PARAM" });
  }
  const price = Math.floor(Number(priceSats) || 0);
  if (!(price >= 1)) throw Object.assign(new Error("priceSats must be a positive sat number"), { code: "BAD_PARAM" });
  if (typeof sellerAddress !== "string" || !sellerAddress) {
    throw Object.assign(new Error("sellerAddress required"), { code: "BAD_PARAM" });
  }
  const feeOpt = fee && typeof fee === "object" ? (fee as { to?: unknown; sats?: unknown }) : null;
  const feeSats = feeOpt ? Math.floor(Number(feeOpt.sats) || 0) : 0;
  const feePayment = feeOpt && feeSats > 0 && typeof feeOpt.to === "string"
    ? { to: feeOpt.to, sats: feeSats }
    : null;
  const memo = [`${origin.toUpperCase()}-BUY`, outpoint];
  const label = `${origin} buy ${outpoint}`;
  if (offer && typeof offer === "object") {
    const r = await completeSwap({
      db: b.db, chain: b.chain, origin, offer,
      ...(feePayment ? { fee: feePayment } : {}),
      memo, label,
      buyerChecks: { expectedSeller: sellerAddress, maxPrice: price },
    });
    return { txid: r.txid, fee: r.fee, atomic: true };
  }
  const r = await spendTo({
    db: b.db, chain: b.chain, origin,
    payments: [{ to: sellerAddress, sats: price }, ...(feePayment ? [feePayment] : [])],
    memo, label,
    description: `${origin} market direct buy ${outpoint} for ${price} sats (pay first, delivery by the seller)`,
  });
  return { txid: r.txid, fee: r.fee, atomic: false };
}

async function swapListFor(origin: string, params: unknown): Promise<unknown> {
  const b = needBackend();
  const { outpoint, priceSats, kind, tokenId, tokenAmount } = p(params) as {
    outpoint?: unknown; priceSats?: unknown; kind?: unknown; tokenId?: unknown; tokenAmount?: unknown;
  };
  const m = typeof outpoint === "string" ? /^([0-9a-fA-F]{64})[._](\d+)$/.exec(outpoint) : null;
  if (!m) throw Object.assign(new Error("outpoint must be <64-hex-txid>.<vout>"), { code: "BAD_PARAM" });
  return signSwapOffer({
    db: b.db, chain: b.chain, origin,
    txid: m[1]!, vout: Number(m[2]),
    priceSats: Number(priceSats) || 0,
    ...(kind === "ordinal" || kind === "bsv21" ? { kind } : {}),
    ...(typeof tokenId === "string" ? { tokenId } : {}),
    ...(typeof tokenAmount === "string" ? { tokenAmount } : {}),
  });
}

/**
 * OrdLock flows, shared by top-level RPCs (CLI/MCP) and app intents.
 * `origin` in params overrides the caller's policy principal.
 */
async function ordlockLockFor(defaultOrigin: string, params: unknown): Promise<unknown> {
  const b = needBackend();
  const { txid, vout, priceSats, origin } = p(params) as {
    txid?: unknown; vout?: unknown; priceSats?: unknown; origin?: unknown;
  };
  if (typeof txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw Object.assign(new Error("txid must be 64-hex"), { code: "BAD_PARAM" });
  }
  return lockOrdinal({
    db: b.db, chain: b.chain,
    origin: typeof origin === "string" && origin ? origin : defaultOrigin,
    txid, vout: Math.floor(Number(vout) || 0), priceSats: Number(priceSats) || 0,
  });
}

async function ordlockBuyFor(defaultOrigin: string, params: unknown): Promise<unknown> {
  const b = needBackend();
  const { lockOutpoint, fee, memo, label, description, origin, maxPrice, expectedSeller } = p(params) as {
    lockOutpoint?: unknown; fee?: unknown; memo?: unknown; label?: unknown;
    description?: unknown; origin?: unknown; maxPrice?: unknown; expectedSeller?: unknown;
  };
  if (typeof lockOutpoint !== "string" || !lockOutpoint) {
    throw Object.assign(new Error("lockOutpoint required"), { code: "BAD_PARAM" });
  }
  const checks = {
    ...(typeof expectedSeller === "string" && expectedSeller ? { expectedSeller } : {}),
    ...(maxPrice !== undefined ? { maxPrice: Number(maxPrice) } : {}),
  };
  return buyOrdLock({
    db: b.db, chain: b.chain,
    origin: typeof origin === "string" && origin ? origin : defaultOrigin,
    lockOutpoint,
    ...(fee && typeof fee === "object" ? { fee: fee as { to: string; sats: number } } : {}),
    ...(Array.isArray(memo) ? { memo: memo as string[] } : {}),
    ...(typeof label === "string" && label ? { label } : {}),
    ...(typeof description === "string" && description ? { description } : {}),
    ...(Object.keys(checks).length ? { buyerChecks: checks } : {}),
  });
}

async function ordlockCancelFor(defaultOrigin: string, params: unknown): Promise<unknown> {
  const b = needBackend();
  const { lockOutpoint, origin } = p(params) as { lockOutpoint?: unknown; origin?: unknown };
  if (typeof lockOutpoint !== "string" || !lockOutpoint) {
    throw Object.assign(new Error("lockOutpoint required"), { code: "BAD_PARAM" });
  }
  return cancelOrdLock({
    db: b.db, chain: b.chain,
    origin: typeof origin === "string" && origin ? origin : defaultOrigin,
    lockOutpoint,
  });
}

/**
 * Phase 0 for iOS: dispatch a paired device's call (docs/ios.md).
 *
 * The origin is DERIVED from the authenticated device, exactly as appInvoke
 * derives it from the installed app's domain — never taken from the request. A
 * device that could name its own origin could impersonate the CLI or another
 * app, and every cap, denial and approval in the policy engine is keyed by
 * origin.
 *
 * Reads delegate to the ordinary handlers, because they have no custody effect
 * and no origin of their own. Writes go to the engine functions with the device
 * origin attached.
 *
 * Reaching this function means the caller has already authenticated: the
 * allowlist and the token check happen at the HTTP boundary (index.ts) and in
 * device.ts. The allowlist is re-checked here anyway, because a second cheap
 * check at the point of action is how this codebase treats security rules.
 */
export async function deviceInvoke(
  device: { id: string; name: string },
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const b = needBackend();
  if (!isDeviceCallable(method)) {
    throw Object.assign(new Error(`method not allowed for a paired device: ${method}`), { code: "NOT_ALLOWED" });
  }
  const origin = deviceOrigin(device.name);

  if (DEVICE_READS.includes(method)) {
    const handler = METHODS[method];
    if (!handler) throw Object.assign(new Error(`no handler for ${method}`), { code: "NOT_FOUND" });
    return handler(params);
  }

  switch (method) {
    // Operator actions: the origin is the *subject* of the policy change, not
    // the caller, so these delegate unchanged.
    case "lock":
    case "unlock":
    case "policyApprove":
    case "policyDeny":
      return METHODS[method]!(params);

    // Hosted apps reach the wallet through appInvoke, which derives the app's
    // own origin. Deliberately NOT rewritten to the device origin: an app on
    // the phone should carry the same policy origin it has on the desktop, not
    // inherit the phone's access.
    case "appInvoke":
      return METHODS.appInvoke!(params);

    // The app store. These are registry operations, not spends; the daemon
    // fetches and validates the manifest itself, so a device cannot install an
    // arbitrary page as an app.
    case "appInstall":
    case "appRemove":
      return METHODS[method]!(params);

    case "registerPush": {
      const raw = p(params) as { token?: unknown };
      const token = typeof raw.token === "string" && raw.token.trim() ? raw.token : null;
      const ok = await setDevicePushToken(b.db, device.id, token);
      return { registered: ok };
    }

    case "send": {
      const raw = p(params) as { to?: unknown; sats?: unknown; label?: unknown };
      if (typeof raw.to !== "string" || !raw.to) {
        throw Object.assign(new Error("recipient address required"), { code: "BAD_PARAM" });
      }
      const amount = Math.floor(Number(raw.sats) || 0);
      if (!(amount > 0)) throw Object.assign(new Error("sats must be a positive sat number"), { code: "BAD_PARAM" });
      const r = await sendSats({
        db: b.db, chain: b.chain, origin, to: raw.to, sats: amount,
        ...(typeof raw.label === "string" && raw.label ? { label: raw.label } : {}),
      });
      return { txid: r.txid, fee: r.fee };
    }

    case "anchorFile": {
      const raw = p(params) as { sha256?: unknown; filename?: unknown };
      const sha256 = typeof raw.sha256 === "string" ? raw.sha256.trim().toLowerCase() : "";
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        throw Object.assign(new Error("sha256 must be 64 hex chars"), { code: "BAD_PARAM" });
      }
      const filename = typeof raw.filename === "string" ? raw.filename : "";
      return anchorTip({
        db: b.db, chain: b.chain, origin, sha256,
        ...(filename ? { label: safeLabel(filename, `anchor ${sha256.slice(0, 12)}`) } : {}),
      });
    }

    case "sweepOut": {
      const raw = p(params) as { to?: unknown };
      if (typeof raw.to !== "string" || !raw.to) {
        throw Object.assign(new Error("destination address required"), { code: "BAD_PARAM" });
      }
      const r = await sweepOut({ db: b.db, chain: b.chain, origin, to: raw.to });
      return { txid: r.txid, fee: r.fee, sats: r.sats };
    }

    case "inscribe": {
      const raw = p(params) as { dataHex?: unknown; contentType?: unknown; memo?: unknown };
      if (typeof raw.dataHex !== "string" || !raw.dataHex) {
        throw Object.assign(new Error("dataHex required"), { code: "BAD_PARAM" });
      }
      if (typeof raw.contentType !== "string" || !raw.contentType) {
        throw Object.assign(new Error("contentType required"), { code: "BAD_PARAM" });
      }
      return inscribeMint({
        db: b.db, chain: b.chain, origin,
        dataHex: raw.dataHex, contentType: raw.contentType,
        ...(Array.isArray(raw.memo) ? { memo: raw.memo as string[] } : {}),
      });
    }

    // Operator spends: the origin is the device's own, so a cap or a block set
    // for the phone applies only to the phone.
    case "pay":
      return payFor(origin, params);
    case "requestPay":
      return requestPayFor(origin, params);
    case "receiptIssue":
      return receiptIssueFor(origin, params);
    case "marketCancel":
      return marketCancelFor(origin, params);

    default:
      // The long tail of the operator tier. These are not origin-sensitive from
      // the device's point of view: app activity carries the app's own origin
      // (twetch*, cast*, board*, ask*), and the rest are not policy-gated at
      // all. Delegating keeps one implementation of each instead of a second
      // copy here that could drift.
      if (DEVICE_WRITES.includes(method) && METHODS[method]) {
        return METHODS[method]!(params);
      }
      // Unreachable while the allowlist and METHODS agree; a test asserts every
      // allowlisted method resolves, so this is the belt to that test's braces.
      throw Object.assign(new Error(`device method has no implementation: ${method}`), { code: "NOT_ALLOWED" });
  }
}

/**
 * pay, with the origin as a parameter.
 *
 * The origin is what the policy engine keys caps and approvals on, so it must
 * never come from the request body. The CLI path passes "cli" through the
 * delegation above; a paired device passes device:<name> from its token.
 */
async function payFor(origin: string, params: unknown): Promise<unknown> {
    const b = needBackend();
    const { to, sats, note } = p(params) as { to?: unknown; sats?: unknown; note?: unknown };
    if (typeof to !== "string" || !to) throw Object.assign(new Error("recipient required (@name, identity key, address)"), { code: "BAD_PARAM" });
    const amount = Math.floor(Number(sats) || 0);
    if (!(amount > 0)) throw Object.assign(new Error("sats must be a positive sat number"), { code: "BAD_PARAM" });
    const person = await resolvePerson(b.db, to, livePeople());
    let address = person.address;
    if (!address && person.identityKey && p2pChannel?.meet) {
      const card = await p2pChannel.meet(person.identityKey);
      if (card?.payTo && validPayTo(card.payTo)) {
        address = card.payTo;
        if (person.identityKey) await learnAddress(b.db, person.identityKey, address);
      }
    }
    if (!address) {
      const hint = person.name ? `bsv contact add ${person.name} <identityKey> <address>` : "bsv contact add <name> <identityKey> <address>";
      throw Object.assign(new Error(`no receive address for ${person.display} — ${hint}`), { code: "BAD_PARAM" });
    }
    const label = typeof note === "string" && note.trim() ? note.trim().slice(0, 100) : person.name ? `pay @${person.name}` : `pay ${person.display}`;
    const r = await sendSats({ db: b.db, chain: b.chain, origin, to: address, sats: amount, label });
    let messageSent = false;
    if (person.identityKey && typeof note === "string" && note.trim()) {
      try {
        await sendDmPreferred(b.db, liveRelay(), p2pChannel, identityPubkeyHex(), person.identityKey, note.trim());
        messageSent = true;
      } catch {
        messageSent = false;
      }
    }
    return {
      txid: r.txid,
      fee: r.fee,
      to: { name: person.name, display: person.display, identityKey: person.identityKey, address },
      messageSent,
    };
}

/**
 * requestPay, with the origin as a parameter.
 *
 * The origin is what the policy engine keys caps and approvals on, so it must
 * never come from the request body. The CLI path passes "cli" through the
 * delegation above; a paired device passes device:<name> from its token.
 */
async function requestPayFor(origin: string, params: unknown): Promise<unknown> {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("request id required"), { code: "BAD_PARAM" });
    const row = await getRequest(b.db, id);
    if (!row) throw Object.assign(new Error(`no request ${id}`), { code: "NOT_FOUND" });
    const err = payableError(row);
    if (err) throw Object.assign(new Error(err), { code: "BAD_PARAM" });
    // Re-verify the stored code before sats move: the ledger must agree with
    // the signature the requester actually produced.
    const verified = parseRequest(row.code);
    if (verified.id !== row.id || verified.address !== row.address || verified.amount !== row.amount) {
      throw Object.assign(new Error("stored request failed re-verification"), { code: "BAD_CODE" });
    }
    const label = row.memo ? row.memo.slice(0, 100) : `request ${row.id.slice(0, 8)}`;
    const r = await sendSats({ db: b.db, chain: b.chain, origin, to: verified.address, sats: verified.amount, label });
    await markPaid(b.db, row.id, r.txid);
    const receipt = row.peer ? await sendReceipt(b.db, liveRelay(), p2pChannel, row, r.txid, row.amount) : { sent: false };
    return { txid: r.txid, fee: r.fee, amount: row.amount, to: row.peer, receiptSent: receipt.sent };
}

/**
 * receiptIssue, with the origin as a parameter.
 *
 * The origin is what the policy engine keys caps and approvals on, so it must
 * never come from the request body. The CLI path passes "cli" through the
 * delegation above; a paired device passes device:<name> from its token.
 */
async function receiptIssueFor(origin: string, params: unknown): Promise<unknown> {
    const b = needBackend();
    const { request, txid, to, amount, memo } = p(params) as {
      request?: unknown; txid?: unknown; to?: unknown; amount?: unknown; memo?: unknown;
    };
    let paymentTxid = "";
    let sats = 0;
    let item = "";
    let peer = "";
    let peerAddress = "";
    let requestId = "";
    if (typeof request === "string" && request) {
      const row = await getRequest(b.db, request);
      if (!row) throw Object.assign(new Error(`no request ${request}`), { code: "NOT_FOUND" });
      if (row.direction !== "in" || row.status !== "paid" || !row.txid) {
        throw Object.assign(new Error("only paid incoming requests can be receipted"), { code: "BAD_PARAM" });
      }
      paymentTxid = row.txid;
      sats = row.amount;
      item = row.memo;
      peer = row.peer;
      peerAddress = row.address;
      requestId = row.id;
    } else {
      if (typeof txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(txid)) {
        throw Object.assign(new Error("txid required (or --request <id>)"), { code: "BAD_PARAM" });
      }
      sats = Math.floor(Number(amount) || 0);
      if (!(sats > 0)) throw Object.assign(new Error("amount (sats) required"), { code: "BAD_PARAM" });
      if (typeof to !== "string" || !to) throw Object.assign(new Error("to required (@name, identity key, address)"), { code: "BAD_PARAM" });
      const person = await resolvePerson(b.db, to, livePeople());
      peer = person.identityKey;
      peerAddress = person.address;
      if (!peerAddress && peer && p2pChannel?.meet) {
        const card = await p2pChannel.meet(peer);
        if (card?.payTo && validPayTo(card.payTo)) {
          peerAddress = card.payTo;
          await learnAddress(b.db, peer, peerAddress);
        }
      }
      if (!peerAddress) {
        const hint = person.name ? `bsv contact add ${person.name} <identityKey> <address>` : "bsv contact add <name> <identityKey> <address>";
        throw Object.assign(new Error(`no receive address for ${person.display} — ${hint}`), { code: "BAD_PARAM" });
      }
      paymentTxid = txid.toLowerCase();
      item = typeof memo === "string" ? memo : "";
    }
    return issueReceipt(
      {
        db: b.db,
        inscribe: (input) =>
          inscribeMint({
            db: b.db,
            chain: b.chain,
            origin,
            dataHex: input.dataHex,
            contentType: input.contentType,
            to: input.to,
            label: input.label,
            ...(item ? { description: item } : {}),
          }),
        notify: async (peerKey, text) => {
          try {
            await sendDmPreferred(b.db, liveRelay(), p2pChannel, identityPubkeyHex(), peerKey, text);
            return { sent: true };
          } catch {
            return { sent: false };
          }
        },
      },
      { txid: paymentTxid, amount: sats, memo: item, peer, peerAddress, requestId },
    );
}

/**
 * marketCancel, with the origin as a parameter.
 *
 * The origin is what the policy engine keys caps and approvals on, so it must
 * never come from the request body. The CLI path passes "cli" through the
 * delegation above; a paired device passes device:<name> from its token.
 */
async function marketCancelFor(origin: string, params: unknown): Promise<unknown> {
    const b = needBackend();
    const { listing } = p(params) as { listing?: unknown };
    if (typeof listing !== "string" || !listing) {
      throw Object.assign(new Error("listing (asset outpoint) required"), { code: "BAD_PARAM" });
    }
    const dot = listing.replace("_", ".");
    let unlockTxid: string | undefined;
    let unlockError: string | undefined;
    try {
      const l = await fetchListing(dot);
      const kind = l?.offer && typeof l.offer === "object" ? (l.offer as { kind?: string }).kind : undefined;
      if (l && kind === "ordlock" && l.status === "active") {
        const unlocked = await cancelOrdLock({ db: b.db, chain: b.chain, origin, lockOutpoint: dot });
        unlockTxid = unlocked.txid;
      }
    } catch (e) {
      unlockError = e instanceof Error ? e.message : String(e);
    }
    await cancelListing(dot, selfAddress());
    return {
      cancelled: true, origin: dot,
      ...(unlockTxid ? { unlockTxid } : {}),
      ...(unlockError ? { unlockError } : {}),
    };
}

/** Best-effort PREDICT-SETTLE board reply so remote bettors can sync. Never throws. */
async function announceSettlement(
  bdb: Knex,
  marketId: string,
  txid: string,
): Promise<void> {
  const row = await bdb("predict_remote").where({ market_id: marketId, role: "creator" }).first() as {
    post_id?: unknown; board?: unknown;
  } | undefined;
  if (!row?.post_id) return;
  const board = await getBoard(bdb, String(row.board ?? "predict")).catch(() => null);
  if (!board) return;
  await boardPublish({ db: bdb } as ReturnType<typeof needBackend>, board, {
    text: `${PREDICT_SETTLE_TAG} ${marketId} ${txid}`,
    kind: "predict",
    replyTo: String(row.post_id),
    origin: "predict",
  });
}
/**
 * Pull-then-scan: fetch the MessageBox relay inbox into the local
 * store BEFORE scanning for board posts, so every board read converges
 * without a manual `bsv msg sync`. Best-effort throughout — relay,
 * lock, or network hiccups must never break the read; local history
 * still serves. (Fixes auxon/bsv-os#1: board reads went silently
 * stale for MCP consumers such as OpenCode.)
 */
async function syncBoards(db: Knex): Promise<void> {
  try {
    await syncInbox(db, liveRelay());
  } catch {
    /* relay unreachable or wallet locked: fall through to local scan */
  }
  try {
    await scanBoardInbox(db, liveRelay());
  } catch {
    /* local history still serves */
  }
}
const METHODS: Record<string, (params: unknown) => unknown | Promise<unknown>> = {
  getVersion: () => ({ version: VERSION, brc100: true }),
  isAuthenticated: async () => {
    const s = await getStatus();
    return { authenticated: !s.locked, ...s };
  },
  createWallet: async (params) => {
    const r = await createWallet(p(params).force === true);
    return { ...r, warning: "BACK UP the recovery phrase NOW — it is shown once and never stored anywhere else" };
  },
  importWallet: async (params) => {
    const { phrase, force } = p(params) as { phrase?: unknown; force?: unknown };
    if (typeof phrase !== "string" || !phrase.trim()) {
      throw Object.assign(new Error("recovery phrase required"), { code: "BAD_PARAM" });
    }
    return importWallet(phrase, force === true);
  },
  unlock: async () => {
    const r = await unlock();
    // Cache the pay-to address while the key is available: the x402 seller
    // surface (manifest, quotes) keeps working after auto-lock. Best effort —
    // a cache failure must never fail the unlock itself.
    try {
      if (backend) {
        const { selfAddress } = await import("./custody.ts");
        await setServeMeta(backend.db, "payto", selfAddress());
      }
    } catch {
      /* locked-down setups stay fail-closed */
    }
    return r;
  },
  lock: () => {
    lock();
    return { locked: true };
  },
  /**
   * Sign an arbitrary message with the identity root key (BSM, base64).
   * Powers wallet-identity auth schemes like Wayfare's BSV1 request signing:
   * the agent builds the canonical string and asks the daemon to sign it.
   * Throws WALLET_LOCKED when locked — unlock first.
   */
  sign: async (params) => {
    const { message } = p(params) as { message?: unknown };
    if (typeof message !== "string" || !message) {
      throw Object.assign(new Error("message required"), { code: "BAD_PARAM" });
    }
    return { identityKey: identityPubkeyHex(), signature: identitySignMessage(message) };
  },
  pending: async () => {
    if (!backend) return { tracked: [] };
    const rows = await backend.db("pending_txs")
      .select("txid", "label", "status", "attempts", "last_check", "detail")
      .orderBy("created_at", "desc")
      .limit(100);
    return { tracked: rows };
  },
  balance: async () => {
    const b = needBackend();
    return getBalance(b.chain);
  },
  utxos: async () => {
    const b = needBackend();
    const address = selfAddress();
    const u = await b.chain.utxos(address);
    return { address, confirmed: u.confirmed, unconfirmed: u.unconfirmed, utxos: u.utxos };
  },
  /**
   * Receive address + PNG QR data URL for the panel. Needs no backend —
   * the address is public. Powers `bsv address --png`.
   */
  addressQr: async () => {
    const address = selfAddress();
    return { address, dataUrl: await qrDataUrl(address) };
  },
  /**
   * Human send: move sats to a P2PKH address through the full policy
   * gate (origin cli). Panel + CLI only — deliberately no MCP tool:
   * agents get scoped tools (anchor_tip, x402_pay), never open sends.
   */
  send: async (params) => {
    const b = needBackend();
    const { to, sats, label } = p(params) as { to?: unknown; sats?: unknown; label?: unknown };
    if (typeof to !== "string" || !to) throw Object.assign(new Error("recipient address required"), { code: "BAD_PARAM" });
    const amount = Math.floor(Number(sats) || 0);
    if (!(amount > 0)) throw Object.assign(new Error("sats must be a positive sat number"), { code: "BAD_PARAM" });
    const r = await sendSats({
      db: b.db, chain: b.chain, origin: "cli", to, sats: amount,
      ...(typeof label === "string" && label ? { label } : {}),
    });
    return { txid: r.txid, fee: r.fee };
  },
  /**
   * Sweep OUT: empty this wallet into one address, amount = balance - fee.
   * Policy-gated like `send`, because these are the wallet's own sats leaving.
   */
  sweepOut: async (params) => {
    const b = needBackend();
    const { to, memo, label, origin } = p(params) as {
      to?: unknown; memo?: unknown; label?: unknown; origin?: unknown;
    };
    if (typeof to !== "string" || !to) {
      throw Object.assign(new Error("destination address required"), { code: "BAD_PARAM" });
    }
    const r = await sweepOut({
      db: b.db, chain: b.chain,
      origin: typeof origin === "string" && origin ? origin : "cli",
      to,
      ...(Array.isArray(memo) ? { memo: memo as string[] } : {}),
      ...(typeof label === "string" && label ? { label } : {}),
    });
    return { txid: r.txid, fee: r.fee, sats: r.sats };
  },
  /**
   * Sweep IN: move everything at a foreign key (WIF) into this wallet.
   *
   * The WIF arrives over the local socket exactly as `importWallet`'s phrase
   * does; the CLI reads it from a hidden prompt so it never reaches argv or a
   * shell history, and the shell app has no field for it. The destination is
   * fixed to this wallet inside custody — see sweepSigner.
   *
   * Not policy-gated on purpose: nothing leaves this wallet. There is no
   * approval to give, and gating an inflow would be theatre.
   */
  sweepIn: async (params) => {
    const b = needBackend();
    const { wif, label } = p(params) as { wif?: unknown; label?: unknown };
    if (typeof wif !== "string" || !wif.trim()) {
      throw Object.assign(new Error("private key (WIF) required"), { code: "BAD_PARAM" });
    }
    return sweepIn({
      db: b.db, chain: b.chain, wif,
      ...(typeof label === "string" && label ? { label } : {}),
    });
  },
  /**
   * Phase 0 device management. Loopback-only operator actions, so they live on
   * the ordinary RPC surface rather than the device one.
   */
  devicePairStart: async () => {
    needBackend();
    return { pairing: mintPairingCode(), devices: await listDevices(needBackend().db) };
  },
  devicePairCancel: () => {
    cancelPairing();
    return { cancelled: true };
  },
  deviceList: async () => {
    const b = needBackend();
    const devices = await listDevices(b.db);
    return { devices, pairing: pendingPairingView() };
  },
  deviceRevoke: async (params) => {
    const b = needBackend();
    const { id, name } = p(params) as { id?: unknown; name?: unknown };
    const target = typeof id === "string" && id ? id : typeof name === "string" && name ? name : "";
    if (!target) throw Object.assign(new Error("device id or name required"), { code: "BAD_PARAM" });
    return { revoked: await revokeDevice(b.db, target) };
  },
  deviceRename: async (params) => {
    const b = needBackend();
    const { id, name, to } = p(params) as { id?: unknown; name?: unknown; to?: unknown };
    const target = typeof id === "string" && id ? id : typeof name === "string" && name ? name : "";
    if (!target) throw Object.assign(new Error("device id or name required"), { code: "BAD_PARAM" });
    if (typeof to !== "string" || !to.trim()) throw Object.assign(new Error("new name required"), { code: "BAD_PARAM" });
    return { renamed: await renameDevice(b.db, target, to) };
  },
  anchor: async (params) => {
    const b = needBackend();
    const { sha256, origin } = p(params) as { sha256?: unknown; origin?: unknown };
    if (typeof sha256 !== "string") throw Object.assign(new Error("sha256 required"), { code: "BAD_PARAM" });
    return anchorTip({ db: b.db, chain: b.chain, origin: typeof origin === "string" ? origin : "cli", sha256 });
  },
  /**
   * F7 share target: anchor a file's hash with its name in the label and
   * an explorer link in the result. Same policy gate as `anchor` — the
   * share sheet approves spends, never bypasses them.
   */
  anchorFile: async (params) => {
    const b = needBackend();
    const { sha256, filename, size, origin } = p(params) as {
      sha256?: unknown; filename?: unknown; size?: unknown; origin?: unknown;
    };
    if (typeof sha256 !== "string") throw Object.assign(new Error("sha256 required"), { code: "BAD_PARAM" });
    const label = safeLabel(filename, `anchor ${sha256.slice(0, 12)}`);
    const r = await anchorTip({
      db: b.db, chain: b.chain, label: `file ${label}`,
      origin: typeof origin === "string" ? origin : "cli", sha256,
    });
    return {
      txid: r.txid, fee: r.fee, explorer: explorerTxUrl(r.txid),
      filename: label, size: Math.max(0, Math.floor(Number(size) || 0)),
    };
  },
  policyApprove: async (params) => {
    const b = needBackend();
    const { origin, capSats, auto } = p(params) as { origin?: unknown; capSats?: unknown; auto?: unknown };
    if (typeof origin !== "string" || !origin) throw Object.assign(new Error("origin required"), { code: "BAD_PARAM" });
    const mode = auto === true ? "auto" : "allow";
    await setPolicy(b.db, origin, mode, Math.max(0, Math.floor(Number(capSats) || 0)));
    return { origin, mode };
  },
  policyDeny: async (params) => {
    const b = needBackend();
    const { origin } = p(params) as { origin?: unknown };
    if (typeof origin !== "string" || !origin) throw Object.assign(new Error("origin required"), { code: "BAD_PARAM" });
    await setPolicy(b.db, origin, "deny");
    return { origin, mode: "deny" };
  },
  policyList: async () => {
    const b = needBackend();
    return { policies: await listPolicies(b.db) };
  },
  policyPending: async () => {
    const b = needBackend();
    return { requests: await pendingRequests(b.db) };
  },
  /** `bsv doctor`: machine-check the gotcha table (wallet, caps, requests, broadcasts, Jev, panel sync). */
  doctor: async () => {
    const b = needBackend();
    return runDoctor(b.db);
  },
  /**
   * Approval-lifecycle feed: request created/approved/denied, budget
   * minted/revoked, newest last, monotonic ids. `waitMs` long-polls
   * (capped at 60s) so agents sleep until something happens instead of
   * diffing state. Powers `bsv events` and the `events_poll` MCP tool.
   */
  eventsPoll: async (params) => {
    const b = needBackend();
    const { since, limit, origin, waitMs } = p(params) as {
      since?: unknown; limit?: unknown; origin?: unknown; waitMs?: unknown;
    };
    const wait = Math.min(60_000, Math.max(0, Math.floor(Number(waitMs) || 0)));
    const opts = {
      since: Math.max(0, Math.floor(Number(since) || 0)),
      limit: Math.min(200, Math.max(1, Math.floor(Number(limit) || 50))),
      ...(typeof origin === "string" && origin ? { origin } : {}),
    };
    let events = await readEvents(b.db, opts);
    const deadline = Date.now() + wait;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      events = await readEvents(b.db, opts);
    }
    return { events };
  },
  /**
   * A cursor parked at the newest event, so `bsv watch --follow` (and any
   * agent that wants "from now on") starts empty instead of replaying the
   * whole archive.
   */
  watchTail: async () => {
    const b = needBackend();
    return { cursor: await watchTailCursor(b.db) };
  },
  /**
   * `bsv watch`: the whole wallet as one filtered tail — policy lifecycle,
   * stream payments, incoming payments, x402 receipts, board posts, cast
   * recordings. `filter` is the text DSL (`type=payment sats>=100
   * since=1h`) or an object. `cursor` is echoed back verbatim; `waitMs`
   * long-polls (max 60s). Agents subscribe here instead of re-diffing
   * state. The Bonsai idea, minus the C#.
   */
  watchPoll: async (params) => {
    const b = needBackend();
    const { filter, cursor, limit, waitMs } = p(params) as {
      filter?: unknown; cursor?: unknown; limit?: unknown; waitMs?: unknown;
    };
    const opts = {
      filter: filter ?? "",
      limit: Math.min(200, Math.max(1, Math.floor(Number(limit) || 50))),
      ...(cursor && typeof cursor === "object" ? { cursor: cursor as WatchCursor } : {}),
      waitMs: Math.min(60_000, Math.max(0, Math.floor(Number(waitMs) || 0))),
    };
    return await watchPoll(b.db, opts);
  },
  /**
   * Dry-run gate: judge a hypothetical spend through caps, budgets, and
   * Jev without writing policy_requests or moving money. Powers
   * `bsv probe` and the `policy_probe` MCP tool.
   */
  policyProbe: async (params) => {
    const b = needBackend();
    const { origin, action, amountSats, label, to, description } = p(params) as {
      origin?: unknown; action?: unknown; amountSats?: unknown;
      label?: unknown; to?: unknown; description?: unknown;
    };
    if (typeof origin !== "string" || !origin) throw Object.assign(new Error("origin required"), { code: "BAD_PARAM" });
    if (typeof action !== "string" || !action) throw Object.assign(new Error("action required"), { code: "BAD_PARAM" });
    const amount = Math.floor(Number(amountSats) || 0);
    if (!(amount > 0)) throw Object.assign(new Error("amountSats must be a positive sat number"), { code: "BAD_PARAM" });
    return probe(b.db, origin, amount, action, {
      context: {
        ...(typeof label === "string" && label ? { label } : {}),
        ...(typeof to === "string" && to ? { to } : {}),
        ...(typeof description === "string" && description ? { description } : {}),
      },
    });
  },
  /** Jev advisor status: enabled, model, auto-approval thresholds (never the key). */
  jevStatus: () => ({
    enabled: jevEnabled(),
    model: jevModel(),
    auto: autoThresholds(),
  }),
  /**
   * One calibrated decision call. Agents and apps go through the daemon so
   * the OpenRouter key stays in the daemon environment; ~$0.00002/call.
   */
  jevDecide: async (params) => {
    const { state, questions, model } = p(params) as { state?: unknown; questions?: unknown; model?: unknown };
    if (state === undefined || state === null) throw Object.assign(new Error("state required"), { code: "BAD_PARAM" });
    return jevDecideCall(state, questions as Record<string, JevQuestion>, {
      model: typeof model === "string" && model ? model : undefined,
    });
  },
  /**
   * EntangleIT Trust profile for this wallet: fetched from TRUST_URL and
   * verified offline. Terms only widen the Jev auto band inside caps; this
   * handler is read-only and never spends. Needs the wallet unlocked for the
   * identity key (the subject).
   */
  trustTerms: async (params) => {
    const { refresh } = p(params) as { refresh?: unknown };
    let identityKey: string | null = null;
    try {
      identityKey = identityPubkeyHex();
    } catch {
      /* locked: report below */
    }
    if (!identityKey) {
      return {
        configured: Boolean(trustUrl()), mode: trustMode(), subject: null,
        verified: false, profile: null, level: null, terms: null,
        expiresAt: null, reasons: [], error: "wallet locked",
      };
    }
    return trustState({ identityKey, force: refresh === true });
  },
  agentMint: async (params) => {
    const b = needBackend();
    const { name, budgetSats, dailySats, expiryAt } = p(params) as {
      name?: unknown; budgetSats?: unknown; dailySats?: unknown; expiryAt?: unknown;
    };
    if (typeof name !== "string" || !name) throw Object.assign(new Error("name required"), { code: "BAD_PARAM" });
    const view = await mintAgent(b.db, { name, budgetSats: Number(budgetSats), dailySats: Number(dailySats ?? 0), expiryAt: Number(expiryAt ?? 0) });
    // Revoke pairs the flag with a policy deny; minting is the approval
    // ceremony, so a re-mint clears that deny back to the default ask mode.
    const row = (await b.db("policies").where({ origin: view.name }).first()) as { mode?: string } | undefined;
    if (row?.mode === "deny") await setPolicy(b.db, view.name, "ask");
    return view;
  },
  agentRevoke: async (params) => {
    // One command fully cuts access: flag the sub-wallet AND deny the origin.
    const b = needBackend();
    const { name } = p(params) as { name?: unknown };
    if (typeof name !== "string" || !name) throw Object.assign(new Error("name required"), { code: "BAD_PARAM" });
    const r = await revokeAgent(b.db, name);
    await setPolicy(b.db, r.name, "deny");
    return r;
  },
  agentList: async () => {
    const b = needBackend();
    return { agents: await listAgents(b.db) };
  },
  agentShow: async (params) => {
    const b = needBackend();
    const { name } = p(params) as { name?: unknown };
    if (typeof name !== "string" || !name) throw Object.assign(new Error("name required"), { code: "BAD_PARAM" });
    const a = await getAgent(b.db, name);
    if (!a) throw Object.assign(new Error(`no agent wallet: ${name}`), { code: "NOT_FOUND" });
    return a;
  },
  history: async () => {
    // F8 dashboard: degrades to empty (like pending) before the engine boots.
    if (!backend) return emptyHistory();
    return getHistory(backend.db, backend.chain);
  },
  certPut: async (params) => {
    const b = needBackend();
    const { type, certifier, subject, fields, signature, expiresAt } = p(params) as {
      type?: unknown; certifier?: unknown; subject?: unknown;
      fields?: unknown; signature?: unknown; expiresAt?: unknown;
    };
    if (typeof type !== "string" || !type) throw Object.assign(new Error("type required"), { code: "BAD_PARAM" });
    if (typeof certifier !== "string" || !certifier) {
      throw Object.assign(new Error("certifier required"), { code: "BAD_PARAM" });
    }
    return putCert(b.db, {
      type, certifier,
      subject: typeof subject === "string" ? subject : undefined,
      fields,
      signature: typeof signature === "string" ? signature : undefined,
      expiresAt: Number(expiresAt ?? 0),
    });
  },
  certList: async () => {
    const b = needBackend();
    return { certs: await listCerts(b.db) };
  },
  certShow: async (params) => {
    const b = needBackend();
    const { id, fields, to } = p(params) as { id?: unknown; fields?: unknown; to?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return showCert(b.db, id, {
      fields: Array.isArray(fields) ? (fields as string[]) : undefined,
      to: typeof to === "string" ? to : undefined,
    });
  },
  certRevoke: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return revokeCert(b.db, id);
  },
  /**
   * F11 explorer: overlay health/topics/lookup are keyless reads;
   * tagging is ownership-scoped to our own tracked transactions.
   */
  overlayHealth: async () => ({ overlays: await overlayHealth() }),
  overlayTopics: async () => ({ topics: await overlayTopics() }),
  overlayLookup: async (params) => {
    const { topic, address, what } = p(params) as { topic?: unknown; address?: unknown; what?: unknown };
    if (typeof topic !== "string" || !topic) throw Object.assign(new Error("topic required"), { code: "BAD_PARAM" });
    return overlayLookup(topic, {
      address: typeof address === "string" ? address : undefined,
      what: typeof what === "string" ? what : undefined,
    });
  },
  overlaySubmit: async (params) => {
    const b = needBackend();
    const { txid, topics } = p(params) as { txid?: unknown; topics?: unknown };
    if (typeof txid !== "string" || !txid) throw Object.assign(new Error("txid required"), { code: "BAD_PARAM" });
    const list = Array.isArray(topics) ? topics as string[] : typeof topics === "string" ? topics.split(",") : [];
    return tagTransaction(b.db, txid, list);
  },
  overlayTags: async (params) => {
    const b = needBackend();
    const { txid } = p(params) as { txid?: unknown };
    if (typeof txid !== "string" || !txid) throw Object.assign(new Error("txid required"), { code: "BAD_PARAM" });
    return { txid, topics: await tagsFor(b.db, txid) };
  },
  /**
   * F13 standing orders: schedules + per-cycle escrow states. Approval
   * debits the agent budget; the daemon never runs agent work itself.
   */
  shiftCreate: async (params) => {
    const b = needBackend();
    const { name, agent, every, cycleSats, bountyId } = p(params) as {
      name?: unknown; agent?: unknown; every?: unknown; cycleSats?: unknown; bountyId?: unknown;
    };
    return createOrder(b.db, {
      name: typeof name === "string" ? name : "",
      agent: typeof agent === "string" ? agent : "",
      every: every as string | number,
      cycleSats: Number(cycleSats),
      bountyId: typeof bountyId === "string" ? bountyId : undefined,
    });
  },
  shiftList: async () => {
    const b = needBackend();
    return { orders: await listOrders(b.db) };
  },
  shiftPause: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return setOrderStatus(b.db, id, "paused");
  },
  shiftResume: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return setOrderStatus(b.db, id, "active");
  },
  shiftRemove: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return removeOrder(b.db, id);
  },
  shiftRuns: async (params) => {
    const b = needBackend();
    const { order, limit } = p(params) as { order?: unknown; limit?: unknown };
    return {
      runs: await listRuns(
        b.db,
        typeof order === "string" ? order : undefined,
        limit === undefined ? 50 : Number(limit),
      ),
    };
  },
  shiftClaim: async (params) => {
    const b = needBackend();
    const { run } = p(params) as { run?: unknown };
    if (run === undefined) throw Object.assign(new Error("run required"), { code: "BAD_PARAM" });
    return claimRun(b.db, Number(run));
  },
  shiftSubmit: async (params) => {
    const b = needBackend();
    const { run, proof } = p(params) as { run?: unknown; proof?: unknown };
    if (run === undefined) throw Object.assign(new Error("run required"), { code: "BAD_PARAM" });
    if (typeof proof !== "string" || !proof) throw Object.assign(new Error("proof required"), { code: "BAD_PARAM" });
    return submitRun(b.db, Number(run), proof);
  },
  shiftApprove: async (params) => {
    const b = needBackend();
    const { run } = p(params) as { run?: unknown };
    if (run === undefined) throw Object.assign(new Error("run required"), { code: "BAD_PARAM" });
    return approveRun(b.db, Number(run));
  },
  shiftFail: async (params) => {
    const b = needBackend();
    const { run } = p(params) as { run?: unknown };
    if (run === undefined) throw Object.assign(new Error("run required"), { code: "BAD_PARAM" });
    return failRun(b.db, Number(run));
  },
  /**
   * F12 board: keyless reads, key-gated rails writes, local lifecycle.
   * Agentpay key comes from AGENTPAY_KEY (never argv/history).
   */
  gigBoard: async (params) => {
    const { category, limit } = p(params) as { category?: unknown; limit?: unknown };
    return {
      gigs: await boardList({
        category: typeof category === "string" ? category : undefined,
        limit: Number(limit ?? 25),
      }),
    };
  },
  gigShow: async (params) => {
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return boardGet(id);
  },
  gigList: async () => {
    const b = needBackend();
    return { gigs: await listGigs(b.db) };
  },
  gigTrack: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return trackGig(b.db, await boardGet(id));
  },
  gigUntrack: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return untrackGig(b.db, id);
  },
  gigClaim: async (params) => {
    const b = needBackend();
    const { id, payoutAddress, workerPubKey } = p(params) as {
      id?: unknown; payoutAddress?: unknown; workerPubKey?: unknown;
    };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return claimGig(b.db, id, {
      payoutAddress: typeof payoutAddress === "string" ? payoutAddress : undefined,
      workerPubKey: typeof workerPubKey === "string" ? workerPubKey : undefined,
    });
  },
  gigSubmit: async (params) => {
    const b = needBackend();
    const { id, workHash, workUri, notes } = p(params) as {
      id?: unknown; workHash?: unknown; workUri?: unknown; notes?: unknown;
    };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return submitGig(b.db, id, {
      workHash: typeof workHash === "string" ? workHash : undefined,
      workUri: typeof workUri === "string" ? workUri : undefined,
      notes: typeof notes === "string" ? notes : undefined,
    });
  },
  gigPaid: async (params) => {
    const b = needBackend();
    const { id, txid, vout } = p(params) as { id?: unknown; txid?: unknown; vout?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    if (typeof txid !== "string" || !txid) throw Object.assign(new Error("txid required"), { code: "BAD_PARAM" });
    return paidGig(b.db, id, txid, Number(vout));
  },
  /**
   * F6 inbox: ECDH DMs over the relay. Sends are off-chain (no policy
   * spend), but every call is origin-stamped and stored ciphertext-only.
   */
  msgSend: async (params) => {
    const b = needBackend();
    const { to, text } = p(params) as { to?: unknown; text?: unknown };
    if (typeof to !== "string" || !to) throw Object.assign(new Error("recipient required (@name, identity key)"), { code: "BAD_PARAM" });
    if (typeof text !== "string" || !text) throw Object.assign(new Error("text required"), { code: "BAD_PARAM" });
    const person = await resolvePerson(b.db, to, livePeople());
    if (!person.identityKey) {
      throw Object.assign(new Error(`no identity key for ${person.display} — add one with: bsv contact add`), { code: "BAD_PARAM" });
    }
    const self = identityPubkeyHex();
    return sendDmPreferred(b.db, liveRelay(), p2pChannel, self, person.identityKey, text);
  },
  msgSync: async () => {
    const b = needBackend();
    return syncInbox(b.db, liveRelay());
  },
  msgList: async (params) => {
    const b = needBackend();
    const { direction } = p(params) as { direction?: unknown };
    const rows = await listStored(b.db, direction === "out" ? "out" : direction === "in" ? "in" : undefined);
    return {
      messages: rows.map((r) => ({
        id: r.id, peer: r.peer, direction: r.direction,
        createdAt: r.createdAt, acked: r.acked === 1, transport: r.transport,
      })),
    };
  },
  msgShow: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return readDm(b.db, id);
  },
  msgAck: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return ackDm(b.db, liveRelay(), id);
  },
  msgStatus: async () => {
    needBackend();
    return liveRelay().status();
  },
  msgRegister: async (params) => {
    needBackend();
    const { username } = p(params) as { username?: unknown };
    if (typeof username !== "string" || !username) {
      throw Object.assign(new Error("username required"), { code: "BAD_PARAM" });
    }
    return liveRelay().register(username);
  },
  /** F6.2 direct channel: discovery + session state (no keys involved). */
  p2pStatus: async () => {
    needBackend();
    if (!p2pChannel) {
      return { enabled: false, identityKey: null, port: null, discovery: false, sessions: 0, peers: 0 };
    }
    return p2pChannel.status();
  },
  p2pPeers: async () => {
    needBackend();
    if (!p2pChannel) return { enabled: false, peers: [] };
    return { enabled: true, peers: p2pChannel.peers() };
  },
  /** People: local names bound to identity keys + receive addresses. */
  contactList: async () => {
    const b = needBackend();
    return { contacts: await listContacts(b.db) };
  },
  contactAdd: async (params) => {
    const b = needBackend();
    const { name, identityKey, address, note } = p(params) as {
      name?: unknown; identityKey?: unknown; address?: unknown; note?: unknown;
    };
    if (typeof name !== "string" || !name) throw Object.assign(new Error("name required"), { code: "BAD_PARAM" });
    if (typeof identityKey !== "string" || !identityKey) throw Object.assign(new Error("identityKey required"), { code: "BAD_PARAM" });
    return addContact(b.db, {
      name,
      identityKey,
      address: typeof address === "string" ? address : "",
      note: typeof note === "string" ? note : "",
    });
  },
  contactRemove: async (params) => {
    const b = needBackend();
    const { name } = p(params) as { name?: unknown };
    if (typeof name !== "string" || !name) throw Object.assign(new Error("name required"), { code: "BAD_PARAM" });
    return removeContact(b.db, name);
  },
  contactLookup: async (params) => {
    const b = needBackend();
    const { who } = p(params) as { who?: unknown };
    if (typeof who !== "string" || !who) throw Object.assign(new Error("who required"), { code: "BAD_PARAM" });
    return resolvePerson(b.db, who, livePeople());
  },
  profileGet: async () => {
    const b = needBackend();
    return { name: await profileName(b.db) };
  },
  profileSet: async (params) => {
    const b = needBackend();
    const { name } = p(params) as { name?: unknown };
    if (typeof name !== "string") throw Object.assign(new Error("name required"), { code: "BAD_PARAM" });
    return setProfileName(b.db, name);
  },
  /**
   * One-tap pay: resolve `@name` (or key/address), learn the address from a
   * live peer when needed, send sats, and attach the note as a DM when the
   * recipient has an identity key. Payment succeeds even if the DM fails.
   */
  pay: (params: unknown) => payFor("cli", params),
  /** First-run faucet (remote service; funds one claim per identity key). */
  faucetStatus: async () => {
    needBackend();
    let identityKey = "";
    try {
      identityKey = identityPubkeyHex();
    } catch {
      /* locked: status without the claim flag */
    }
    return faucetStatus(undefined, undefined, identityKey);
  },
  faucetClaim: async () => {
    needBackend();
    return faucetClaim();
  },
  /** F6.3 file sharing: real BitTorrent, bsvOS discovery. */
  torrentList: async () => {
    needBackend();
    if (!torrentService) return { enabled: false, torrents: [] };
    return { enabled: true, port: torrentService.btPort, torrents: await torrentService.list() };
  },
  torrentShare: async (params) => {
    needBackend();
    const s = needTorrents();
    const { path: file, name } = p(params) as { path?: unknown; name?: unknown };
    if (typeof file !== "string" || !file) throw Object.assign(new Error("path required"), { code: "BAD_PARAM" });
    return s.share(file, typeof name === "string" && name ? name : undefined);
  },
  torrentFetch: async (params) => {
    needBackend();
    const s = needTorrents();
    const { infoHash, torrentFile, peer, out } = p(params) as {
      infoHash?: unknown; torrentFile?: unknown; peer?: unknown; out?: unknown;
    };
    if (typeof infoHash !== "string" && typeof torrentFile !== "string") {
      throw Object.assign(new Error("infoHash or torrentFile required"), { code: "BAD_PARAM" });
    }
    return s.fetch({
      ...(typeof infoHash === "string" && infoHash ? { infoHash } : {}),
      ...(typeof torrentFile === "string" && torrentFile ? { torrentFile } : {}),
      ...(typeof peer === "string" && peer ? { peer } : {}),
      ...(typeof out === "string" && out ? { out } : {}),
    });
  },
  torrentPeers: async (params) => {
    needBackend();
    const s = needTorrents();
    const { infoHash } = p(params) as { infoHash?: unknown };
    if (typeof infoHash !== "string" || !infoHash) throw Object.assign(new Error("infoHash required"), { code: "BAD_PARAM" });
    return { peers: await s.peersFor(infoHash) };
  },
  torrentRemove: async (params) => {
    needBackend();
    const s = needTorrents();
    const { infoHash, deleteFile } = p(params) as { infoHash?: unknown; deleteFile?: unknown };
    if (typeof infoHash !== "string" || !infoHash) throw Object.assign(new Error("infoHash required"), { code: "BAD_PARAM" });
    return s.remove(infoHash, { deleteFile: deleteFile === true });
  },
  /**
   * Payment requests: a signed ask for money that travels over DM, QR, or
   * paste. Creating one costs nothing and never spends; paying one is a
   * normal policy-gated spend plus a signed receipt back to the requester.
   */
  requestCreate: async (params) => {
    const b = needBackend();
    const { to, sats, memo, expires } = p(params) as { to?: unknown; sats?: unknown; memo?: unknown; expires?: unknown };
    if (typeof to !== "string" || !to) throw Object.assign(new Error("who required (@name, identity key, address)"), { code: "BAD_PARAM" });
    const amount = Math.floor(Number(sats) || 0);
    if (!(amount > 0)) throw Object.assign(new Error("sats must be a positive sat number"), { code: "BAD_PARAM" });
    const ttlMs = parseDuration(expires);
    const person = await resolvePerson(b.db, to, livePeople());
    const request = buildRequest({
      identityKey: identityPubkeyHex(),
      address: selfAddress(),
      amount,
      memo: typeof memo === "string" ? memo : "",
      ttlMs,
    });
    const row = await recordOutgoing(b.db, request, person.identityKey);
    const code = encodeRequest(request);
    let sent = false;
    if (person.identityKey) {
      ({ sent } = await sendRequestCode(b.db, liveRelay(), p2pChannel, person.identityKey, code, request.memo));
    }
    return {
      id: row.id,
      code,
      dataUrl: await qrDataUrlText(code),
      sent,
      to: { name: person.name, display: person.display, identityKey: person.identityKey },
      amount: request.amount,
      memo: request.memo,
      expiresAt: row.expiresAt,
    };
  },
  requestList: async () => {
    const b = needBackend();
    await expireOld(b.db);
    let sync = { scanned: 0, imported: 0, paid: 0, claimed: 0 };
    try {
      let address = "";
      try {
        address = selfAddress();
      } catch {
        /* locked: import will no-op anyway */
      }
      const verifyPayment = address ? incomingPaymentVerifier(b.chain, address) : undefined;
      sync = await scanInbound(b.db, verifyPayment ? { verifyPayment } : {});
    } catch {
      /* locked wallet: list what we already know */
    }
    return {
      incoming: await listRequests(b.db, "in"),
      outgoing: await listRequests(b.db, "out"),
      sync,
    };
  },
  requestPay: (params: unknown) => requestPayFor("cli", params),
  requestDecline: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("request id required"), { code: "BAD_PARAM" });
    const row = await getRequest(b.db, id);
    if (!row) throw Object.assign(new Error(`no request ${id}`), { code: "NOT_FOUND" });
    return markDeclined(b.db, id);
  },
  requestImport: async (params) => {
    const b = needBackend();
    const { code } = p(params) as { code?: unknown };
    if (typeof code !== "string" || !code.trim()) throw Object.assign(new Error("code required"), { code: "BAD_PARAM" });
    const request = parseRequest(code.trim());
    const saved = await saveIncoming(b.db, request, code.trim());
    return { fresh: saved.fresh, request: saved.row };
  },
  requestCode: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("request id required"), { code: "BAD_PARAM" });
    const row = await getRequest(b.db, id);
    if (!row) throw Object.assign(new Error(`no request ${id}`), { code: "NOT_FOUND" });
    return { id: row.id, code: row.code, dataUrl: await qrDataUrlText(row.code), status: row.status, direction: row.direction };
  },
  /**
   * Inscribe a purchase receipt as a 1Sat ordinal and deliver it to the
   * counterparty in the same transaction. Sources: a paid incoming request
   * (knows amount, memo, peer, payment txid) or explicit txid/to/amount.
   */
  receiptIssue: (params: unknown) => receiptIssueFor("cli", params),
  receiptList: async () => {
    const b = needBackend();
    return { receipts: await listPaymentReceipts(b.db) };
  },
  /** F6.4 boards: fast, permissioned, persistent agent-to-agent logs. */
  boardList: async () => {
    const b = needBackend();
    await syncBoards(b.db);
    return { boards: await listBoards(b.db) };
  },
  boardCreate: async (params) => {
    const b = needBackend();
    const { name, mode, members, posters } = p(params) as { name?: unknown; mode?: unknown; members?: unknown; posters?: unknown };
    if (typeof name !== "string" || !name) throw Object.assign(new Error("board name required"), { code: "BAD_PARAM" });
    const resolved: string[] = [];
    for (const who of Array.isArray(members) ? members : []) {
      const person = await resolvePerson(b.db, String(who), livePeople()).catch(() => null);
      if (!person?.identityKey) throw Object.assign(new Error(`no identity key for ${String(who)}`), { code: "BAD_PARAM" });
      resolved.push(person.identityKey);
    }
    const row = await createBoard(b.db, {
      name,
      mode: mode === "open" ? "open" : "members",
      members: resolved,
      posters: Array.isArray(posters) ? posters.map((x) => String(x)) : [],
    });
    // Founding members need the key: deliver it now (best effort).
    let delivered = 0;
    for (const member of row.members) {
      if (await deliverBoardKey(b.db, liveRelay(), p2pChannel, row.name, member)) delivered++;
    }
    return {
      board: row.name,
      mode: row.mode,
      epoch: row.epoch,
      members: row.members,
      delivered,
      keyCode: encodeBoardKey(row.name, row.keyHex, identityPubkeyHex(), row.epoch, row.members),
    };
  },
  boardKey: async (params) => {
    const b = needBackend();
    const { name } = p(params) as { name?: unknown };
    const row = await getBoard(b.db, String(name ?? ""));
    if (!row) throw Object.assign(new Error(`no board ${String(name ?? "")}`), { code: "NOT_FOUND" });
    return { board: row.name, epoch: row.epoch, keyCode: encodeBoardKey(row.name, row.keyHex, identityPubkeyHex(), row.epoch) };
  },
  boardRemove: async (params) => {
    const b = needBackend();
    const { name } = p(params) as { name?: unknown };
    const row = await getBoard(b.db, String(name ?? ""));
    if (!row) throw Object.assign(new Error(`no board ${String(name ?? "")}`), { code: "NOT_FOUND" });
    return removeBoard(b.db, row.name);
  },
  boardJoin: async (params) => {
    const b = needBackend();
    const { code } = p(params) as { code?: unknown };
    const key = parseBoardKey(typeof code === "string" ? code.trim() : "");
    if (!key) throw Object.assign(new Error("not a valid board key code"), { code: "BAD_PARAM" });
    const row = await createBoard(b.db, { name: key.board, keyHex: key.keyHex, epoch: key.epoch, members: [key.from] });
    return { board: row.name, mode: row.mode, epoch: row.epoch, members: row.members };
  },
  boardInvite: async (params) => {
    const b = needBackend();
    const { board, to } = p(params) as { board?: unknown; to?: unknown };
    const row = await getBoard(b.db, String(board ?? ""));
    if (!row) throw Object.assign(new Error(`no board ${String(board ?? "")}`), { code: "NOT_FOUND" });
    const person = await resolvePerson(b.db, String(to ?? ""), livePeople());
    if (!person.identityKey) throw Object.assign(new Error("invitee needs an identity key"), { code: "BAD_PARAM" });
    // Membership is local truth; notifying members is best effort. Adding a
    // member rotates the key, so the new epoch is delivered to everyone
    // (the newcomer cannot read old posts; everyone can read new ones).
    await addMember(b.db, row.name, person.identityKey);
    const rotated = await rotateBoardKey(b.db, row.name);
    const after = (await getBoard(b.db, row.name)) as BoardRow;
    let delivered = 0;
    for (const member of after.members) {
      if (await deliverBoardKey(b.db, liveRelay(), p2pChannel, after.name, member)) delivered++;
    }
    return { board: after.name, invited: person.identityKey, epoch: rotated.epoch, delivered, members: after.members.length };
  },
  boardKick: async (params) => {
    const b = needBackend();
    const { board, who } = p(params) as { board?: unknown; who?: unknown };
    const row = await getBoard(b.db, String(board ?? ""));
    if (!row) throw Object.assign(new Error(`no board ${String(board ?? "")}`), { code: "NOT_FOUND" });
    const person = await resolvePerson(b.db, String(who ?? ""), livePeople());
    if (!person.identityKey) throw Object.assign(new Error("who needs an identity key"), { code: "BAD_PARAM" });
    const after = await removeMember(b.db, row.name, person.identityKey);
    if (!after) throw Object.assign(new Error(`no board ${row.name}`), { code: "NOT_FOUND" });
    let delivered = 0;
    for (const member of after.members) {
      if (await deliverBoardKey(b.db, liveRelay(), p2pChannel, after.name, member)) delivered++;
    }
    return { board: after.name, removed: person.identityKey, epoch: after.epoch, members: after.members.length, delivered };
  },
  boardThread: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("post id required"), { code: "BAD_PARAM" });
    const thread = await getThread(b.db, id);
    if (!thread) throw Object.assign(new Error(`no post ${id}`), { code: "NOT_FOUND" });
    if (thread.board) await markRead(b.db, thread.board);
    return thread;
  },
  boardPost: async (params) => {
    const b = needBackend();
    const { board, text, kind, refs, replyTo, agent, origin } = p(params) as {
      board?: unknown; text?: unknown; kind?: unknown; refs?: unknown; replyTo?: unknown; agent?: unknown; origin?: unknown;
    };
    const row = await getBoard(b.db, String(board ?? ""));
    if (!row) throw Object.assign(new Error(`no board ${String(board ?? "")}`), { code: "NOT_FOUND" });
    return boardPublish(b, row, { text, kind, refs, replyTo, agent, origin });
  },
  boardReply: async (params) => {
    const b = needBackend();
    const { id, text, agent, origin } = p(params) as { id?: unknown; text?: unknown; agent?: unknown; origin?: unknown };
    const post = (await b.db("board_posts").where({ id: String(id ?? "") }).first()) as { board?: string } | undefined;
    if (!post?.board) throw Object.assign(new Error(`no post ${String(id ?? "")}`), { code: "NOT_FOUND" });
    const row = await getBoard(b.db, post.board);
    if (!row) throw Object.assign(new Error(`no board ${post.board}`), { code: "NOT_FOUND" });
    return boardPublish(b, row, { text, replyTo: String(id ?? ""), agent, origin });
  },
  boardGet: async (params) => {
    const b = needBackend();
    const { board, since, limit, remote } = p(params) as { board?: unknown; since?: unknown; limit?: unknown; remote?: unknown };
    const row = await getBoard(b.db, String(board ?? ""));
    if (!row) throw Object.assign(new Error(`no board ${String(board ?? "")}`), { code: "NOT_FOUND" });
    await syncBoards(b.db);
    const sinceMs = Math.floor(Number(since) || 0);
    if (typeof remote === "string" && remote && p2pChannel?.boardGet) {
      try {
        const direct = /^[0-9a-fA-F]{66}$/.test(remote) ? remote.toLowerCase() : (await resolvePerson(b.db, remote, livePeople())).identityKey;
        if (direct) {
          const pulled = await p2pChannel.boardGet(direct, row.name, sinceMs);
          for (const env of pulled ?? []) {
            if (envelopeShape(env)) await ingestPost(b.db, env);
          }
        }
      } catch {
        /* remote catch-up is best effort */
      }
    }
    const res = await getPosts(b.db, row.name, { since: sinceMs, limit: Math.floor(Number(limit) || 100) });
    return { board: row.name, locked: res.locked, posts: res.posts };
  },
  boardWait: async (params) => {
    const b = needBackend();
    const { board, timeoutMs, replyTo, from, agent, mention } = p(params) as {
      board?: unknown; timeoutMs?: unknown; replyTo?: unknown; from?: unknown; agent?: unknown; mention?: unknown;
    };
    const row = await getBoard(b.db, String(board ?? ""));
    if (!row) throw Object.assign(new Error(`no board ${String(board ?? "")}`), { code: "NOT_FOUND" });
    await syncBoards(b.db);
    let fromKey: string | undefined;
    if (typeof from === "string" && from) {
      fromKey = /^[0-9a-fA-F]{66}$/.test(from) ? from.toLowerCase() : (await resolvePerson(b.db, from, livePeople())).identityKey || undefined;
    }
    const matchId = typeof replyTo === "string" && replyTo ? replyTo : "";
    const wantAgent = typeof agent === "string" && agent ? agent : "";
    const wantMention = typeof mention === "string" && mention ? `agent:${mention}` : "";
    const needsContent = Boolean(matchId || wantMention);
    const env = await waitForPost({
      board: row.name,
      timeoutMs: Math.floor(Number(timeoutMs) || 30_000),
      ...(fromKey ? { from: fromKey } : {}),
      ...(wantAgent ? { agent: wantAgent } : {}),
      ...(needsContent
        ? {
            matches: async (e) => {
              const content = await postContent(b.db, row.name, e);
              if (!content) return false;
              if (matchId && content.replyTo !== matchId) return false;
              if (wantMention && !content.refs.includes(wantMention)) return false;
              return true;
            },
          }
        : {}),
    });
    if (!env) return { timeout: true, post: null };
    await ingestPost(b.db, env).catch(() => null);
    const posts = await getPosts(b.db, row.name, { limit: 500, markRead: false });
    return { timeout: false, post: posts.posts.find((x) => x.id === env.id) ?? null };
  },
  /**
   * AskAnything (wallet-only Q&A): funded questions as board posts, sats
   * pledged in refs, paid on accept through the existing spend/pay paths.
   * Asking and answering are free and off-chain; only the accept payment
   * moves sats (human-confirmed, policy-gated).
   */
  askPost: async (params) => {
    const b = needBackend();
    const { board, title, details, amountSats, agent, origin } = p(params) as {
      board?: unknown; title?: unknown; details?: unknown; amountSats?: unknown; agent?: unknown; origin?: unknown;
    };
    const q = validateQuestion({ title, details, amountSats });
    const row = await getBoard(b.db, String(board ?? ASK_BOARD));
    const target = row ?? await ensureAskBoard(b.db, String(board ?? ASK_BOARD));
    return boardPublish(b, target, {
      text: q.details, kind: "request", refs: [amountRef(q.amountSats), titleRef(q.title)], agent, origin,
    });
  },
  askList: async (params) => {
    const b = needBackend();
    const { board } = p(params) as { board?: unknown };
    const name = String(board ?? ASK_BOARD);
    const row = await getBoard(b.db, name);
    if (!row) return { board: null, questions: [] };
    return { board: row.name, questions: await openQuestions(b.db, row.name) };
  },
  askAnswer: async (params) => {
    const b = needBackend();
    const { board, replyTo, text, payTo, agent, origin } = p(params) as {
      board?: unknown; replyTo?: unknown; text?: unknown; payTo?: unknown; agent?: unknown; origin?: unknown;
    };
    const a = validateAnswer({ text, payTo });
    if (typeof replyTo !== "string" || !replyTo) throw Object.assign(new Error("replyTo question id required"), { code: "BAD_PARAM" });
    const row = await getBoard(b.db, String(board ?? ASK_BOARD));
    if (!row) throw Object.assign(new Error(`no board ${String(board ?? ASK_BOARD)}`), { code: "NOT_FOUND" });
    return boardPublish(b, row, {
      text: a.text, kind: "result", refs: [payToRef(a.payTo)], replyTo, agent, origin,
    });
  },
  /**
   * Resolve an accept into a payment preview. Never spends: the caller pays
   * through the spend/pay paths (app two-step confirm, `bsv pay`).
   */
  askAccept: async (params) => {
    const b = needBackend();
    const { board, answerId } = p(params) as { board?: unknown; answerId?: unknown };
    if (typeof answerId !== "string" || !answerId) throw Object.assign(new Error("answerId required"), { code: "BAD_PARAM" });
    const row = await getBoard(b.db, String(board ?? ASK_BOARD));
    if (!row) throw Object.assign(new Error(`no board ${String(board ?? ASK_BOARD)}`), { code: "NOT_FOUND" });
    const { posts } = await getPosts(b.db, row.name, { limit: 500, markRead: false });
    const answer = posts.find((x) => x.id === answerId);
    if (!answer || answer.locked) throw Object.assign(new Error("answer not found"), { code: "NOT_FOUND" });
    if (answer.kind !== "result" || !answer.replyTo) {
      throw Object.assign(new Error("not an answer (needs kind=result with a question replyTo)"), { code: "BAD_PARAM" });
    }
    const payTo = payToFromRefs(answer.refs);
    if (!payTo) throw Object.assign(new Error("answer carries no valid payto: ref"), { code: "BAD_PARAM" });
    const question = posts.find((x) => x.id === answer.replyTo);
    if (!question || question.locked) throw Object.assign(new Error("question not found"), { code: "NOT_FOUND" });
    const amountSats = amountFromRefs(question.refs) ?? 0;
    const { title, details } = decodeQuestion({ text: question.text, refs: question.refs });
    return {
      board: row.name,
      questionId: question.id, title, details, amountSats,
      answerId: answer.id, answerText: answer.text, answerFrom: answer.from, payTo,
      payCommand: `bsv pay ${payTo} ${amountSats} --note "ask ${question.id.slice(0, 8)}"`,
    };
  },
  /** Jev review of a draft question: clarity + duplicates. Advisory, fail-open. */
  askTriage: async (params) => {
    const { board, title, details, amountSats } = p(params) as {
      board?: unknown; title?: unknown; details?: unknown; amountSats?: unknown;
    };
    const q = validateQuestion({ title, details, amountSats });
    const b = needBackend();
    const open = await openQuestions(b.db, String(board ?? ASK_BOARD));
    return triageQuestion(jevDecideCall, {
      title: q.title, details: q.details, amountSats: q.amountSats,
      open: open.map((o) => ({ id: o.id, title: o.title })),
    });
  },
  /** Jev blind grade of one answer against its question. Advisory, fail-open. */
  askGrade: async (params) => {
    const { question, submission } = p(params) as { question?: unknown; submission?: unknown };
    return gradeAnswer(jevDecideCall, { question: String(question ?? ""), submission: String(submission ?? "") });
  },

  /* ── Prediction markets: parimutuel pools, Jev resolution ────────── */
  predictList: async (params) => {
    const b = needBackend();
    const { status } = p(params) as { status?: unknown };
    return { markets: await listMarkets(b.db, typeof status === "string" ? status : undefined) };
  },
  predictShow: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    const v = await marketView(b.db, id);
    if (!v) throw Object.assign(new Error(`no market ${id}`), { code: "NOT_FOUND" });
    return { market: v, bets: await getBets(b.db, id) };
  },
  predictCreate: async (params) => {
    const b = needBackend();
    const raw = p(params) as Record<string, unknown>;
    const v = validateMarket(raw);
    const origin = typeof raw.origin === "string" && raw.origin ? raw.origin : "predict";
    const m = await createMarket(b.db, createBasket, {
      question: v.question,
      outcomes: v.outcomes,
      closes_at: v.closes_at,
      evidence: v.evidence,
      fee_bps: v.fee_bps,
      dispute_hours: v.dispute_hours,
      creator_origin: origin,
    });
    return { market: await marketView(b.db, m.id) };
  },
  predictBet: async (params) => {
    const b = needBackend();
    const raw = p(params) as Record<string, unknown>;
    const id = String(raw.id ?? "");
    const outcome = String(raw.outcome ?? "");
    const sats = Math.floor(Number(raw.sats) || 0);
    const origin = typeof raw.origin === "string" && raw.origin ? raw.origin : "predict";
    let to = String(raw.to ?? "");
    const m = await getMarket(b.db, id);
    if (!m) throw Object.assign(new Error(`no market ${id}`), { code: "NOT_FOUND" });
    const live = await lockIfPastClose(b.db, m);
    if (live.status !== "open") throw Object.assign(new Error(`market is ${live.status}, not open`), { code: "BAD_STATE" });
    if (!live.outcomes.includes(outcome)) throw Object.assign(new Error(`unknown outcome (pick: ${live.outcomes.join(", ")})`), { code: "BAD_PARAM" });
    if (!(sats >= PREDICT_MIN_BET_SATS)) throw Object.assign(new Error(`min bet ${PREDICT_MIN_BET_SATS} sats`), { code: "BAD_PARAM" });
    if (!to) to = selfAddress();
    const paid = await sendSats({
      db: b.db, chain: b.chain, origin, to: selfAddress(), sats,
      label: `predict bet ${sats} on ${outcome} (${id})`,
    });
    await labelOutputs(b.db, paid.txid, [{ vout: 0, value: sats, basket: marketBasket(id) }]);
    const bet = await recordBet(b.db, {
      market_id: id, origin, payout_address: to, outcome, sats, txid: paid.txid,
    });
    return { bet, fee: paid.fee };
  },
  predictResolve: async (params) => {
    const b = needBackend();
    const raw = p(params) as Record<string, unknown>;
    const id = String(raw.id ?? "");
    const force = typeof raw.force === "string" && raw.force ? raw.force : null;
    const evidence = typeof raw.evidence === "string" ? raw.evidence.slice(0, 500) : "";
    const m = await getMarket(b.db, id);
    if (!m) throw Object.assign(new Error(`no market ${id}`), { code: "NOT_FOUND" });
    const live = await lockIfPastClose(b.db, m);
    if (live.status !== "locked") {
      throw Object.assign(new Error(`market is ${live.status}; resolve needs a locked (past-close) market`), { code: "BAD_STATE" });
    }
    if (force) {
      if (!live.outcomes.includes(force)) throw Object.assign(new Error(`unknown outcome (pick: ${live.outcomes.join(", ")})`), { code: "BAD_PARAM" });
      const market = await recordVerdict(b.db, id, { winner: force, confidence: 1 });
      return { market: await marketView(b.db, id), forced: true, verdict: market.winning_outcome };
    }
    const verdict = await gradeEvidence(
      (state, questions) => jevDecideCall(state, questions as Record<string, JevQuestion>),
      live,
      evidence || undefined,
    );
    const market = await recordVerdict(b.db, id, verdict);
    return {
      market: await marketView(b.db, id),
      verdict: market.winning_outcome,
      confidence: market.verdict_confidence,
      voided: !market.winning_outcome,
    };
  },
  predictDispute: async (params) => {
    const b = needBackend();
    const raw = p(params) as Record<string, unknown>;
    const id = String(raw.id ?? "");
    const outcome = String(raw.outcome ?? "");
    const why = String(raw.why ?? "");
    const by = typeof raw.origin === "string" && raw.origin ? raw.origin : "predict";
    const market = await recordDispute(b.db, id, { by, winningOutcome: outcome, why });
    return { market: await marketView(b.db, id) };
  },
  predictSettle: async (params) => {
    const b = needBackend();
    const raw = p(params) as Record<string, unknown>;
    const id = String(raw.id ?? "");
    const origin = typeof raw.origin === "string" && raw.origin ? raw.origin : "predict";
    const now = Date.now();
    let m = await getMarket(b.db, id);
    if (!m) throw Object.assign(new Error(`no market ${id}`), { code: "NOT_FOUND" });
    m = await lockIfPastClose(b.db, m, now);
    if (m.status === "open" || m.status === "locked") {
      throw Object.assign(new Error("resolve first (predictResolve), then settle"), { code: "BAD_STATE" });
    }
    if (m.status === "settled") throw Object.assign(new Error("already settled"), { code: "BAD_STATE" });
    const bets = await getBets(b.db, id);
    // Disputed: one re-grade with the disputant's evidence, then settle.
    if (m.status === "disputed") {
      if (!m.dispute_why) throw Object.assign(new Error("dispute without evidence"), { code: "BAD_STATE" });
      const re = await gradeEvidence(
        (state, questions) => jevDecideCall(state, questions as Record<string, JevQuestion>),
        m,
        `DISPUTE by ${m.dispute_by}: ${m.dispute_why}`,
      );
      if (re.winner && re.winner !== m.winning_outcome && re.confidence >= PREDICT_CONF_THRESHOLD) {
        await recordVerdict(b.db, id, re, now);
        m = (await getMarket(b.db, id)) as typeof m;
      }
      // else: original verdict stands; fall through to payout below.
    }
    if (m.status === "void" || !m.winning_outcome) {
      if (bets.length === 0) {
        await recordSettlement(b.db, id, null, "void");
        return { market: await marketView(b.db, id), refunded: 0, txid: null };
      }
      const outs = splitVoid(bets).filter((o) => o.sats >= 546);
      const paid = await spendTo({
        db: b.db, chain: b.chain, origin,
        payments: outs.map((o) => ({ to: o.payout_address, sats: o.sats })),
        label: `predict void refund ${id}`,
        description: `prediction market ${id} voided (${m.winning_outcome ?? "no verdict"}); full refunds, no fee`,
      });
      await recordSettlement(b.db, id, paid.txid, "void" as const);
      return { market: await marketView(b.db, id), refunded: outs.reduce((s, o) => s + o.sats, 0), txid: paid.txid, fee: paid.fee };
    }
    // Resolving past the dispute window with no dispute: settle winners.
    if (m.status === "resolving") {
      if (!m.resolved_at || disputeWindowOpen(m.resolved_at, m.dispute_hours, now)) {
        throw Object.assign(new Error("dispute window still open (dispute or wait)"), { code: "BAD_STATE" });
      }
    }
    const { payouts, fee } = splitPool(bets, m.winning_outcome, m.fee_bps);
    const outs = payouts.filter((o) => o.sats >= 546);
    if (outs.length === 0) {
      await recordSettlement(b.db, id, null, "void");
      return { market: await marketView(b.db, id), refunded: 0, txid: null, note: "no payouts above dust; voided" };
    }
    const paid = await spendTo({
      db: b.db, chain: b.chain, origin,
      payments: outs.map((o) => ({ to: o.payout_address, sats: o.sats })),
      label: `predict settle ${id} -> ${m.winning_outcome}`,
      description: `prediction market ${id} settled: ${m.winning_outcome} wins (conf ${m.verdict_confidence})`,
    });
    await recordSettlement(b.db, id, paid.txid, "settled" as const);
    await announceSettlement(b.db, id, paid.txid).catch(() => null);
    return { market: await marketView(b.db, id), payouts: outs, fee, txid: paid.txid, settleFee: paid.fee };
  },
  predictCancel: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    const m = await getMarket(b.db, id);
    if (!m) throw Object.assign(new Error(`no market ${id}`), { code: "NOT_FOUND" });
    if (m.status !== "open") throw Object.assign(new Error("only open markets cancel (settle pays the rest)"), { code: "BAD_STATE" });
    await b.db("predict_markets").where({ id }).update({ status: "void", resolved_at: Date.now() });
    return { market: await marketView(b.db, id), note: "cancelled; run predictSettle for full refunds" };
  },
  predictPositions: async (params) => {
    const b = needBackend();
    const { origin } = p(params) as { origin?: unknown };
    if (typeof origin !== "string" || !origin) throw Object.assign(new Error("origin required"), { code: "BAD_PARAM" });
    return { positions: await positionsFor(b.db, origin) };
  },
  /* ── Federated bookmaker: markets other wallets can bet into ────── */
  predictAnnounce: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    const m = await getMarket(b.db, id);
    if (!m) throw Object.assign(new Error(`no market ${id}`), { code: "NOT_FOUND" });
    let board = await getBoard(b.db, PREDICT_BOARD).catch(() => null);
    if (!board) board = await createBoard(b.db, { name: PREDICT_BOARD, mode: "members" });
    let creator = m.creator_origin;
    try {
      creator = identityPubkeyHex();
    } catch { /* locked wallet: origin label it is */ }
    const text = `${PREDICT_MARKET_TAG} ${JSON.stringify(descriptorFor(m, selfAddress(), creator))}`;
    const sent = await boardPublish({ db: b.db } as ReturnType<typeof needBackend>, board, { text, kind: "predict", origin: m.creator_origin });
    await b.db("predict_remote").insert({
      market_id: id, role: "creator", board: PREDICT_BOARD, post_id: sent.id,
      descriptor: JSON.stringify(descriptorFor(m, selfAddress(), creator)),
      status: "open", created_at: Date.now(),
    }).onConflict("market_id").merge({ post_id: sent.id });
    return { postId: sent.id, board: PREDICT_BOARD };
  },
  predictRemoteMarkets: async () => {
    const b = needBackend();
    const board = await getBoard(b.db, PREDICT_BOARD).catch(() => null);
    if (!board) return { markets: [] };
    const res = await getPosts(b.db, board.name, { limit: 100 });
    const out = [];
    for (const post of res.posts ?? []) {
      const d = parseDescriptor(post.text ?? "");
      if (d) out.push({ descriptor: d, postId: post.id ?? null, from: post.from ?? null });
    }
    return { markets: out };
  },
  predictBetRemote: async (params) => {
    const b = needBackend();
    const raw = p(params) as Record<string, unknown>;
    const pool = String(raw.pool ?? "");
    const marketId = String(raw.market ?? raw.id ?? "");
    const outcome = String(raw.outcome ?? "");
    const sats = Math.floor(Number(raw.sats) || 0);
    const origin = typeof raw.origin === "string" && raw.origin ? raw.origin : "predict";
    const payout = String(raw.payout ?? "");
    const trustOk = raw.trustOk === true;
    if (!pool || !marketId || !outcome || !(sats >= PREDICT_MIN_BET_SATS)) {
      throw Object.assign(new Error("pool, market, outcome and sats≥1000 required"), { code: "BAD_PARAM" });
    }
    if (!trustOk) {
      throw Object.assign(new Error("remote bookmaker: verify the creator's Trust profile first (bsv trust), then pass trustOk"), { code: "TRUST_REQUIRED" });
    }
    const to = payout || selfAddress();
    const paid = await spendTo({
      db: b.db, chain: b.chain, origin,
      payments: [{ to: pool, sats }],
      memo: betMemo(marketId, outcome, to),
      label: `predict remote bet ${sats} on ${outcome} (${marketId})`,
      description: `remote prediction bet: ${sats} sats on ${outcome} to bookmaker ${pool.slice(0, 12)}`,
    });
    await b.db("predict_remote").insert({
      market_id: marketId, role: "bettor", board: PREDICT_BOARD, post_id: null,
      descriptor: JSON.stringify({ pool_address: pool, outcome, sats, payout: to }),
      status: "open", created_at: Date.now(),
    }).onConflict("market_id").merge({ status: "open" });
    await recordBet(b.db, {
      market_id: marketId, origin: `${origin}:remote`, payout_address: to, outcome, sats, txid: paid.txid,
    }).catch(() => null);
    return { txid: paid.txid, fee: paid.fee, market: marketId, outcome, sats };
  },
  predictSyncIn: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    const m = await getMarket(b.db, id);
    if (!m) throw Object.assign(new Error(`no market ${id}`), { code: "NOT_FOUND" });
    const poolHex = p2pkhScript(selfAddress()).toHex();
    const u = await b.chain.utxos(selfAddress());
    const credited = [];
    const skipped = [];
    for (const x of (u.utxos ?? []).slice(0, 30)) {
      const known = await b.db("predict_bets").where({ txid: String(x.txid).toLowerCase() }).first();
      if (known) continue;
      let hex = "";
      try {
        const r = await fetch(`${WOC_TX}/${x.txid}/hex`);
        if (!r.ok) continue;
        hex = (await r.text()).trim();
      } catch {
        continue;
      }
      let outputs: { scriptHex: string; sats: number }[] = [];
      try {
        const tx = Transaction.fromHex(hex);
        outputs = (tx.outputs ?? []).map((o) => ({
          scriptHex: o.lockingScript?.toHex?.() ?? "",
          sats: Number(o.satoshis ?? 0),
        }));
      } catch {
        continue;
      }
      const r = await creditScannedBet(b.db, m, String(x.txid), outputs, poolHex);
      if (r.bet) credited.push({ txid: x.txid, outcome: r.bet.outcome, sats: r.bet.sats });
      else skipped.push({ txid: String(x.txid).slice(0, 12), reason: r.reason });
    }
    return { market: id, credited, skipped };
  },
  predictCredit: async (params) => {
    const b = needBackend();
    const { id, txid } = p(params) as { id?: unknown; txid?: unknown };
    if (typeof id !== "string" || !id || typeof txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw Object.assign(new Error("id and 64-hex txid required"), { code: "BAD_PARAM" });
    }
    const m = await getMarket(b.db, id);
    if (!m) throw Object.assign(new Error(`no market ${id}`), { code: "NOT_FOUND" });
    const poolHex = p2pkhScript(selfAddress()).toHex();
    const r = await fetch(`${WOC_TX}/${txid}/hex`);
    if (!r.ok) throw Object.assign(new Error("tx fetch failed"), { code: "RAILS" });
    const tx = Transaction.fromHex((await r.text()).trim());
    const outputs = (tx.outputs ?? []).map((o) => ({
      scriptHex: o.lockingScript?.toHex?.() ?? "",
      sats: Number(o.satoshis ?? 0),
    }));
    const res = await creditScannedBet(b.db, m, txid, outputs, poolHex);
    if (!res.bet) throw Object.assign(new Error(`not credited: ${res.reason}`), { code: "BAD_STATE" });
    return { bet: res.bet };
  },
  predictSyncRemote: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    const row = await b.db("predict_remote").where({ market_id: id, role: "bettor" }).first();
    if (!row) throw Object.assign(new Error(`no remote bet tracked for ${id}`), { code: "NOT_FOUND" });
    const board = await getBoard(b.db, PREDICT_BOARD).catch(() => null);
    if (!board) return { market: id, status: (row as Record<string, unknown>).status, note: "no predict board" };
    const res = await getPosts(b.db, board.name, { limit: 200 });
    for (const post of res.posts ?? []) {
      const text = post.text ?? "";
      const mm = text.match(/PREDICT-SETTLE\s+(\S+)\s+([0-9a-fA-F]{64})/);
      if (mm && mm[1] === id) {
        await b.db("predict_remote").where({ market_id: id }).update({ status: "settled", settle_txid: mm[2].toLowerCase() });
        return { market: id, status: "settled", settleTxid: mm[2].toLowerCase() };
      }
    }
    return { market: id, status: (row as Record<string, unknown>).status };
  },
  /** Post a request and block for its first reply: the agent ask primitive. */
  boardAsk: async (params) => {
    const b = needBackend();
    const { board, text, to, waitMs, kind, refs, agent, origin } = p(params) as {
      board?: unknown; text?: unknown; to?: unknown; waitMs?: unknown; kind?: unknown; refs?: unknown; agent?: unknown; origin?: unknown;
    };
    const row = await getBoard(b.db, String(board ?? ""));
    if (!row) throw Object.assign(new Error(`no board ${String(board ?? "")}`), { code: "NOT_FOUND" });
    const mentions = Array.isArray(refs) ? refs.map((r) => String(r)) : [];
    if (typeof to === "string" && to) mentions.push(`agent:${to.replace(/^@/, "")}`);
    const sent = await boardPublish(b, row, { text, kind: kind ?? "request", refs: mentions, agent, origin });
    const env = await waitForPost({
      board: row.name,
      timeoutMs: Math.floor(Number(waitMs) || 30_000),
      matches: async (e) => {
        const content = await postContent(b.db, row.name, e);
        return Boolean(content && content.replyTo === sent.id);
      },
    });
    if (!env) return { postId: sent.id, timeout: true, reply: null };
    await ingestPost(b.db, env).catch(() => null);
    const posts = await getPosts(b.db, row.name, { limit: 500, markRead: false });
    return { postId: sent.id, timeout: false, reply: posts.posts.find((x) => x.id === env.id) ?? null };
  },
  /**
   * Agent memory on the shared board + UsenetBSV. Private posts are signed
   * and encrypted board artifacts; public posts are x402-paid usenet
   * articles in the shared group, idempotent per content hash. Dry-run is
   * the default; live writes need `live: true`.
   */
  memoryRemember: async (params) => {
    const b = needBackend();
    const { text, tag, visibility, live, agent, origin } = p(params) as {
      text?: unknown; tag?: unknown; visibility?: unknown; live?: unknown; agent?: unknown; origin?: unknown;
    };
    const clean = normalizeMemoryText(text);
    if (!clean) throw Object.assign(new Error("text required"), { code: "BAD_PARAM" });
    const ctag = cleanTag(tag);
    const hash = contentHash(clean);
    const vis = visibility === "public" ? "public" : "private";
    let row = await getBoard(b.db, MEMORY_BOARD);
    if (!row) row = await createBoard(b.db, { name: MEMORY_BOARD, mode: "members" });
    const known = await getPosts(b.db, MEMORY_BOARD, { limit: 500, markRead: false });
    const dup = known.posts.find((x) => x.refs.includes(`sha256:${hash}`) && x.refs.includes("#memory"));
    if (dup) return { duplicate: true, hash, id: dup.id, board: MEMORY_BOARD, visibility: vis };
    const refs = memoryRefs(hash, ctag);
    if (live !== true) {
      return { dryRun: true, hash, board: MEMORY_BOARD, visibility: vis, refs, tag: ctag, text: clean };
    }
    const originStr = typeof origin === "string" && origin ? origin : "memory";
    if (vis === "private") {
      const sent = await boardPublish(b, row, { text: clean, kind: "artifact", refs, agent, origin: originStr });
      return { duplicate: false, hash, id: sent.id, board: MEMORY_BOARD, visibility: vis, tag: ctag };
    }
    const payload = usenetPayload(clean, ctag, hash);
    const paid = await x402Pay({
      db: b.db, chain: b.chain,
      url: `${USENET_BASE}/api/groups/${USENET_GROUP}/post`,
      method: "POST", body: payload, origin: originStr,
    });
    const article = (paid.data ?? {}) as { id?: unknown; messageId?: unknown; createdTx?: unknown };
    return {
      duplicate: false, hash, board: MEMORY_BOARD, visibility: vis, tag: ctag,
      articleId: typeof article.id === "string" ? article.id : null,
      createdTx: typeof article.createdTx === "string" ? article.createdTx : null,
      txid: paid.receipt?.txid ?? null,
    };
  },
  memoryRecall: async (params) => {
    const b = needBackend();
    const { query, tag, limit, includePublic } = p(params) as {
      query?: unknown; tag?: unknown; limit?: unknown; includePublic?: unknown;
    };
    return recallMemories(b.db, fetch, {
      ...(typeof query === "string" ? { query } : {}),
      ...(typeof tag === "string" ? { tag } : {}),
      ...(Number.isFinite(Number(limit)) ? { limit: Number(limit) } : {}),
      ...(includePublic === true ? { includePublic: true as const } : {}),
    });
  },
  memoryForget: async (params) => {
    const b = needBackend();
    const { id, agent, origin } = p(params) as { id?: unknown; agent?: unknown; origin?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    const row = await getBoard(b.db, MEMORY_BOARD);
    if (!row) throw Object.assign(new Error("no memory board yet"), { code: "NOT_FOUND" });
    const known = await getPosts(b.db, MEMORY_BOARD, { limit: 500, markRead: false });
    const target = known.posts.find((x) => x.id === id);
    if (!target) throw Object.assign(new Error(`no memory ${id}`), { code: "NOT_FOUND" });
    const hash = refHash(target.refs);
    if (!hash) throw Object.assign(new Error("not a memory post"), { code: "BAD_PARAM" });
    const struck = known.posts.some((x) => x.refs.includes("#memory-forget") && x.replyTo === id);
    if (struck) return { forgotten: true, duplicate: true, id, hash };
    const originStr = typeof origin === "string" && origin ? origin : "memory";
    const sent = await boardPublish(b, row, {
      text: `forget ${id}`, kind: "artifact", refs: forgetRefs(hash), replyTo: id, agent, origin: originStr,
    });
    return { forgotten: true, duplicate: false, id, hash, tombstone: sent.id };
  },
  /** Ensure the shared board exists; dry-run the usenet group create unless live. */
  memoryInit: async (params) => {
    const b = needBackend();
    const { live, payTo, origin } = p(params) as { live?: unknown; payTo?: unknown; origin?: unknown };
    let row = await getBoard(b.db, MEMORY_BOARD);
    if (!row) row = await createBoard(b.db, { name: MEMORY_BOARD, mode: "members" });
    const to = typeof payTo === "string" && payTo ? payTo : selfAddress();
    const payload = {
      name: USENET_GROUP,
      description: "Shared agent memory for bsvOS wallets: content-hash idempotent public memories.",
      postPriceSats: 20,
      readPriceDefault: 0,
      payTo: to,
    };
    if (live !== true) {
      return { board: row.name, group: USENET_GROUP, dryRun: true, payload, createPriceSats: 500 };
    }
    const originStr = typeof origin === "string" && origin ? origin : "memory";
    const paid = await x402Pay({
      db: b.db, chain: b.chain, url: `${USENET_BASE}/api/groups`,
      method: "POST", body: payload, origin: originStr,
    });
    return { board: row.name, group: USENET_GROUP, dryRun: false, txid: paid.receipt?.txid ?? null, data: paid.data };
  },
  /**
   * Sats-streaming for agent compute. streamStart opens a per-minute flow
   * to a worker address; the minutely ticker pays rate × elapsed while
   * fresh `stream:<id>` heartbeats land on the board, auto-pauses on
   * staleness, and closes at the cap. Ticks below the pay floor accrue.
   * Origin `stream` pays — approve with `bsv allow stream <cap>`.
   */
  streamStart: async (params) => {
    const b = needBackend();
    const { name, payee, rate, every, max, board, agent } = p(params) as {
      name?: unknown; payee?: unknown; rate?: unknown; every?: unknown;
      max?: unknown; board?: unknown; agent?: unknown;
    };
    const row = await getBoard(b.db, String(board ?? ""));
    if (!row) throw Object.assign(new Error(`no board ${String(board ?? "")}`), { code: "NOT_FOUND" });
    const created = await createStream(b.db, {
      name: typeof name === "string" ? name : "",
      payee: typeof payee === "string" ? payee : "",
      ratePerMin: Math.floor(Number(rate) || 0),
      every: every ?? "5m",
      maxTotal: Math.floor(Number(max) || 0),
      board: row.name,
    });
    void agent;
    return {
      ...created,
      origin: "stream",
      approve: "bsv allow stream <cap sats>",
      warn: created.feeShare > 0.2 ? `fee share ~${Math.round(created.feeShare * 100)}% per tick — raise the rate or lengthen the interval` : null,
    };
  },
  streamList: async () => {
    const b = needBackend();
    return { streams: await listStreams(b.db) };
  },
  /**
   * Sign a claim that this wallet holds at least `minSats`, bound to a Merkle
   * commitment over the spendable UTXO set, with an expiry. The daemon
   * refuses to sign above the total it can see. The published object omits
   * the balance and UTXO count on purpose. `bsv funds attest`.
   */
  fundsAttest: async (params) => {
    const b = needBackend();
    const { minSats, validFor, anchor } = p(params) as { minSats?: unknown; validFor?: unknown; anchor?: unknown };
    const ms = typeof validFor === "string" ? parseDurationMs(validFor) : Math.floor(Number(validFor) || 0) * 1000;
    const att = await createFundsAttestation({ db: b.db, chain: b.chain }, { minSats: Number(minSats), validForMs: ms });
    const id = await recordFundsAttestation(b.db, att);
    let anchorTxid: string | null = null;
    if (anchor === true) {
      // Public timestamp: the statement hash in an OP_RETURN, policy-gated.
      const digest = sha256hex(canonicalStatement(att.statement));
      const res = await anchorTip({ db: b.db, chain: b.chain, origin: "funds", sha256: digest, label: "FUNDS-ATTEST" });
      anchorTxid = res.txid;
      await b.db("funds_attestations").where({ id }).update({ anchor_txid: anchorTxid });
    }
    return { id, ...att, anchorTxid };
  },
  /**
   * Verify someone else's claim (or your own). Reports every check by name,
   * and says what the object does and does not reveal. `bsv funds verify`.
   */
  fundsVerify: async (params) => {
    const { attestation, minSats } = p(params) as { attestation?: unknown; minSats?: unknown };
    if (attestation === undefined || attestation === null) {
      throw Object.assign(new Error("attestation required (an object, or JSON text)") , { code: "BAD_PARAM" });
    }
    const parsed = typeof attestation === "string" ? JSON.parse(attestation) : attestation;
    const res = verifyFundsAttestation(parsed);
    const claimed = Number((parsed as { statement?: { minSats?: unknown } })?.statement?.minSats) || 0;
    if (Number(minSats) > 0) {
      res.checks.push({
        name: "sufficient",
        ok: claimed >= Number(minSats),
        detail: `caller wanted >= ${Number(minSats)} sats, claim says ${claimed}`,
      });
      res.ok = res.ok && res.checks[res.checks.length - 1]!.ok;
    }
    return res;
  },
  /** Disclose one UTXO as a Merkle inclusion proof against an attestation. */
  fundsProve: async (params) => {
    const b = needBackend();
    const { attestation, outpoint } = p(params) as { attestation?: unknown; outpoint?: unknown };
    if (typeof outpoint !== "string" || !outpoint) {
      throw Object.assign(new Error("outpoint required (txid_vout)"), { code: "BAD_PARAM" });
    }
    const statement = (typeof attestation === "string" ? JSON.parse(attestation) : attestation) as { statement?: FundsStatement };
    if (!statement?.statement?.root) {
      throw Object.assign(new Error("attestation with a statement.root is required"), { code: "BAD_PARAM" });
    }
    return await proveFundsUtxo({ db: b.db, chain: b.chain }, statement.statement, outpoint);
  },
  fundsList: async (params) => {
    const b = needBackend();
    const { limit } = p(params) as { limit?: unknown };
    return { attestations: await listFundsAttestations(b.db, Number(limit) || 20) };
  },
  /**
   * Every timed commitment in one place: sats streams, cast pay-per-minute
   * sessions, and time capsules, with caps, paid totals, and the condition
   * that releases each one. `bsv commitments` / `commitment_list`.
   */
  commitmentList: async () => {
    const b = needBackend();
    const commitments = await listCommitments(b.db);
    return { commitments, exposure: commitmentExposure(commitments) };
  },
  streamStop: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return setStreamStatus(b.db, id, "done");
  },
  streamPause: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return setStreamStatus(b.db, id, "paused");
  },
  streamResume: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    const s = await getStream(b.db, id);
    if (s.status === "done") throw Object.assign(new Error("closed streams stay closed"), { code: "BAD_STATE" });
    const row = await setStreamStatus(b.db, id, "active");
    await b.db("streams").where({ id }).update({ next_due: Date.now() + row.tickSecs * 1000, last_paid_at: Date.now() });
    return getStream(b.db, id);
  },
  streamTicks: async (params) => {
    const b = needBackend();
    const { id, limit } = p(params) as { id?: unknown; limit?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    await getStream(b.db, id);
    return { ticks: await listTicks(b.db, id, Number.isFinite(Number(limit)) ? Number(limit) : 50) };
  },
  /** Worker side: post a heartbeat proof to the stream's board. */
  streamBeat: async (params) => {
    const b = needBackend();
    const { id, text, agent, origin } = p(params) as { id?: unknown; text?: unknown; agent?: unknown; origin?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    const s = await getStream(b.db, id);
    if (s.status === "done") throw Object.assign(new Error("stream is closed"), { code: "BAD_STATE" });
    const row = await getBoard(b.db, s.board);
    if (!row) throw Object.assign(new Error(`no board ${s.board}`), { code: "NOT_FOUND" });
    return boardPublish(b, row, {
      text: typeof text === "string" && text.trim() ? text : `beat for ${s.id}`,
      kind: "artifact", refs: [streamBeatRef(s.id)], agent, origin,
    });
  },
  /**
   * Prompt evolution market. The sponsor (this wallet) posts a task +
   * rubric + per-round prize; agents submit (prompt, output) entries to the
   * shared open board and pay the entry fee on-chain. At round close Jev
   * scores entries blind and the winner is paid from the sponsor budget
   * through policy (origin `evolve`).
   */
  evolveCreate: async (params) => {
    const b = needBackend();
    const { task, rubric, prize, rounds, entryFee, round } = p(params) as {
      task?: unknown; rubric?: unknown; prize?: unknown; rounds?: unknown; entryFee?: unknown; round?: unknown;
    };
    let board = await getBoard(b.db, EVOLVE_BOARD);
    if (!board) board = await createBoard(b.db, { name: EVOLVE_BOARD, mode: "open" });
    const c = await createContest(b.db, {
      task: typeof task === "string" ? task : "",
      rubric: typeof rubric === "string" ? rubric : "",
      prize: Number(prize) || 0,
      rounds: Number(rounds) || 1,
      entryFee: Number(entryFee) || 0,
      sponsor: selfAddress(),
      round: round ?? "1h",
    });
    await boardPublish(b, board, {
      text: `contest ${c.id}: ${c.task}`,
      kind: "artifact",
      refs: [contestRef(c.id), "contest", `prize:${c.prize}`, `rounds:${c.rounds}`, `fee:${c.entryFee}`],
    });
    return { ...c, board: board.name, origin: "evolve", approve: `bsv allow evolve <cap sats, at least ${c.prize * c.rounds} + fees>` };
  },
  evolveList: async () => {
    const b = needBackend();
    return { contests: await listContests(b.db) };
  },
  evolveSubmit: async (params) => {
    const b = needBackend();
    const { contest, round, text, payTo, parent, feeTxid, payNow, agent, origin } = p(params) as {
      contest?: unknown; round?: unknown; text?: unknown; payTo?: unknown;
      parent?: unknown; feeTxid?: unknown; payNow?: unknown; agent?: unknown; origin?: unknown;
    };
    const c = await getContest(b.db, String(contest ?? ""));
    if (typeof payTo !== "string" || !payTo) throw Object.assign(new Error("payTo (winner payout address) required"), { code: "BAD_PARAM" });
    const { output } = splitEntry(typeof text === "string" ? text : "");
    if (!output) throw Object.assign(new Error("entry output required (use ---OUTPUT--- to separate prompt from output)"), { code: "BAD_PARAM" });
    const originStr = typeof origin === "string" && origin ? origin : "evolve";
    let feeOutpoint: string | null = null;
    if (c.entryFee > 0) {
      if (payNow === true) {
        const paid = await spendTo({
          db: b.db, chain: b.chain, origin: originStr,
          payments: [{ to: c.sponsor, sats: c.entryFee }],
          memo: ["EVOLVE-ENTRY", c.id],
          label: `evolve entry fee ${c.id}`,
          description: `evolution market entry fee ${c.entryFee} sats for contest ${c.id}`,
        });
        feeOutpoint = paid.txid;
      } else if (typeof feeTxid === "string" && feeTxid) {
        // Remote wallet paid itself: claim an exact-fee UTXO at the sponsor
        // address that no other entry has claimed. Attribution is by amount
        // + memo convention, not cryptographic — stated limit of v1.
        const u = await b.chain.utxos(c.sponsor);
        const claimed = new Set(
          ((await b.db("evolve_entries").where({ contest: c.id }).select("fee_outpoint")) as Array<{ fee_outpoint: string | null }>)
            .map((r) => r.fee_outpoint).filter((x): x is string => !!x),
        );
        const hit = u.utxos.find((x) => x.value === c.entryFee && !claimed.has(`${x.txid}:${x.vout}`) && !claimed.has(x.txid));
        if (!hit) throw Object.assign(new Error("no unclaimed exact-fee UTXO at the sponsor address — pay the entry fee first"), { code: "BAD_STATE" });
        feeOutpoint = `${hit.txid}:${hit.vout}`;
      } else {
        throw Object.assign(new Error("entry fee required: payNow true or feeTxid of your payment"), { code: "BAD_PARAM" });
      }
    }
    const row = await getBoard(b.db, EVOLVE_BOARD);
    if (!row) throw Object.assign(new Error("no evolve board"), { code: "NOT_FOUND" });
    const entry = await recordEntry(b.db, {
      contest: c.id,
      round: Math.floor(Number(round) || 1),
      author: identityPubkeyHex(),
      agent: typeof agent === "string" && agent ? agent : "cli",
      output,
      ...(parent !== undefined && parent !== null && parent !== "" ? { parent: Math.floor(Number(parent)) } : {}),
      payTo,
      ...(feeOutpoint ? { feeOutpoint } : {}),
    });
    const posted = await boardPublish(b, row, {
      text: typeof text === "string" ? text : output,
      kind: "artifact",
      refs: [contestRef(c.id), `round:${entry.round}`, "entry", ...(entry.parent !== null ? [`parent:${entry.parent}`] : [])],
      agent, origin: originStr,
    });
    await b.db("evolve_entries").where({ id: entry.id }).update({ board_post_id: posted.id });
    return { ...entry, boardPostId: posted.id, boardPost: posted.id };
  },
  evolveEntries: async (params) => {
    const b = needBackend();
    const { contest, round } = p(params) as { contest?: unknown; round?: unknown };
    await getContest(b.db, String(contest ?? ""));
    const all = await roundEntries(b.db, String(contest ?? ""), Math.floor(Number(round) || 1));
    return { entries: all.map((e) => ({ ...e, output: e.output.slice(0, 500) })) };
  },
  evolveScore: async (params) => {
    const b = needBackend();
    const { contest, round } = p(params) as { contest?: unknown; round?: unknown };
    const c = await getContest(b.db, String(contest ?? ""));
    const n = Math.floor(Number(round) || 1);
    const { winner, ranking } = await judgeRound(b.db, c.id, n, async (output) => {
      const r = await jevDecideCall(
        { task: c.task, rubric: c.rubric, output },
        { quality: { type: "score", instructions: "Score this contest entry output against the rubric. Judge the output only.", criteria: SCORE_LEVELS } },
        {},
      );
      const a = r.answers.quality;
      return { score: Math.floor(Number(a?.score) || 0), confidence: Number(a?.confidence) || 0 };
    });
    const row = await getBoard(b.db, EVOLVE_BOARD);
    if (row) {
      await boardPublish(b, row, {
        text: `results ${c.id} round ${n}: winner entry #${winner.id} (${SCORE_LEVELS[winner.score ?? 0]}, conf ${(winner.confidence ?? 0).toFixed(2)}) over ${ranking.length} entries`,
        kind: "result",
        refs: [contestRef(c.id), `round:${n}`, "results", `winner:${winner.id}`],
      });
    }
    return { winner, ranking: ranking.map((e) => ({ id: e.id, score: e.score, confidence: e.confidence, author: e.author.slice(0, 16) })) };
  },
  evolvePayout: async (params) => {
    const b = needBackend();
    const { contest, round, origin } = p(params) as { contest?: unknown; round?: unknown; origin?: unknown };
    const c = await getContest(b.db, String(contest ?? ""));
    const n = Math.floor(Number(round) || 1);
    const entries = await roundEntries(b.db, c.id, n);
    const scored = entries.filter((e) => e.score !== null).sort((a, b2) =>
      (b2.score ?? -1) - (a.score ?? -1) || (b2.confidence ?? -1) - (a.confidence ?? -1) || a.createdAt - b2.createdAt,
    );
    if (!scored.length) throw Object.assign(new Error("round has no scored entries — run evolveScore first"), { code: "BAD_STATE" });
    const winner = scored[0]!;
    const originStr = typeof origin === "string" && origin ? origin : "evolve";
    const r = await spendTo({
      db: b.db, chain: b.chain, origin: originStr,
      payments: [{ to: winner.payTo, sats: c.prize }],
      memo: ["EVOLVE-PRIZE", c.id, `round:${n}`, `entry:${winner.id}`],
      label: `evolve prize ${c.id} round ${n}`,
      description: `evolution market prize ${c.prize} sats to round ${n} winner (entry ${winner.id})`,
    });
    if (n >= c.rounds) await b.db("evolve_contests").where({ id: c.id }).update({ status: "closed" });
    return { txid: r.txid, fee: r.fee, winner: winner.id, payTo: winner.payTo, prize: c.prize };
  },
  evolveClose: async (params) => {
    const b = needBackend();
    const { contest } = p(params) as { contest?: unknown };
    await getContest(b.db, String(contest ?? ""));
    await b.db("evolve_contests").where({ id: String(contest) }).update({ status: "closed" });
    return { closed: String(contest) };
  },
  /**
   * Time capsules: consensus-enforced timelock (CLTV) + public note.
   * Lock pays into the capsule script through policy (origin `capsule`);
   * claim spends it back once the tip passes the locktime.
   */
  capsuleLock: async (params) => {
    const b = needBackend();
    const { amount, unlockAt, to, message } = p(params) as {
      amount?: unknown; unlockAt?: unknown; to?: unknown; message?: unknown;
    };
    if (typeof unlockAt !== "string" || !unlockAt) throw Object.assign(new Error("unlockAt required: height, ISO date, or +blocks"), { code: "BAD_PARAM" });
    return lockCapsule({ db: b.db, chain: b.chain }, {
      amount: Math.floor(Number(amount) || 0),
      unlockAt,
      ...(typeof to === "string" && to ? { to } : {}),
      ...(typeof message === "string" && message ? { message } : {}),
    });
  },
  capsuleList: async (params) => {
    const b = needBackend();
    const { tip } = p(params) as { tip?: unknown };
    const caps = await listCapsules(b.db);
    if (tip === false) return { capsules: caps };
    let t = null;
    try {
      t = await fetchChainTip();
    } catch {
      t = null;
    }
    return {
      capsules: caps.map((c) => ({ ...c, ...(t ? { remaining: remaining(c, t) } : {}) })),
      ...(t ? { tip: t } : { tipUnvailable: true }),
    };
  },
  capsuleClaim: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return claimCapsule({ db: b.db, chain: b.chain }, id);
  },
  capsuleCancel: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return cancelCapsule(b.db, id);
  },
  /**
   * Value-for-value creator streaming. Episodes carry value splits;
   * play opens one sats-stream per recipient and the minutely loop posts
   * playback beats while the session is open. v1 trusts the stop button.
   */
  castAdd: async (params) => {
    const b = needBackend();
    const { title, feed, media, live, splits } = p(params) as { title?: unknown; feed?: unknown; media?: unknown; live?: unknown; splits?: unknown };
    const { p2pkhScript } = await import("./tx.ts");
    const parsed = parseSplits(splits, (a) => {
      try {
        p2pkhScript(a);
        return true;
      } catch {
        return false;
      }
    });
    return addEpisode(b.db, {
      title: typeof title === "string" ? title : "",
      ...(typeof feed === "string" ? { feed } : {}),
      ...(typeof media === "string" ? { mediaUrl: media } : {}),
      ...(live === true ? { live: true as const } : {}),
      splits: parsed,
    });
  },
  castEpisodes: async () => {
    const b = needBackend();
    return { episodes: await listEpisodes(b.db) };
  },
  castPlay: async (params) => {
    const b = needBackend();
    const { episode, rate, every, max, agent, origin } = p(params) as {
      episode?: unknown; rate?: unknown; every?: unknown; max?: unknown; agent?: unknown; origin?: unknown;
    };
    if (typeof episode !== "string" || !episode) throw Object.assign(new Error("episode required"), { code: "BAD_PARAM" });
    let board = await getBoard(b.db, CAST_BOARD);
    if (!board) board = await createBoard(b.db, { name: CAST_BOARD, mode: "members" });
    void board;
    const session = await startSession(b.db, { createStream }, {
      episode,
      ratePerMin: Math.floor(Number(rate) || 0),
      every: every ?? "5m",
      maxTotal: Math.floor(Number(max) || 0),
      tickSecs: (e) => Math.floor(parseTick(e) / 1000),
    });
    void agent;
    void origin;
    return { ...session, board: CAST_BOARD, approve: "bsv allow stream <cap sats>" };
  },
  castStop: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return stopSession(b.db, id);
  },
  castList: async () => {
    const b = needBackend();
    return { sessions: await listSessions(b.db) };
  },
  castLiveStart: async (params) => {
    const b = needBackend();
    const { episode } = p(params) as { episode?: unknown };
    if (typeof episode !== "string" || !episode) throw Object.assign(new Error("episode required"), { code: "BAD_PARAM" });
    const live = await startLive(b.db, episode);
    return { ...live, playlist: `/cast/live/${live.id}/index.m3u8` };
  },
  castLiveStop: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return endLive(b.db, id);
  },
  castLiveList: async () => {
    const b = needBackend();
    return { live: await listLive(b.db) };
  },
  castLiveGet: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("id required"), { code: "BAD_PARAM" });
    return getLive(b.db, id);
  },
  castSetMedia: async (params) => {
    const b = needBackend();
    const { episode, mediaUrl } = p(params) as { episode?: unknown; mediaUrl?: unknown };
    if (typeof episode !== "string" || !episode) throw Object.assign(new Error("episode required"), { code: "BAD_PARAM" });
    const url = typeof mediaUrl === "string" ? mediaUrl.trim().slice(0, 500) : "";
    if (url && !/^https?:\/\//i.test(url) && !url.startsWith("/")) {
      throw Object.assign(new Error("media must be an http(s) URL or site path"), { code: "BAD_PARAM" });
    }
    const row = await b.db("cast_episodes").where({ id: episode }).first();
    if (!row) throw Object.assign(new Error(`no episode ${episode}`), { code: "NOT_FOUND" });
    await b.db("cast_episodes").where({ id: episode }).update({ media_url: url });
    return { episode, mediaUrl: url };
  },
  /** x402 seller surface: price list, repricing, sales ledger, self-heal status. */
  serveMenu: async () => {
    const b = needBackend();
    return { menu: await serveMenu(b.db) };
  },
  serveStatus: async () => {
    const b = needBackend();
    return serveStatus(b.db);
  },
  serveCheck: async () => {
    const b = needBackend();
    return checkSellerSurface(b.db);
  },
  servePrice: async (params) => {
    const b = needBackend();
    const { method, price } = p(params) as { method?: unknown; price?: unknown };
    if (typeof method !== "string" || !method) throw Object.assign(new Error("method required"), { code: "BAD_PARAM" });
    if (price === undefined) {
      const menu = await serveMenu(b.db);
      const item = menu.find((m) => m.method === method);
      if (!item) throw Object.assign(new Error(`not for sale: ${method}`), { code: "NOT_FOUND" });
      return item;
    }
    return serveSetPrice(b.db, method, Number(price));
  },
  serveSales: async (params) => {
    const b = needBackend();
    const { limit } = p(params) as { limit?: unknown };
    return { sales: await serveSales(b.db, Number.isFinite(Number(limit)) ? Number(limit) : 50) };
  },
  /**
   * Sign an arbitrary short message with the wallet identity key (BSM).
   * Public verifiers can check it with only the identity key; used for
   * proofs like adfeed's raised-limit claims. Length-capped so it cannot
   * become a general document-signing oracle.
   */
  signMessage: async (params) => {
    const { message } = p(params) as { message?: unknown };
    if (typeof message !== "string" || !message.trim()) {
      throw Object.assign(new Error("message required"), { code: "BAD_PARAM" });
    }
    if (message.length > 1000) throw Object.assign(new Error("message too long (max 1000 chars)"), { code: "BAD_PARAM" });
    return {
      identityKey: identityPubkeyHex(),
      signature: identitySignMessage(message),
      note: "BSM signature by the wallet identity key",
    };
  },
  /** The inscribed receipt NFT, decoded and signature-checked, for the panel. */
  receiptShow: async (params) => {
    const b = needBackend();
    const { id } = p(params) as { id?: unknown };
    if (typeof id !== "string" || !id) throw Object.assign(new Error("receipt id required"), { code: "BAD_PARAM" });
    const row = await getReceipt(b.db, id);
    if (!row) throw Object.assign(new Error(`no receipt ${id}`), { code: "NOT_FOUND" });
    return receiptDetail(row);
  },
  /**
   * F10 social recovery. Setup/rotate need the wallet unlocked and print
   * shares EXACTLY once (never stored). Restore combines cards on-device
   * and refuses superseded or foreign sets when local metadata exists.
   */
  recoverySetup: async (params) => {
    const b = needBackend();
    const { need, guardians } = p(params) as { need?: unknown; guardians?: unknown };
    if (!Array.isArray(guardians)) throw Object.assign(new Error("guardians required"), { code: "BAD_PARAM" });
    const entropy = await exportEntropy();
    const out = splitFor(entropy, Math.floor(Number(need) || 0), guardians);
    await recordSet(b.db, {
      setId: out.setId, need: out.need, total: out.total, fingerprint: out.fingerprint,
      guardians: out.cards.map((c) => c.guardian),
    });
    await supersedeSets(b.db, out.setId);
    return {
      setId: out.setId, need: out.need, total: out.total,
      fingerprint: out.fingerprint,
      cards: out.cards.map((c) => ({ guardian: c.guardian.name, card: c.card })),
      warning: "BACK UP each guardian card NOW — shares are shown once and never stored anywhere",
    };
  },
  recoveryStatus: async () => {
    const b = needBackend();
    const sets = await listSets(b.db);
    return { sets, protected: sets.some((s) => s.superseded === 0) };
  },
  recoveryRestore: async (params) => {
    const b = needBackend();
    const { cards, force } = p(params) as { cards?: unknown; force?: unknown };
    if (!Array.isArray(cards)) throw Object.assign(new Error("cards required"), { code: "BAD_PARAM" });
    const { entropy, setId, need, total } = combineCards(cards as string[]);
    // Rotation kills old cards: if this device knows sets, the fingerprint
    // must belong to a live one. Fresh devices (no sets) trust the cards'
    // own verified fingerprint.
    const known = await listSets(b.db);
    // Rotation re-splits the SAME seed (same fingerprint, new set id), so
    // the liveness check matches set ids: old cards die on rotate.
    if (known.length > 0 && !known.some((s) => s.superseded === 0 && s.setId === setId)) {
      throw Object.assign(new Error("unknown or superseded set — rotate first, then use new cards"), { code: "BAD_CARD" });
    }
    return restoreFromEntropy(entropy, force === true).then((r) => ({ ...r, setId, need, total }));
  },
  recoveryRotate: async (params) => {
    const b = needBackend();
    const { need, guardians } = p(params) as { need?: unknown; guardians?: unknown };
    const active = (await listSets(b.db)).find((s) => s.superseded === 0);
    const entropy = await exportEntropy();
    const useGuardians = Array.isArray(guardians)
      ? guardians
      : active
        ? active.guardians
        : null;
    if (!useGuardians) throw Object.assign(new Error("guardians required (no active set)"), { code: "BAD_PARAM" });
    const useNeed = need !== undefined ? Math.floor(Number(need) || 0) : active?.need ?? 0;
    const out = splitFor(entropy, useNeed, useGuardians);
    await recordSet(b.db, {
      setId: out.setId, need: out.need, total: out.total, fingerprint: out.fingerprint,
      guardians: out.cards.map((c) => c.guardian),
    });
    await supersedeSets(b.db, out.setId);
    return {
      setId: out.setId, need: out.need, total: out.total,
      fingerprint: out.fingerprint,
      cards: out.cards.map((c) => ({ guardian: c.guardian.name, card: c.card })),
      warning: "BACK UP each guardian card NOW — old cards are dead, shares are shown once",
    };
  },
  /**
   * F14 metered fetch: quote → policy-gated pay → retry with proof.
   * The origin pays (agent budgets bind); receipts land in history.
   */
  x402Pay: async (params) => {
    const b = needBackend();
    const { url, method, body, origin } = p(params) as {
      url?: unknown; method?: unknown; body?: unknown; origin?: unknown;
    };
    if (typeof url !== "string" || !url) throw Object.assign(new Error("url required"), { code: "BAD_PARAM" });
    return x402Pay({
      db: b.db, chain: b.chain, url,
      method: typeof method === "string" ? method : "GET",
      body: body === undefined ? undefined : body,
      origin: typeof origin === "string" ? origin : "cli",
    });
  },
  x402Receipts: async () => {
    const b = needBackend();
    return { receipts: await listReceipts(b.db) };
  },
  x402Attest: async (params) => {
    const b = needBackend();
    const { days, verifier } = p(params) as { days?: unknown; verifier?: unknown };
    const s = await getStatus();
    if (!s.identityKey) throw Object.assign(new Error("wallet locked"), { code: "WALLET_LOCKED" });
    return attestSpend(b.db, s.identityKey, {
      days: Number(days ?? 30),
      verifier: typeof verifier === "string" ? verifier : undefined,
    });
  },
  /**
   * F5 gallery + BSV21 positions (read-only 1Sat Stack; no keys).
   * Address defaults to the wallet (locked wallets must pass one).
   */
  ordList: async (params) => {
    const { address } = p(params) as { address?: unknown };
    const addr = typeof address === "string" && address ? address : selfAddress();
    return { ordinals: await galleryFor(addr) };
  },
  bsv21List: async (params) => {
    const { address } = p(params) as { address?: unknown };
    const addr = typeof address === "string" && address ? address : selfAddress();
    return { tokens: await bsv21For(addr) };
  },
  /** Mint a 1-sat inscription (dataHex, contentType) from the wallet. */
  ordInscribe: async (params) => {
    const b = needBackend();
    const { dataHex, contentType, fee, memo, origin } = p(params) as {
      dataHex?: unknown; contentType?: unknown; fee?: unknown; memo?: unknown; origin?: unknown;
    };
    if (typeof dataHex !== "string" || !dataHex) {
      throw Object.assign(new Error("dataHex required"), { code: "BAD_PARAM" });
    }
    if (typeof contentType !== "string" || !contentType) {
      throw Object.assign(new Error("contentType required"), { code: "BAD_PARAM" });
    }
    return inscribeMint({
      db: b.db, chain: b.chain,
      origin: typeof origin === "string" && origin ? origin : "cli",
      dataHex, contentType,
      ...(fee && typeof fee === "object" ? { fee: fee as { to: string; sats: number } } : {}),
      ...(Array.isArray(memo) ? { memo: memo as string[] } : {}),
    });
  },
  ordSend: async (params) => {
    const b = needBackend();
    const { txid, vout, to, origin } = p(params) as {
      txid?: unknown; vout?: unknown; to?: unknown; origin?: unknown;
    };
    if (typeof txid !== "string" || !txid) throw Object.assign(new Error("txid required"), { code: "BAD_PARAM" });
    if (typeof to !== "string" || !to) throw Object.assign(new Error("recipient address required"), { code: "BAD_PARAM" });
    return sendOrdinal({
      db: b.db, chain: b.chain,
      origin: typeof origin === "string" ? origin : "cli",
      txid, vout: Math.floor(Number(vout) || 0), to,
    });
  },
  bsv21Send: async (params) => {
    const b = needBackend();
    const { tokenId, id, to, amt, origin } = p(params) as {
      tokenId?: unknown; id?: unknown; to?: unknown; amt?: unknown; origin?: unknown;
    };
    const idStr = typeof tokenId === "string" && tokenId ? tokenId : typeof id === "string" ? id : "";
    if (!idStr) throw Object.assign(new Error("token id required"), { code: "BAD_PARAM" });
    if (typeof to !== "string" || !to) throw Object.assign(new Error("recipient address required"), { code: "BAD_PARAM" });
    if (typeof amt !== "string" && typeof amt !== "number") {
      throw Object.assign(new Error("amt required (base units)"), { code: "BAD_PARAM" });
    }
    return sendBsv21({
      db: b.db, chain: b.chain,
      origin: typeof origin === "string" ? origin : "cli",
      tokenId: idStr, to, amt,
    });
  },
  basketCreate: async (params) => {
    const b = needBackend();
    const { name, description } = p(params) as { name?: unknown; description?: unknown };
    if (typeof name !== "string" || !name) throw Object.assign(new Error("name required"), { code: "BAD_PARAM" });
    return createBasket(b.db, name, typeof description === "string" ? description : "");
  },
  basketRemove: async (params) => {
    const b = needBackend();
    const { name } = p(params) as { name?: unknown };
    if (typeof name !== "string" || !name) throw Object.assign(new Error("name required"), { code: "BAD_PARAM" });
    return removeBasket(b.db, name);
  },
  basketAssign: async (params) => {
    const b = needBackend();
    const { txid, vout, basket } = p(params) as { txid?: unknown; vout?: unknown; basket?: unknown };
    if (typeof txid !== "string" || !txid) throw Object.assign(new Error("txid required"), { code: "BAD_PARAM" });
    if (typeof basket !== "string" || !basket) throw Object.assign(new Error("basket required"), { code: "BAD_PARAM" });
    return assignUtxo(b.db, txid, Number(vout), basket);
  },
  basketList: async () => {
    const b = needBackend();
    const views = await walletBaskets(b.db, b.chain);
    return {
      baskets: views.map((v) => ({
        name: v.name, description: v.description,
        balance: v.balance, memberCount: v.memberCount,
      })),
    };
  },
  basketBalance: async (params) => {
    const b = needBackend();
    const { name } = p(params) as { name?: unknown };
    const views = await walletBaskets(b.db, b.chain);
    if (typeof name === "string" && name) {
      const v = views.find((x) => x.name === name);
      if (!v) throw Object.assign(new Error(`no basket: ${name}`), { code: "NOT_FOUND" });
      return v;
    }
    return { baskets: views };
  },
  appInstall: async (params) => {
    const b = needBackend();
    const { domain, manifestJson } = p(params) as { domain?: unknown; manifestJson?: unknown };
    if (typeof domain !== "string" || !domain.trim()) {
      throw Object.assign(new Error("domain required"), { code: "BAD_PARAM" });
    }
    const { app, asked } = await installApp(b.db, domain.trim(), {
      seedPolicyRequest: (origin, amountSats, action) => seedRequest(b.db, origin, amountSats, action),
    }, manifestJson !== undefined ? { manifestJson } : {});
    const launcher = await writeDesktopEntry(app).catch(() => null);
    return { app, asked, launcher };
  },
  appList: async () => {
    const b = needBackend();
    return { apps: await listApps(b.db) };
  },
  appRemove: async (params) => {
    const b = needBackend();
    const { domain } = p(params) as { domain?: unknown };
    if (typeof domain !== "string" || !domain.trim()) {
      throw Object.assign(new Error("domain required"), { code: "BAD_PARAM" });
    }
    const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
    const removed = await removeApp(b.db, clean);
    await removeDesktopEntry(clean);
    return { removed };
  },
  storeList: async () => {
    const b = needBackend();
    return { store: await storeList(b.db) };
  },
  appUpdate: async (params) => {
    const b = needBackend();
    const { domain, all, approveWidening } = p(params) as {
      domain?: unknown; all?: unknown; approveWidening?: unknown;
    };
    const seed = {
      seedPolicyRequest: (origin: string, amountSats: number, action: string) => seedRequest(b.db, origin, amountSats, action),
    };
    if (all === true) {
      const apps = await listApps(b.db);
      const results = [];
      for (const a of apps) {
        results.push(await applyAppUpdate(b.db, a.domain, seed, { approveWidening: approveWidening === true }));
      }
      return { results };
    }
    if (typeof domain !== "string" || !domain.trim()) {
      throw Object.assign(new Error("domain required (or all=true)"), { code: "BAD_PARAM" });
    }
    return applyAppUpdate(b.db, domain, seed, { approveWidening: approveWidening === true });
  },
  appOpen: async (params) => {
    const b = needBackend();
    const { domain } = p(params) as { domain?: unknown };
    if (typeof domain !== "string" || !domain.trim()) {
      throw Object.assign(new Error("domain required"), { code: "BAD_PARAM" });
    }
    const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
    const app = await getApp(b.db, clean);
    if (!app) throw Object.assign(new Error("not installed — bsv app install first"), { code: "NOT_FOUND" });
    return { startUrl: app.startUrl, domain: app.domain };
  },
  /**
   * Launch an installed app in a sandboxed runner window. This is what the
   * bundled Launcher app calls, so the UI can open apps the same way
   * `bsv app open` does — the browser launch has to live in the daemon,
   * because a web page cannot spawn a window with the window.bsv bridge
   * attached.
   *
   * Installed-only (never a bare URL, so this cannot become an
   * open-redirector), and fire-and-forget: the bridge child watches the
   * window's profile and exits with it, so the RPC never blocks on the UI.
   */
  appLaunch: async (params) => {
    const b = needBackend();
    const { domain } = p(params) as { domain?: unknown };
    if (typeof domain !== "string" || !domain.trim()) {
      throw Object.assign(new Error("domain required"), { code: "BAD_PARAM" });
    }
    const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
    const app = await getApp(b.db, clean);
    if (!app) throw Object.assign(new Error("not installed — install it first"), { code: "NOT_FOUND" });
    const { openInRunner } = await import("./runner.ts");
    const res = await openInRunner({
      startUrl: app.startUrl,
      domain: app.domain,
      bridgeEntry: bridgeEntryPath(),
      wait: false,
    });
    if (!res.launched) {
      throw Object.assign(new Error(`runner unavailable: ${res.reason ?? "unknown"}`), { code: "RUNNER_UNAVAILABLE" });
    }
    return { launched: true, domain: app.domain, startUrl: app.startUrl };
  },
  /**
   * F2 runner intents: the sandboxed webview's `window.bsv` bridge calls
   * through here with the app's domain as origin. Installed-only,
   * allowlisted methods, spends under the app's own origin policy —
   * the page never touches keys and cannot reach any other RPC.
   */
  appInvoke: async (params) => {
    const b = needBackend();
    const { domain, method, callParams } = p(params) as {
      domain?: unknown; method?: unknown; callParams?: unknown;
    };
    if (typeof domain !== "string" || !domain.trim()) {
      throw Object.assign(new Error("domain required"), { code: "BAD_PARAM" });
    }
    const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
    const app = await getApp(b.db, clean);
    if (!app) throw Object.assign(new Error(`not installed — bsv app install ${clean} first`), { code: "NOT_FOUND" });
    const args = (callParams && typeof callParams === "object" ? callParams : {}) as Record<string, unknown>;
    switch (method) {
      case "getStatus": {
        const s = await getStatus();
        return { authenticated: !s.locked, locked: s.locked, hasWallet: s.hasWallet };
      }
      case "getIdentity": {
        const s = await getStatus();
        return { identityKey: (s as { identityKey?: string | null }).identityKey ?? null, locked: s.locked };
      }
      case "getBalance":
        return getBalance(b.chain);
      case "timestamp": {
        const { sha256 } = args as { sha256?: unknown };
        if (typeof sha256 !== "string") throw Object.assign(new Error("sha256 required"), { code: "BAD_PARAM" });
        return anchorTip({ db: b.db, chain: b.chain, origin: app.domain, sha256 });
      }
      /**
       * PocketPets cutover: the game runs on OS custody instead of
       * browser keys. Reads are free; every write is policy-gated under
       * the app's origin (ask-mode prompts in the panel) and tracked +
       * labeled like any other spend. Pages describe intents — scripts
       * are always fetched and verified daemon-side, never trusted.
       */
      case "getUtxos": {
        const addr = selfAddress();
        const u = await b.chain.utxos(addr);
        return {
          address: addr,
          confirmed: u.confirmed,
          unconfirmed: u.unconfirmed,
          utxos: u.utxos.map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, height: x.height ?? 0 })),
        };
      }
      case "spend": {
        const { payments, memo, label } = args as { payments?: unknown; memo?: unknown; label?: unknown };
        if (!Array.isArray(payments) || !payments.length) {
          throw Object.assign(new Error("payments required"), { code: "BAD_PARAM" });
        }
        // The page's memo is the action tag: first entry becomes the label
        // the policy gate and ledger see, the rest is Jev's description.
        const intent = intentFromMemo(memo, label);
        return spendTo({
          db: b.db, chain: b.chain, origin: app.domain,
          payments: payments as Array<{ to: string; sats: number }>,
          memo: Array.isArray(memo) ? (memo as string[]) : undefined,
          ...(intent.label ? { label: intent.label } : {}),
          ...(intent.description ? { description: intent.description } : {}),
        });
      }
      case "inscribe": {
        const { dataHex, contentType, to, fee, memo, label } = args as {
          dataHex?: unknown; contentType?: unknown; to?: unknown;
          fee?: unknown; memo?: unknown; label?: unknown;
        };
        if (typeof dataHex !== "string" || !dataHex) {
          throw Object.assign(new Error("dataHex required"), { code: "BAD_PARAM" });
        }
        if (typeof contentType !== "string" || !contentType) {
          throw Object.assign(new Error("contentType required"), { code: "BAD_PARAM" });
        }
        const intent = intentFromMemo(memo, label);
        return inscribeMint({
          db: b.db, chain: b.chain, origin: app.domain, dataHex, contentType,
          to: typeof to === "string" ? to : undefined,
          fee: fee && typeof fee === "object" ? (fee as { to: string; sats: number }) : undefined,
          memo: Array.isArray(memo) ? (memo as string[]) : undefined,
          ...(intent.label ? { label: intent.label } : {}),
          ...(intent.description ? { description: intent.description } : {}),
        });
      }
      case "transferNft": {
        const { txid, vout, to, memo } = args as {
          txid?: unknown; vout?: unknown; to?: unknown; memo?: unknown;
        };
        if (typeof txid !== "string" || !txid) throw Object.assign(new Error("txid required"), { code: "BAD_PARAM" });
        if (typeof to !== "string" || !to) throw Object.assign(new Error("recipient address required"), { code: "BAD_PARAM" });
        return sendOrdinal({
          db: b.db, chain: b.chain, origin: app.domain,
          txid, vout: Math.floor(Number(vout) || 0), to,
          memo: Array.isArray(memo) ? (memo as string[]) : undefined,
        });
      }
      case "signSwapOffer": {
        const { txid, vout, priceSats, kind, tokenId, tokenAmount } = args as {
          txid?: unknown; vout?: unknown; priceSats?: unknown;
          kind?: unknown; tokenId?: unknown; tokenAmount?: unknown;
        };
        if (typeof txid !== "string" || !txid) throw Object.assign(new Error("txid required"), { code: "BAD_PARAM" });
        return signSwapOffer({
          db: b.db, chain: b.chain, origin: app.domain,
          txid, vout: Math.floor(Number(vout) || 0), priceSats: Number(priceSats) || 0,
          ...(kind === "ordinal" || kind === "bsv21" ? { kind } : {}),
          ...(typeof tokenId === "string" ? { tokenId } : {}),
          ...(typeof tokenAmount === "string" ? { tokenAmount } : {}),
        });
      }
      case "ordlockLock": {
        const { txid, vout, priceSats } = args as { txid?: unknown; vout?: unknown; priceSats?: unknown };
        if (typeof txid !== "string" || !txid) throw Object.assign(new Error("txid required"), { code: "BAD_PARAM" });
        return ordlockLockFor(app.domain, { txid, vout, priceSats });
      }
      case "ordlockBuy": {
        const { lockOutpoint, fee } = args as { lockOutpoint?: unknown; fee?: unknown };
        if (typeof lockOutpoint !== "string" || !lockOutpoint) {
          throw Object.assign(new Error("lockOutpoint required"), { code: "BAD_PARAM" });
        }
        return ordlockBuyFor(app.domain, {
          lockOutpoint,
          ...(fee && typeof fee === "object" ? { fee } : {}),
          memo: ["MARKET-BUY", lockOutpoint],
          label: `market buy ${lockOutpoint}`,
        });
      }
      case "ordlockCancel": {
        const { lockOutpoint } = args as { lockOutpoint?: unknown };
        if (typeof lockOutpoint !== "string" || !lockOutpoint) {
          throw Object.assign(new Error("lockOutpoint required"), { code: "BAD_PARAM" });
        }
        return ordlockCancelFor(app.domain, { lockOutpoint });
      }
      case "completeSwap": {
        const { offer, fee, memo, label, buyerChecks } = args as { offer?: unknown; fee?: unknown; memo?: unknown; label?: unknown; buyerChecks?: unknown };
        if (!offer || typeof offer !== "object") throw Object.assign(new Error("offer required"), { code: "BAD_PARAM" });
        const intent = intentFromMemo(memo, label);
        return completeSwap({
          db: b.db, chain: b.chain, origin: app.domain, offer,
          fee: fee && typeof fee === "object" ? (fee as { to: string; sats: number }) : undefined,
          memo: Array.isArray(memo) ? (memo as string[]) : undefined,
          ...(intent.label ? { label: intent.label } : {}),
          ...(intent.description ? { description: intent.description } : {}),
          ...(buyerChecks && typeof buyerChecks === "object"
            ? { buyerChecks: buyerChecks as { expectedSeller?: string; maxPrice?: number } }
            : {}),
        });
      }
      default:
        throw Object.assign(new Error(`unknown app method ${String(method)}`), { code: "BAD_METHOD" });
    }
  },
  /**
   * F3/P4 identity: Sign in with Twetch over OIDC (PKCE + loopback).
   * The hosted issuer page never sees wallet keys; we only store the
   * verified session (sub, handle, avatar) and bind the wallet identity
   * that is unlocked at sign-in time.
   */
  identityConfigure: async (params) => {
    const b = needBackend();
    return { config: await setIdentityConfig(b.db, p(params)) };
  },
  /**
   * Read the OIDC config so a UI can tell "not set up yet" from "signed out"
   * without starting a login flow to find out. The client secret is reduced
   * to a boolean — a page must never be able to read it back, and a public
   * PKCE client does not have one anyway.
   */
  identityConfigStatus: async () => {
    const b = needBackend();
    const c = await identityConfig(b.db);
    return {
      config: {
        issuer: c.issuer,
        clientId: c.clientId,
        redirectPort: c.redirectPort,
        scope: c.scope,
        hasSecret: Boolean(c.clientSecret),
      },
    };
  },
  identityLoginStart: async (params) => {
    const b = needBackend();
    const raw = p(params);
    const started = await startLogin(b.db, {
      issuer: typeof raw.issuer === "string" ? raw.issuer : undefined,
      clientId: typeof raw.clientId === "string" ? raw.clientId : undefined,
      clientSecret:
        raw.clientSecret === null ? null : typeof raw.clientSecret === "string" ? raw.clientSecret : undefined,
      redirectPort: typeof raw.redirectPort === "number" ? raw.redirectPort : undefined,
      scope: typeof raw.scope === "string" ? raw.scope : undefined,
      force: raw.force === true,
    });
    return { ...started, config: await identityConfig(b.db) };
  },
  identityLoginStatus: async () => {
    const b = needBackend();
    return loginStatus(b.db);
  },
  identityLoginCancel: () => cancelLogin(),
  identitySession: async () => {
    const b = needBackend();
    return { session: await currentSession(b.db) };
  },
  identityLogout: async () => {
    const b = needBackend();
    return identityLogout(b.db);
  },
  /**
   * Twetch companion: keyless reads (feed, notifications) plus posting.
   * Posting spends the network fee through the BRC-100 facade under the
   * caller's origin; the imported Twetch key only signs AIP/API auth.
   */
  twetchStatus: async () => {
    const b = needBackend();
    const account = await twetchAccountStatus();
    let identity: Record<string, unknown> | null = null;
    try {
      const s = await currentSession(b.db);
      if (s) {
        identity = {
          sub: s.sub, handle: s.handle, name: s.name,
          picture: s.picture, profile: s.profile,
          stale: s.stale === true,
        };
      }
    } catch {
      identity = null;
    }
    return { account, identity };
  },
  twetchFeed: async (params) => {
    needBackend();
    const raw = p(params);
    return feedLatest(fetch, {
      limit: typeof raw.limit === "number" ? raw.limit : 30,
      cursor: typeof raw.cursor === "string" ? raw.cursor : undefined,
    });
  },
  twetchNotifications: async (params) => {
    const b = needBackend();
    const raw = p(params);
    const session = await currentSession(b.db);
    const userId = Math.floor(Number(session?.sub ?? 0));
    if (!(userId > 0)) {
      throw Object.assign(new Error("sign in with Twetch first: bsv login"), { code: "BAD_PARAM" });
    }
    const limit = typeof raw.limit === "number" ? raw.limit : 30;
    const [feed, posts] = await Promise.all([
      notifications(fetch, userId, { limit }),
      postNotifications(fetch, userId, { limit: Math.min(limit, 20) }),
    ]);
    return { userId, ...feed, postNotifications: posts.posts };
  },
  twetchPost: async (params) => {
    const b = needBackend();
    const raw = p(params);
    if (typeof raw.content !== "string" || !raw.content.trim()) {
      throw Object.assign(new Error("post content required"), { code: "BAD_PARAM" });
    }
    let media: { bytes: number[]; mime: string } | undefined;
    if (typeof raw.mediaBase64 === "string" && raw.mediaBase64) {
      const bytes = Array.from(Buffer.from(raw.mediaBase64, "base64"));
      if (!bytes.length) {
        throw Object.assign(new Error("mediaBase64 is not valid base64"), { code: "BAD_PARAM" });
      }
      media = { bytes, mime: typeof raw.mediaMime === "string" ? raw.mediaMime : "" };
    }
    const session = await currentSession(b.db).catch(() => null);
    const userId = Math.floor(Number(session?.sub ?? 0));
    return postText(
      {
        db: b.db,
        chain: b.chain,
        fetchFn: fetch,
        origin: typeof raw.origin === "string" && raw.origin ? raw.origin : "twetch",
        expectUserId: userId,
      },
      raw.content,
      { userId, media },
    );
  },
  twetchIndex: async (params) => {
    const b = needBackend();
    const raw = p(params);
    const txid = typeof raw.txid === "string" ? raw.txid.trim() : "";
    const session = await currentSession(b.db).catch(() => null);
    const userId = Math.floor(Number(session?.sub ?? 0));
    return indexPost(
      { db: b.db, chain: b.chain, fetchFn: fetch, origin: "twetch", expectUserId: userId },
      txid,
      { userId },
    );
  },
  twetchAccountImport: async (params) => {
    const raw = p(params);
    if (typeof raw.wif !== "string" || !raw.wif.trim()) {
      throw Object.assign(new Error("private key (WIF) required"), { code: "BAD_PARAM" });
    }
    return twetchAccountImport(raw.wif);
  },
  /**
   * One-tap import: derive the Twetch account key from the enrolled seed
   * (default m/44'/0'/0'/0/0) and store it. Derivation and storage happen
   * inside custody; this only sees the public key, which it checks against
   * Twetch's key-linkage index to confirm the key really is the account's.
   */
  twetchAccountImportFromSeed: async (params) => {
    const b = needBackend();
    const raw = p(params);
    const path = typeof raw.path === "string" && raw.path ? raw.path : undefined;
    const session = await currentSession(b.db).catch(() => null);
    const imported = await twetchAccountImportFromSeed(path, twetchTarget(session));
    return verifyTwetchImport(imported, session);
  },
  /**
   * Same scan-and-verify import from an explicitly supplied phrase (a
   * separate Twetch wallet). The phrase is used locally and never stored
   * beyond the derived key entry.
   */
  twetchAccountImportFromPhrase: async (params) => {
    const b = needBackend();
    const raw = p(params);
    if (typeof raw.phrase !== "string" || !raw.phrase.trim()) {
      throw Object.assign(new Error("recovery phrase required"), { code: "BAD_PARAM" });
    }
    const path = typeof raw.path === "string" && raw.path ? raw.path : undefined;
    const session = await currentSession(b.db).catch(() => null);
    const imported = await twetchAccountImportFromPhrase(raw.phrase, path, twetchTarget(session));
    return verifyTwetchImport(imported, session);
  },
  twetchAccountRemove: async () => {
    await twetchAccountRemove();
    return { removed: true };
  },
  /** Read-only Meme Library (Dank Rares) browse/search. */
  twetchMemes: async (params) => {
    needBackend();
    const raw = p(params);
    return memeLibrary(fetch, {
      q: typeof raw.q === "string" ? raw.q : undefined,
      folder: typeof raw.folder === "string" ? raw.folder : undefined,
      tag: typeof raw.tag === "string" ? raw.tag : undefined,
      format: typeof raw.format === "string" ? raw.format : undefined,
      sort: typeof raw.sort === "string" ? raw.sort : undefined,
      cursor: typeof raw.cursor === "string" ? raw.cursor : undefined,
      limit: typeof raw.limit === "number" ? raw.limit : 30,
    });
  },
  twetchMemeFolders: async () => {
    needBackend();
    return { folders: await memeFolders(fetch) };
  },
  /**
   * Classify a meme image + caption with Clef vision (advisory only).
   * Accepts a mediaUrl (daemon fetches, 4 MiB cap) or mediaBase64.
   * Warn-don't-block: throws coded errors, the app shows a notice.
   */
  classifyMeme: async (params) => {
    const raw = p(params);
    const caption = typeof raw.caption === "string" ? raw.caption.slice(0, 500) : "";
    let base64 = typeof raw.mediaBase64 === "string" ? raw.mediaBase64 : "";
    let contentType = "image/jpeg";
    if (!base64 && typeof raw.mediaUrl === "string" && /^https?:\/\//i.test(raw.mediaUrl)) {
      const res = await fetch(raw.mediaUrl);
      if (!res.ok) {
        throw Object.assign(new Error(`template fetch failed (${res.status})`), { code: "TEMPLATE_FETCH" });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > CLEF_MAX_IMAGE_BYTES) {
        throw Object.assign(new Error("template image exceeds the 4 MiB vision cap"), { code: "BAD_PARAM" });
      }
      contentType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim() || "image/jpeg";
      base64 = buf.toString("base64");
    }
    if (!base64) {
      throw Object.assign(new Error("mediaUrl or mediaBase64 required"), { code: "BAD_PARAM" });
    }
    return classifyMeme({ imageBase64: base64, contentType, caption });
  },
  /** Public profile + recent posts for a Twetch user. */
  twetchUser: async (params) => {
    needBackend();
    const raw = p(params);
    const id = Math.floor(Number(raw.id) || 0);
    if (!(id > 0)) {
      throw Object.assign(new Error("userId required"), { code: "BAD_PARAM" });
    }
    const [user, posts] = await Promise.all([
      userProfile(fetch, id),
      userPosts(fetch, id, {
        limit: typeof raw.limit === "number" ? raw.limit : 20,
        cursor: typeof raw.cursor === "string" ? raw.cursor : undefined,
      }),
    ]);
    return { user, ...posts };
  },
  /** Read-only NFT Market: active listings, recent sales, collections. */
  twetchMarket: async (params) => {
    needBackend();
    const raw = p(params);
    const view = typeof raw.view === "string" ? raw.view : "listings";
    const opts = {
      cursor: typeof raw.cursor === "string" ? raw.cursor : undefined,
      limit: typeof raw.limit === "number" ? raw.limit : 24,
    };
    if (view === "sales") return { view, ...(await marketSales(fetch, opts)) };
    if (view === "collections") return { view, ...(await marketCollections(fetch, opts)) };
    return { view: "listings", ...(await marketListings(fetch, opts)) };
  },
  /**
   * Buy a Twetch-listed NFT through OS custody. Atomic when the seller
   * published a swap offer (same outpoint listed on the atomic market):
   * payment + NFT settle in one tx or nothing moves. Otherwise a
   * direct-buy spend to the seller — pay first, delivery via Twetch,
   * stated plainly in the confirm. Policy origin "twetch" either way.
   */
  twetchBuy: (params) => swapBuyFor("twetch", params),
  /**
   * List an OS-custodied NFT for atomic sale: pre-signs the swap offer
   * (proceeds to self, SINGLE|ANYONECANPAY). The app posts the returned
   * offer to the atomic market worker itself. Rejects foreign carriers —
   * only our inscribed 1-sat UTXOs list.
   */
  twetchList: (params) => swapListFor("twetch", params),
  /** OrdLock: lock an ordinal on-chain (miner fee) and return the lock outpoint. */
  ordlockLock: (params) => ordlockLockFor("cli", params),
  /** OrdLock: spend a lock (covenant enforces the payout). Policy origin defaults to cli. */
  ordlockBuy: (params) => ordlockBuyFor("cli", params),
  /** OrdLock: cancel a lock back to the wallet (miner fee). */
  ordlockCancel: (params) => ordlockCancelFor("cli", params),
  /** Market listings (read-only) from the configured deployment. */
  marketBrowse: async (params) => {
    const { kind } = p(params) as { kind?: unknown };
    const listings = await fetchListings(kind === "ordinal" || kind === "bsv21" ? kind : undefined);
    return { market: marketUrl(), listings };
  },
  /** The market operator's declared fee for new listings. */
  marketFees: async () => ({ market: marketUrl(), ...(await fetchOperatorFee()) }),
  /**
   * Buy a listing end to end: fetch terms, verify seller + price
   * (buyerChecks), sign, broadcast, and post the buy (plus settle for
   * atomic swaps) to the market. Policy origin defaults to "cli";
   * agents pass their name so budgets and caps apply.
   */
  marketBuy: async (params) => {
    const b = needBackend();
    const { listing, origin, maxPrice } = p(params) as { listing?: unknown; origin?: unknown; maxPrice?: unknown };
    if (typeof listing !== "string" || !listing) {
      throw Object.assign(new Error("listing (asset outpoint) required"), { code: "BAD_PARAM" });
    }
    const l = await fetchListing(listing.replace("_", "."));
    if (!l) throw Object.assign(new Error(`unknown listing ${listing}`), { code: "NOT_FOUND" });
    if (l.status !== "active") throw Object.assign(new Error(`listing is ${l.status}`), { code: "ALREADY_SOLD" });
    const policyOrigin = typeof origin === "string" && origin ? origin : "cli";
    const cap = maxPrice === undefined ? l.priceSats : Math.floor(Number(maxPrice));
    if (!Number.isFinite(cap) || cap < l.priceSats) {
      throw Object.assign(new Error(`price ${l.priceSats} exceeds max ${cap}`), { code: "BAD_PARAM" });
    }
    const marketFee = listingFeeSats(l);
    const fee = marketFee > 0 ? { to: l.feeAddress, sats: marketFee } : undefined;
    const memo = ["MARKET-BUY", l.origin];
    const label = `market buy ${l.origin}`;
    let r: { txid: string; fee: number };
    let atomic = false;
    const offerKind = l.offer && typeof l.offer === "object" ? (l.offer as { kind?: string }).kind : undefined;
    if (offerKind === "ordlock") {
      atomic = true;
      r = await buyOrdLock({
        db: b.db, chain: b.chain, origin: policyOrigin,
        lockOutpoint: l.origin,
        ...(fee ? { fee } : {}),
        memo, label,
        buyerChecks: { expectedSeller: l.seller, maxPrice: cap },
      });
    } else if (l.offer && typeof l.offer === "object") {
      atomic = true;
      r = await completeSwap({
        db: b.db, chain: b.chain, origin: policyOrigin,
        offer: l.offer,
        ...(fee ? { fee } : {}),
        memo, label,
        buyerChecks: { expectedSeller: l.seller, maxPrice: cap },
      });
    } else {
      r = await spendTo({
        db: b.db, chain: b.chain, origin: policyOrigin,
        payments: [{ to: l.seller, sats: l.priceSats }, ...(fee ? [fee] : [])],
        memo, label,
        description: `market direct buy ${l.origin} for ${l.priceSats} sats (pay first, delivery by the seller)`,
      });
    }
    let posted = false;
    let postError: string | undefined;
    try {
      await markBought(l.origin, r.txid, policyOrigin);
      posted = true;
    } catch (e) {
      postError = e instanceof Error ? e.message : String(e);
    }
    let settled = false;
    if (atomic) {
      try {
        await markSettled(l.origin, r.txid);
        settled = true;
      } catch {
        /* settle is bookkeeping; the swap already moved the asset */
      }
    }
    return { txid: r.txid, fee: r.fee, atomic, priceSats: l.priceSats, marketFee, posted, settled, ...(postError ? { postError } : {}) };
  },
  /**
   * List one of our carriers: sign the offer, then post it to the market
   * with the operator's declared fee (override with feeBps). Policy
   * origin defaults to "cli"; agents pass their name.
   */
  marketList: async (params) => {
    const b = needBackend();
    const { outpoint, priceSats, kind, tokenId, tokenAmount, origin, title, image, feeBps } = p(params) as {
      outpoint?: unknown; priceSats?: unknown; kind?: unknown; tokenId?: unknown; tokenAmount?: unknown;
      origin?: unknown; title?: unknown; image?: unknown; feeBps?: unknown;
    };
    const m = typeof outpoint === "string" ? /^([0-9a-fA-F]{64})[._](\d+)$/.exec(outpoint) : null;
    if (!m) throw Object.assign(new Error("outpoint must be <64-hex-txid>.<vout>"), { code: "BAD_PARAM" });
    const policyOrigin = typeof origin === "string" && origin ? origin : "cli";
    const assetKind = kind === "bsv21" ? ("bsv21" as const) : ("ordinal" as const);
    const price = Math.floor(Number(priceSats) || 0);
    const fees = await fetchOperatorFee();
    const bps = feeBps === undefined ? fees.feeBps : Math.max(0, Math.min(10000, Math.floor(Number(feeBps) || 0)));
    const seller = selfAddress();
    let listingOrigin = `${m[1]!.toLowerCase()}.${Number(m[2])}`;
    let offer: unknown;
    let lockFee = 0;
    let freshLock = false;
    if (assetKind === "bsv21") {
      // tokens are envelope-tracked: the v3 pre-signed swap stays valid
      offer = await signSwapOffer({
        db: b.db, chain: b.chain, origin: policyOrigin,
        txid: m[1]!, vout: Number(m[2]), priceSats: price,
        kind: "bsv21",
        ...(typeof tokenId === "string" ? { tokenId } : {}),
        ...(typeof tokenAmount === "string" ? { tokenAmount } : {}),
      });
    } else {
      // ordinals: OrdLock covenant — the carrier moves into the lock script
      const locked = await lockOrdinal({
        db: b.db, chain: b.chain, origin: policyOrigin,
        txid: m[1]!, vout: Number(m[2]), priceSats: price,
      });
      listingOrigin = locked.lockOutpoint;
      lockFee = locked.fee;
      freshLock = true;
      offer = { version: 5, kind: "ordlock", priceSats: price, lockTime: 0 };
    }
    await postListing({
      origin: listingOrigin,
      assetKind,
      title: typeof title === "string" && title ? title : `${assetKind} ${listingOrigin.slice(0, 12)}`,
      ...(typeof image === "string" && image ? { image } : {}),
      priceSats: price,
      seller,
      offer,
      feeBps: bps,
      feeAddress: fees.feeAddress,
      metadata: { source: policyOrigin },
    }, fetch, freshLock ? { attempts: 6 } : {});
    return {
      listed: true, origin: listingOrigin, priceSats: price, feeBps: bps, feeAddress: fees.feeAddress,
      atomic: true, version: (offer as { version: number }).version, kind: (offer as { kind: string }).kind,
      ...(lockFee ? { lockFee } : {}),
    };
  },
  /**
   * Cancel our listing on the market (seller must be this wallet). OrdLock
   * listings also unlock the carrier back on-chain (miner fee), so the
   * asset returns to the wallet; the market cancel always runs.
   */
  marketCancel: (params: unknown) => marketCancelFor("cli", params),
  /**
   * Reconcile a broadcast buy with the market: post the buy (+settle for
   * atomic swaps) for a tx that already exists. Use when a buy's market
   * post failed because the indexer had not seen the fresh tx yet —
   * idempotent when the listing already recorded the same txid.
   */
  marketSync: async (params) => {
    const { listing, txid } = p(params) as { listing?: unknown; txid?: unknown };
    if (typeof listing !== "string" || !listing) {
      throw Object.assign(new Error("listing (asset outpoint) required"), { code: "BAD_PARAM" });
    }
    if (typeof txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw Object.assign(new Error("txid must be a 64-hex transaction id"), { code: "BAD_PARAM" });
    }
    const clean = txid.toLowerCase();
    const l = await fetchListing(listing.replace("_", "."));
    if (!l) throw Object.assign(new Error(`unknown listing ${listing}`), { code: "NOT_FOUND" });
    if (l.buyTxid === clean || l.transferTxid === clean) {
      return { listing: l.origin, txid: clean, posted: true, settled: l.status === "sold", status: l.status };
    }
    if (l.status !== "active") {
      throw Object.assign(new Error(`listing is ${l.status} with a different tx recorded`), { code: "ALREADY_SOLD" });
    }
    let posted = false;
    let postError: string | undefined;
    try {
      await markBought(l.origin, clean, "sync");
      posted = true;
    } catch (e) {
      postError = e instanceof Error ? e.message : String(e);
    }
    let settled = false;
    if (posted && l.offer && typeof l.offer === "object") {
      try {
        await markSettled(l.origin, clean);
        settled = true;
      } catch {
        /* settle is bookkeeping; the swap already moved the asset */
      }
    }
    return { listing: l.origin, txid: clean, posted, settled, status: l.status, ...(postError ? { postError } : {}) };
  },
  /**
   * Token UTXOs for one tokenId: which of our wallet UTXOs carry the
   * token and how much. Listing is exact-UTXO (partial fills can't be
   * atomic-safe), so the sell UI needs these, not just balances.
   */
  bsv21Utxos: async (params) => {
    const b = needBackend();
    const { tokenId } = p(params) as { tokenId?: unknown };
    const id = normalizeTokenId(tokenId);
    if (!id) throw Object.assign(new Error("tokenId must be <64-hex-txid>_<vout>"), { code: "BAD_PARAM" });
    const address = selfAddress();
    const u = await b.chain.utxos(address);
    const holdings = await tokenHoldings(id, u.utxos.map((x) => `${x.txid}_${x.vout}`));
    return {
      tokenId: id,
      utxos: holdings.map((h) => ({ outpoint: `${h.txid}_${h.vout}`, amount: h.amt })),
    };
  },
};

export async function dispatch(body: unknown): Promise<RpcResponse> {
  const req = (body ?? {}) as RpcRequest;
  const { method, params = {}, id = null } = req;
  if (typeof method !== "string" || !(method in METHODS)) {
    return { error: { code: "METHOD_NOT_FOUND", message: `unknown method ${String(method)}` }, id };
  }
  try {
    return { result: await METHODS[method]!(params), id };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "INTERNAL";
    return { error: { code, message: err instanceof Error ? err.message : String(err) }, id };
  }
}
