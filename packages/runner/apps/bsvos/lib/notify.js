// Notification + presence layer — the macOS stand-in for the Omarchy bar pill.
//
// The pill was an always-visible widget that showed lock state, balance and a
// pending-approval count, highlighted while requests were open, and summoned
// the panel when a new request appeared. A web page cannot be a menu bar
// item, so the always-visible half becomes:
//
//   - a compact status header pinned in the app (see app.js renderStatus)
//   - a real macOS notification the moment a new spend request appears
//
// eventsPoll is the daemon's long-poll (waitMs clamped to 0..60000). It is
// reachable over HTTP, unlike boardSubscribe, which only exists on the Unix
// socket and is therefore unusable from a page.
"use strict";

import { rpc, tryRpc } from "./rpc.js";

const NOTIFY_KEY = "bsvos.notify";

export function notificationsEnabled() {
  return localStorage.getItem(NOTIFY_KEY) !== "off";
}

export function setNotificationsEnabled(on) {
  localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");
  if (!on) notifications.close?.();
}

/** Ask for permission only in response to a user gesture, never on load. */
export async function requestNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  const result = await Notification.requestPermission();
  return Notification.permission;
}

export function notify(title, body) {
  if (!notificationsEnabled()) return false;
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  try {
    // tag collapses repeats of the same request; renotify keeps the count.
    const n = new Notification(title, { body, tag: "bsvos", renotify: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * Watch for new spend requests and announce them.
 *
 * `seen` is a real set held across polls, seeded on the first poll so a page
 * load never fires a burst of notifications for requests that were already
 * open. Callers that want the "unseen since launch" behaviour (the pill's
 * set-diff) get it from the first poll's return value.
 */
export function watchRequests({ onCount, onNew } = {}) {
  let seen = null;
  let stopped = false;

  async function poll() {
    while (!stopped) {
      const res = await tryRpc("policyPending", {});
      if (res.ok) {
        const requests = res.value?.requests ?? [];
        const ids = requests.map((r) => r.id);
        if (seen === null) {
          seen = new Set(ids);
        } else {
          const fresh = requests.filter((r) => !seen.has(r.id));
          for (const id of ids) seen.add(id);
          if (fresh.length) {
            const sats = fresh.reduce((n, r) => n + (Number(r.amount_sats) || 0), 0);
            notify(
              fresh.length === 1 ? "Spend request waiting" : `${fresh.length} spend requests waiting`,
              fresh.length === 1
                ? `${fresh[0].origin} wants ${fresh[0].amount_sats} sats (${fresh[0].action})`
                : `${sats} sats across ${fresh.length} origins — open bsvOS to review`,
            );
            onNew?.(fresh);
          }
        }
        onCount?.(requests.length, requests);
      }
      // eventsPoll doubles as a cheap keepalive + change signal, but the
      // request list is the thing we actually watch, so keep the cadence tight
      // and cheap rather than holding a long-poll open.
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  void poll();
  return () => {
    stopped = true;
  };
}

/** Compact one-line status for the header: the pill's text, in the app. */
export async function statusLine() {
  const [auth, pending] = await Promise.all([tryRpc("isAuthenticated"), tryRpc("pending")]);
  if (!auth.ok) return { tone: "bad", text: "daemon unreachable" };
  const st = auth.value ?? {};
  if (!st.hasWallet) return { tone: "bad", text: "no wallet — create one to begin" };
  const requests = await tryRpc("policyPending");
  const openCount = requests.ok ? (requests.value?.requests ?? []).length : 0;
  if (st.locked) {
    return {
      tone: "warn",
      text: openCount ? `locked · ${openCount} request${openCount === 1 ? "" : "s"} waiting` : "locked",
    };
  }
  const bal = await tryRpc("balance");
  const total = bal.ok ? (bal.value?.confirmed ?? 0) + (bal.value?.unconfirmed ?? 0) : 0;
  const inflight = pending.ok ? (pending.value?.tracked ?? []).length : 0;
  const parts = [`${(total / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} BSV`];
  if (inflight) parts.push(`${inflight} in flight`);
  if (openCount) parts.push(`${openCount} waiting`);
  return { tone: openCount ? "warn" : "ok", text: parts.join(" · ") };
}

export { rpc };
