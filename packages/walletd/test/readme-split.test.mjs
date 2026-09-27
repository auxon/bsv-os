import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The front-end split is a product decision, not a bug, and the two agents on
// this repo need it stated or they will re-add features to both UIs. Guarding
// it with tests is the same treatment the macOS install guide gets.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const panelReadme = fs.readFileSync(path.join(root, "packages/shell/README.md"), "utf8");
const cli = fs.readFileSync(path.join(root, "packages/walletd/src/cli.ts"), "utf8");

test("README states the split and the rule for new features", () => {
  assert.match(readme, /front-end split/i, "the split is named");
  assert.match(readme, /not at parity|deliberately not/i, "and that divergence is intentional");
  // The decision rule, in the order it should be applied.
  assert.match(readme, /capability .{0,40}in `packages\/walletd`/i, "daemon first");
  assert.match(readme, /shell app[\s\S]{0,200}default home/i, "shell app is the default UI home");
  assert.match(readme, /panel only if it is wallet-critical/i, "panel is the exception, with a condition");
  assert.match(readme, /CLI-only is a valid answer/i, "and CLI-only is allowed");
  // The instruction aimed at whoever reads this next.
  assert.match(readme, /do not mirror a new feature across\s+both UIs/i, "explicit instruction to agents");
});

test("the panel README carries the scope note where a maintainer would look", () => {
  assert.match(panelReadme, /wallet-critical only/i, "scope is stated up front");
  assert.match(panelReadme, /bsvos/, "points at the shell app");
  assert.match(panelReadme, /Do \*\*not\*\* mirror/, "tells you not to chase parity");
  // The honest consequence: name what is missing, so nobody goes hunting.
  assert.match(panelReadme, /absent here/i, "warns that newer features are missing");
  for (const feature of ["sweep", "inscrib", "Twetch"]) {
    assert.ok(new RegExp(feature, "i").test(panelReadme), `names ${feature} as missing from the panel`);
  }
});

test("the split note does not rot: the features it calls missing really exist", () => {
  // If the panel is ever given one of these, the note becomes a lie.
  assert.match(cli, /case "sweep"/, "bsv sweep exists (claimed missing from the panel)");
  assert.match(cli, /case "ord"/, "bsv ord exists");
  assert.match(cli, /case "twetch"/, "bsv twetch exists");
  // And the shell app really is the bigger surface.
  const appDir = path.join(root, "packages/runner/apps/bsvos");
  const registry = fs.readFileSync(path.join(appDir, "views/index.js"), "utf8");
  assert.match(registry, /VIEWS/, "the shell app builds a view registry");
  const panel = fs.readFileSync(path.join(root, "packages/shell/plugin/Panel.qml"), "utf8");
  assert.ok(panel.split("\n").length > 1000, "the panel is still the large QML surface described");
});
