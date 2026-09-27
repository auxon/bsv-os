import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The MCP section of the README rotted once already: it advertised "Eight
// tools" long after the server had 44. These tests keep it honest, and keep
// the two setup traps documented — both of which cost real debugging time.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const mcp = fs.readFileSync(path.join(root, "packages/walletd/src/mcp.ts"), "utf8");

test("the documented MCP tool count matches the server", () => {
  const names = new Set([...mcp.matchAll(/name:\s*"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]));
  const advertised = /(\d+)\s+\*\*?tools|(\d+) tools/i.exec(readme);
  const claimed = Number(advertised?.[1] ?? advertised?.[2]);
  assert.ok(claimed > 0, "the README states a tool count");
  assert.equal(claimed, names.size, `README says ${claimed} tools; mcp.ts defines ${names.size}`);
  // And the sections it names should actually exist.
  for (const tool of ["memory_remember", "memory_recall", "memory_forget", "watch_poll", "x402_pay", "jev_decide"]) {
    assert.ok(names.has(tool), `${tool} is a real tool`);
    assert.ok(readme.includes(tool), `${tool} is documented`);
  }
});

test("the documented memory argument matches the schema, not a camelCase guess", () => {
  // The trap: the schema is snake_case (include_public) and unknown arguments
  // are dropped silently, so sending includePublic returns a plausible empty
  // result with no error. That looked exactly like broken memory.
  const at = mcp.indexOf('name: "memory_recall"');
  assert.ok(at > 0, "memory_recall found");
  const block = mcp.slice(at, mcp.indexOf("},\n  {", at));
  assert.ok(block.includes("include_public"), "the schema uses include_public");
  assert.ok(!block.includes("includePublic"), "the schema does not use camelCase");
  assert.ok(mcp.includes("args.include_public === true"), "and the handler reads the same name");
  // The README must warn about the silent drop, since it is the confusing part.
  assert.match(readme, /snake_case/, "documents the naming");
  assert.match(readme, /silently dropped/i, "warns that wrong names do not error");
});

test("the documented client wiring explains the PATH trap", () => {
  // Verified failure: under PATH=/usr/bin:/bin the server exits 127 with
  // "env: node: No such file or directory", because bsv's shebang needs node
  // and node comes from nvm. A login shell is the fix.
  assert.match(readme, /\/bin\/zsh/, "shows the login-shell command");
  assert.match(readme, /exec bsv mcp --agent=/, "and that it execs the server");
  assert.match(readme, /minimal environment|PATH=/, "names the failure condition");
  assert.match(readme, /No such file or directory|127/, "quotes the actual error");
  assert.match(readme, /-lc.*not.*-lic|-lic/, "explains why not an interactive shell");
  assert.match(readme, /snake_case/, "and the argument-naming trap next to it");
});
