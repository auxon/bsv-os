#!/usr/bin/env node
/**
 * bsv — policy console + wallet CLI for bsv-walletd.
 * Talks to the daemon over the Unix socket (or HTTPS with BSV_WALLETD_URL).
 * Management commands (allow/deny/lock/unlock/create) are the policy console
 * and always run locally; spends go through policy like any other origin.
 */
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SOCK = path.join(process.env.XDG_RUNTIME_DIR ?? path.join(os.homedir(), ".local/share/bsv-os"), "bsv-walletd.sock");
const HTTPS_URL = process.env.BSV_WALLETD_URL ?? "";

let nextId = 1;
async function call(method: string, params: unknown = {}): Promise<unknown> {
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
    sock.on("error", (e) => reject(new Error(`daemon unreachable (${SOCK}): ${e.message}`)));
    setTimeout(() => reject(new Error("daemon timeout")), 30000).unref?.();
  });
}

/** Hidden stdin prompt (no echo) for secrets. Falls back to visible on dumb terminals. */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    try {
      if (stdin.isTTY) stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
    let out = "";
    const done = () => {
      try {
        if (stdin.isTTY) stdin.setRawMode(!!wasRaw);
      } catch {
        /* ignore */
      }
      process.stdout.write("\n");
      stdin.removeListener("data", onData);
      stdin.pause();
      resolve(out);
    };
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          done();
          return;
        }
        if (ch === "\u0003") {
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          out = out.slice(0, -1);
        } else {
          out += ch;
        }
      }
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}

function print(res: unknown): void {  const r = res as { result?: unknown; error?: { code?: string; message?: string } };
  if (r && typeof r === "object" && "error" in r && r.error) {
    console.error(`error [${r.error.code ?? "?"}]: ${r.error.message ?? r.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(r && typeof r === "object" && "result" in r ? r.result : r, null, 2));
}

/** --key=value or --key value. */
function flag(rest: string[], name: string): string | undefined {
  const eq = rest.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = rest.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < rest.length) return rest[i + 1];
  return undefined;
}

/** --expiry 30d | 2026-10-14 | <ms epoch> → ms epoch, 0 = never. */
function parseExpiry(raw: string | undefined): number {
  if (!raw) return 0;
  const days = /^(\d+)d$/.exec(raw);
  if (days) return Date.now() + Number(days[1]) * 86_400_000;
  const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(t)) {
    console.error("bad --expiry: use 30d, YYYY-MM-DD, or ms epoch");
    process.exitCode = 2;
    return -1;
  }
  return t;
}

/** Open an installed app in the sandboxed runner (Chromium app window +
 * per-app profile + window.bsv bridge). False when the runner is
 * unavailable — the caller falls back to the default browser. */
async function openInRunner(startUrl: string, domain: string): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const { findChromium, findExtensionDir, buildLaunchPlan } = await import("./launcher.ts");
  const { randomBytes } = await import("node:crypto");
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { mkdir } = await import("node:fs/promises");
  const chromium = findChromium();
  const extensionDir = findExtensionDir();
  if (!chromium || !extensionDir) return false;
  const token = randomBytes(16).toString("hex");
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(p));
    });
  });
  if (!port) return false;
  const plan = buildLaunchPlan({ chromium, domain, startUrl, extensionDir, port, token });
  await mkdir(plan.dataDir, { recursive: true });
  const self = process.argv[1];
  const bridge = spawn(process.execPath, [self, "_bridge", domain, `--port=${port}`, `--token=${token}`], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("bridge start timeout")), 10000);
    bridge.stdout.on("data", (d: Buffer) => {
      if (d.toString().includes('"ready"')) {
        clearTimeout(t);
        resolve();
      }
    });
    bridge.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    bridge.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`bridge exited ${code}`));
    });
  }).catch((e: unknown) => {
    bridge.kill();
    throw e;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(plan.chromium, plan.args, { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", () => resolve());
    });
  } finally {
    bridge.kill();
  }
  return true;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "status":
      print(await call("isAuthenticated"));
      break;
    case "create":
      print(await call("createWallet", { force: rest.includes("--force") }));
      break;
    case "import": {
      // Phrase via hidden stdin prompt — never as an argv (shell history).
      const phrase = await readSecret("Recovery phrase (12 words, hidden): ");
      if (!phrase.trim()) {
        console.error("empty phrase — aborted");
        process.exitCode = 2;
        break;
      }
      print(await call("importWallet", { phrase, force: rest.includes("--force") }));
      break;
    }
    case "unlock":
      print(await call("unlock"));
      break;
    case "lock":
      print(await call("lock"));
      break;
    case "pending":
      print(await call("pending"));
      break;
    case "balance":
      print(await call("balance"));
      break;
    case "anchor": {
      const sha256 = rest.find((a) => !a.startsWith("--"));
      const originFlag = rest.find((a) => a.startsWith("--origin="));
      if (!sha256) {
        console.error("usage: bsv anchor <64-hex-sha256> [--origin=name]");
        process.exitCode = 2;
        break;
      }
      print(await call("anchor", { sha256, origin: originFlag ? originFlag.slice(9) : "cli" }));
      break;
    }
    case "allow": {
      const [origin, cap] = rest;
      if (!origin) {
        console.error("usage: bsv allow <origin> [capSats]");
        process.exitCode = 2;
        break;
      }
      print(await call("policyApprove", { origin, capSats: Number(cap ?? 0) }));
      break;
    }
    case "deny": {
      const [origin] = rest;
      if (!origin) {
        console.error("usage: bsv deny <origin>");
        process.exitCode = 2;
        break;
      }
      print(await call("policyDeny", { origin }));
      break;
    }
    case "requests":
      print(await call("policyPending"));
      break;
    case "agent": {
      const [sub, name] = rest;
      if (sub === "mint" && name) {
        const exp = parseExpiry(flag(rest, "expiry"));
        if (process.exitCode) break;
        print(await call("agentMint", {
          name,
          budgetSats: Number(flag(rest, "budget") ?? 0),
          dailySats: Number(flag(rest, "daily") ?? 0),
          expiryAt: exp,
        }));
      } else if (sub === "revoke" && name) {
        print(await call("agentRevoke", { name }));
      } else if ((sub === "show" && name) || (sub === "list" && name)) {
        print(await call("agentShow", { name }));
      } else if (sub === "list" || sub === undefined) {
        print(await call("agentList"));
      } else {
        console.error("usage: bsv agent <mint <name> --budget=N [--daily=N] [--expiry=30d|YYYY-MM-DD]|list|show <name>|revoke <name>>");
        process.exitCode = 2;
      }
      break;
    }
    case "history":
      print(await call("history"));
      break;
    case "policies":
      print(await call("policyList"));
      break;
    case "app": {
      const [sub, arg] = rest;
      if (sub === "install" && arg) {
        const mf = flag(rest, "manifest-file");
        let manifestJson: unknown;
        if (mf !== undefined) {
          const { readFile } = await import("node:fs/promises");
          try {
            manifestJson = JSON.parse(await readFile(mf, "utf8"));
          } catch (e) {
            console.error(`cannot read manifest file: ${e instanceof Error ? e.message : e}`);
            process.exitCode = 2;
            break;
          }
        }
        print(await call("appInstall", manifestJson !== undefined ? { domain: arg, manifestJson } : { domain: arg }));
      } else if (sub === "list" || sub === undefined) {
        print(await call("appList"));
      } else if (sub === "remove" && arg) {
        print(await call("appRemove", { domain: arg }));
      } else if (sub === "open" && arg) {
        const res = (await call("appOpen", { domain: arg })) as { result?: { startUrl?: string; domain?: string } };
        const url = res?.result?.startUrl;
        if (!url) {
          print(res);
          break;
        }
        // Sandboxed runner first (window.bsv bridge); default browser fallback.
        let launched = false;
        try {
          launched = await openInRunner(url, res?.result?.domain ?? arg);
        } catch (e) {
          console.error(`runner failed (${e instanceof Error ? e.message : e}) — falling back to browser`);
        }
        if (!launched) {
          console.log(url);
          if (process.platform === "linux") {
            const { execFile } = await import("node:child_process");
            execFile("xdg-open", [url], (e) => {
              if (e) console.error("(could not open browser automatically)");
            });
          }
        }
      } else {
        console.error("usage: bsv app <install <domain>|list|remove <domain>|open <domain>>");
        process.exitCode = 2;
      }
      break;
    }
    case "_bridge": {
      // F2 runner internals: loopback relay for ONE app window. Spawned by
      // `app open`, never by hand. Dies with the window (or its parent).
      const [bridgeDomain] = rest;
      const bridgePort = Number(flag(rest, "port") ?? 0);
      const bridgeToken = flag(rest, "token") ?? "";
      if (!bridgeDomain || !bridgePort || !bridgeToken) {
        console.error("usage: bsv _bridge <domain> --port=N --token=T");
        process.exitCode = 2;
        break;
      }
      const { createServer } = await import("node:http");
      const { createBridgeHandler } = await import("./bridge.ts");
      const handler = createBridgeHandler({
        token: bridgeToken,
        domain: bridgeDomain.toLowerCase(),
        invoke: async (method, params) => {
          const res = (await call("appInvoke", { domain: bridgeDomain, method, callParams: params })) as {
            result?: unknown; error?: unknown;
          };
          return res && typeof res === "object" && "error" in res && res.error
            ? { error: res.error }
            : { result: (res as { result?: unknown }).result };
        },
      });
      await new Promise<void>((resolve, reject) => {
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
          req.on("error", () => reject(new Error("bridge request failed")));
        });
        server.on("error", reject);
        server.listen(bridgePort, "127.0.0.1", () => {
          console.log(JSON.stringify({ ready: true, port: bridgePort }));
        });
      });
      break;
    }
    case "mcp": {
      // Agent bridge: MCP on stdio, daemon on the socket. Keys stay put.
      const agentFlag = rest.find((a) => a.startsWith("--agent="));
      const agent = agentFlag ? agentFlag.slice(8) || "agent" : "agent";
      const { buildMcpServer } = await import("./mcp.ts");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const daemon = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
        const res = (await call(method, params)) as { result?: unknown; error?: { code?: string; message?: string } };
        if (res && typeof res === "object" && "error" in res && res.error) {
          throw { code: res.error.code ?? "INTERNAL", message: res.error.message ?? "daemon error" };
        }
        return (res as { result?: unknown }).result;
      };
      const server = buildMcpServer(daemon, agent);
      await server.connect(new StdioServerTransport());
      break;
    }
    default:
      console.error("usage: bsv <status|create|import|unlock|lock|pending|balance|history|anchor|allow|deny|requests|policies|agent|app|mcp [--agent=NAME]>");
      process.exitCode = 2;
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
