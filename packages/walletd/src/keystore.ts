/**
 * Pluggable secret storage for custody — the ONLY place key material touches disk.
 *
 * Backends:
 * - "keychain" (default): OS keyring via keytar (Keychain on macOS,
 *   Secret Service on Linux). The OS login session is the auth factor.
 * - "file": AES-256-GCM encrypted file, for headless/server Linux with no
 *   Secret Service. Explicit opt-in ONLY:
 *
 *     BSV_WALLETD_KEYSTORE=file
 *     BSV_WALLETD_KEYSTORE_PASSWORD=<encryption password>   # required
 *     BSV_WALLETD_KEYSTORE_FILE=<path>                      # optional
 *
 * The file backend never touches keytar (lazy import), so the daemon runs
 * where libsecret can't. The password must come from the environment —
 * there is no default, no prompt, and no weak fallback. Missing password
 * fails fast at startup, not at first wallet op.
 *
 * File layout (0600): JSON { salt, iv, tag, data } — data is the GCM
 * ciphertext of {"service:account": "secret", ...}. Key = scrypt(password).
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Keystore {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export class KeystoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "KeystoreError";
    this.code = code;
  }
}

function keyOf(service: string, account: string): string {
  return `${service}\0${account}`;
}

/** Default backend: OS keyring. keytar loads lazily so file-mode never needs it. */
class KeychainKeystore implements Keystore {
  private async keytar() {
    return (await import("keytar")).default;
  }
  async getPassword(service: string, account: string): Promise<string | null> {
    return (await this.keytar()).getPassword(service, account);
  }
  async setPassword(service: string, account: string, password: string): Promise<void> {
    await (await this.keytar()).setPassword(service, account, password);
  }
  async deletePassword(service: string, account: string): Promise<boolean> {
    return (await this.keytar()).deletePassword(service, account);
  }
}

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Headless backend: single encrypted file. */
export class FileKeystore implements Keystore {
  readonly file: string;
  private password: string;

  constructor(file?: string, password?: string) {
    const dataDir =
      process.env.BSV_WALLETD_DATA ?? join(homedir(), ".local/share/bsv-os");
    this.file =
      file ?? process.env.BSV_WALLETD_KEYSTORE_FILE ?? join(dataDir, "keystore.enc");
    const pw = password ?? process.env.BSV_WALLETD_KEYSTORE_PASSWORD ?? "";
    if (!pw) {
      throw new KeystoreError(
        "NO_PASSWORD",
        "BSV_WALLETD_KEYSTORE=file needs BSV_WALLETD_KEYSTORE_PASSWORD set " +
          "(put it in the 0600 walletd.env, never in shell history)",
      );
    }
    this.password = pw;
  }

  private readAll(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    let envelope: { salt: string; iv: string; tag: string; data: string };
    try {
      envelope = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new KeystoreError("CORRUPT", `keystore file unreadable: ${this.file}`);
    }
    const key = scryptSync(
      this.password,
      Buffer.from(envelope.salt, "base64"),
      32,
      SCRYPT_OPTS,
    );
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plain =
        decipher.update(Buffer.from(envelope.data, "base64"), undefined, "utf8") +
        decipher.final("utf8");
      return JSON.parse(plain) as Record<string, string>;
    } catch {
      throw new KeystoreError(
        "DECRYPT_FAILED",
        "keystore decryption failed — wrong BSV_WALLETD_KEYSTORE_PASSWORD or corrupt file",
      );
    }
  }

  private writeAll(entries: Record<string, string>): void {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(this.password, salt, 32, SCRYPT_OPTS);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data =
      cipher.update(JSON.stringify(entries), "utf8", "base64") + cipher.final("base64");
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.file,
      JSON.stringify({
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data,
      }),
      { mode: 0o600 },
    );
    chmodSync(this.file, 0o600);
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    return this.readAll()[keyOf(service, account)] ?? null;
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    const entries = this.readAll();
    entries[keyOf(service, account)] = password;
    this.writeAll(entries);
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const entries = this.readAll();
    const k = keyOf(service, account);
    if (!(k in entries)) return false;
    delete entries[k];
    this.writeAll(entries);
    return true;
  }
}

export function getKeystore(): Keystore {
  const which = (process.env.BSV_WALLETD_KEYSTORE ?? "keychain").toLowerCase();
  if (which === "file") return new FileKeystore();
  if (which === "keychain") return new KeychainKeystore();
  throw new KeystoreError(
    "BAD_BACKEND",
    `unknown BSV_WALLETD_KEYSTORE=${which} (want "keychain" or "file")`,
  );
}
