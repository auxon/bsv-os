import { getStatus, lock } from "./custody.ts";

export const VERSION = "0.1.0";

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

const METHODS: Record<string, (params: unknown) => unknown> = {
  getVersion: () => ({ version: VERSION, brc100: true }),
  isAuthenticated: () => ({ authenticated: !getStatus().locked, ...getStatus() }),
  lock: () => {
    lock();
    return { locked: true };
  },
};

export function dispatch(body: unknown): RpcResponse {
  const req = (body ?? {}) as RpcRequest;
  const { method, params = {}, id = null } = req;
  if (typeof method !== "string" || !(method in METHODS)) {
    return { error: { code: "METHOD_NOT_FOUND", message: `unknown method ${String(method)}` }, id };
  }
  try {
    return { result: METHODS[method]!(params), id };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "INTERNAL";
    return { error: { code, message: err instanceof Error ? err.message : String(err) }, id };
  }
}
