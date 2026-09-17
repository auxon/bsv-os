/**
 * F2 runner launcher: open an installed Metanet app in a sandboxed
 * Chromium app window instead of the default browser.
 *
 * Sandboxing (per app window):
 * - `--app=<start_url>`: no browser chrome, the app is the window
 * - `--user-data-dir=<apps>/<appid>`: cookies/storage/history partitioned
 *   per app — apps never share a profile with each other or the browser
 * - `--load-extension=<bridge extension>`: the ONLY extension; injects the
 *   capability-scoped `window.bsv` (see packages/runner/extension)
 * - `--ignore-certificate-errors` ONLY for loopback hosts (local demos)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appIdFor, isLoopbackHost } from "./apps.ts";

export interface LaunchPlan {
  chromium: string;
  dataDir: string;
  extensionDir: string;
  url: string;
  args: string[];
  ignoreCert: boolean;
}

export function findChromium(): string | null {
  const candidates = [
    process.env.BSV_RUNNER_CHROMIUM,
    "/usr/local/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Extension source: installed package first, repo checkout second. */
export function findExtensionDir(): string | null {
  const here = path.dirname(new URL(import.meta.url).pathname); // .../dist or .../src
  const candidates = [
    "/usr/share/bsv-os/runner/extension",
    path.resolve(here, "..", "..", "runner", "extension"), // repo: packages/walletd/{dist,src} -> packages/runner
    path.resolve(here, "..", "runner", "extension"),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(path.join(c, "manifest.json"), fs.constants.R_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

export function appDataDir(domain: string): string {
  const base = process.env.BSV_WALLETD_DATA ?? path.join(os.homedir(), ".local/share/bsv-os");
  return path.join(base, "apps", appIdFor(domain));
}

export function withBridgeFragment(startUrl: string, port: number, token: string): string {
  const sep = startUrl.includes("#") ? "&" : "#";
  return `${startUrl}${sep}bsv-port=${port}&bsv-token=${encodeURIComponent(token)}`;
}

export function isLoopbackUrl(startUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(startUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function buildLaunchPlan(opts: {
  chromium: string;
  domain: string;
  startUrl: string;
  extensionDir: string;
  port: number;
  token: string;
}): LaunchPlan {
  const dataDir = appDataDir(opts.domain);
  const ignoreCert = isLoopbackUrl(opts.startUrl);
  const url = withBridgeFragment(opts.startUrl, opts.port, opts.token);
  const args = [
    `--app=${url}`,
    `--user-data-dir=${dataDir}`,
    `--load-extension=${opts.extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (ignoreCert) args.push("--ignore-certificate-errors");
  return { chromium: opts.chromium, dataDir, extensionDir: opts.extensionDir, url, args, ignoreCert };
}
