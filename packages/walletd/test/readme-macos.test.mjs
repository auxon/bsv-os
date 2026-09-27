import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The README is the only install path most people will ever read, so it gets
// the same treatment as code: every command it tells a macOS user to run must
// actually exist, and every file it links must actually be there.

// test/ -> walletd/ -> packages/ -> repo root
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const cli = fs.readFileSync(path.join(root, "packages/walletd/src/cli.ts"), "utf8");
const installer = fs.readFileSync(path.join(root, "scripts/install-macos.sh"), "utf8");

test("README: every bsv command in the macOS guide exists in the CLI", () => {
  // The macOS setup section only.
  const start = readme.indexOf("### macOS");
  assert.ok(start > 0, "macOS section exists");
  const section = readme.slice(start, readme.indexOf("\n## ", start));
  const commands = [...section.matchAll(/\bbsv ([a-z]+)/g)].map((m) => m[1]);
  assert.ok(commands.length >= 8, `found ${commands.length} commands to check`);
  for (const c of new Set(commands)) {
    assert.ok(new RegExp(`case "${c}"`).test(cli), `bsv ${c} is a real command`);
  }
});

test("README: install-macos.sh verbs are real", () => {
  const start = readme.indexOf("### macOS");
  const section = readme.slice(start, readme.indexOf("\n## ", start));
  for (const verb of [...section.matchAll(/install-macos\.sh\s+(\w+)/g)].map((m) => m[1])) {
    assert.ok(new RegExp(`^    ${verb}\\)`, "m").test(installer), `install-macos.sh ${verb} is a real verb`);
  }
});

test("README: relative links resolve", () => {
  const links = [...readme.matchAll(/\]\((?!https?:|#)([^)#]+)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, "there are relative links");
  for (const link of new Set(links)) {
    assert.ok(fs.existsSync(path.join(root, link)), `${link} exists`);
  }
});

test("README: the shell-app anchor actually resolves", () => {
  // GitHub slugifies "## The shell app (`apps/bsvos/`)" to the-shell-app-appsbsvos
  const runnerReadme = fs.readFileSync(path.join(root, "packages/runner/README.md"), "utf8");
  const heading = runnerReadme.split("\n").find((l) => l.startsWith("## The shell app"));
  assert.ok(heading, "shell app heading exists in the runner README");
  const slug = heading
    .replace(/^#+ /, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  assert.ok(readme.includes(`#${slug}`), `README links to #${slug}`);
});

test("README: the PATH gotcha is documented, because the installer does not do it", () => {
  // install-macos.sh symlinks ~/.local/bin/bsv but only *warns* that it is
  // not on PATH. Without this note a fresh install looks broken.
  assert.ok(/only \*warn\*|only warn/.test(readme), "explains that the installer only warns");
  assert.ok(/\.local\/bin/.test(readme), "names the directory to add");
  assert.ok(/\.zshrc/.test(readme), "shows the shell snippet");
  // And the installer really does not write to a profile.
  assert.ok(!/\.zshrc|\.bashrc|profile/.test(installer), "installer does not touch shell profiles");
});

test("README: documents the confidential-client trap we actually hit", () => {
  // A client created without "public client" is rejected with invalid_client
  // and cannot be flipped afterwards. That cost real debugging time.
  const start = readme.indexOf("### macOS");
  const section = readme.slice(start, readme.indexOf("\n## ", start));
  assert.ok(/public client/i.test(section), "mentions the public client option");
  assert.ok(/invalid_client/.test(section), "names the actual error");
  assert.ok(/127\.0\.0\.1:2122\/callback/.test(section), "gives the exact redirect URI");
  assert.ok(/cannot be flipped|not be flipped|create a new one/i.test(section), "warns it cannot be changed in place");
});

test("README: the two app slots are documented", () => {
  const start = readme.indexOf("### macOS");
  const section = readme.slice(start, readme.indexOf("\n## ", start));
  assert.ok(/one app slot per host/i.test(section), "explains the one-slot-per-host model");
  assert.ok(/127\.0\.0\.1/.test(section) && /localhost/.test(section), "names both identities");
});
