// Local library search: pure functions over library-index.json rows.
// No DOM, no fetch — unit-tested in test/library.test.mjs.
// Row: { id, t (title), f (family|null), h (hook|null), u (mediaUrl),
//        p (previewUrl), g (tags[]) }

/** All distinct families present, most-common first. */
export function families(index) {
  const c = new Map();
  for (const r of index.rows ?? []) {
    if (r.f) c.set(r.f, (c.get(r.f) ?? 0) + 1);
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => ({ family: f, n }));
}

/**
 * Search + filter + rank. q matches title/tags/family/id (case-insensitive,
 * all words must hit somewhere). family restricts to one family.
 * hookFirst ("money") floats that hook to the top, stable otherwise.
 */
export function searchLibrary(index, { q = "", family = "", hookFirst = "", limit = 60 } = {}) {
  const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const r of index.rows ?? []) {
    if (family && r.f !== family) continue;
    if (words.length > 0) {
      const hay = `${r.t ?? ""} ${(r.g ?? []).join(" ")} ${r.f ?? ""} ${r.id ?? ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
    }
    out.push(r);
  }
  if (hookFirst) {
    const yes = [];
    const no = [];
    for (const r of out) (r.h === hookFirst ? yes : no).push(r);
    return [...yes, ...no].slice(0, Math.max(1, limit));
  }
  return out.slice(0, Math.max(1, limit));
}

/** Adapt an index row to the Twetch-item shape the caption flow expects. */
export function toItem(row) {
  return {
    id: row.id,
    mediaUrl: row.u,
    previewUrl: row.p,
    title: row.t || row.f || "untitled",
    url: row.w || "",
    format: /\.gif(\?|$)/i.test(row.u) ? "gif" : "",
    libraryFamily: row.f ?? null,
    libraryHook: row.h ?? null,
  };
}
