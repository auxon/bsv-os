import { createWallet, getStatus, importWallet, lock, unlock } from "./custody.ts";
import type { Knex } from "knex";
import type { ChainProvider } from "./chain.ts";
import { listPolicies, pendingRequests, seedRequest, setPolicy } from "./policy.ts";
import { anchorTip, getBalance } from "./engine.ts";
import { emptyHistory, getHistory } from "./history.ts";
import { getApp, installApp, listApps, removeApp } from "./apps.ts";
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
  history: async () => {
    // F8 dashboard: degrades to empty (like pending) before the engine boots.
    if (!backend) return emptyHistory();
    return getHistory(backend.db);
  },
  appInstall: async (params) => {
    const b = needBackend();
    const { domain } = p(params) as { domain?: unknown };
    if (typeof domain !== "string" || !domain.trim()) {
      throw Object.assign(new Error("domain required"), { code: "BAD_PARAM" });
    }
    const { app, asked } = await installApp(b.db, domain.trim(), {
      seedPolicyRequest: (origin, amountSats, action) => seedRequest(b.db, origin, amountSats, action),
    });
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
