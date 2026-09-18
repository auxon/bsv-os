import { createWallet, exportEntropy, getStatus, importWallet, lock, restoreFromEntropy, selfAddress, unlock } from "./custody.ts";
import {
  twetchAccountImport,
  twetchAccountImportFromPhrase,
  twetchAccountImportFromSeed,
  twetchAccountRemove,
  twetchAccountStatus,
} from "./custody.ts";
import type { Knex } from "knex";
import type { ChainProvider } from "./chain.ts";
import { listPolicies, pendingRequests, seedRequest, setPolicy } from "./policy.ts";
import { autoThresholds, decide as jevDecideCall, jevEnabled, jevModel, type JevQuestion } from "./jev.ts";
import { anchorTip, explorerTxUrl, getBalance, inscribeMint, safeLabel, sendBsv21, sendOrdinal, sendSats, spendTo } from "./engine.ts";
import { emptyHistory, getHistory } from "./history.ts";
import { getAgent, listAgents, mintAgent, revokeAgent } from "./agents.ts";
import { getApp, installApp, listApps, removeApp, storeList, applyAppUpdate } from "./apps.ts";
import { getCert, listCerts, listDisclosures, putCert, revokeCert, showCert } from "./certs.ts";
import { assignUtxo, createBasket, removeBasket, walletBaskets } from "./baskets.ts";
import { bsv21For, galleryFor } from "./tokens.ts";
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
import { ackDm, listStored, liveRelay, readDm, sendDm, syncInbox } from "./msgs.ts";
import { removeDesktopEntry, writeDesktopEntry } from "./desktop.ts";
import { completeSwap, signSwapOffer } from "./swaps.ts";
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
    return mintAgent(b.db, { name, budgetSats: Number(budgetSats), dailySats: Number(dailySats ?? 0), expiryAt: Number(expiryAt ?? 0) });
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
    if (typeof to !== "string" || !to) throw Object.assign(new Error("recipient identity key required"), { code: "BAD_PARAM" });
    if (typeof text !== "string" || !text) throw Object.assign(new Error("text required"), { code: "BAD_PARAM" });
    const self = selfAddress();
    return sendDm(b.db, liveRelay(), self, to, text);
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
        createdAt: r.createdAt, acked: r.acked === 1,
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
        return spendTo({
          db: b.db, chain: b.chain, origin: app.domain,
          payments: payments as Array<{ to: string; sats: number }>,
          memo: Array.isArray(memo) ? (memo as string[]) : undefined,
          label: typeof label === "string" ? label : undefined,
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
        return inscribeMint({
          db: b.db, chain: b.chain, origin: app.domain, dataHex, contentType,
          to: typeof to === "string" ? to : undefined,
          fee: fee && typeof fee === "object" ? (fee as { to: string; sats: number }) : undefined,
          memo: Array.isArray(memo) ? (memo as string[]) : undefined,
          label: typeof label === "string" ? label : undefined,
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
        const { txid, vout, priceSats } = args as { txid?: unknown; vout?: unknown; priceSats?: unknown };
        if (typeof txid !== "string" || !txid) throw Object.assign(new Error("txid required"), { code: "BAD_PARAM" });
        return signSwapOffer({
          db: b.db, chain: b.chain, origin: app.domain,
          txid, vout: Math.floor(Number(vout) || 0), priceSats: Number(priceSats) || 0,
        });
      }
      case "completeSwap": {
        const { offer, fee, memo } = args as { offer?: unknown; fee?: unknown; memo?: unknown };
        if (!offer || typeof offer !== "object") throw Object.assign(new Error("offer required"), { code: "BAD_PARAM" });
        return completeSwap({
          db: b.db, chain: b.chain, origin: app.domain, offer,
          fee: fee && typeof fee === "object" ? (fee as { to: string; sats: number }) : undefined,
          memo: Array.isArray(memo) ? (memo as string[]) : undefined,
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
