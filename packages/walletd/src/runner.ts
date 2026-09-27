/**
 * Sandboxed app-window launch, shared by the CLI (`bsv app open`) and the
 * daemon (`appLaunch`, which the bundled Launcher app calls).
 *
 * The window is a Chromium `--app=` window on a private per-app profile with
 * the bsvOS extension loaded. The extension's `window.bsv` content script
 * relays to a per-window bridge child, which forwards to the daemon's
 * origin-scoped `appInvoke`. The 128-bit token rides in the URL fragment and
 * is never sent to the server; the bridge also pins the app's domain.
 *
 * Two callers, two lifetimes:
 *   - CLI: `wait: true` — block until the window closes, then reap the bridge.
 *   - Daemon: `wait: false` — return as soon as Chromium is spawned. The
 *     bridge child watches the profile itself and exits with the window, so
 *     nothing is orphaned when the RPC returns.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  buildLaunchPlan,
  findChromium,
  findExtensionDir,
  profilePidsFromPs,
} from "./launcher.ts";

export interface LaunchOptions {
  startUrl: string;
  domain: string;
  /** Script that implements the bridge child (argv: domain --port --token --data-dir). */
  bridgeEntry: string;
  /** Block until the window closes (CLI) or return once Chromium is up (daemon). */
  wait: boolean;
}

export interface LaunchResult {
  launched: boolean;
  /** Set when launched is false. */
  reason?: string;
}

/** PIDs whose command line carries this app's private browser profile. */
export async function profilePids(dataDir: string): Promise<number[]> {
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    // macOS: /proc does not exist — ask ps (only runs while waiting on a window).
    try {
      const { execFile } = await import("node:child_process");
      const out = await new Promise<string>((resolve, reject) => {
        execFile("ps", ["-axo", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => {
          if (e) reject(e);
          else resolve(stdout);
        });
      });
      return profilePidsFromPs(out, dataDir);
    } catch {
      return pids;
    }
  }
  entries = entries.filter((e) => /^\d+$/.test(e));
  for (const entry of entries) {
    try {
      const raw = fs.readFileSync(pathJoinProc(entry, "cmdline"), "utf8");
      const cmd = raw.split("\0").join(" ").trim();
      if (cmd.includes(`--user-data-dir=${dataDir}`)) pids.push(Number(entry));
    } catch {
      /* process vanished mid-scan */
    }
  }
  return pids;
}

function pathJoinProc(pid: string, file: string): string {
  return `/proc/${pid}/${file}`;
}

export async function waitForProfile(dataDir: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if ((await profilePids(dataDir)).length > 0) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function waitForProfileGone(dataDir: string): Promise<void> {
  for (;;) {
    if ((await profilePids(dataDir)).length === 0) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(p));
    });
  });
}

/**
 * Launch one sandboxed app window. Never throws for an ordinary failure to
 * start (no browser, no extension) — those come back as `launched: false` with
 * a reason, because every caller has a browser fallback.
 */
export async function openInRunner(opts: LaunchOptions): Promise<LaunchResult> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return { launched: false, reason: `no runner on ${process.platform}` };
  }
  const chromium = findChromium();
  if (!chromium) return { launched: false, reason: "no Chromium-family browser found" };
  const extensionDir = findExtensionDir();
  if (!extensionDir) return { launched: false, reason: "runner extension not installed" };

  const token = randomBytes(16).toString("hex");
  const port = await freePort();
  if (!port) return { launched: false, reason: "no free loopback port for the bridge" };

  const plan = buildLaunchPlan({
    chromium,
    domain: opts.domain,
    startUrl: opts.startUrl,
    extensionDir,
    port,
    token,
  });
  await mkdir(plan.dataDir, { recursive: true });

  const bridge = spawn(
    process.execPath,
    [opts.bridgeEntry, opts.domain, `--port=${port}`, `--token=${token}`, `--data-dir=${plan.dataDir}`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
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
    });
  } catch (e) {
    bridge.kill();
    return { launched: false, reason: e instanceof Error ? e.message : String(e) };
  }

  // Chromium re-execs (or hands off to an existing instance) within a few
  // hundred ms, so the spawned process exiting does NOT mean the window
  // closed. Tie the bridge to the app's browser process instead, found by
  // its unique --user-data-dir; otherwise the bridge dies under a live
  // window and window.bsv answers BRIDGE_DOWN.
  const child = spawn(plan.chromium, plan.args, { stdio: "ignore" });
  let spawnError: Error | null = null;
  child.on("error", (e) => {
    spawnError = e as Error;
  });

  const appeared = await waitForProfile(plan.dataDir, 15000);
  if (!appeared && spawnError) {
    bridge.kill();
    return { launched: false, reason: (spawnError as Error).message };
  }

  if (opts.wait) {
    // CLI: hold the process for the window's lifetime, then reap the bridge.
    try {
      if (appeared) await waitForProfileGone(plan.dataDir);
    } finally {
      bridge.kill();
    }
  }
  // wait:false — the bridge child watches the profile and exits with the
  // window on its own, so returning here orphans nothing.
  return { launched: true };
}
