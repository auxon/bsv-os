/**
 * bsv-walletd entry: HTTPS on 127.0.0.1:2121 (pinned self-signed cert) +
 * Unix socket at $XDG_RUNTIME_DIR/bsv-walletd.sock. Same JSON-RPC shape on both.
 */
import fs from "node:fs";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import selfsigned from "selfsigned";
import { dispatch } from "./rpc.ts";
import { VERSION } from "./rpc.ts";

const PORT = Number(process.env.BSV_WALLETD_PORT ?? 2121);
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR ?? path.join(os.homedir(), ".local/share/bsv-os");
const SOCK = path.join(RUNTIME_DIR, "bsv-walletd.sock");
const CERT_DIR = path.join(os.homedir(), ".local/share/bsv-os");

function certPaths(): Promise<{ key: string; cert: string }> {
  return (async () => {
    fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
    const key = path.join(CERT_DIR, "walletd.key");
    const cert = path.join(CERT_DIR, "walletd.crt");
    if (!fs.existsSync(key) || !fs.existsSync(cert)) {
      const pems = await selfsigned.generate([{ name: "commonName", value: "bsv-walletd" }], {
        keySize: 2048,
        algorithm: "sha256",
        days: 825,
      });
      fs.writeFileSync(key, pems.private, { mode: 0o600 });
      fs.writeFileSync(cert, pems.cert, { mode: 0o600 });
    }
    return { key, cert };
  })();
}

async function readJson(req: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as unknown) : {};
}

function handler() {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: VERSION }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "POST only" }));
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "PARSE", message: "invalid JSON" }, id: null }));
      return;
    }
    const out = await dispatch(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  };
}

export async function main(): Promise<void> {
  const { key, cert } = await certPaths();
  const options = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  const serve = handler();

  await new Promise<void>((resolve) => {
    https.createServer(options, serve).listen(PORT, "127.0.0.1", resolve);
  });
  // eslint-disable-next-line no-console
  console.log(`bsv-walletd ${VERSION} https on 127.0.0.1:${PORT}`);

  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    if (fs.existsSync(SOCK)) fs.rmSync(SOCK);
  } catch {
    /* ignore */
  }
  const unix = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      // newline-delimited JSON frames
      const jobs: Array<Promise<void>> = [];
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        jobs.push(
          (async () => {
            try {
              socket.write(`${JSON.stringify(await dispatch(JSON.parse(line)))}\n`);
            } catch {
              socket.write(`${JSON.stringify({ error: { code: "PARSE", message: "invalid JSON" }, id: null })}\n`);
            }
          })(),
        );
      }
      void Promise.all(jobs);
    });
  });
  await new Promise<void>((resolve) => {
    unix.listen(SOCK, resolve);
  });
  // eslint-disable-next-line no-console
  console.log(`bsv-walletd socket on ${SOCK}`);
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  void main();
}
