#!/usr/bin/env node
/**
 * bsv — policy console + wallet CLI for bsv-walletd.
 * Talks to the daemon over the Unix socket (or HTTPS with BSV_WALLETD_URL).
 * Management commands (allow/deny/lock/unlock/create) are the policy console
 * and always run locally; spends go through policy like any other origin.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { call, HTTPS_URL, SOCK } from "./rpcclient.ts";
import { openExternalCommand } from "./launcher.ts";

/** Media mime by extension for `bsv twetch post --media`. */
function mediaMimeFor(file: string): string {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      mp4: "video/mp4",
    }[ext] ?? "application/octet-stream"
  );
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

/** All values of a repeatable flag: --member a --member b, or --member=a. */
function flags(rest: string[], name: string): string[] {
  const out: string[] = [];
  rest.forEach((a, i) => {
    if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
    else if (a === `--${name}` && i + 1 < rest.length) out.push(rest[i + 1]);
  });
  return out;
}

/** Wait durations: 250ms, 30s, 2m, or a bare number of seconds. */
function waitMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const m = /^(\d+)(ms|s|m)?$/.exec(raw.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return unit === "ms" ? n : unit === "m" ? n * 60_000 : n * 1000;
}

/** `bsv board subscribe`: stream board posts as JSON lines until Ctrl-C. */
async function boardSubscribe(boards: string[]): Promise<void> {
  const body = JSON.stringify({ method: "boardSubscribe", params: { boards }, id: 1 });
  if (HTTPS_URL) {
    console.error("board subscribe needs the daemon socket (unset BSV_WALLETD_URL)");
    process.exitCode = 2;
    return;
  }
  const sock = net.createConnection(SOCK, () => {
    sock.write(`${body}\n`);
  });
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) process.stdout.write(`${line}\n`);
    }
  });
  sock.on("error", (e) => {
    console.error(`daemon unreachable (${SOCK}): ${e.message}`);
    process.exitCode = 1;
  });
  await new Promise<void>((resolve) => {
    const stop = () => {
      sock.destroy();
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    sock.on("close", () => resolve());
  });
}

/** requestList without per-row codes (long; `request code <id>` fetches one). */
async function requestListForCli(): Promise<unknown> {
  const res = (await call("requestList")) as {
    incoming?: Array<Record<string, unknown>>;
    outgoing?: Array<Record<string, unknown>>;
  };
  for (const list of [res.incoming, res.outgoing]) {
    for (const row of list ?? []) delete row.code;
  }
  return res;
}

/** Inline value, or @file to read the value from a file. */
function argText(raw: string): string {
  return raw.startsWith("@") ? fs.readFileSync(raw.slice(1), "utf8") : raw;
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

/**
 * Open an installed app in the sandboxed runner. Thin wrapper over the shared
 * launcher so `bsv app open` and the daemon's `appLaunch` cannot drift; the
 * CLI differs only in blocking for the window's lifetime.
 */
async function openInRunner(startUrl: string, domain: string): Promise<boolean> {
  const { openInRunner: launch } = await import("./runner.ts");
  const self = process.argv[1] ?? "";
  const res = await launch({
    startUrl,
    domain,
    bridgeEntry: self,
    wait: true,
  });
  if (!res.launched && res.reason) console.error(`runner: ${res.reason}`);
  return res.launched;
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
    case "utxos":
      print(await call("utxos"));
      break;
    case "address": {
      if (rest.includes("--png")) {
        print(await call("addressQr"));
        break;
      }
      const bal = (await call("balance")) as { result?: { address?: string } };
      const address = bal?.result?.address;
      if (!address) {
        print(bal);
        break;
      }
      if (rest.includes("--qr")) {
        const { qrAscii } = await import("./qr.ts");
        console.log(address);
        console.log(await qrAscii(address));
      } else {
        print({ address });
      }
      break;
    }
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
    case "send": {
      const [toAddr, satsRaw] = rest.filter((a) => !a.startsWith("--"));
      const sendLabel = flag(rest, "label");
      if (!toAddr || !(Number(satsRaw) > 0)) {
        console.error("usage: bsv send <address> <sats> [--label=..]");
        process.exitCode = 2;
        break;
      }
      print(await call("send", {
        to: toAddr,
        sats: Number(satsRaw),
        ...(sendLabel !== undefined ? { label: sendLabel } : {}),
      }));
      break;
    }
    case "allow": {
      const [origin, cap] = rest.filter((a) => !a.startsWith("--"));
      if (!origin) {
        console.error("usage: bsv allow <origin> [capSats] [--auto]");
        process.exitCode = 2;
        break;
      }
      print(await call("policyApprove", {
        origin,
        capSats: Number(cap ?? 0),
        ...(rest.includes("--auto") ? { auto: true } : {}),
      }));
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
    case "doctor": {
      const res = (await call("doctor")) as { result?: { ok?: boolean } };
      print(res);
      if (res && typeof res === "object" && res.result && typeof res.result === "object" && res.result.ok === false) {
        process.exitCode = 1;
      }
      break;
    }
    case "events": {
      print(await call("eventsPoll", {
        ...(flag(rest, "since") !== undefined ? { since: Number(flag(rest, "since")) } : {}),
        ...(flag(rest, "limit") !== undefined ? { limit: Number(flag(rest, "limit")) } : {}),
        ...(flag(rest, "origin") !== undefined ? { origin: flag(rest, "origin") } : {}),
        ...(flag(rest, "wait") !== undefined ? { waitMs: Math.floor(Number(flag(rest, "wait")) * 1000) } : {}),
      }));
      break;
    }
    case "watch": {
      // Positional args form the filter DSL: bsv watch 'type=payment sats>=100'
      // (flag values like `--limit 12` are not filter terms).
      const WATCH_VALUE_FLAGS = new Set(["since", "limit", "filter"]);
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a.startsWith("--")) {
          if (!a.includes("=") && WATCH_VALUE_FLAGS.has(a.slice(2))) i++;
          continue;
        }
        if (a === "-f") continue;
        positionals.push(a);
      }
      const filterText = positionals.join(" ");
      const follow = rest.includes("--follow") || rest.includes("-f");
      const asJson = rest.includes("--json");
      const limit = Number(flag(rest, "limit") ?? 25);
      const sinceArg = flag(rest, "since");
      const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
      let windowStart: number | null = null;
      if (sinceArg !== undefined && sinceArg !== "now" && sinceArg !== "tail") {
        const m = /^(\d+)(s|m|h|d|w)$/.exec(sinceArg);
        const secs = m ? (Number(m[1]) * unitMs[m[2]!]!) / 1000 : Number(sinceArg);
        if (!Number.isFinite(secs) || secs <= 0) {
          console.error(`bad --since "${sinceArg}" (use 30m, 2h, 1d, or a seconds count)`);
          process.exitCode = 2;
          break;
        }
        windowStart = Date.now() - secs * 1000;
      }
      let cursor: { at: number; keys: string[] } | null = null;
      if (windowStart !== null) {
        // Replay the window from its first millisecond, then follow.
        cursor = { at: windowStart - 1, keys: [] };
      } else if (follow) {
        // Tail mode starts at the newest event, not at the beginning of time.
        const probe = (await call("watchTail")) as {
          result?: { cursor?: { at: number; keys: string[] } };
        };
        cursor = probe.result?.cursor ?? { at: Date.now(), keys: [] };
      }
      if (follow) {
        process.stderr.write(
          `watching${filterText ? ` ${filterText}` : " everything"} — ctrl-c to stop\n`,
        );
      }
      const printEvent = (ev: Record<string, unknown>): void => {
        if (asJson) {
          console.log(JSON.stringify(ev));
          return;
        }
        const when = new Date(Number(ev.at)).toISOString().replace("T", " ").slice(0, 19);
        const sats = Number(ev.sats) > 0 ? `${Number(ev.sats)} sats` : "";
        const arrow = ev.dir === "in" ? "←" : ev.dir === "out" ? "→" : "·";
        const who = ev.origin ? ` [${ev.origin}]` : "";
        const note = ev.detail ? ` — ${ev.detail}` : "";
        console.log(`${when} ${arrow} ${String(ev.type).padEnd(26)}${sats.padStart(11)}${who}${note}`);
      };
      for (;;) {
        const res = (await call("watchPoll", {
          filter: filterText,
          limit,
          ...(cursor ? { cursor } : {}),
          ...(follow ? { waitMs: 30_000 } : {}),
        })) as {
          result?: { events?: Array<Record<string, unknown>>; cursor?: { at: number; keys: string[] } };
          error?: { code?: string; message?: string };
        };
        if (res.error) {
          print(res);
          break;
        }
        for (const ev of res.result?.events ?? []) printEvent(ev);
        if (res.result?.cursor) cursor = res.result.cursor;
        if (!follow) break;
      }
      break;
    }
    case "market": {
      const [mSub, ...mRest] = rest;
      const mPos = mRest.filter((a) => !a.startsWith("--"));
      const mOrigin = flag(mRest, "origin");
      if (mSub === "browse" || mSub === undefined) {
        print(await call("marketBrowse", {
          ...(flag(mRest, "kind") !== undefined ? { kind: flag(mRest, "kind") } : {}),
        }));
      } else if (mSub === "fees") {
        print(await call("marketFees"));
      } else if (mSub === "buy" && mPos[0]) {
        print(await call("marketBuy", {
          listing: mPos[0],
          ...(mOrigin !== undefined ? { origin: mOrigin } : {}),
          ...(flag(mRest, "max") !== undefined ? { maxPrice: Number(flag(mRest, "max")) } : {}),
        }));
      } else if (mSub === "list" && mPos[0] && Number(mPos[1]) > 0) {
        print(await call("marketList", {
          outpoint: mPos[0],
          priceSats: Number(mPos[1]),
          ...(flag(mRest, "kind") !== undefined ? { kind: flag(mRest, "kind") } : {}),
          ...(flag(mRest, "token-id") !== undefined ? { tokenId: flag(mRest, "token-id") } : {}),
          ...(flag(mRest, "amount") !== undefined ? { tokenAmount: flag(mRest, "amount") } : {}),
          ...(flag(mRest, "title") !== undefined ? { title: flag(mRest, "title") } : {}),
          ...(flag(mRest, "image") !== undefined ? { image: flag(mRest, "image") } : {}),
          ...(flag(mRest, "fee-bps") !== undefined ? { feeBps: Number(flag(mRest, "fee-bps")) } : {}),
          ...(mOrigin !== undefined ? { origin: mOrigin } : {}),
        }));
      } else if (mSub === "cancel" && mPos[0]) {
        print(await call("marketCancel", { listing: mPos[0] }));
      } else if (mSub === "sync" && mPos[0] && mPos[1]) {
        print(await call("marketSync", { listing: mPos[0], txid: mPos[1] }));
      } else {
        console.error("usage: bsv market <browse [--kind=ordinal|bsv21]|fees|buy <listing> [--origin=name] [--max=sats]|list <outpoint> <priceSats> [--kind=bsv21 --token-id= --amount=] [--title=] [--fee-bps=] [--origin=name]  (ordinals lock on-chain, miner fee)|cancel <listing>  (unlocks on-chain)|sync <listing> <txid>>");
        process.exitCode = 2;
      }
      break;
    }
    case "probe": {
      const [pOrigin, pAction, pAmount] = rest.filter((a) => !a.startsWith("--"));
      if (!pOrigin || !pAction || !pAmount || !(Number(pAmount) > 0)) {
        console.error("usage: bsv probe <origin> <action> <amountSats> [--label=..] [--to=..] [--desc=..]");
        process.exitCode = 2;
        break;
      }
      print(await call("policyProbe", {
        origin: pOrigin,
        action: pAction,
        amountSats: Number(pAmount),
        ...(flag(rest, "label") !== undefined ? { label: flag(rest, "label") } : {}),
        ...(flag(rest, "to") !== undefined ? { to: flag(rest, "to") } : {}),
        ...(flag(rest, "desc") !== undefined ? { description: flag(rest, "desc") } : {}),
      }));
      break;
    }
    case "jev": {
      const [jSub, ...jRest] = rest;
      if (jSub === "status" || jSub === undefined) {
        print(await call("jevStatus"));
        break;
      }
      if (jSub !== "decide") {
        console.error("usage: bsv jev <status|decide>");
        process.exitCode = 2;
        break;
      }
      const stateRaw = flag(jRest, "state");
      const questionsRaw = flag(jRest, "questions");
      if (stateRaw === undefined || questionsRaw === undefined) {
        console.error("usage: bsv jev decide --state <json|text|@file> --questions <json|@file> [--model=m]");
        process.exitCode = 2;
        break;
      }
      let state: unknown;
      let questions: unknown;
      try {
        const stateText = argText(stateRaw);
        try {
          state = JSON.parse(stateText);
        } catch {
          state = stateText; // a plain string is a valid state
        }
        questions = JSON.parse(argText(questionsRaw));
      } catch (e) {
        console.error(`jev decide: ${e instanceof Error ? e.message : e}`);
        process.exitCode = 2;
        break;
      }
      print(await call("jevDecide", {
        state,
        questions,
        ...(flag(jRest, "model") ? { model: flag(jRest, "model") } : {}),
      }));
      break;
    }
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
    case "stream": {
      const [stSub, ...stRest] = rest;
      const stArg = stRest.find((a) => !a.startsWith("--"));
      if (stSub === "start") {
        const payee = stArg ?? flag(rest, "to");
        const rate = flag(rest, "rate");
        const every = flag(rest, "every") ?? "5m";
        const max = flag(rest, "max");
        const board = flag(rest, "board");
        if (!payee || !rate || !max || !board) {
          console.error("usage: bsv stream start <address> --rate <sats/min> --every <60s|5m|1h> --max <total sats> --board <board> [--name <n>]");
          process.exitCode = 2;
          break;
        }
        print(await call("streamStart", {
          name: flag(rest, "name") ?? payee.slice(0, 12),
          payee, rate: Number(rate), every, max: Number(max), board,
          ...(flag(rest, "agent") !== undefined ? { agent: flag(rest, "agent") } : {}),
        }));
      } else if (stSub === "beat" && stArg) {
        const text = flag(rest, "text") ?? stRest.filter((a) => !a.startsWith("--"))[1];
        print(await call("streamBeat", {
          id: stArg,
          ...(text ? { text } : {}),
          ...(flag(rest, "agent") !== undefined ? { agent: flag(rest, "agent") } : {}),
        }));
      } else if (stSub === "list" || stSub === undefined) {
        print(await call("streamList"));
      } else if (stSub === "ticks" && stArg) {
        print(await call("streamTicks", {
          id: stArg,
          ...(flag(rest, "limit") ? { limit: Number(flag(rest, "limit")) } : {}),
        }));
      } else if (stSub === "pause" && stArg) {
        print(await call("streamPause", { id: stArg }));
      } else if (stSub === "resume" && stArg) {
        print(await call("streamResume", { id: stArg }));
      } else if ((stSub === "stop" || stSub === "cancel") && stArg) {
        print(await call("streamStop", { id: stArg }));
      } else {
        console.error("usage: bsv stream <start|beat|list|ticks|pause|resume|stop>");
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
      } else if (xSub === "serve" || xSub === "menu") {
        print(await call("serveMenu"));
      } else if (xSub === "price" && xArg) {
        const price = flag(rest, "price") ?? xRest.filter((a) => !a.startsWith("--"))[1];
        if (price === undefined) {
          print(await call("servePrice", { method: xArg }));
        } else {
          print(await call("servePrice", { method: xArg, price: Number(price) }));
        }
      } else if (xSub === "sales") {
        print(await call("serveSales", {
          ...(flag(rest, "limit") ? { limit: Number(flag(rest, "limit")) } : {}),
        }));
      } else {
        console.error("usage: bsv x402 <pay <url> [--method=M] [--data=JSON] [--origin=name]|receipts|attest [--days=N] [--to=<key>]|serve|price <method> [--price N]|sales>");
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
          console.error("usage: bsv msg send <@name|identityKey> --text <message>");
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
        console.error("usage: bsv msg <send <@name|identityKey> --text <msg>|sync|list|show <id>|ack <id>|status|register <username>>");
        process.exitCode = 2;
      }
      break;
    }
    case "p2p": {
      const [p2pSub] = rest;
      if (p2pSub === "status" || p2pSub === undefined) {
        print(await call("p2pStatus"));
      } else if (p2pSub === "peers") {
        print(await call("p2pPeers"));
      } else {
        console.error("usage: bsv p2p <status|peers>");
        process.exitCode = 2;
      }
      break;
    }
    case "contact": {
      const [cSub, ...cRest] = rest;
      const cArg = cRest.find((a) => !a.startsWith("--"));
      if (cSub === "list" || cSub === undefined) {
        print(await call("contactList"));
      } else if (cSub === "add" && cArg) {
        const [name, key, address] = cRest.filter((a) => !a.startsWith("--"));
        const note = flag(cRest, "note");
        if (!name || !key) {
          console.error("usage: bsv contact add <name> <identityKey> [address] [--note=..]");
          process.exitCode = 2;
          break;
        }
        print(await call("contactAdd", {
          name, identityKey: key,
          ...(address ? { address } : {}),
          ...(note !== undefined ? { note } : {}),
        }));
      } else if (cSub === "remove" && cArg) {
        print(await call("contactRemove", { name: cArg }));
      } else if (cSub === "lookup" && cArg) {
        print(await call("contactLookup", { who: cArg }));
      } else {
        console.error("usage: bsv contact <list|add <name> <identityKey> [address]|remove <name>|lookup <who>>");
        process.exitCode = 2;
      }
      break;
    }
    case "me": {
      const name = rest.find((a) => !a.startsWith("--"));
      print(name ? await call("profileSet", { name }) : await call("profileGet"));
      break;
    }
    case "pay": {
      const [who, satsRaw] = rest.filter((a) => !a.startsWith("--"));
      const note = flag(rest, "note") ?? flag(rest, "for");
      if (!who || !(Number(satsRaw) > 0)) {
        console.error("usage: bsv pay <@name|identityKey|address> <sats> [--note=..]");
        process.exitCode = 2;
        break;
      }
      print(await call("pay", {
        to: who,
        sats: Number(satsRaw),
        ...(note !== undefined ? { note } : {}),
      }));
      break;
    }
    case "faucet": {
      const [fSub] = rest;
      if (fSub === "claim") {
        print(await call("faucetClaim"));
      } else if (fSub === "status" || fSub === undefined) {
        print(await call("faucetStatus"));
      } else {
        console.error("usage: bsv faucet <status|claim>");
        process.exitCode = 2;
      }
      break;
    }
    case "torrent": {
      const [tSub, ...tRest] = rest;
      const tArg = tRest.find((a) => !a.startsWith("--"));
      if (tSub === "list" || tSub === undefined) {
        print(await call("torrentList"));
      } else if (tSub === "seed" && tArg) {
        const name = flag(rest, "name");
        print(await call("torrentShare", { path: tArg, ...(name !== undefined ? { name } : {}) }));
      } else if (tSub === "fetch" && tArg) {
        const peer = flag(rest, "peer");
        const out = flag(rest, "out");
        const isFile = tArg.endsWith(".torrent") || tArg.includes("/");
        print(await call("torrentFetch", {
          ...(isFile ? { torrentFile: tArg } : { infoHash: tArg }),
          ...(peer !== undefined ? { peer } : {}),
          ...(out !== undefined ? { out } : {}),
        }));
      } else if (tSub === "peers" && tArg) {
        print(await call("torrentPeers", { infoHash: tArg }));
      } else if (tSub === "remove" && tArg) {
        print(await call("torrentRemove", { infoHash: tArg, ...(rest.includes("--delete") ? { deleteFile: true } : {}) }));
      } else {
        console.error("usage: bsv torrent <list|seed <file> [--name=..]|fetch <infohash|file.torrent> [--peer host:port] [--out path]|peers <infohash>|remove <infohash> [--delete]>");
        process.exitCode = 2;
      }
      break;
    }
    case "request": {
      const [rSub, ...rRest] = rest;
      const rArgs = rRest.filter((a) => !a.startsWith("--"));
      if (rSub === "pay" && rArgs[0]) {
        print(await call("requestPay", { id: rArgs[0] }));
      } else if (rSub === "decline" && rArgs[0]) {
        print(await call("requestDecline", { id: rArgs[0] }));
      } else if (rSub === "import" && rArgs[0]) {
        print(await call("requestImport", { code: rArgs[0] }));
      } else if (rSub === "code" && rArgs[0]) {
        const res = (await call("requestCode", { id: rArgs[0] })) as Record<string, unknown>;
        delete res.dataUrl;
        print(res);
      } else if (rSub === "list" || rSub === undefined) {
        print(await requestListForCli());
      } else {
        const who = rSub === "create" ? rArgs[0] : rSub;
        const satsRaw = rSub === "create" ? rArgs[1] : rArgs[0];
        if (!who || !(Number(satsRaw) > 0)) {
          console.error("usage: bsv request <@name|identityKey|address> <sats> [--memo=..] [--expires=7d] | request pay|decline|code <id> | request import <code> | request list");
          process.exitCode = 2;
          break;
        }
        const memo = flag(rest, "memo");
        const expires = flag(rest, "expires");
        const res = (await call("requestCreate", {
          to: who,
          sats: Number(satsRaw),
          ...(memo !== undefined ? { memo } : {}),
          ...(expires !== undefined ? { expires } : {}),
        })) as Record<string, unknown>;
        delete res.dataUrl;
        print(res);
      }
      break;
    }
    case "receipt": {
      const [rcSub, ...rcRest] = rest;
      const rcArg = rcRest.find((a) => !a.startsWith("--"));
      if (rcSub === "list" || rcSub === undefined) {
        print(await call("receiptList"));
      } else if (rcSub === "show" && rcArg) {
        print(await call("receiptShow", { id: rcArg }));
      } else if (rcSub === "issue") {
        const request = flag(rest, "request");
        const txid = flag(rest, "txid");
        const to = flag(rest, "to");
        const amount = flag(rest, "amount");
        const memo = flag(rest, "memo");
        if (!request && !(txid && to && Number(amount) > 0)) {
          console.error('usage: bsv receipt issue --request <id> | --txid <txid> --to <@name|key|address> --amount <sats> [--memo "..."]');
          process.exitCode = 2;
          break;
        }
        print(await call("receiptIssue", {
          ...(request ? { request } : {}),
          ...(txid ? { txid } : {}),
          ...(to ? { to } : {}),
          ...(amount && Number(amount) > 0 ? { amount: Number(amount) } : {}),
          ...(memo !== undefined ? { memo } : {}),
        }));
      } else {
        console.error('usage: bsv receipt <list|show <id>|issue --request <id>|issue --txid <txid> --to <who> --amount <sats> [--memo ".."]>');
        process.exitCode = 2;
      }
      break;
    }
    case "sign": {
      const msg = flag(rest, "message") ?? rest.filter((a) => !a.startsWith("--")).join(" ");
      if (!msg.trim()) {
        console.error('usage: bsv sign --message "text"');
        process.exitCode = 2;
        break;
      }
      print(await call("signMessage", { message: msg }));
      break;
    }
    case "board": {
      const [bSub, ...bRest] = rest;
      const arg = bRest.find((a) => !a.startsWith("--"));
      const text = flag(bRest, "text") ?? flag(bRest, "message");
      if (bSub === "list" || bSub === undefined) {
        print(await call("boardList"));
      } else if (bSub === "create" && arg) {
        const members = flags(bRest, "member");
        const posters = flags(bRest, "poster");
        print(await call("boardCreate", {
          name: arg,
          mode: bRest.includes("--open") ? "open" : "members",
          members,
          posters,
        }));
      } else if (bSub === "kick" && arg) {
        const who = bRest.filter((a) => !a.startsWith("--"))[1];
        if (!who) {
          console.error("usage: bsv board kick <board> <@name|identityKey>");
          process.exitCode = 2;
          break;
        }
        print(await call("boardKick", { board: arg, who }));
      } else if (bSub === "thread" && arg) {
        print(await call("boardThread", { id: arg }));
      } else if (bSub === "remove" && arg) {
        print(await call("boardRemove", { name: arg }));
      } else if (bSub === "join" && arg) {
        print(await call("boardJoin", { code: arg }));
      } else if (bSub === "key" && arg) {
        print(await call("boardKey", { name: arg }));
      } else if (bSub === "invite" && arg) {
        const who = bRest.filter((a) => !a.startsWith("--"))[1];
        if (!who) {
          console.error("usage: bsv board invite <board> <@name|identityKey>");
          process.exitCode = 2;
          break;
        }
        print(await call("boardInvite", { board: arg, to: who }));
      } else if (bSub === "post" && arg && text) {
        print(await call("boardPost", {
          board: arg,
          text,
          ...(flag(bRest, "kind") !== undefined ? { kind: flag(bRest, "kind") } : {}),
          ...(flags(bRest, "ref").length ? { refs: flags(bRest, "ref") } : {}),
          ...(flag(bRest, "reply") !== undefined ? { replyTo: flag(bRest, "reply") } : {}),
          ...(flag(bRest, "agent") !== undefined ? { agent: flag(bRest, "agent") } : {}),
        }));
      } else if (bSub === "get" && arg) {
        print(await call("boardGet", {
          board: arg,
          ...(flag(bRest, "since") !== undefined ? { since: Number(flag(bRest, "since")) } : {}),
          ...(flag(bRest, "limit") !== undefined ? { limit: Number(flag(bRest, "limit")) } : {}),
          ...(flag(bRest, "remote") !== undefined ? { remote: flag(bRest, "remote") } : {}),
        }));
      } else if (bSub === "reply" && arg && text) {
        print(await call("boardReply", {
          id: arg,
          text,
          ...(flag(bRest, "agent") !== undefined ? { agent: flag(bRest, "agent") } : {}),
        }));
      } else if (bSub === "wait" && arg) {
        print(await call("boardWait", {
          board: arg,
          timeoutMs: waitMs(flag(bRest, "timeout"), 30000),
          ...(flag(bRest, "reply") !== undefined ? { replyTo: flag(bRest, "reply") } : {}),
          ...(flag(bRest, "from") !== undefined ? { from: flag(bRest, "from") } : {}),
          ...(flag(bRest, "agent") !== undefined ? { agent: flag(bRest, "agent") } : {}),
          ...(flag(bRest, "mention") !== undefined ? { mention: flag(bRest, "mention") } : {}),
        }));
      } else if (bSub === "ask" && arg && text) {
        print(await call("boardAsk", {
          board: arg,
          text,
          waitMs: waitMs(flag(bRest, "wait"), 30000),
          ...(flag(bRest, "to") !== undefined ? { to: flag(bRest, "to") } : {}),
          ...(flag(bRest, "agent") !== undefined ? { agent: flag(bRest, "agent") } : {}),
        }));
      } else if (bSub === "subscribe") {
        const boards = [arg, ...flags(bRest, "board")].filter((b): b is string => Boolean(b));
        if (!boards.length) {
          console.error("usage: bsv board subscribe <board>[,<board2>…]");
          process.exitCode = 2;
          break;
        }
        await boardSubscribe(boards.flatMap((b) => b.split(",").filter(Boolean)));
      } else {
        console.error(
          'usage: bsv board <list|create <name> [--open] [--member @who]… [--poster agent]|remove <name>|kick <board> <who>|join <keyCode>|key <name>|invite <board> <who>|thread <postId>|post <board> --text "…" [--kind note|request|result|artifact] [--ref …]… [--reply <id>]|get <board> [--since ms] [--limit n] [--remote <who>]|reply <id> --text "…"|wait <board> [--timeout 30s] [--reply <id>] [--from <who>] [--mention agent]|ask <board> --text "…" [--to <agent>] [--wait 30s]|subscribe <board>[,<board2>]>',
        );
        process.exitCode = 2;
      }
      break;
    }
    case "memory": {
      const [mSub, ...mRest] = rest;
      const mText = flag(mRest, "text") ?? flag(mRest, "message");
      if (mSub === "remember" && mText) {
        print(await call("memoryRemember", {
          text: mText,
          ...(flag(mRest, "tag") !== undefined ? { tag: flag(mRest, "tag") } : {}),
          ...(flag(mRest, "visibility") !== undefined ? { visibility: flag(mRest, "visibility") } : {}),
          ...(mRest.includes("--live") ? { live: true } : {}),
          ...(flag(mRest, "agent") !== undefined ? { agent: flag(mRest, "agent") } : {}),
        }));
      } else if (mSub === "recall") {
        print(await call("memoryRecall", {
          ...(flag(mRest, "query") !== undefined ? { query: flag(mRest, "query") } : {}),
          ...(flag(mRest, "tag") !== undefined ? { tag: flag(mRest, "tag") } : {}),
          ...(flag(mRest, "limit") !== undefined ? { limit: Number(flag(mRest, "limit")) } : {}),
          ...(mRest.includes("--include-public") ? { includePublic: true } : {}),
        }));
      } else if (mSub === "forget" && mRest.find((a) => !a.startsWith("--"))) {
        print(await call("memoryForget", { id: mRest.find((a) => !a.startsWith("--")) }));
      } else if (mSub === "init") {
        print(await call("memoryInit", {
          ...(mRest.includes("--live") ? { live: true } : {}),
          ...(flag(mRest, "pay-to") !== undefined ? { payTo: flag(mRest, "pay-to") } : {}),
        }));
      } else {
        console.error(
          'usage: bsv memory <remember --text "…" [--tag t] [--visibility private|public] [--live]|recall [--query q] [--tag t] [--limit n] [--include-public]|forget <id>|init [--live [--pay-to <addr>]]>',
        );
        process.exitCode = 2;
      }
      break;
    }
    case "evolve": {
      const [evSub, ...evRest] = rest;
      const evArg = evRest.find((a) => !a.startsWith("--"));
      if (evSub === "create") {
        const task = flag(rest, "task") ?? evArg;
        const rubric = flag(rest, "rubric");
        const prize = flag(rest, "prize");
        if (!task || !rubric || !prize) {
          console.error("usage: bsv evolve create --task <text> --rubric <text> --prize <sats> [--rounds N] [--fee <sats>] [--round <30m|6h|7d>]");
          process.exitCode = 2;
          break;
        }
        print(await call("evolveCreate", {
          task, rubric, prize: Number(prize),
          ...(flag(rest, "rounds") ? { rounds: Number(flag(rest, "rounds")) } : {}),
          ...(flag(rest, "fee") ? { entryFee: Number(flag(rest, "fee")) } : {}),
          ...(flag(rest, "round") ? { round: flag(rest, "round") } : {}),
        }));
      } else if (evSub === "submit" && evArg) {
        const text = flag(rest, "text");
        const payTo = flag(rest, "pay-to");
        if (!text || !payTo) {
          console.error("usage: bsv evolve submit <contest> --text <prompt ---OUTPUT--- output> --pay-to <addr> [--round N] [--parent <entry>] [--pay-now|--fee-txid <txid>]");
          process.exitCode = 2;
          break;
        }
        print(await call("evolveSubmit", {
          contest: evArg, text, payTo,
          ...(flag(rest, "round") ? { round: Number(flag(rest, "round")) } : {}),
          ...(flag(rest, "parent") ? { parent: Number(flag(rest, "parent")) } : {}),
          ...(evRest.includes("--pay-now") ? { payNow: true } : {}),
          ...(flag(rest, "fee-txid") ? { feeTxid: flag(rest, "fee-txid") } : {}),
          ...(flag(rest, "agent") !== undefined ? { agent: flag(rest, "agent") } : {}),
        }));
      } else if (evSub === "entries" && evArg) {
        print(await call("evolveEntries", {
          contest: evArg,
          ...(flag(rest, "round") ? { round: Number(flag(rest, "round")) } : {}),
        }));
      } else if (evSub === "score" && evArg) {
        print(await call("evolveScore", {
          contest: evArg,
          ...(flag(rest, "round") ? { round: Number(flag(rest, "round")) } : {}),
        }));
      } else if (evSub === "payout" && evArg) {
        print(await call("evolvePayout", {
          contest: evArg,
          ...(flag(rest, "round") ? { round: Number(flag(rest, "round")) } : {}),
        }));
      } else if (evSub === "close" && evArg) {
        print(await call("evolveClose", { contest: evArg }));
      } else if (evSub === "list" || evSub === undefined) {
        print(await call("evolveList"));
      } else {
        console.error("usage: bsv evolve <create|submit|entries|score|payout|close|list>");
        process.exitCode = 2;
      }
      break;
    }
    case "capsule": {
      const [capSub, ...capRest] = rest;
      const capArg = capRest.find((a) => !a.startsWith("--"));
      if (capSub === "lock") {
        const amount = flag(rest, "amount");
        const unlockAt = flag(rest, "unlock-at") ?? capArg;
        if (!amount || !unlockAt) {
          console.error("usage: bsv capsule lock --amount <sats> --unlock-at <height|ISO date|+blocks> [--to <addr>] [--message <text>]");
          process.exitCode = 2;
          break;
        }
        print(await call("capsuleLock", {
          amount: Number(amount), unlockAt,
          ...(flag(rest, "to") ? { to: flag(rest, "to") } : {}),
          ...(flag(rest, "message") ? { message: flag(rest, "message") } : {}),
        }));
      } else if (capSub === "claim" && capArg) {
        print(await call("capsuleClaim", { id: capArg }));
      } else if ((capSub === "cancel" || capSub === "close") && capArg) {
        print(await call("capsuleCancel", { id: capArg }));
      } else if (capSub === "list" || capSub === undefined) {
        print(await call("capsuleList"));
      } else {
        console.error("usage: bsv capsule <lock|claim <id>|cancel <id>|list>");
        process.exitCode = 2;
      }
      break;
    }
    case "cast": {
      const [castSub, ...castRest] = rest;
      const castArg = castRest.find((a) => !a.startsWith("--"));
      if (castSub === "add") {
        const title = flag(rest, "title") ?? castArg;
        const splits = flag(rest, "splits");
        if (!title || !splits) {
          console.error('usage: bsv cast add --title <name> --splits <addr:pct[,addr:pct…]> [--feed <url>] [--media <http(s) audio/video url>] [--live]');
          process.exitCode = 2;
          break;
        }
        print(await call("castAdd", {
          title, splits,
          ...(flag(rest, "feed") ? { feed: flag(rest, "feed") } : {}),
          ...(flag(rest, "media") ? { media: flag(rest, "media") } : {}),
          ...(rest.includes("--live") ? { live: true } : {}),
        }));
      } else if (castSub === "play" && castArg) {
        const rate = flag(rest, "rate");
        const max = flag(rest, "max");
        if (!rate || !max) {
          console.error("usage: bsv cast play <episode> --rate <sats/min> --max <total sats> [--every <60s|5m|1h>]");
          process.exitCode = 2;
          break;
        }
        print(await call("castPlay", {
          episode: castArg, rate: Number(rate), max: Number(max),
          ...(flag(rest, "every") ? { every: flag(rest, "every") } : {}),
        }));
      } else if ((castSub === "stop" || castSub === "close") && castArg) {
        print(await call("castStop", { id: castArg }));
      } else if (castSub === "live-start" && castArg) {
        print(await call("castLiveStart", { episode: castArg }));
      } else if (castSub === "live-stop" && castArg) {
        print(await call("castLiveStop", { id: castArg }));
      } else if (castSub === "live-list") {
        print(await call("castLiveList"));
      } else if (castSub === "episodes") {
        print(await call("castEpisodes"));
      } else if (castSub === "sessions" || castSub === "list" || castSub === undefined) {
        print(await call("castList"));
      } else {
        console.error("usage: bsv cast <add|play <episode>|stop <session>|episodes|sessions|live-start <episode>|live-stop <id>|live-list>");
        process.exitCode = 2;
      }
      break;
    }
    case "ord": {
      const [ordSub, ...ordRest] = rest;
      const ordArg = ordRest.find((a) => !a.startsWith("--"));
      if (ordSub === "list" || ordSub === undefined) {
        print(await call("ordList", flag(rest, "address") ? { address: flag(rest, "address") } : {}));
      } else if (ordSub === "inscribe" && ordArg) {
        print(await call("ordInscribe", {
          dataHex: ordArg,
          contentType: flag(rest, "type") ?? "text/plain",
          ...(flag(rest, "origin") !== undefined ? { origin: flag(rest, "origin") } : {}),
        }));
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
    case "twetch": {
      const [tSub, ...tRest] = rest;
      const tArg = tRest.find((a) => !a.startsWith("--"));
      if (tSub === "feed") {
        print(await call("twetchFeed", {
          limit: Number(flag(tRest, "limit") ?? 30),
          cursor: flag(tRest, "cursor"),
        }));
      } else if (tSub === "notifications" || tSub === "notifs") {
        print(await call("twetchNotifications", { limit: Number(flag(tRest, "limit") ?? 30) }));
      } else if (tSub === "status") {
        print(await call("twetchStatus"));
      } else if (tSub === "memes" || tSub === "meme") {
        print(await call("twetchMemes", {
          q: tArg,
          folder: flag(tRest, "folder"),
          tag: flag(tRest, "tag"),
          format: flag(tRest, "format"),
          sort: flag(tRest, "sort"),
          limit: Number(flag(tRest, "limit") ?? 30),
        }));
      } else if (tSub === "meme-folders" || tSub === "memefolders") {
        print(await call("twetchMemeFolders"));
      } else if (tSub === "user" && tArg) {
        print(await call("twetchUser", { id: Number(tArg), limit: Number(flag(tRest, "limit") ?? 20) }));
      } else if (tSub === "market" || tSub === "nft") {
        print(await call("twetchMarket", {
          view: tArg ?? flag(tRest, "view") ?? "listings",
          cursor: flag(tRest, "cursor"),
          limit: Number(flag(tRest, "limit") ?? 24),
        }));
      } else if (tSub === "post" && tArg) {
        const mediaPath = flag(tRest, "media");
        let mediaBase64: string | undefined;
        let mediaMime: string | undefined;
        if (mediaPath) {
          if (!fs.existsSync(mediaPath)) {
            console.error(`media file not found: ${mediaPath}`);
            process.exitCode = 2;
            break;
          }
          const bytes = fs.readFileSync(mediaPath);
          if (!bytes.length || bytes.length > 1_000_000) {
            console.error("media must be 1..1,000,000 bytes");
            process.exitCode = 2;
            break;
          }
          mediaBase64 = bytes.toString("base64");
          mediaMime = flag(tRest, "media-mime") ?? mediaMimeFor(mediaPath);
        }
        print(await call("twetchPost", {
          content: tArg,
          origin: flag(tRest, "origin") ?? "cli",
          mediaBase64,
          mediaMime,
        }));
      } else if (tSub === "index" && tArg) {
        print(await call("twetchIndex", { txid: tArg }));
      } else if (tSub === "account") {
        if (tArg === "import-seed" || tArg === "derive") {
          print(await call("twetchAccountImportFromSeed", { path: flag(tRest, "path") }));
        } else if (tArg === "import-phrase") {
          const phrase = await readSecret("Twetch recovery phrase (12/24 words, hidden): ");
          if (!phrase.trim()) {
            console.error("empty phrase — aborted");
            process.exitCode = 2;
            break;
          }
          print(await call("twetchAccountImportFromPhrase", { phrase, path: flag(tRest, "path") }));
        } else if (tArg === "import") {
          const wif = await readSecret("Twetch account private key (WIF, hidden): ");
          if (!wif.trim()) {
            console.error("empty key — aborted");
            process.exitCode = 2;
            break;
          }
          print(await call("twetchAccountImport", { wif }));
        } else if (tArg === "remove") {
          print(await call("twetchAccountRemove"));
        } else if (tArg === "status" || tArg === undefined) {
          print(await call("twetchStatus"));
        } else {
          console.error("usage: bsv twetch account <status|import|import-phrase|import-seed [--path=m/44'/0'/0'/0/0]|remove>");
          process.exitCode = 2;
        }
      } else {
        console.error("usage: bsv twetch <feed [--limit=N]|notifications [--limit=N]|post <text> [--media=<file> [--media-mime=<mime>]] [--origin=name]|index <txid>|memes [query] [--folder=slug] [--tag=x] [--format=all|gif|png|webp] [--sort=recent|top|popular|rarity] [--limit=N]|meme-folders|user <id> [--limit=N]|market [listings|sales|collections] [--cursor=C] [--limit=N]|status|account <status|import|import-phrase|import-seed|remove>>");
        process.exitCode = 2;
      }
      break;
    }
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
      if (!rest.includes("--no-open") && (process.platform === "linux" || process.platform === "darwin")) {
        const { openExternalCommand } = await import("./launcher.ts");
        const { execFile } = await import("node:child_process");
        const { cmd, args } = openExternalCommand(process.platform, started.result.authUrl);
        execFile(cmd, args, () => {
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
          if (process.platform === "linux" || process.platform === "darwin") {
            const { execFile } = await import("node:child_process");
            const { cmd, args } = openExternalCommand(process.platform, url);
            execFile(cmd, args, (e) => {
              if (e) console.error("(could not open browser automatically)");
            });
          }
        }
      } else {
        console.error("usage: bsv app <install <domain|https://host/path/> [--manifest-file <path>]|list|remove <domain>|update [<domain>|--all] [--approve-widening]|open <domain>>");
        process.exitCode = 2;
      }
      break;
    }
    case "_bridge": {
      // F2 runner internals: loopback relay for ONE app window. Spawned by
      // `app open`, never by hand. Dies with the window (or its parent).
      // The server itself lives in bridge-server.ts so the daemon can spawn
      // the exact same bridge from bridge-main.ts.
      const [bridgeDomain] = rest;
      const bridgePort = Number(flag(rest, "port") ?? 0);
      const bridgeToken = flag(rest, "token") ?? "";
      const bridgeDataDir = flag(rest, "data-dir");
      if (!bridgeDomain || !bridgePort || !bridgeToken) {
        console.error("usage: bsv _bridge <domain> --port=N --token=T");
        process.exitCode = 2;
        break;
      }
      const { runBridge } = await import("./bridge-server.ts");
      await runBridge(bridgeDomain, bridgePort, bridgeToken, bridgeDataDir);
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
      console.error("usage: bsv <status|create|import|unlock|lock|pending|balance|utxos|address|history|anchor|share|send|allow|deny|requests|probe|events|watch|market|jev|policies|doctor|agent|app|store|cert|basket|ord|bsv21|msg|x402|twetch|recovery|gig|nightshift|overlay|mcp [--agent=NAME]>");
      process.exitCode = 2;
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
