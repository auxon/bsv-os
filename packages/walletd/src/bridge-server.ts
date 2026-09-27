/**
 * Runner-bridge server.
 *
 * Spawned once per app window by `openInRunner` (from either `bsv app open`
 * or the daemon's `appLaunch`) — never run by hand. It serves the loopback
 * relay that the window's `window.bsv` content script talks to, forwarding
 * every call to the daemon's origin-scoped `appInvoke`.
 *
 * Two things make this safe to run as a child of the long-lived daemon:
 *   - it only ever forwards `appInvoke`, never the full RPC surface
 *   - it exits by itself when the app window closes (dataDir watch), so a
 *     fire-and-forget launch from the daemon leaks no process
 *
 * The executable wrapper is `bridge-main.ts`; this module is import-safe.
 */
import { createServer } from "node:http";
import { createBridgeHandler } from "./bridge.ts";
import { call } from "./rpcclient.ts";
import { waitForProfile, waitForProfileGone } from "./runner.ts";

export async function runBridge(
  domain: string,
  port: number,
  token: string,
  dataDir?: string,
): Promise<void> {
  const handler = createBridgeHandler({
    token,
    domain: domain.toLowerCase(),
    invoke: async (method, params) => {
      const res = (await call("appInvoke", { domain, method, callParams: params })) as {
        result?: unknown;
        error?: unknown;
      };
      return res && typeof res === "object" && "error" in res && res.error
        ? { error: res.error }
        : { result: (res as { result?: unknown }).result };
    },
  });

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      void handler(req, body).then((out) => {
        res.writeHead(out.status, out.headers);
        res.end(out.json === null ? undefined : JSON.stringify(out.json));
      });
    });
    req.on("error", () => res.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  // The launcher blocks on this line before it spawns Chromium.
  console.log(JSON.stringify({ ready: true, port }));

  if (dataDir) {
    // Tie our lifetime to the window: once the profile has been seen, the
    // first moment no process carries it means the user closed the app.
    if (await waitForProfile(dataDir, 20_000)) {
      await waitForProfileGone(dataDir);
      server.close();
    }
  }
}
