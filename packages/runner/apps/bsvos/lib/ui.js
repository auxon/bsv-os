// Shared UI helpers.
//
// This module is where the three macOS blockers from the old panel are
// absorbed: `wl-copy` becomes navigator.clipboard, `xdg-open` becomes
// window.open, and native file dialogs become <input type="file"> (the
// caller hashes the bytes and hands a digest to the daemon).
"use strict";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── escaping / formatting ───────────────────────────────────────────────
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const fmtInt = (n) => Number(n ?? 0).toLocaleString("en-US");

export const fmtBsv = (sats) => `${(Number(sats ?? 0) / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} BSV`;

export const fmtSats = (n) => `${fmtInt(n)} sats`;

export function short(s, n = 10) {
  const v = String(s ?? "");
  return v.length > n * 2 ? `${v.slice(0, n)}…${v.slice(-n)}` : v;
}

export function timeAgo(unixSec) {
  if (!unixSec) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const when = (ms) => (ms ? new Date(Number(ms)).toLocaleString() : "—");

// ── toast ───────────────────────────────────────────────────────────────
let toastTimer;
export function toast(msg, bad = false) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 6500 : 2400);
}

// ── clipboard (replaces wl-copy) ─────────────────────────────────────────
export async function copy(text, label = "Copied") {
  const value = String(text ?? "");
  try {
    await navigator.clipboard.writeText(value);
    toast(label);
  } catch {
    // execCommand fallback for a denied clipboard permission.
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.("copy");
    ta.remove();
    toast(ok ? label : "Copy failed", !ok);
  }
}

// ── external URLs (replaces xdg-open) ────────────────────────────────────
export function openExternal(url) {
  if (!url) return;
  window.open(String(url), "_blank", "noopener");
}

// ── confirm + prompt dialogs (replace QtQuick.Dialogs) ──────────────────
export function confirmDialog(title, body, confirmLabel = "Confirm") {
  return new Promise((resolve) => {
    const m = modal(title, `<p>${esc(body)}</p>`, [
      { label: "Cancel", value: false },
      { label: confirmLabel, value: true, primary: true },
    ]);
    m.onClose = (value) => resolve(value === true);
    m.open();
  });
}

export function promptDialog(title, { label = "", placeholder = "", value = "", confirmLabel = "OK" } = {}) {
  return new Promise((resolve) => {
    const m = modal(
      title,
      `<label class="field"><span>${esc(label)}</span><input id="__prompt" placeholder="${esc(placeholder)}" value="${esc(value)}"></label>`,
      [
        { label: "Cancel", value: null },
        { label: confirmLabel, value: "__ok__", primary: true },
      ],
    );
    const input = $("#__prompt", m.el);
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          m.close(input.value);
        }
      });
      queueMicrotask(() => input.focus());
    }
    m.onClose = (v) => resolve(v === "__ok__" ? input?.value ?? "" : null);
    m.open();
  });
}

// ── generic modal ───────────────────────────────────────────────────────
export function modal(title, html, buttons = [{ label: "Close", value: null, primary: true }]) {
  const host = document.createElement("div");
  host.className = "modal";
  host.innerHTML =
    `<div class="modal-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">` +
      `<div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>` +
      `<div class="modal-body">${html}</div>` +
      `<div class="modal-foot">${buttons
        .map((b) => `<button class="btn ${b.primary ? "primary" : ""}" data-value="${esc(b.value ?? "")}">${esc(b.label)}</button>`)
        .join("")}</div>` +
    `</div>`;
  document.body.appendChild(host);

  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    host.remove();
    m.onClose?.(value);
  };
  const m = {
    el: host,
    open: () => host.classList.add("open"),
    close: (v) => finish(v),
    onClose: null,
  };
  $("[data-close]", host).addEventListener("click", () => finish(null));
  host.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-value]");
    if (btn) finish(btn.dataset.value);
    else if (e.target === host) finish(null);
  });
  document.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      finish(null);
    }
  });
  return m;
}

// ── file picker (replaces the Qt FileDialog) ────────────────────────────
/**
 * Pick a file and return `{name, size, arrayBuffer}`. The caller hashes it —
 * the daemon never needs a disk path, so nothing about the filesystem is
 * exposed and there is no path to sanitise.
 */
export function pickFile(accept = "") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      file.arrayBuffer().then((buf) => resolve({ name: file.name, size: file.size, bytes: new Uint8Array(buf) }));
    });
    // A cancelled picker fires no event in most browsers; the node is removed
    // on the next pick anyway, so a light cleanup is enough.
    input.click();
  });
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── form values ─────────────────────────────────────────────────────────
export function fieldValues(root) {
  const out = {};
  $$("[name]", root).forEach((el) => {
    out[el.name] = el.type === "checkbox" ? el.checked : el.value.trim();
  });
  return out;
}

export function intOr(value, fallback) {
  const n = Number.parseInt(String(value ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : fallback;
}
