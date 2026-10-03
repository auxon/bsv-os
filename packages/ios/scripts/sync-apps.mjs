// Copies the stock runner apps into the iOS package's resources, where
// DirectoryAppAssetSource serves them to a standalone phone.
//
// They are generated, not tracked: 5.5 MB of assets duplicated in git would go
// stale the moment the runner apps change, and the two agents working this repo
// should not have to keep two copies in step. Run this before building a
// standalone-capable app bundle:
//
//   node packages/ios/scripts/sync-apps.mjs
//
// The folder itself is tracked (Resources/apps/.gitkeep), so a fresh clone
// builds without this step and simply carries no bundled apps.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerApps = path.resolve(here, "../../runner/apps");
const destination = path.resolve(here, "../Sources/BSVOSWallet/Resources/apps");

if (!existsSync(runnerApps)) {
  console.error(`no runner apps at ${runnerApps}`);
  process.exit(1);
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
writeFileSync(path.join(destination, ".gitkeep"), "");

const apps = readdirSync(runnerApps, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const app of apps) {
  cpSync(path.join(runnerApps, app), path.join(destination, app), { recursive: true });
}

console.log(`synced ${apps.length} apps: ${apps.join(", ")}`);
console.log(`  -> ${destination}`);
console.log("  (generated; gitignored except .gitkeep)");
