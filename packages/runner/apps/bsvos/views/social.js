// Social: system identity (Twetch OIDC + certificates), people, the
// encrypted inbox, nearby peers, and composing direct messages.
"use strict";

import { rpc, tryRpc, explain } from "../lib/rpc.js";
import { esc, fmtInt, fmtSats, short, timeAgo, when, copy, confirmDialog, promptDialog, intOr } from "../lib/ui.js";
import { empty, errorBox, kv, rows, chip } from "./common.js";

/**
 * The OIDC login round trip. The panel shelled out to `bsv login`, which
 * spawned the system browser and blocked for 10 minutes. The daemon already
 * owns the loopback callback server, so a page can drive the whole state
 * machine itself and just needs the user to click a link.
 */
async function runLogin(ctx, btn) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Waiting for Twetch…";
  let poll = null;
  try {
    const started = await rpc("identityLoginStart", { force: true });
    ctx.openExternal(started.authUrl);
    ctx.setNote("Finish signing in on the page that just opened, then come back here.");
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 10 * 60 * 1000;
      poll = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error("login timed out after 10 minutes"));
          return;
        }
        try {
          const st = await rpc("identityLoginStatus");
          if (st?.state === "done") {
            clearInterval(poll);
            resolve();
          } else if (st?.state === "error") {
            clearInterval(poll);
            reject(new Error(st.error || "sign-in failed"));
          }
        } catch (e) {
          clearInterval(poll);
          reject(e);
        }
      }, 1500);
    });
    ctx.toast("Signed in");
    await ctx.reload();
  } catch (e) {
    ctx.fail(e);
  } finally {
    clearInterval(poll);
    btn.disabled = false;
    btn.textContent = was;
  }
}

export const identity = {
  id: "identity",
  title: "Identity",
  group: "Identity",
  note: "Who you are on the network: your system sign-in, your identity key, and the certificates you hold.",
  async load(ctx) {
    const [sess, acct, certs, auth] = await Promise.all([
      tryRpc("identitySession"),
      tryRpc("twetchStatus"),
      tryRpc("certList"),
      tryRpc("isAuthenticated"),
    ]);
    ctx.data.session = sess.ok ? sess.value?.session ?? null : null;
    ctx.data.twetch = acct.ok ? acct.value : null;
    ctx.data.certs = certs.ok ? certs.value?.certs ?? [] : [];
    ctx.data.identityKey = auth.ok ? auth.value?.identityKey ?? null : null;
    ctx.data.disclosure = null;
    ctx.data.importNote = null;
  },
  render(ctx) {
    const { session, twetch, certs = [], identityKey } = ctx.data;
    return (
      `<div class="split">` +
        `<div class="card"><h3>System sign-in</h3>` +
          (session
            ? kv([
                ["handle", session.handle ? `@${session.handle}` : null],
                ["user", session.sub ? `#${session.sub}` : null],
                ["bound wallet key", session.walletIdentityKey ? short(session.walletIdentityKey, 10) : null],
                ["stale", session.stale ? "yes — sign in again" : "no"],
              ]) +
              `<div class="card-actions">` +
                `<button class="btn" data-login>Sign in again</button>` +
                `<button class="btn danger" data-logout>Sign out</button>` +
              `</div>`
            : `<p class="dim">Not signed in. Signing in links this wallet to your account for posting and payouts.</p>` +
              `<div class="card-actions"><button class="btn primary" data-login>Sign in with Twetch</button></div>`) +
        `</div>` +

        `<div class="card"><h3>Identity key</h3>` +
          `<p class="dim">Your stable key. Certificates below are signed by it.</p>` +
          `<div class="card-sub mono">${esc(identityKey ?? "—")}</div>` +
          (identityKey ? `<div class="card-actions"><button class="btn" data-copy="${esc(identityKey)}">Copy</button></div>` : "") +
        `</div>` +

        `<div class="card"><h3>Twetch posting key</h3>` +
          (twetch?.account?.address
            ? kv([
                ["address", twetch.account.address],
                ["linked user", twetch.account.verifiedUserId ? `#${twetch.account.verifiedUserId}` : "unverified"],
              ]) +
              `<div class="card-actions"><button class="btn" data-import-seed>Import from wallet seed</button></div>` +
              (ctx.data.importNote ? `<p class="dim">${esc(ctx.data.importNote)}</p>` : "")
            : `<p class="dim">No posting key imported yet.</p>` +
              `<div class="card-actions"><button class="btn" data-import-seed>Import from wallet seed</button></div>`) +
        `</div>` +
      `</div>` +

      `<h2 class="sec">Certificates (${certs.length})</h2>` +
      (certs.length
        ? rows(certs, (c) => {
            const state = c.revoked ? "revoked" : c.verified ? "verified" : "self-asserted";
            const fields = Object.entries(c.fields ?? {});
            return (
              `<div class="row" style="align-items:flex-start;flex-direction:column;gap:6px">` +
                `<div style="display:flex;align-items:center;gap:9px;width:100%">` +
                  `${chip(state, c.revoked ? "bad" : c.verified ? "ok" : "warn")}` +
                  `<span class="grow">${esc(c.type ?? "certificate")}${c.certifier ? ` · ${esc(c.certifier)}` : ""}</span>` +
                  `<span class="mono dim">${esc(short(c.id, 8))}</span>` +
                  `<span class="actions">` +
                    `<button class="btn tiny" data-disclose="${esc(c.id)}">Present</button>` +
                    `<button class="btn tiny danger" data-revoke-cert="${esc(c.id)}">Revoke</button>` +
                  `</span>` +
                `</div>` +
                (fields.length
                  ? `<div class="dim mono" style="padding-left:2px">${fields.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ")}</div>`
                  : "") +
              `</div>`
            );
          })
        : empty("No certificates held.")) +
      (ctx.data.disclosure
        ? `<div class="card" style="margin-top:12px"><h3>Disclosure</h3><pre class="code">${esc(
            JSON.stringify(ctx.data.disclosure, null, 2),
          )}</pre><p class="dim">The disclosure was recorded in the daemon's audit log.</p></div>`
        : "")
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const login = e.target.closest("[data-login]");
      if (login) return runLogin(ctx, login);
      if (e.target.closest("[data-logout]")) {
        if (!(await confirmDialog("Sign out", "Unlink your system account from this wallet?", "Sign out"))) return;
        try {
          await rpc("identityLogout", {});
          ctx.toast("Signed out");
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
        return;
      }
      const cp = e.target.closest("[data-copy]");
      if (cp) return copy(cp.dataset.copy, "Identity key copied");
      if (e.target.closest("[data-import-seed]")) {
        if (!(await confirmDialog("Import posting key", "Derive a posting key from the wallet seed and offer it to Twetch. The key material never leaves the daemon.", "Import"))) return;
        try {
          const res = await rpc("twetchAccountImportFromSeed", {});
          ctx.data.importNote = res?.matchesSession
            ? "Imported and matched your signed-in account."
            : res?.verifiedUserId
              ? `Imported, but it belongs to user #${res.verifiedUserId}, not your signed-in account.`
              : "Imported, but no matching Twetch account was found.";
          ctx.toast("Import finished");
          root.innerHTML = identity.render(ctx);
          identity.bind(root, ctx);
        } catch (err) { ctx.fail(err); }
        return;
      }
      const d = e.target.closest("[data-disclose]");
      if (d) {
        const fields = await promptDialog("Present certificate", {
          label: "Fields to disclose (comma separated, blank = all)",
          placeholder: "name,email",
          confirmLabel: "Present",
        });
        if (fields === null) return;
        const list = fields.split(",").map((s) => s.trim()).filter(Boolean);
        try {
          const res = await rpc("certShow", list.length ? { id: d.dataset.disclose, fields: list } : { id: d.dataset.disclose });
          ctx.data.disclosure = res?.disclosed ?? null;
          root.innerHTML = identity.render(ctx);
          identity.bind(root, ctx);
        } catch (err) { ctx.fail(err); }
        return;
      }
      const r = e.target.closest("[data-revoke-cert]");
      if (r) {
        if (!(await confirmDialog("Revoke certificate", "Revoking is permanent and recorded on chain.", "Revoke"))) return;
        try {
          await rpc("certRevoke", { id: r.dataset.revokeCert });
          ctx.toast("Revoked");
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
      }
    });
  },
};

export const people = {
  id: "people",
  title: "People",
  group: "Identity",
  note: "Your name on the network, and the people you know.",
  async load(ctx) {
    const [c, p] = await Promise.all([tryRpc("contactList"), tryRpc("profileGet")]);
    ctx.data.contacts = c.ok ? c.value?.contacts ?? [] : [];
    ctx.data.name = p.ok ? p.value?.name ?? "" : "";
  },
  render(ctx) {
    const contacts = ctx.data.contacts ?? [];
    return (
      `<div class="split">` +
        `<div class="card" style="max-width:420px"><h3>Your name</h3>` +
          `<form data-form="me"><label class="field"><span>Display name</span><input name="name" value="${esc(ctx.data.name ?? "")}" placeholder="how peers see you"></label>` +
          `<div class="card-actions"><button class="btn primary" type="submit">Save</button></div></form>` +
        `</div>` +
        `<div class="card" style="max-width:520px"><h3>Add someone</h3>` +
          `<form data-form="add">` +
            `<label class="field"><span>Name</span><input name="name" required></label>` +
            `<label class="field"><span>Identity key (66 hex chars)</span><input name="identityKey" spellcheck="false" required></label>` +
            `<label class="field"><span>Address (optional)</span><input name="address" spellcheck="false"></label>` +
            `<div class="card-actions"><button class="btn" type="submit">Add</button></div>` +
          `</form>` +
        `</div>` +
        `<div class="card"><h3>Contacts (${contacts.length})</h3>` +
          (contacts.length
            ? rows(contacts, (c) =>
                `<div class="row"><span class="grow">${esc(c.name ?? "—")}</span>` +
                `<span class="mono dim ellipsis">${esc(short(c.identityKey ?? "", 8))}</span>` +
                `<span class="actions">` +
                  `<button class="btn tiny" data-msg="${esc(c.name)}">Message</button>` +
                  `<button class="btn tiny" data-pay="${esc(c.name)}">Pay</button>` +
                `</span></div>`)
            : empty("No contacts yet.")) +
        `</div>` +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", (e) => {
      const m = e.target.closest("[data-msg]");
      if (m) {
        ctx.go("compose", { to: m.dataset.msg });
        return;
      }
      const p = e.target.closest("[data-pay]");
      if (p) ctx.go("pay", { preset: p.dataset.pay });
    });
    root.addEventListener("submit", async (e) => {
      const me = e.target.closest('[data-form="me"]');
      if (me) {
        e.preventDefault();
        try {
          await rpc("profileSet", { name: me.name.value.trim() });
          ctx.toast("Name saved");
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
        return;
      }
      const add = e.target.closest('[data-form="add"]');
      if (add) {
        e.preventDefault();
        const key = add.identityKey.value.trim();
        if (!/^[0-9a-fA-F]{66}$/.test(key)) return ctx.fail(new Error("identity key must be 66 hex characters"));
        try {
          await rpc("contactAdd", {
            name: add.name.value.trim(),
            identityKey: key,
            address: add.address.value.trim() || undefined,
          });
          ctx.toast("Contact added");
          add.reset();
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
      }
    });
  },
};

export const inbox = {
  id: "inbox",
  title: "Inbox",
  group: "Identity",
  note: "Encrypted messages. Plaintext only appears after an explicit Read, and stays in memory.",
  async load(ctx) {
    const sync = await tryRpc("msgSync");
    const list = await tryRpc("msgList");
    ctx.data.messages = list.ok ? list.value?.messages ?? [] : [];
    ctx.data.syncNote = sync.ok ? null : explain(sync.error);
    ctx.data.opened = ctx.data.opened ?? null;
  },
  render(ctx) {
    const list = ctx.data.messages ?? [];
    return (
      (ctx.data.syncNote ? `<div class="notice">Relay sync: ${esc(ctx.data.syncNote)}</div>` : "") +
      (list.length
        ? rows(list, (m) => {
            const canReply = /^[0-9a-fA-F]{66}$/.test(m.peer ?? "");
            return (
              `<div class="row" style="align-items:flex-start;flex-direction:column;gap:5px">` +
                `<div style="display:flex;align-items:center;gap:9px;width:100%">` +
                  `${chip(m.direction, m.direction === "in" ? "info" : "")}` +
                  `<span class="grow mono ellipsis">${esc(short(m.peer ?? "?", 8))}</span>` +
                  `<span class="dim">${timeAgo(Math.floor((m.createdAt ?? 0) / 1000))}</span>` +
                  `<span class="dim">${esc(m.transport ?? "")}</span>` +
                  `<span class="actions">` +
                    `<button class="btn tiny" data-read="${esc(m.id)}">Read</button>` +
                    (canReply ? `<button class="btn tiny" data-reply="${esc(m.peer)}">Reply</button>` : "") +
                    (!m.acked && m.direction !== "out" ? `<button class="btn tiny" data-ack="${esc(m.id)}">Ack</button>` : "") +
                  `</span>` +
                `</div>` +
                (ctx.data.opened?.id === m.id ? `<div class="dim">${esc(ctx.data.opened.text ?? "")}</div>` : "") +
              `</div>`
            );
          })
        : empty("Inbox is empty."))
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const r = e.target.closest("[data-read]");
      if (r) {
        try {
          const res = await rpc("msgShow", { id: r.dataset.read });
          ctx.data.opened = { id: r.dataset.read, text: res?.text ?? "" };
          root.innerHTML = inbox.render(ctx);
          inbox.bind(root, ctx);
        } catch (err) { ctx.fail(err); }
        return;
      }
      const a = e.target.closest("[data-ack]");
      if (a) {
        try {
          await rpc("msgAck", { id: a.dataset.ack });
          ctx.toast("Acknowledged");
          await ctx.reload();
        } catch (err) { ctx.fail(err); }
        return;
      }
      const rep = e.target.closest("[data-reply]");
      if (rep) ctx.go("compose", { to: rep.dataset.reply });
    });
  },
};

export const peers = {
  id: "peers",
  title: "Nearby peers",
  group: "Identity",
  note: "Wallets discovered on this network. Addresses are runtime only and change when they move.",
  async load(ctx) {
    const r = await tryRpc("p2pPeers");
    ctx.data.p2p = r.ok ? r.value : null;
  },
  render(ctx) {
    const p = ctx.data.p2p;
    if (!p) return empty("Direct channel unavailable.");
    const peers = p.peers ?? [];
    return (
      `<div class="card"><div class="card-top"><h3 class="grow">Direct channel</h3>${chip(p.enabled ? "on" : "off", p.enabled ? "ok" : "warn")}</div>` +
      (peers.length
        ? rows(peers, (x) =>
            `<div class="row">${chip(x.online ? "online" : "seen", x.online ? "ok" : "")}` +
            `<span class="grow">${esc(x.name || short(x.identityKey ?? "", 8))}${x.nameVerified ? " ✓" : ""}</span>` +
            `<span class="dim mono">${esc(x.address ?? "")}${x.port ? `:${x.port}` : ""}</span>` +
            `<span class="actions">` +
              (x.online ? `<button class="btn tiny" data-msg="${esc(x.identityKey ?? "")}">Message</button>` : "") +
              (x.online && x.payTo ? `<button class="btn tiny" data-pay="${esc(x.identityKey ?? "")}">Pay</button>` : "") +
              (x.online && x.nameVerified && x.name
                ? `<button class="btn tiny" data-save='${esc(JSON.stringify({ name: x.name, identityKey: x.identityKey, address: x.payTo }))}'>Save</button>`
                : "") +
            `</span></div>`)
        : empty("No peers on this network yet.")) +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", (e) => {
      const m = e.target.closest("[data-msg]");
      if (m) return ctx.go("compose", { to: m.dataset.msg });
      const p = e.target.closest("[data-pay]");
      if (p) return ctx.go("pay", { preset: p.dataset.pay });
      const s = e.target.closest("[data-save]");
      if (s) {
        try {
          const c = JSON.parse(s.dataset.save);
          return ctx.run(async () => {
            await rpc("contactAdd", { name: c.name, identityKey: c.identityKey, address: c.address });
            ctx.toast(`${c.name} saved`);
            await ctx.reload();
          });
        } catch (err) { return ctx.fail(err); }
      }
    });
  },
};

export const compose = {
  id: "compose",
  title: "Compose",
  group: "Identity",
  note: "Send an encrypted message. Goes direct to a peer when one is online, otherwise via the relay.",
  async load(ctx) {
    const p = await tryRpc("p2pPeers");
    ctx.data.peers = p.ok ? p.value?.peers ?? [] : [];
    const c = await tryRpc("contactList");
    ctx.data.contacts = c.ok ? c.value?.contacts ?? [] : [];
  },
  render(ctx) {
    const peers = (ctx.data.peers ?? []).filter((p) => p.online);
    const contacts = ctx.data.contacts ?? [];
    return (
      `<div class="card" style="max-width:560px"><h3>New message</h3>` +
        `<form data-form="compose">` +
          `<label class="field"><span>To</span><input name="to" list="compose-known" value="${esc(ctx.params?.to ?? "")}" placeholder="@name, identity key, or peer" required></label>` +
          `<datalist id="compose-known">` +
            contacts.map((c) => `<option value="@${esc(c.name)}">${esc(c.name)}</option>`).join("") +
            peers.map((p) => `<option value="${esc(p.identityKey ?? "")}">${esc(p.name || short(p.identityKey ?? "", 8))}</option>`).join("") +
          `</datalist>` +
          `<label class="field"><span>Message</span><textarea name="text" required></textarea></label>` +
          `<div class="card-actions"><button class="btn primary" type="submit">Send</button></div>` +
        `</form>` +
        (ctx.data.sent ? `<p class="dim" style="margin-top:10px">Sent via ${esc(ctx.data.sent.transport)} (${esc(short(ctx.data.sent.id, 10))})</p>` : "") +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("submit", async (e) => {
      const form = e.target.closest('[data-form="compose"]');
      if (!form) return;
      e.preventDefault();
      try {
        ctx.data.sent = await rpc("msgSend", { to: form.to.value.trim(), text: form.text.value });
        ctx.toast("Message sent");
        form.reset();
        await ctx.reload();
      } catch (err) { ctx.fail(err); }
    });
  },
};

export default [identity, people, inbox, peers, compose];
