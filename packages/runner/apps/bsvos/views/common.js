// Render helpers shared by every view.
"use strict";

import { esc, fmtInt, fmtSats, confirmDialog } from "../lib/ui.js";

export const empty = (msg) => `<div class="empty">${esc(msg)}</div>`;

export const errorBox = (msg, retry) =>
  `<div class="error-box">${esc(msg)}${retry ? ` <button class="btn tiny" data-retry>Retry</button>` : ""}</div>`;

export const lockedBox = (msg = "Wallet is locked.") =>
  `<div class="notice">${esc(msg)} Unlock from the sidebar or the terminal (<span class="mono">bsv unlock</span>) to act.` +
  ` Reading still works while locked.</div>`;

export function kv(pairs) {
  const rows = pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join("");
  return rows ? `<dl class="kv">${rows}</dl>` : "";
}

export function rows(list, renderRow) {
  return `<div class="rows">${list.map(renderRow).join("")}</div>`;
}

export const chip = (text, tone = "") => `<span class="chip ${tone}">${esc(text)}</span>`;

export const satsChip = (n) => chip(Number(n) ? fmtSats(n) : "no spend cap", Number(n) ? "" : "warn");

/**
 * Gate a spend behind an explicit confirmation. The panel had no such gate —
 * it shelled out and let the policy engine be the only brake. Here the amount
 * and destination are always shown first, because a mis-click in a GUI is
 * cheaper to prevent than to reverse on-chain.
 */
export async function confirmSpend({ verb, amountSats, to, extra }) {
  const bits = [`${verb} ${fmtSats(amountSats)}`, to ? `to ${to}` : null, extra || null].filter(Boolean);
  return confirmDialog("Confirm spend", bits.join(" · "), verb);
}

/** Wrap an action so a failure surfaces the daemon's real code, never a throw. */
export function guard(ctx, busyBtn, label, fn) {
  return async (...args) => {
    const was = busyBtn?.textContent;
    if (busyBtn) {
      busyBtn.disabled = true;
      busyBtn.textContent = label;
    }
    try {
      await fn(...args);
    } catch (e) {
      ctx.fail(e);
    } finally {
      if (busyBtn) {
        busyBtn.disabled = false;
        busyBtn.textContent = was;
      }
    }
  };
}

export { fmtInt, fmtSats, esc };
