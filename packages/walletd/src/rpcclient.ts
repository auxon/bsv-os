/**
 * Daemon client shared by the CLI, the runner bridge, and the app launcher.
 *
 * One implementation, three callers: `bsv` (console), the per-window bridge
 * child, and the daemon-side `appLaunch`. Keeping the transport here means a
 * new caller cannot accidentally pick a weaker path than the CLI uses.
 *
 * Transport is the Unix socket by default, or HTTPS when BSV_WALLETD_URL is
 * set. Callers are always local: the CLI and the bridge child are spawned by
 * this machine, and the daemon calls its own handlers in-process.
 */
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const SOCK = path.join(
  process.env.XDG_RUNTIME_DIR ?? path.join(os.homedir(), ".local/share/bsv-os"),
  "bsv-walletd.sock",
);
export const HTTPS_URL = process.env.BSV_WALLETD_URL ?? "";

let nextId = 1;

/** One JSON-RPC round trip. Resolves the whole envelope (result or error). */
export async function call(method: string, params: unknown = {}): Promise<unknown> {
  const body = JSON.stringify({ method, params, id: nextId++ });
  if (HTTPS_URL) {
    if (HTTPS_URL.startsWith("https:") && process.env.BSV_WALLETD_INSECURE === "1") {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // spike: self-signed localhost cert
    }
    const res = await fetch(HTTPS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    // pinned self-signed in production use; -k equivalent for the spike
    return res.json();
  }
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK, () => {
      sock.write(`${body}\n`);
    });
    let buf = "";
    const done = (v: unknown) => {
      sock.destroy();
      resolve(v);
    };
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        try {
          done(JSON.parse(buf.slice(0, idx)));
        } catch (e) {
          done({ error: String(e) });
        }
      }
    });
    sock.on("error", (e) => reject(new Error(`daemon unreachable (${SOCK}): ${(e as Error).message}`)));
    setTimeout(() => reject(new Error("daemon timeout")), 30000).unref?.();
  });
}
