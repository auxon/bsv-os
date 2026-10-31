/**
 * Canonical hashes for listing tokens.
 *
 * Manifest hash is sha256 of key-order-stable JSON (same algorithm as
 * packages/walletd/src/apps.ts). Bundle hash is sha256 of the sorted
 * `path\\nfileSha256\\n` catalogue — the bytes of every file, not only
 * the manifest. A publisher key over the listing does not prove who
 * shipped the code unless this bundle hash is checked at install.
 */

const HEX = /^[0-9a-f]{64}$/;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return hexOf(new Uint8Array(buf));
}

export async function manifestHash(manifest: unknown): Promise<string> {
  return sha256Hex(stableStringify(manifest));
}

export interface BundleFile {
  path: string;
  /** Raw file bytes, or the file's sha256 when bytes are already hashed. */
  sha256?: string;
  bytes?: Uint8Array;
}

/** POSIX-style relative path: no leading slash, no `..`, forward slashes. */
export function normalizeBundlePath(raw: string): string {
  const cleaned = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0") || cleaned.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new Error(`invalid bundle path: ${raw}`);
  }
  return cleaned;
}

export async function fileSha256(file: BundleFile): Promise<string> {
  if (typeof file.sha256 === "string") {
    const h = file.sha256.toLowerCase();
    if (!HEX.test(h)) throw new Error(`invalid file sha256 for ${file.path}`);
    return h;
  }
  if (file.bytes) return sha256Hex(file.bytes);
  throw new Error(`bundle file ${file.path} has neither bytes nor sha256`);
}

/**
 * Root hash of a file tree. Files are sorted by normalized path; each
 * contributes `path\\n<sha256>\\n`. Same input, same hash, in Node and Workers.
 */
export async function bundleHash(files: BundleFile[]): Promise<string> {
  const rows: Array<{ path: string; sha: string }> = [];
  for (const f of files) {
    rows.push({ path: normalizeBundlePath(f.path), sha: await fileSha256(f) });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const catalog = rows.map((r) => `${r.path}\n${r.sha}\n`).join("");
  return sha256Hex(catalog);
}

export async function verifyBundleFiles(
  files: BundleFile[],
  expected: string,
): Promise<{ ok: true; hash: string } | { ok: false; hash: string; reason: string }> {
  const want = expected.toLowerCase();
  if (!HEX.test(want)) return { ok: false, hash: "", reason: "listing bundleHash is not 64 hex chars" };
  try {
    const hash = await bundleHash(files);
    if (hash !== want) return { ok: false, hash, reason: "bundle hash mismatch" };
    return { ok: true, hash };
  } catch (e) {
    return { ok: false, hash: "", reason: e instanceof Error ? e.message : String(e) };
  }
}

export function isSha256Hex(value: string): boolean {
  return HEX.test(value.toLowerCase());
}
