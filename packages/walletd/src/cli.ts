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
    case "share": {
      // F7: hash a file (streamed, any size) and anchor it with its name.
      const file = rest.find((a) => !a.startsWith("--"));
      const shareOrigin = flag(rest, "origin") ?? "cli";
      if (!file) {
        console.error("usage: bsv share <file> [--origin=name]");
        process.exitCode = 2;
        break;
      }
      try {
        const { createReadStream, promises: fsp } = await import("node:fs");
        const { createHash } = await import("node:crypto");
        const { basename } = await import("node:path");
        const st = await fsp.stat(file);
        if (!st.isFile()) throw new Error("not a file");
        const sha256 = await new Promise<string>((resolve, reject) => {
          const hash = createHash("sha256");
          const stream = createReadStream(file);
          stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
          stream.on("end", () => resolve(hash.digest("hex")));
          stream.on("error", reject);
        });
        print(await call("anchorFile", { sha256, filename: basename(file), size: st.size, origin: shareOrigin }));
      } catch (e) {
        console.error(`share failed: ${e instanceof Error ? e.message : e}`);
        process.exitCode = 1;
      }
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
    case "overlay": {
      const [ovSub, ...ovRest] = rest;
      const ovArg = ovRest.find((a) => !a.startsWith("--"));
      if (ovSub === "health" || ovSub === undefined) {
        print(await call("overlayHealth"));
      } else if (ovSub === "topics") {
        print(await call("overlayTopics"));
      } else if (ovSub === "lookup" && ovArg) {
        print(await call("overlayLookup", {
          topic: ovArg,
          ...(flag(rest, "address") ? { address: flag(rest, "address") } : {}),
          ...(flag(rest, "history") !== undefined ? { what: "history" } : {}),
        }));
      } else if (ovSub === "submit" && ovArg) {
        const topics: string[] = [];
        rest.forEach((a, i) => {
          if (a.startsWith("--topic=")) topics.push(a.slice(8));
          else if (a === "--topic" && i + 1 < rest.length) topics.push(rest[i + 1]!);
        });
        const topicList = topics.length > 0 ? topics : (flag(rest, "topics") ?? "").split(",").filter(Boolean);
        if (topicList.length === 0) {
          console.error("usage: bsv overlay submit <txid> --topic <t> [--topic ...]");
          process.exitCode = 2;
          break;
        }
        print(await call("overlaySubmit", { txid: ovArg, topics: topicList }));
      } else if (ovSub === "tags" && ovArg) {
        print(await call("overlayTags", { txid: ovArg }));
      } else {
        console.error("usage: bsv overlay <health|topics|lookup <tm_topic> --address <addr>|submit <txid> --topic <t>|tags <txid>>");
        process.exitCode = 2;
      }
      break;
    }
    case "nightshift": {
      const [nsSub, ...nsRest] = rest;
      const nsArg = nsRest.find((a) => !a.startsWith("--"));
      if (nsSub === "create") {
        const name = flag(rest, "name") ?? nsArg;
        const agent = flag(rest, "agent");
        const every = flag(rest, "every");
        const budget = flag(rest, "budget") ?? flag(rest, "cycle");
        if (!name || !agent || !every || !budget) {
          console.error("usage: bsv nightshift create --name <n> --agent <a> --every <60s|15m|6h|2d|1w> --budget <sats> [--bounty <id>]");
          process.exitCode = 2;
          break;
        }
        print(await call("shiftCreate", {
          name, agent, every, cycleSats: Number(budget),
          ...(flag(rest, "bounty") ? { bountyId: flag(rest, "bounty") } : {}),
        }));
      } else if (nsSub === "list" || nsSub === undefined) {
        print(await call("shiftList"));
      } else if (nsSub === "runs") {
        print(await call("shiftRuns", {
          ...(nsArg ? { order: nsArg } : {}),
          ...(flag(rest, "limit") ? { limit: Number(flag(rest, "limit")) } : {}),
        }));
      } else if (nsSub === "pause" && nsArg) {
        print(await call("shiftPause", { id: nsArg }));
      } else if (nsSub === "resume" && nsArg) {
        print(await call("shiftResume", { id: nsArg }));
      } else if (nsSub === "remove" && nsArg) {
        print(await call("shiftRemove", { id: nsArg }));
      } else if (nsSub === "claim" && nsArg) {
        print(await call("shiftClaim", { run: Number(nsArg) }));
      } else if (nsSub === "submit" && nsArg) {
        const proof = flag(rest, "proof");
        if (!proof) {
          console.error("usage: bsv nightshift submit <run> --proof <text>");
          process.exitCode = 2;
          break;
        }
        print(await call("shiftSubmit", { run: Number(nsArg), proof }));
      } else if (nsSub === "approve" && nsArg) {
        print(await call("shiftApprove", { run: Number(nsArg) }));
      } else if (nsSub === "fail" && nsArg) {
        print(await call("shiftFail", { run: Number(nsArg) }));
      } else {
        console.error("usage: bsv nightshift <create|list|runs|pause|resume|remove|claim|submit|approve|fail>");
        process.exitCode = 2;
      }
      break;
    }
    case "gig": {
      const [gigSub, ...gigRest] = rest;
      const gigArg = gigRest.find((a) => !a.startsWith("--"));
      if (gigSub === "board" || gigSub === undefined) {
        print(await call("gigBoard", {
          ...(flag(rest, "category") ? { category: flag(rest, "category") } : {}),
          ...(flag(rest, "limit") ? { limit: Number(flag(rest, "limit")) } : {}),
        }));
      } else if (gigSub === "show" && gigArg) {
        print(await call("gigShow", { id: gigArg }));
      } else if (gigSub === "list") {
        print(await call("gigList"));
      } else if (gigSub === "track" && gigArg) {
        print(await call("gigTrack", { id: gigArg }));
      } else if (gigSub === "untrack" && gigArg) {
        print(await call("gigUntrack", { id: gigArg }));
      } else if (gigSub === "claim" && gigArg) {
        print(await call("gigClaim", {
          id: gigArg,
          ...(flag(rest, "payout") ? { payoutAddress: flag(rest, "payout") } : {}),
          ...(flag(rest, "worker-key") ? { workerPubKey: flag(rest, "worker-key") } : {}),
        }));
      } else if (gigSub === "submit" && gigArg) {
        print(await call("gigSubmit", {
          id: gigArg,
          ...(flag(rest, "hash") ? { workHash: flag(rest, "hash") } : {}),
          ...(flag(rest, "uri") ? { workUri: flag(rest, "uri") } : {}),
          ...(flag(rest, "notes") ? { notes: flag(rest, "notes") } : {}),
        }));
      } else if (gigSub === "paid" && gigArg) {
        const outpoint = gigRest.filter((a) => !a.startsWith("--"))[1];
        const [txid, vout] = (outpoint ?? "").split(":");
        if (!txid || vout === undefined || vout === "") {
          console.error("usage: bsv gig paid <id> <txid:vout>");
          process.exitCode = 2;
          break;
        }
        print(await call("gigPaid", { id: gigArg, txid, vout: Number(vout) }));
      } else {
        console.error("usage: bsv gig <board|show <id>|list|track <id>|claim <id>|submit <id>|paid <id> <txid:vout>|untrack <id>>");
        process.exitCode = 2;
      }
      break;
    }
    case "recovery": {
      // F10: guardian ceremonies. Shares travel by hidden prompt and are
      // never argv, never chat, never stored — printed once at setup/rotate.
      const [recSub, ...recRest] = rest;
      const collectGuardians = () => {
        const vals: string[] = [];
        rest.forEach((a, i) => {
          if (a.startsWith("--guardian=")) vals.push(a.slice(11));
          else if (a === "--guardian" && i + 1 < rest.length) vals.push(rest[i + 1]!);
        });
        return vals.map((v) => {
          const c = v.indexOf(":");
          return c < 0 ? { name: v } : { name: v.slice(0, c), identityKey: v.slice(c + 1) };
        });
      };
      if (recSub === "setup") {
        const need = Number(flag(rest, "need") ?? 0);
        const guardians = collectGuardians();
        if (!need || guardians.length === 0) {
          console.error("usage: bsv recovery setup --need <M> --guardian <name[:key]> [--guardian ...]");
          process.exitCode = 2;
          break;
        }
        print(await call("recoverySetup", { need, guardians }));
      } else if (recSub === "status" || recSub === undefined) {
        print(await call("recoveryStatus"));
      } else if (recSub === "rotate") {
        const needRaw = flag(rest, "need");
        const guardians = collectGuardians();
        print(await call("recoveryRotate", {
          ...(needRaw !== undefined ? { need: Number(needRaw) } : {}),
          ...(guardians.length > 0 ? { guardians } : {}),
        }));
      } else if (recSub === "restore") {
        const cards: string[] = [];
        for (let i = 0; i < 255; i++) {
          const line = (await readSecret(`Guardian card ${i + 1} (blank to finish): `)).trim();
          if (!line) break;
          cards.push(line);
        }
        if (cards.length === 0) {
          console.error("no cards given — aborted");
          process.exitCode = 2;
          break;
        }
        print(await call("recoveryRestore", { cards, force: rest.includes("--force") }));
      } else {
        console.error("usage: bsv recovery <setup|status|rotate|restore>");
        process.exitCode = 2;
      }
      break;
    }
    case "x402": {
      const [xSub, ...xRest] = rest;
      const xArg = xRest.find((a) => !a.startsWith("--"));
      if (xSub === "pay" && xArg) {
        const method = flag(rest, "method") ?? "GET";
        const dataRaw = flag(rest, "data");
        let data: unknown;
        if (dataRaw !== undefined) {
          try {
            data = JSON.parse(dataRaw);
          } catch {
            console.error("bad --data: must be JSON");
            process.exitCode = 2;
            break;
          }
        }
        print(await call("x402Pay", {
          url: xArg, method,
          body: data,
          origin: flag(rest, "origin") ?? "cli",
        }));
      } else if (xSub === "receipts" || xSub === undefined) {
        print(await call("x402Receipts"));
      } else if (xSub === "attest") {
        print(await call("x402Attest", {
          days: Number(flag(rest, "days") ?? 30),
          verifier: flag(rest, "to"),
        }));
      } else {
        console.error("usage: bsv x402 <pay <url> [--method=M] [--data=JSON] [--origin=name]|receipts|attest [--days=N] [--to=<key>]>");
        process.exitCode = 2;
      }
      break;
    }
    case "msg": {
      const [msgSub, ...msgRest] = rest;
      const msgArg = msgRest.find((a) => !a.startsWith("--"));
      if (msgSub === "send" && msgArg) {
        const text = flag(rest, "text") ?? msgRest.filter((a) => !a.startsWith("--"))[1];
        if (!text) {
          console.error("usage: bsv msg send <identityKey> --text <message>");
          process.exitCode = 2;
          break;
        }
        print(await call("msgSend", { to: msgArg, text }));
      } else if (msgSub === "sync" || msgSub === undefined) {
        print(await call("msgSync"));
      } else if (msgSub === "list") {
        print(await call("msgList", {}));
      } else if (msgSub === "show" && msgArg) {
        print(await call("msgShow", { id: msgArg }));
      } else if (msgSub === "ack" && msgArg) {
        print(await call("msgAck", { id: msgArg }));
      } else if (msgSub === "status") {
        print(await call("msgStatus"));
      } else if (msgSub === "register" && msgArg) {
        print(await call("msgRegister", { username: msgArg }));
      } else {
        console.error("usage: bsv msg <send <identityKey> --text <msg>|sync|list|show <id>|ack <id>|status|register <username>>");
        process.exitCode = 2;
      }
      break;
    }
    case "ord": {
      const [ordSub, ...ordRest] = rest;
      const ordArg = ordRest.find((a) => !a.startsWith("--"));
      if (ordSub === "list" || ordSub === undefined) {
        print(await call("ordList", flag(rest, "address") ? { address: flag(rest, "address") } : {}));
      } else if (ordSub === "send" && ordArg) {
        const [txid, vout] = ordArg.split(":");
        const to = flag(rest, "to") ?? ordRest.filter((a) => !a.startsWith("--"))[1];
        if (!txid || vout === undefined || !to) {
          console.error("usage: bsv ord send <txid:vout> --to <address> [--origin=name]");
          process.exitCode = 2;
          break;
        }
        print(await call("ordSend", { txid, vout: Number(vout), to, origin: flag(rest, "origin") ?? "cli" }));
      } else {
        console.error("usage: bsv ord <list [--address=<addr>]|send <txid:vout> --to <address>>");
        process.exitCode = 2;
      }
      break;
    }
    case "bsv21": {
      const [tokSub, ...tokRest] = rest;
      if (tokSub === "list" || tokSub === undefined) {
        print(await call("bsv21List", flag(rest, "address") ? { address: flag(rest, "address") } : {}));
      } else if (tokSub === "send") {
        const id = flag(rest, "id") ?? tokRest.find((a) => !a.startsWith("--"));
        const to = flag(rest, "to");
        const amt = flag(rest, "amt");
        if (!id || !to || !amt) {
          console.error("usage: bsv bsv21 send --id <tokenId> --to <address> --amt <base-units> [--origin=name]");
          process.exitCode = 2;
          break;
        }
        print(await call("bsv21Send", { tokenId: id, to, amt, origin: flag(rest, "origin") ?? "cli" }));
      } else {
        console.error("usage: bsv bsv21 <list [--address=<addr>]|send --id <tokenId> --to <address> --amt <base-units>>");
        process.exitCode = 2;
      }
      break;
    }
    case "basket": {
      const [basketSub, ...basketRest] = rest;
      const basketArg = basketRest.find((a) => !a.startsWith("--"));
      if (basketSub === "create" && basketArg) {
        print(await call("basketCreate", { name: basketArg, description: flag(rest, "description") ?? "" }));
      } else if (basketSub === "remove" && basketArg) {
        print(await call("basketRemove", { name: basketArg }));
      } else if (basketSub === "assign" && basketArg) {
        const [txid, vout] = basketArg.split(":");
        const to = flag(rest, "to") ?? basketRest.filter((a) => !a.startsWith("--"))[1];
        if (!txid || vout === undefined || !to) {
          console.error("usage: bsv basket assign <txid:vout> --to <basket>");
          process.exitCode = 2;
          break;
        }
        print(await call("basketAssign", { txid, vout: Number(vout), basket: to }));
      } else if (basketSub === "balance") {
        print(await call("basketBalance", basketArg ? { name: basketArg } : {}));
      } else if (basketSub === "list" || basketSub === undefined) {
        print(await call("basketList"));
      } else {
        console.error("usage: bsv basket <list|balance [name]|create <name>|remove <name>|assign <txid:vout> --to <basket>>");
        process.exitCode = 2;
      }
      break;
    }
    case "cert": {
      const [certSub, ...certRest] = rest;
      const certId = certRest.find((a) => !a.startsWith("--"));
      if (certSub === "put") {
        const type = flag(rest, "type");
        const certifier = flag(rest, "certifier");
        const fields: Record<string, string> = {};
        const takeField = (kv: string | undefined) => {
          if (!kv) return;
          const eq = kv.indexOf("=");
          if (eq > 0) fields[kv.slice(0, eq)] = kv.slice(eq + 1);
        };
        rest.forEach((a, i) => {
          if (a.startsWith("--field=")) takeField(a.slice(8));
          else if (a === "--field") takeField(rest[i + 1]);
        });
        if (!type || !certifier || Object.keys(fields).length === 0) {
          console.error("usage: bsv cert put --type=<t> --certifier=<pubkey> --field <k>=<v> [--field ...] [--subject=<pubkey>] [--signature=<hex>] [--expires=30d|YYYY-MM-DD]");
          process.exitCode = 2;
          break;
        }
        const exp = parseExpiry(flag(rest, "expires"));
        if (process.exitCode) break;
        print(await call("certPut", {
          type, certifier, fields,
          subject: flag(rest, "subject"),
          signature: flag(rest, "signature"),
          expiresAt: exp,
        }));
      } else if (certSub === "list" || certSub === undefined) {
        print(await call("certList"));
      } else if (certSub === "show" && certId) {
        const only = flag(rest, "fields");
        print(await call("certShow", {
          id: certId,
          fields: only !== undefined ? only.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          to: flag(rest, "to"),
        }));
      } else if (certSub === "revoke" && certId) {
        print(await call("certRevoke", { id: certId }));
      } else {
        console.error("usage: bsv cert <put|list|show <id>|revoke <id>>");
        process.exitCode = 2;
      }
      break;
    }
    case "store":
      print(await call("storeList"));
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
    case "login": {
      // P4/F3: Sign in with Twetch (OIDC + PKCE). Client registration is
      // manual at the issuer — pass the console-issued values once and they
      // are stored daemon-side. The secret (if any) is prompted hidden,
      // never taken from argv.
      const clientId = flag(rest, "client-id");
      const clientSecret = flag(rest, "client-secret");
      const bareSecret = clientSecret === undefined && rest.includes("--client-secret");
      const issuer = flag(rest, "issuer");
      const scope = flag(rest, "scope");
      const portRaw = flag(rest, "port");
      const port = portRaw !== undefined ? Number(portRaw) : undefined;
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
        console.error("bad --port: use 0-65535");
        process.exitCode = 2;
        break;
      }
      let secret = clientSecret;
      if (bareSecret) {
        secret = (await readSecret("Twetch client secret (hidden, Enter to skip): ")).trim() || undefined;
      }
      const cfg: Record<string, unknown> = {};
      if (clientId) cfg.clientId = clientId;
      if (issuer) cfg.issuer = issuer;
      if (scope) cfg.scope = scope;
      if (port !== undefined) cfg.redirectPort = port;
      if (secret) cfg.clientSecret = secret;
      if (Object.keys(cfg).length) {
        const set = (await call("identityConfigure", cfg)) as { error?: unknown };
        if (set && typeof set === "object" && "error" in set && set.error) {
          print(set);
          break;
        }
      }
      const started = (await call("identityLoginStart", { force: rest.includes("--force") })) as {
        result?: { authUrl?: string; redirectUri?: string };
        error?: { code?: string; message?: string };
      };
      if (started.error || !started.result?.authUrl) {
        print(started);
        break;
      }
      console.log("Open the Twetch sign-in page:\n");
      console.log(`  ${started.result.authUrl}\n`);
      if (!rest.includes("--no-open") && process.platform === "linux") {
        const { execFile } = await import("node:child_process");
        execFile("xdg-open", [started.result.authUrl], () => {
          /* URL is printed either way */
        });
      }
      process.stdout.write("Waiting for Twetch");
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        let status: {
          result?: { state?: string; session?: unknown; error?: { code?: string; message?: string } };
        };
        try {
          status = (await call("identityLoginStatus")) as typeof status;
        } catch (e) {
          process.stdout.write("\n");
          console.error(`daemon unreachable: ${e instanceof Error ? e.message : e}`);
          process.exitCode = 1;
          break;
        }
        const state = status.result?.state ?? "idle";
        if (state === "done") {
          process.stdout.write("\n\n");
          print({ result: status.result?.session });
          break;
        }
        if (state === "error") {
          process.stdout.write("\n");
          console.error(`login failed [${status.result?.error?.code ?? "?"}]: ${status.result?.error?.message ?? ""}`);
          process.exitCode = 1;
          break;
        }
        if (state === "idle") {
          process.stdout.write("\n");
          console.error("login was cancelled or the daemon restarted — run bsv login again");
          process.exitCode = 1;
          break;
        }
        process.stdout.write(".");
      }
      if (Date.now() >= deadline) {
        process.stdout.write("\n");
        console.error("timed out waiting for sign-in");
        process.exitCode = 1;
      }
      break;
    }
    case "whoami":
      print(await call("identitySession"));
      break;
    case "logout":
      print(await call("identityLogout"));
      break;
    case "app": {
      const [sub, ...subRest] = rest;
      const arg = subRest.find((a) => !a.startsWith("--"));
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
      } else if (sub === "update" && (arg || rest.includes("--all"))) {
        const approve = rest.includes("--approve-widening");
        print(await call("appUpdate", arg
          ? { domain: arg, approveWidening: approve }
          : { all: true, approveWidening: approve }));
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
        console.error("usage: bsv app <install <domain> [--manifest-file <path>]|list|remove <domain>|update [<domain>|--all] [--approve-widening]|open <domain>>");
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
      console.error("usage: bsv <status|create|import|unlock|lock|pending|balance|history|anchor|share|allow|deny|requests|policies|agent|app|store|cert|basket|ord|bsv21|msg|x402|recovery|gig|nightshift|overlay|mcp [--agent=NAME]>");
      process.exitCode = 2;
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
