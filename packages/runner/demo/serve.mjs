#!/usr/bin/env node
/**
 * Demo HTTPS server for the F2 runner click-through.
 *
 * Serves packages/runner/demo/ on https://127.0.0.1:8443/ with a throwaway
 * self-signed cert (IP SAN 127.0.0.1, 7 days) cached under
 * ~/.local/share/bsv-os/demo/. The runner passes
 * --ignore-certificate-errors for loopback hosts only, so no system trust
 * store is touched and nothing else accepts this cert.
 *
 * Usage: node packages/runner/demo/serve.mjs   (Ctrl-C to stop)
 */
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.BSV_WALLETD_DATA ?? path.join(os.homedir(), ".local/share/bsv-os");
const certDir = path.join(dir, "demo");
const keyFile = path.join(certDir, "key.pem");
const certFile = path.join(certDir, "cert.pem");

fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048",
    "-keyout", keyFile, "-out", certFile, "-days", "7", "-nodes",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "inherit" });
}

const MIME = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript" };

const server = https.createServer(
  { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) },
  (req, res) => {
    const url = new URL(req.url ?? "/", "https://127.0.0.1:8443");
    let file = path.normalize(path.join(here, url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
    if (!file.startsWith(here)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    });
  },
);

server.listen(8443, "127.0.0.1", () => {
  console.log("demo serving https://127.0.0.1:8443/ (Ctrl-C to stop)");
});
