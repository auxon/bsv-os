// Inscribe media as a 1Sat ordinal.
//
// The daemon's ordInscribe takes `dataHex` + `contentType`, never a file
// path — which is why this works in a browser at all. The CLI's
// `bsv ord inscribe <hex>` takes hex on the command line, so it has never
// been a usable path for a real file.
//
// Hard ceiling: MAX_INSCRIPTION_BYTES = 256 KiB in the daemon. That fits
// images, audio clips, documents and short clips; it does NOT fit video
// files, and the UI says so before you pick rather than after you spend.
"use strict";

import { rpc, tryRpc } from "../lib/rpc.js";
import { esc, fmtSats, short, copy, confirmDialog, pickFile, sha256Hex, toHex, fmtBytes, contentTypeFor, isPreviewable } from "../lib/ui.js";
import { kv, rows, chip } from "./common.js";

/** Mirror of the daemon's MAX_INSCRIPTION_BYTES. */
const MAX_BYTES = 256 * 1024;

/**
 * Fee estimate, fitted to two live measurements from the daemon:
 *   8 B     ->    275 sats
 *   256 KiB -> 263,510 sats
 * The daemon prices at FEE_SATS_PER_KB = 1000 (1 sat per byte), so cost
 * scales with the file — this is emphatically NOT a flat "a few sats"
 * operation. A fixed +2000 was wrong in both directions: 7x too high for a
 * small file, and it hid how expensive a large one is. This form is within
 * 0.04% at both ends, plus a 100-sat margin so we never under-promise.
 */
function estimateFeeSats(size) {
  const n = Math.max(0, Number(size) || 0);
  return Math.ceil(n + 267 + n * 0.00419) + 100;
}

export const inscribe = {
  id: "inscribe",
  title: "Inscribe",
  group: "Money",
  note: `Mint any file up to ${fmtBytes(MAX_BYTES)} as a 1Sat ordinal — the content lands on chain, not just a reference to it. Fees run about 1 sat per byte, so a large file is not cheap.`,
  async load(ctx) {
    // Reset the staged file on every navigation so a stale blob never gets
    // inscribed after the user comes back to this view.
    ctx.data.picked = null;
    ctx.data.result = null;
    ctx.data.error = null;
    const [list, bal] = await Promise.all([tryRpc("ordList"), tryRpc("balance")]);
    ctx.data.recent = list.ok ? (list.value?.ordinals ?? []).slice(0, 6) : [];
    // Needed to tell the user whether they can actually afford the file
    // before they pick it, not after the daemon says "insufficient funds".
    ctx.data.balance = bal.ok ? (bal.value?.confirmed ?? 0) + (bal.value?.unconfirmed ?? 0) : 0;
  },
  render(ctx) {
    const picked = ctx.data.picked;
    const result = ctx.data.result;
    const balance = ctx.data.balance ?? 0;
    return (
      `<div class="split">` +
        `<div class="card" style="max-width:560px">` +
          `<h3>Inscribe a file</h3>` +
          `<p class="dim">The file's bytes are hex-encoded in this window and sent to the daemon, which builds the inscription and broadcasts it. Nothing about your filesystem is exposed.</p>` +
          (picked ? pickedCard(picked, balance) : pickButton()) +
          (picked ? inscribeButton(picked, balance) : "") +
        `</div>` +
        (result ? resultCard(result) : `<div class="card"><h3>What you get</h3>` +
          `<ul class="dim" style="padding-left:18px;margin:6px 0">` +
            `<li>The content itself, on chain — viewable by anyone, forever.</li>` +
            `<li>A 1 sat output that makes it transferable and tradeable.</li>` +
            `<li>A permanent indexer link, shown below once mined.</li>` +
          `</ul>` +
          `<div class="notice">Inscribing is <b>not</b> reversible and the content is <b>public</b>. Do not inscribe anything private. Size ceiling is ${fmtBytes(
            MAX_BYTES,
          )} — that covers images, audio, documents and short clips, but not video files.</div>` +
        `</div>`) +
      `</div>` +
      (ctx.data.recent?.length
        ? `<h2 class="sec">Recently held</h2>` +
          rows(ctx.data.recent, (o) =>
            `<div class="row"><span class="grow">${esc(o.contentType ?? "binary")} · ${fmtBytes(o.contentLength ?? 0)}</span>` +
            `<span class="mono dim">${esc(short(o.outpoint ?? "", 10))}</span>` +
            `<span class="actions">` +
              (o.contentUrl ? `<button class="btn tiny" data-view="${esc(o.contentUrl)}">View</button>` : "") +
            `</span></div>`)
        : "")
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const go = e.target.closest("[data-go]");
      if (go) {
        // A staged file is discarded when leaving the view (load() resets it),
        // so revoke its preview URL rather than leaking a blob.
        if (ctx.data.picked?.previewUrl) URL.revokeObjectURL(ctx.data.picked.previewUrl);
        return ctx.go(go.dataset.go);
      }
      const pick = e.target.closest("[data-pick]");
      if (pick) return chooseFile(ctx, pick);

      const mint = e.target.closest("[data-inscribe]");
      if (mint) {
        const picked = ctx.data.picked;
        if (!picked) return;
        if (picked.tooBig) {
          return ctx.fail(
            new Error(
              `${picked.name} is ${fmtBytes(picked.size)}, over the ${fmtBytes(MAX_BYTES)} inscription ceiling. ` +
                `Shrink it first, or use bsv share to anchor just its hash.`,
            ),
          );
        }
        if (
          !(await confirmDialog(
            "Inscribe on chain",
            `${picked.name} · ${fmtBytes(picked.size)} · ${picked.contentType}. This is permanent and public, and costs about ${fmtSats(
              estimateFeeSats(picked.size),
            )}.`,
            "Inscribe",
          ))
        )
          return;
        mint.disabled = true;
        mint.textContent = "Inscribing…";
        try {
          // One-shot: the daemon defaults the destination to this wallet.
          const res = await rpc("ordInscribe", {
            dataHex: picked.hex,
            contentType: picked.contentType,
            memo: [picked.name],
          });
          ctx.data.result = { ...res, name: picked.name, contentType: picked.contentType, size: picked.size };
          ctx.toast(`Inscribed · fee ${fmtSats(res?.fee ?? 0)}`);
          root.innerHTML = inscribe.render(ctx);
          inscribe.bind(root, ctx);
        } catch (err) {
          ctx.fail(err);
        } finally {
          mint.disabled = false;
          mint.textContent = "Inscribe on chain";
        }
        return;
      }

      const clear = e.target.closest("[data-clear]");
      if (clear) {
        if (ctx.data.picked?.previewUrl) URL.revokeObjectURL(ctx.data.picked.previewUrl);
        ctx.data.picked = null;
        root.innerHTML = inscribe.render(ctx);
        inscribe.bind(root, ctx);
        return;
      }
      const cp = e.target.closest("[data-copy]");
      if (cp) return copy(cp.dataset.copy, "Copied");
      const v = e.target.closest("[data-view]");
      if (v) return ctx.openExternal(v.dataset.view);
      const ex = e.target.closest("[data-explorer]");
      if (ex) return ctx.openExplorer(ex.dataset.explorer);
    });
  },
};

async function chooseFile(ctx, btn) {
  const file = await pickFile();
  if (!file) return;
  btn.disabled = true;
  btn.textContent = "Reading…";
  try {
    const contentType = contentTypeFor(file);
    const tooBig = file.size > MAX_BYTES || file.size < 1;
    // Hex doubles the payload, so guard the wire size too.
    const hexTooBig = file.size * 2 > MAX_BYTES * 2;
    ctx.data.picked = {
      name: file.name,
      size: file.size,
      contentType,
      // Stash an object URL for a local preview; revoke the old one first.
      previewUrl: isPreviewable(contentType) ? URL.createObjectURL(new Blob([file.bytes], { type: contentType })) : null,
      hex: tooBig || hexTooBig ? null : toHex(file.bytes),
      sha256: await sha256Hex(file.bytes),
      tooBig,
    };
    ctx.data.result = null;
  } catch (err) {
    ctx.fail(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Choose a file…";
  }
  const host = document.querySelector("#view");
  if (host) {
    host.innerHTML = inscribe.render(ctx);
    inscribe.bind(host, ctx);
  }
}

function pickButton() {
  return `<div class="card-actions"><button class="btn primary" data-pick>Choose a file…</button></div>`;
}

function pickedCard(p, balance = 0) {
  const fee = estimateFeeSats(p.size);
  const affordable = balance >= fee;
  const preview = p.previewUrl
    ? /^image\//.test(p.contentType)
      ? `<img src="${esc(p.previewUrl)}" alt="" style="max-width:100%;max-height:220px;border-radius:10px;border:1px solid var(--line)">`
      : /^video\//.test(p.contentType)
        ? `<video src="${esc(p.previewUrl)}" controls style="max-width:100%;max-height:220px;border-radius:10px"></video>`
        : /^audio\//.test(p.contentType)
          ? `<audio src="${esc(p.previewUrl)}" controls style="width:100%"></audio>`
          : ""
    : "";
  return (
    `<div class="card-top"><div class="grow"><h3>${esc(p.name)}</h3>` +
    `<div class="card-sub">${esc(p.contentType)}</div></div>${chip(fmtBytes(p.size))}</div>` +
    (preview ? `<div>${preview}</div>` : "") +
    kv([
      ["size", `${fmtBytes(p.size)} of ${fmtBytes(MAX_BYTES)}`],
      ["estimated fee", `~${fmtSats(fee)}`],
      ["wallet balance", fmtSats(balance)],
      ["sha256", p.sha256],
    ]) +
    (p.tooBig
      ? `<div class="notice bad">Too large to inscribe. The ceiling is ${fmtBytes(MAX_BYTES)}; this file is ${fmtBytes(
          p.size,
        )}. Video files in particular will not fit — use <b>Share</b> to anchor the hash instead.</div>`
      : affordable
        ? `<div class="notice">Costs about <b>${fmtSats(fee)}</b> — the content is written on chain, so the fee scales with the file at roughly 1 sat per byte. It will be public and permanent.</div>`
        : `<div class="notice bad">You cannot afford this yet: it needs about <b>${fmtSats(
            fee,
          )}</b> and the wallet holds ${fmtSats(balance)}. Inscribing costs chain space proportional to the file, so a ${fmtBytes(
            p.size,
          )} file needs roughly ${fmtSats(Math.ceil(p.size))} sats of it. Fund the wallet, or shrink the file.</div>`)
  );
}

function inscribeButton(p, balance = 0) {
  const blocked = p.tooBig || balance < estimateFeeSats(p.size);
  return (
    `<div class="card-actions">` +
      `<button class="btn primary" data-inscribe ${blocked ? "disabled" : ""}>Inscribe on chain</button>` +
      `<button class="btn" data-clear>Choose another</button>` +
    `</div>`
  );
}

function resultCard(r) {
  return (
    `<div class="card"><h3>Inscribed</h3>` +
    `<div class="card-meta">${chip("broadcast", "info")}${chip(fmtBytes(r.size ?? 0))}${chip(r.contentType ?? "")}</div>` +
    kv([
      ["file", r.name],
      ["txid", `<span class="mono">${esc(r.txid ?? "")}</span>`],
      ["fee", fmtSats(r.fee ?? 0)],
    ]) +
    `<p class="dim">It shows up under <b>Collectibles</b> once it confirms. Transferring it uses the outpoint.</p>` +
    `<div class="card-actions">` +
      `<button class="btn" data-copy="${esc(r.txid ?? "")}">Copy txid</button>` +
      `<button class="btn" data-explorer="${esc(r.txid ?? "")}">Open in explorer</button>` +
      `<button class="btn primary" data-go="collectibles">See it in Collectibles</button>` +
    `</div>` +
    `</div>`
  );
}

export default [inscribe];
