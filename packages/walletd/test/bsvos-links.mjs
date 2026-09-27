// Verify every named import in the bsvOS bundle resolves to a real export.
// `node --check` only parses; it does not link, so a named import of
// something that does not exist passes it and then kills the entire module
// graph in the browser (the page goes blank, or silently keeps old modules).
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? ".";
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".js")) files.push(p);
  }
})(root);

function exportsOf(src) {
  const exp = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)) exp.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (t) exp.add(t.split(/\s+as\s+/).pop().trim());
    }
  }
  if (/export\s+default/.test(src)) exp.add("default");
  return exp;
}

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/import\s+([^;]*?)\s+from\s+["'](\.[^"']+)["']/g)) {
    const clause = m[1];
    const rel = m[2];
    const target = path.normalize(path.join(path.dirname(f), rel));
    if (!fs.existsSync(target)) {
      console.log("MISSING FILE   ", f, "->", rel);
      bad++;
      continue;
    }
    const texp = exportsOf(fs.readFileSync(target, "utf8"));
    const braces = clause.match(/\{([^}]*)\}/);
    if (!braces) continue;
    for (const raw of braces[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!texp.has(name)) {
        console.log("MISSING EXPORT ", f, "imports", name, "from", rel);
        bad++;
      }
    }
  }
}
console.log(bad === 0 ? "OK: every named import resolves." : `BROKEN: ${bad} import(s)`);
process.exit(bad === 0 ? 0 : 1);
