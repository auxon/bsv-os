// First-run setup wizard.
//
// The shell used to dead-end at "no wallet — run bsv create in a terminal",
// which made the README the onboarding. Linux had post-install.sh plus a
// panel; macOS had neither. This closes that gap.
//
// One deliberate exception: enrolling a wallet stays terminal-only.
// createWallet and importWallet are plain RPCs, and createWallet returns the
// 12-word phrase in its response — a browser must never be in that path, so
// this step hands the command to the terminal and polls until it lands. Every
// other step is safe in-app: unlock reads the OS keyring and needs no TTY,
// naming yourself is a local write, and the faucet claim is an ordinary
// confirmed spend through policy.
"use strict";

import { rpc, tryRpc } from "../lib/rpc.js";
import { esc, fmtInt, fmtSats, copy, confirmDialog } from "../lib/ui.js";
import { empty, kv, chip } from "./common.js";

/** Progress is derived from live state, never from a local flag. */
async function gather(ctx) {
  const [auth, prof, faucet, apps, oidc] = await Promise.all([
    tryRpc("isAuthenticated"),
    tryRpc("profileGet"),
    tryRpc("faucetStatus"),
    tryRpc("appList"),
    tryRpc("identityConfigStatus"),
  ]);
  const st = auth.ok ? auth.value ?? {} : {};
  const f = faucet.ok ? faucet.value : null;
  ctx.data.hasWallet = st.hasWallet === true;
  ctx.data.locked = st.locked !== false;
  ctx.data.identityKey = st.identityKey ?? null;
  ctx.data.name = prof.ok ? prof.value?.name ?? "" : "";
  ctx.data.funded = f?.funded === true;
  ctx.data.claimed = f?.claimed === true;
  ctx.data.faucetAmount = f?.amount ?? 0;
  ctx.data.appCount = apps.ok ? (apps.value?.apps ?? []).length : 0;
  ctx.data.oidc = oidc.ok ? oidc.value?.config ?? null : null;
}

function step(n, title, done, body, action) {
  return (
    `<div class="card step ${done ? "done" : "todo"}">` +
      `<div class="step-head">` +
        `<span class="step-num">${done ? "✓" : n}</span>` +
        `<div class="grow"><h3>${esc(title)}</h3></div>` +
        chip(done ? "done" : "next", done ? "ok" : "warn") +
      `</div>` +
      body +
      (action ?? "") +
    `</div>`
  );
}

export const setup = {
  id: "setup",
  title: "Setup",
  group: "Wallet",
  note: "One-time setup for this machine. Everything here is safe to run in the shell except enrolling the wallet, which stays in the terminal.",
  async load(ctx) {
    await gather(ctx);
    ctx.data.claimResult = null;
  },
  render(ctx) {
    const d = ctx.data;
    const steps = [
      step(
        1,
        "Enroll a wallet",
        d.hasWallet,
        `<p class="dim">The recovery phrase is shown once and must never pass through a browser, so this one step is terminal-only. Run it, then come back.</p>` +
          `<pre class="code">bsv create        # new wallet
bsv import        # or restore an existing 12-word phrase</pre>` +
          `<p class="dim">Both read the phrase from a hidden prompt, never from your shell history. Write the phrase down before doing anything else.</p>`,
        d.hasWallet
          ? ""
          : `<div class="card-actions">` +
            `<button class="btn" data-copy-cmd="bsv create">Copy <span class="mono">bsv create</span></button>` +
            `<button class="btn primary" data-recheck>I've run it — check again</button>` +
            `</div>`,
      ),
      step(
        2,
        "Unlock",
        d.hasWallet && !d.locked,
        d.hasWallet
          ? `<p class="dim">Reads the wallet seed from the macOS Keychain. No passphrase, no terminal. macOS asks once for Keychain access.</p>`
          : `<p class="dim">Available once a wallet is enrolled.</p>`,
        d.hasWallet && d.locked
          ? `<div class="card-actions"><button class="btn primary" data-unlock>Unlock wallet</button></div>`
          : "",
      ),
      step(
        3,
        "Name yourself",
        !!d.name,
        `<p class="dim">Peers see this instead of a raw key when you message or get paid.</p>` +
          `<form data-form="name">` +
          `<label class="field"><span>Display name</span><input name="name" value="${esc(d.name ?? "")}" placeholder="how peers see you"></label>` +
          `<div class="card-actions"><button class="btn ${d.name ? "" : "primary"}" type="submit">Save</button></div>` +
          `</form>`,
        "",
      ),
      step(
        4,
        "Starter sats",
        d.claimed,
        d.claimed
          ? `<p class="dim">Already claimed — this is a one-time grant per wallet.</p>`
          : d.funded
            ? `<p class="dim">This wallet is eligible for a one-off grant of ${fmtSats(d.faucetAmount)}.</p>` +
              `<div class="card-actions"><button class="btn primary" data-claim>Claim ${fmtSats(d.faucetAmount)}</button></div>`
            : `<p class="dim">Not eligible — the faucet needs a wallet that has never claimed before.</p>`,
        "",
      ),
      step(
        5,
        "Pick an app",
        d.appCount > 1,
        d.appCount > 1
          ? `<p class="dim">${d.appCount} installed. Manage them in the Apps tab.</p>`
          : `<p class="dim">Pick something to try. The shell itself is already installed; these share the one <span class="mono">localhost</span> slot, so installing one replaces the last.</p>` +
            `<div class="card-actions">` +
            `<button class="btn" data-install="localhost">Twetch</button>` +
            `<button class="btn" data-install="colosseum">Ordinal Colosseum</button>` +
            `<button class="btn" data-install="explorer">Chain Explorer</button>` +
            `</div>`,
        "",
      ),
      step(
        6,
        "Connect your Twetch account",
        !!d.oidc?.clientId,
        `<p class="dim">Optional. Links this wallet to a Twetch account for posting, the feed, and the market.</p>` +
          (d.oidc?.clientId
            ? kv([["client", d.oidc.clientId], ["callback", `http://127.0.0.1:${d.oidc.redirectPort}/callback`]])
            : `<p class="dim">Needs a public OIDC client from the issuer console. The Identity tab walks through it.</p>`) +
          `<div class="card-actions"><button class="btn" data-go="identity">Open Identity</button></div>`,
        "",
      ),
    ];

    const doneCount = [d.hasWallet, d.hasWallet && !d.locked, !!d.name, d.claimed, d.appCount > 1, !!d.oidc?.clientId].filter(Boolean).length;
    return (
      `<div class="card" style="max-width:760px;margin-bottom:14px">` +
        `<div class="step-head"><h3 class="grow">Setup progress</h3>${chip(`${doneCount} of 6`, doneCount === 6 ? "ok" : "warn")}</div>` +
        `<div class="bar ${doneCount === 6 ? "" : "gold"}"><i style="width:${Math.round((doneCount / 6) * 100)}%"></i></div>` +
        (doneCount === 6
          ? `<div class="notice ok" style="margin-top:12px">All set. The CLI still works for everything the shell does not cover.</div>`
          : `<div class="notice" style="margin-top:12px">You can stop and come back — progress is read from the daemon, not stored here.</div>`) +
      `</div>` +
      `<div class="steps">${steps.join("")}</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const cc = e.target.closest("[data-copy-cmd]");
      if (cc) return copy(cc.dataset.copyCmd, "Command copied — paste it in a terminal");

      if (e.target.closest("[data-recheck]")) {
        const btn = e.currentTarget;
        return ctx.run(async () => {
          btn.disabled = true;
          btn.textContent = "Checking…";
          await gather(ctx);
          const fresh = root.querySelector('[data-copy-cmd]');
          if (!fresh && ctx.data.hasWallet) {
            ctx.toast("Wallet found — welcome to bsvOS");
            await ctx.reload();
          } else {
            root.innerHTML = setup.render(ctx);
            setup.bind(root, ctx);
            if (!ctx.data.hasWallet) ctx.toast("No wallet yet — is the command still running?", true);
          }
        });
      }

      if (e.target.closest("[data-unlock]")) {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = "Unlocking…";
        return ctx
          .run(async () => {
            await rpc("unlock", {});
            ctx.toast("Unlocked");
            await ctx.reload();
          })
          .finally(() => {
            btn.disabled = false;
          });
      }

      if (e.target.closest("[data-claim]")) {
        if (!(await confirmDialog("Claim starter sats", `A one-off grant of ${fmtSats(ctx.data.faucetAmount)} to this wallet. Only once, ever.`, "Claim"))) return;
        return ctx.run(async () => {
          const res = await rpc("faucetClaim", {});
          ctx.toast(`${fmtSats(res?.amount ?? ctx.data.faucetAmount)} sent`);
          await ctx.reload();
        });
      }

      const inst = e.target.closest("[data-install]");
      if (inst) {
        const domain = inst.dataset.install;
        if (!(await confirmDialog("Install app", `${domain} will be able to ask to spend up to the cap in its manifest. You approve each request.`, "Install"))) return;
        return ctx.run(async () => {
          const res = await rpc("appInstall", { domain });
          ctx.toast(`${res?.app?.name ?? domain} installed`);
          await ctx.reload();
        });
      }

      const go = e.target.closest("[data-go]");
      if (go) return ctx.go(go.dataset.go);
    });

    root.addEventListener("submit", async (e) => {
      const form = e.target.closest('[data-form="name"]');
      if (!form) return;
      e.preventDefault();
      try {
        await rpc("profileSet", { name: form.name.value.trim() });
        ctx.toast("Name saved");
        await ctx.reload();
      } catch (err) {
        ctx.fail(err);
      }
    });
  },
};

export default [setup];
