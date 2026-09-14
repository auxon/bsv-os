/**
 * F2 runner bridge: loopback HTTP relay between the sandboxed webview's
 * `window.bsv` content script and the daemon's origin-scoped `appInvoke`.
 *
 * Why HTTP and not native messaging: unpacked (`--load-extension`)
 * extensions get unstable IDs, so native-messaging origin pinning cannot
 * work. Instead the launcher spawns this bridge per app window with a
 * 128-bit token delivered in the window's URL fragment (client-side only,
 * never sent to the server) and a pinned expected domain:
 *
 * - every call must carry the token (kills cross-profile/window reuse)
 * - the `Origin` header host must equal the pinned domain (the browser
 *   sets it; pages cannot spoof it — kills token-leak reuse from other
 *   sites; the page never claims its own domain, the launcher stamps it)
 * - Private Network Access preflights are answered only for that origin
 * - the bridge forwards to `appInvoke` only — never the full RPC surface
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface BridgeConfig {
  token: string;
  domain: string; // pinned app domain, lowercase hostname
  invoke: (method: string, params: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;
}

function originHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function bridgeCors(domain: string, origin: string | undefined): Record<string, string> | null {
  if (originHost(origin) !== domain.toLowerCase()) return null;
  return {
    "access-control-allow-origin": origin!,
    "access-control-allow-private-network": "true",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "Origin",
  };
}

export function createBridgeHandler(config: BridgeConfig) {
  return async (req: IncomingMessage, body: string): Promise<{ status: number; headers: Record<string, string>; json: unknown }> => {
    const cors = bridgeCors(config.domain, req.headers.origin);
    if (req.method === "OPTIONS") {
      if (!cors) return { status: 403, headers: {}, json: { error: "forbidden origin" } };
      return { status: 204, headers: cors, json: null };
    }
    if (req.method !== "POST" || req.url !== "/invoke") {
      return { status: 404, headers: {}, json: { error: "not found" } };
    }
    if (!cors) return { status: 403, headers: {}, json: { error: "forbidden origin" } };
    let msg: { token?: unknown; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(body);
    } catch {
      return { status: 400, headers: cors, json: { error: "bad json" } };
    }
    if (typeof msg.token !== "string" || msg.token.length !== config.token.length ||
        !timingSafeEqual(msg.token, config.token)) {
      return { status: 403, headers: cors, json: { error: "bad token" } };
    }
    if (typeof msg.method !== "string" || !msg.method) {
      return { status: 400, headers: cors, json: { error: "method required" } };
    }
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    const out = await config.invoke(msg.method, params);
    return { status: 200, headers: { ...cors, "content-type": "application/json" }, json: out };
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
