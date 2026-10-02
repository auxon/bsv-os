/**
 * Phase 3: push notifications, so a spend request reaches the lock screen.
 *
 * The phone cannot run the daemon's monitor — iOS gives no long-lived process —
 * so the machine that holds the wallet is the one that must speak up when
 * something needs a human. That is what this does, on the same hook the policy
 * engine already uses when it queues an approval.
 *
 * Delivery needs an Apple developer key (an APNs .p8), a team id, and the app's
 * bundle id; without them this module is a no-op that says so once, because a
 * wallet whose owner never configured push should still work.
 *
 * The transport is injectable so the payload can be asserted without talking to
 * Apple, which is the only honest way to test this: real delivery requires a
 * real device.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export interface PushMessage {
  /** The device token, hex, as Apple issued it. */
  deviceToken: string;
  title: string;
  body: string;
  /** Delivered to the app, which decides what the notification's actions do. */
  userInfo: Record<string, unknown>;
  /** Collapses repeats: one pending-approval notification per origin. */
  collapseId?: string;
}

export interface PushTransport {
  send(message: PushMessage, authorization: string): Promise<{ ok: boolean; status: number; detail?: string }>;
}

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** PEM contents of the .p8, not a path. */
  privateKey: string;
  /** The app's bundle id. */
  topic: string;
  /** Overridden in tests; production is Apple's host. */
  host?: string;
}

/**
 * Read the APNs settings from the environment, or null when push is not set up.
 * Fails soft: an unconfigured wallet is a working wallet, and a missing push
 * key is not a reason to refuse a spend.
 */
export function apnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const keyId = env.BSV_APNS_KEY_ID?.trim();
  const teamId = env.BSV_APNS_TEAM_ID?.trim();
  const topic = env.BSV_APNS_TOPIC?.trim();
  const keyPath = env.BSV_APNS_KEY_P8?.trim();
  if (!keyId || !teamId || !topic || !keyPath) return null;
  let privateKey: string;
  try {
    privateKey = readFileSync(keyPath, "utf8");
  } catch {
    return null;
  }
  return { keyId, teamId, privateKey, topic, ...(env.BSV_APNS_HOST ? { host: env.BSV_APNS_HOST } : {}) };
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * The provider token Apple requires: an ES256 JWT, refreshed at most hourly.
 * Apple rejects tokens older than an hour and throttles regeneration, so this
 * caches until just under the limit rather than signing per push.
 */
export class ApnsTokenProvider {
  private cached: { token: string; mintedAt: number } | null = null;
  private readonly config: ApnsConfig;
  private readonly now: () => number;

  // Plain fields rather than parameter properties: those are not erasable
  // syntax, and the test loader strips types rather than compiling them.
  constructor(config: ApnsConfig, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
  }

  token(): string {
    const fresh = this.cached && this.now() - this.cached.mintedAt < 50 * 60 * 1000;
    if (fresh) return this.cached!.token;

    const header = b64url(JSON.stringify({ alg: "ES256", kid: this.config.keyId }));
    const claims = b64url(JSON.stringify({ iss: this.config.teamId, iat: Math.floor(this.now() / 1000) }));
    const signingInput = `${header}.${claims}`;
    const signer = createSign("SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign({ key: this.config.privateKey, dsaEncoding: "ieee-p1363" });
    const token = `${signingInput}.${b64url(signature)}`;
    this.cached = { token, mintedAt: this.now() };
    return token;
  }
}

/** The real transport: HTTP/2 to Apple. */
export class ApnsHttpTransport implements PushTransport {
  private readonly config: ApnsConfig;

  constructor(config: ApnsConfig) {
    this.config = config;
  }

  async send(message: PushMessage, authorization: string): Promise<{ ok: boolean; status: number; detail?: string }> {
    const host = this.config.host ?? "https://api.push.apple.com";
    const url = `${host}/3/device/${message.deviceToken}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `bearer ${authorization}`,
          "apns-topic": this.config.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          ...(message.collapseId ? { "apns-collapse-id": message.collapseId } : {}),
        },
        body: JSON.stringify({
          aps: {
            alert: { title: message.title, body: message.body },
            sound: "default",
            category: "BSV_APPROVAL",
            "interruption-level": "time-sensitive",
          },
          ...message.userInfo,
        }),
      });
      const detail = res.ok ? undefined : await res.text().catch(() => undefined);
      return { ok: res.ok, status: res.status, ...(detail ? { detail } : {}) };
    } catch (e) {
      return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}

/**
 * Send one push per device, and never let a delivery failure escape: a phone
 * that cannot be reached must not turn into a failed spend or a failed install.
 * A 410 from Apple means the token is dead, and the caller prunes it.
 */
export async function sendToDevices(
  transport: PushTransport,
  authorization: string,
  devices: Array<{ id: string; apnsToken: string }>,
  message: Omit<PushMessage, "deviceToken">,
): Promise<{ sent: number; failed: number; deadTokens: string[] }> {
  let sent = 0;
  let failed = 0;
  const deadTokens: string[] = [];
  for (const device of devices) {
    try {
      const result = await transport.send({ ...message, deviceToken: device.apnsToken }, authorization);
      if (result.ok) {
        sent++;
      } else {
        failed++;
        // 410 Gone / 400 BadDeviceToken: Apple says this token will never work.
        if (result.status === 410 || /BadDeviceToken|Unregistered/i.test(result.detail ?? "")) {
          deadTokens.push(device.apnsToken);
        }
      }
    } catch {
      failed++;
    }
  }
  return { sent, failed, deadTokens };
}

/** What the notification says. Kept here so the wording is testable. */
export function approvalPushContent(request: {
  origin: string;
  amountSats: number;
  action: string;
}): { title: string; body: string; userInfo: Record<string, unknown>; collapseId: string } {
  const sats = request.amountSats > 0 ? `${request.amountSats} sats` : "no fixed amount";
  return {
    title: "Spend request waiting",
    body: `${request.origin} wants ${sats} (${request.action})`,
    userInfo: {
      kind: "approval",
      origin: request.origin,
      action: request.action,
      amountSats: request.amountSats,
    },
    collapseId: `approval:${request.origin}`,
  };
}
