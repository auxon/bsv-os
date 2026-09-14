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
    case "policies":
      print(await call("policyList"));
      break;
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
      console.error("usage: bsv <status|create|import|unlock|lock|pending|balance|anchor|allow|deny|requests|policies|mcp [--agent=NAME]>");
      process.exitCode = 2;
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
