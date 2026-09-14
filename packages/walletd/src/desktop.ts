/**
 * Native launcher entries: installed Metanet apps get `.desktop` files so
 * they open from the Quickshell launcher like anything else. The Exec target
 * is `bsv app open`, which launches the sandboxed runner (per-app Chromium
 * profile + window.bsv bridge) and falls back to the default browser where
 * the runner is unavailable.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appIdFor, type AppRecord } from "./apps.ts";

export function applicationsDir(): string | null {
  if (process.platform !== "linux") return null;
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share");
  return path.join(base, "applications");
}

export function desktopFile(app: AppRecord): string {
  const safe = app.name.replace(/\n/g, " ").slice(0, 80);
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${safe}`,
    `Comment=Metanet app · ${app.domain}`,
    `Exec=bsv app open ${app.domain}`,
    "Icon=web-browser",
    "Terminal=false",
    "Categories=Network;",
    "",
  ].join("\n");
}

export async function writeDesktopEntry(app: AppRecord): Promise<string | null> {
  const dir = applicationsDir();
  if (!dir) return null; // non-Linux dev machines: registry still works
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `bsv-${appIdFor(app.domain)}.desktop`);
  await fs.promises.writeFile(file, desktopFile(app), { mode: 0o644 });
  return file;
}

export async function removeDesktopEntry(domain: string): Promise<void> {
  const dir = applicationsDir();
  if (!dir) return;
  try {
    await fs.promises.rm(path.join(dir, `bsv-${appIdFor(domain)}.desktop`), { force: true });
  } catch {
    /* ignore */
  }
}
