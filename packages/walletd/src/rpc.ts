import { createWallet, getStatus, importWallet, lock, unlock } from "./custody.ts";
import type { Knex } from "knex";
import type { ChainProvider } from "./chain.ts";
import { listPolicies, pendingRequests, seedRequest, setPolicy } from "./policy.ts";
import { anchorTip, explorerTxUrl, getBalance, safeLabel } from "./engine.ts";
import { emptyHistory, getHistory } from "./history.ts";
import { getAgent, listAgents, mintAgent, revokeAgent } from "./agents.ts";
import { getApp, installApp, listApps, removeApp, storeList, applyAppUpdate } from "./apps.ts";
import { getCert, listCerts, listDisclosures, putCert, revokeCert, showCert } from "./certs.ts";
import { assignUtxo, createBasket, removeBasket, walletBaskets } from "./baskets.ts";
import { removeDesktopEntry, writeDesktopEntry } from "./desktop.ts";

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
    const { origin, capSats } = p(params) as { origin?: unknown; capSats?: unknown };
    if (typeof origin !== "string" || !origin) throw Object.assign(new Error("origin required"), { code: "BAD_PARAM" });
    await setPolicy(b.db, origin, "allow", Math.max(0, Math.floor(Number(capSats) || 0)));
    return { origin, mode: "allow" };
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
      default:
        throw Object.assign(new Error(`unknown app method ${String(method)}`), { code: "BAD_METHOD" });
    }
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
