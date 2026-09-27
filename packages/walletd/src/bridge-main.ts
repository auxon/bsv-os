/**
 * Executable entry for the per-window runner bridge.
 *
 * Nothing imports this file — it is spawned as a child process by
 * `openInRunner` (see runner.ts). Kept separate from bridge-server.ts so the
 * server module stays import-safe for the CLI.
 *
 * Usage (internal, never by hand):
 *   node bridge-main.js <domain> --port=N --token=T [--data-dir=DIR]
 */
import { runBridge } from "./bridge-server.ts";

function flag(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const [domain] = process.argv.slice(2);
const port = Number(flag(process.argv, "port") ?? 0);
const token = flag(process.argv, "token") ?? "";
const dataDir = flag(process.argv, "data-dir");

if (!domain || !port || !token) {
  console.error("usage: bridge-main <domain> --port=N --token=T [--data-dir=DIR]");
  process.exit(2);
}

await runBridge(domain, port, token, dataDir);
