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

/** Chromium-family browser locations, in trust order, per platform. */
export function chromiumCandidates(
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  const out: string[] = [];
  if (env.BSV_RUNNER_CHROMIUM) out.push(env.BSV_RUNNER_CHROMIUM);
  if (platform === "darwin") {
    for (const home of [homedir, "/Applications"]) {
      out.push(
        path.join(home, "Google Chrome.app/Contents/MacOS/Google Chrome"),
        path.join(home, "Chromium.app/Contents/MacOS/Chromium"),
        path.join(home, "Brave Browser.app/Contents/MacOS/Brave Browser"),
        path.join(home, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
      );
    }
    out.push("/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary");
  } else {
    out.push(
      "/usr/local/bin/chromium",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/local/bin/google-chrome",
      "/usr/bin/google-chrome",
    );
  }
  return out;
}

export function findChromium(): string | null {
  const candidates = chromiumCandidates();
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

/** PIDs parsed from `ps -axo pid=,command=` lines carrying a browser profile. */
export function profilePidsFromPs(psOutput: string, dataDir: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m && m[2]!.includes(`--user-data-dir=${dataDir}`)) pids.push(Number(m[1]));
  }
  return pids;
}

/** Command that hands a URL to the desktop browser (Linux/macOS). */
export function openExternalCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  return platform === "darwin" ? { cmd: "open", args: [url] } : { cmd: "xdg-open", args: [url] };
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
