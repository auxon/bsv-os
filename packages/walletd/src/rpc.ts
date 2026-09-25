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
import { runDoctor } from "./doctor.ts";
import { autoThresholds, decide as jevDecideCall, jevEnabled, jevModel, type JevQuestion } from "./jev.ts";
import { anchorTip, explorerTxUrl, getBalance, inscribeMint, safeLabel, sendBsv21, sendOrdinal, sendSats, spendTo } from "./engine.ts";
import { emptyHistory, getHistory } from "./history.ts";
import { getAgent, listAgents, mintAgent, revokeAgent } from "./agents.ts";
import { getApp, installApp, intentFromMemo, listApps, removeApp, storeList, applyAppUpdate } from "./apps.ts";
import { getCert, listCerts, listDisclosures, putCert, revokeCert, showCert } from "./certs.ts";
import { assignUtxo, createBasket, removeBasket, walletBaskets } from "./baskets.ts";
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

export const VERSION = "0.1.0";

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
  unlock: async () => unlock(),
  lock: () => {
    lock();
    return { locked: true };
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
  pay: async (params) => {
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
    const r = await sendSats({ db: b.db, chain: b.chain, origin: "cli", to: address, sats: amount, label });
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
  },
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
  requestPay: async (params) => {
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
    const r = await sendSats({ db: b.db, chain: b.chain, origin: "cli", to: verified.address, sats: verified.amount, label });
    await markPaid(b.db, row.id, r.txid);
    const receipt = row.peer ? await sendReceipt(b.db, liveRelay(), p2pChannel, row, r.txid, row.amount) : { sent: false };
    return { txid: r.txid, fee: r.fee, amount: row.amount, to: row.peer, receiptSent: receipt.sent };
  },
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
  receiptIssue: async (params) => {
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
            origin: "cli",
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
  },
  receiptList: async () => {
    const b = needBackend();
    return { receipts: await listPaymentReceipts(b.db) };
  },
  /** F6.4 boards: fast, permissioned, persistent agent-to-agent logs. */
  boardList: async () => {
    const b = needBackend();
    try {
      await scanBoardInbox(b.db, liveRelay());
    } catch {
      /* relay or lock hiccups must not break listing */
    }
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
    try {
      await scanBoardInbox(b.db, liveRelay());
    } catch {
      /* local history still serves */
    }
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
    try {
      await scanBoardInbox(b.db, liveRelay());
    } catch {
      /* keep waiting on the live channel */
    }
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
  marketCancel: async (params) => {
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
        const unlocked = await cancelOrdLock({ db: b.db, chain: b.chain, origin: "cli", lockOutpoint: dot });
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
  },
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
