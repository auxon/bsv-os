// Same-origin JSON-RPC to bsv-walletd.
//
// This page is served by the daemon from its own HTTPS origin, so the calls
// are same-origin and loopback-gated (see isLoopbackPeer). That makes it an
// operator surface: the same trust level as the `bsv` CLI, not a sandboxed
// third-party app. Spends are still gated daemon-side by the policy engine.
//
// The old Quickshell panel shelled out to `bsv` 51 times per refresh and
// branched on the process exit code, so failures surfaced as "see the
// terminal". Here we get the real error code and message from the daemon.
"use strict";

let rpcId = 1;

/** An RPC failure carrying the daemon's own code (POLICY_DENY, WALLET_LOCKED, …). */
export class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RpcError";
    this.code = code ?? "INTERNAL";
  }
}

export async function rpc(method, params = {}) {
  const res = await fetch("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params, id: rpcId++ }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new RpcError(`daemon returned ${res.status} (not JSON)`, "BAD_REPLY");
  }
  if (body?.error) {
    const e = body.error;
    throw new RpcError(e.message || e.code || "rpc error", e.code);
  }
  return body?.result ?? null;
}

/** Run an RPC, returning `{ok:true,value}` or `{ok:false,error}` — never throws. */
export async function tryRpc(method, params) {
  try {
    return { ok: true, value: await rpc(method, params) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Human wording for the daemon's error codes. The panel could not do this:
 * it only saw a non-zero exit status.
 */
export function explain(error) {
  const code = error?.code ?? "";
  const msg = String(error?.message ?? error ?? "unknown error");
  switch (code) {
    case "WALLET_LOCKED":
      return "Wallet is locked. Unlock it to act.";
    case "NO_WALLET":
      return "No wallet enrolled on this machine yet.";
    case "POLICY_DENY":
      return `Blocked by spending policy: ${msg}`;
    case "RUNNER_UNAVAILABLE":
      return `No sandboxed browser available (${msg}).`;
    case "SETUP_REQUIRED":
      // The daemon has no OIDC client id yet. That is a public value for a
      // PKCE client, so the shell can configure it — no terminal needed.
      return "Sign-in is not set up on this machine yet. Add the issuer client id below.";
    case "CLIENT_AUTH":
      // The issuer knows the client but will not accept it without a secret.
      return String(error?.message ?? msg);
    case "NOT_FOUND":
      return msg;
    default:
      return msg;
  }
}

/** True when the failure is just "the wallet is locked" — drives the unlock hint. */
export function isLocked(error) {
  return error?.code === "WALLET_LOCKED" || error?.code === "NO_WALLET";
}
