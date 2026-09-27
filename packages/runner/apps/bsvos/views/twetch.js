// Twetch views: feed, alerts, profile, memes, market.
//
// The daemon proxies all of this (twetchFeed, twetchPost, twetchNotifications,
// twetchUser, twetchMemes, twetchMarket, twetchBuy) and signs with the wallet's
// linked posting key, so the page never holds a credential.
//
// Two things worth knowing, both learned from the live daemon rather than the
// docs:
//   - a public OIDC client gets no refresh token, so `identity.stale` becomes
//     true a few hours after signing in. Posting needs a fresh sign-in; the
//     Identity view can start one, so the hint here links there instead of
//     telling you to open a terminal.
//   - a feed post's `content` is sometimes just a "https://twetch.com/t/<hash>"
//     permalink (a branch/reply stub), not prose. Render it as a link rather
//     than dumping a bare URL into the timeline.
"use strict";

import { rpc, tryRpc } from "../lib/rpc.js";
import { esc, fmtInt, short, timeAgo, copy, confirmDialog, when } from "../lib/ui.js";
import { empty, kv, rows, chip } from "./common.js";

/**
 * Twetch media resolver, matching packages/runner/apps/twetch/app.js:
 * b:// or a bare 64-hex -> api.twetch.com, relative names ->
 * media.ordinalswallet.com, http(s) upgraded to https.
 */
export function mediaUrl(raw, type = "jpg") {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^(data:image\/|blob:)/i.test(s)) return s;
  const out = /^(?:b:\/\/)?([a-f0-9]{64})@(\d{1,3})$/i.exec(s);
  if (out) return `https://api.twetch.com/v1/media/${out[1].toLowerCase()}-o${Number(out[2])}.${type}?v=4`;
  if (s.startsWith("b://")) {
    const m = s.slice(4).match(/[a-f0-9]{64}/i);
    return m ? `https://api.twetch.com/v1/media/${m[0].toLowerCase()}.${type}?v=4` : null;
  }
  if (/^https?:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    const host = u.hostname.toLowerCase();
    if (host === "media.twetch.app" || host === "cimg.twetch.com") {
      return s.replace(/^http:/i, "https:").replace(host, "media.ordinalswallet.com");
    }
    return s.replace(/^http:/i, "https:");
  }
  if (/^[a-f0-9]{64}$/i.test(s)) return `https://api.twetch.com/v1/media/${s.toLowerCase()}.${type}?v=4`;
  if (/^[0-9a-f]{40,}$/i.test(s)) return `https://media.ordinalswallet.com/${s}`;
  if (!s.includes("..") && (s.includes("/") || /\.[a-z0-9]{2,5}$/i.test(s))) {
    return `https://media.ordinalswallet.com/${s}`;
  }
  return null;
}

const avatar = (user, size = 34) => {
  const url = mediaUrl(user?.icon, "webp") ?? mediaUrl(user?.icon);
  const name = String(user?.name ?? "?").slice(0, 1).toUpperCase();
  return url
    ? `<img class="avatar" src="${esc(url)}" alt="" width="${size}" height="${size}" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('?'))">`
    : `<span class="avatar fallback" style="width:${size}px;height:${size}px">${esc(name)}</span>`;
};

const sats = (n) => `${fmtInt(n)} sats`;

/**
 * swapBuyFor validates outpoint against /^([0-9a-f]{64})[._](\d+)$/, but the
 * Twetch market returns "txid:vout" with a colon. Normalise, or the buy dies
 * on BAD_PARAM with a message that gives no hint about the separator.
 */
function buyOutpoint(item) {
  return String(item?.outpoint ?? "").replace(":", ".");
}

/** A listing is only buyable if it has the three fields swapBuyFor requires. */
function buyable(item) {
  return /^[0-9a-fA-F]{64}[:._]\d+$/.test(String(item?.outpoint ?? ""))
    && Number(item?.priceSats) > 0
    && !!item?.sellerAddress;
}

/** A post whose content is just a permalink is a branch stub, not prose. */
function postBody(post) {
  const content = String(post?.content ?? "").trim();
  const link = /^https?:\/\/twetch\.com\/t\/[a-f0-9]+$/i.exec(content);
  if (link) {
    return `<a class="post-link" href="${esc(content)}" target="_blank" rel="noopener">${esc(
      post.replyPostId ? "in reply to a post" : "branch post",
    )} ↗</a>`;
  }
  return `<div class="post-text">${linkify(content)}</div>`;
}

/** Minimal, escape-first linkification. */
function linkify(text) {
  const safe = esc(text);
  return safe.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}

function postCard(post, opts = {}) {
  const u = post.user ?? {};
  const counts = [
    post.numReplies ? `${fmtInt(post.numReplies)} replies` : null,
    post.numLikes ? `${fmtInt(post.numLikes)} likes` : null,
    post.numBranches ? `${fmtInt(post.numBranches)} branches` : null,
  ].filter(Boolean);
  return (
    `<div class="post" data-txid="${esc(post.txid ?? "")}">` +
      `<div class="post-head">${avatar(u)}` +
        `<div class="grow"><div class="post-name">${esc(u.name ?? "unknown")}</div>` +
        `<div class="post-meta">#${esc(u.id ?? "?")} · ${timeAgo(Math.floor((post.postedAtMs ?? 0) / 1000))}` +
        (u.isTwetchGreen ? ` · <span class="chip ok">green</span>` : "") +
        `</div></div>` +
        (opts.mine ? chip("you", "self") : "") +
      `</div>` +
      postBody(post) +
      (counts.length ? `<div class="post-meta">${counts.join(" · ")}</div>` : "") +
      `<div class="post-actions">` +
        `<button class="btn tiny" data-copy="${esc(post.txid ?? "")}">Copy txid</button>` +
        (post.txid ? `<button class="btn tiny" data-index="${esc(post.txid)}">Index on chain</button>` : "") +
        `<button class="btn tiny" data-profile="${esc(u.id ?? "")}">Profile</button>` +
      `</div>` +
    `</div>`
  );
}

// ── sign-in gate shared by every Twetch view ────────────────────────────
function signedOut(ctx, what) {
  return (
    `<div class="card" style="max-width:520px"><h3>Not signed in to Twetch</h3>` +
    `<p class="dim">${esc(what)} needs your Twetch account. Signing in links this wallet to your account — the daemon holds the posting key, the page never sees it.</p>` +
    `<div class="card-actions">` +
      `<button class="btn primary" data-goto="identity">Set up or sign in</button>` +
    `</div>` +
    (ctx.data.identity?.stale
      ? `<div class="notice" style="margin-top:12px">Your session expired. A public OIDC client gets no refresh token, so this happens every few hours — <b>Sign in again</b> on the Identity tab fixes it.</div>`
      : "") +
    `</div>`
  );
}

function staleNotice(ctx) {
  if (!ctx.data.identity?.stale) return "";
  return (
    `<div class="notice" style="margin-bottom:12px">Your Twetch session has expired, so posting is unavailable until you sign in again. ` +
    `<button class="btn tiny" data-goto="identity">Sign in again</button></div>`
  );
}

async function loadIdentity(ctx) {
  const st = await tryRpc("twetchStatus");
  ctx.data.identity = st.ok ? st.value?.identity ?? null : null;
  ctx.data.account = st.ok ? st.value?.account ?? null : null;
}

// ── Feed ────────────────────────────────────────────────────────────────
export const feed = {
  id: "twetch-feed",
  title: "Feed",
  group: "Twetch",
  note: "The public timeline. Posting is signed by the wallet's linked posting key and costs only the network fee.",
  async load(ctx) {
    await loadIdentity(ctx);
    const f = await tryRpc("twetchFeed", { limit: 30 });
    ctx.data.feed = f.ok ? f.value?.posts ?? [] : [];
    ctx.data.error = f.ok ? null : f.error;
    ctx.data.posted = null;
  },
  render(ctx) {
    if (!ctx.data.identity) return signedOut(ctx, "The feed");
    if (ctx.data.error) return `<div class="error-box">${esc(String(ctx.data.error.message ?? ctx.data.error))}</div>`;
    const posts = ctx.data.feed ?? [];
    const me = ctx.data.account;
    return (
      staleNotice(ctx) +
      `<div class="card" style="max-width:640px;margin-bottom:14px"><h3>Post</h3>` +
        (me?.address
          ? `<form data-form="post">` +
            `<label class="field"><span>What's happening?</span><textarea name="content" maxlength="280" placeholder="Say something" required></textarea></label>` +
            `<div class="form-row">` +
              `<label class="field"><span>Attach an image (optional)</span><input type="file" name="media" accept="image/*"></label>` +
            `</div>` +
            `<div class="card-actions">` +
              `<button class="btn primary" type="submit" ${ctx.data.identity.stale ? "disabled" : ""}>Post</button>` +
              `<span class="dim">costs a network fee, no platform fee</span>` +
            `</div>` +
          `</form>`
          : `<div class="notice">No posting key imported. Link one on the <b>Identity</b> tab (derive it from the wallet seed — the key material never leaves the daemon).</div>`) +
        (ctx.data.posted
          ? `<div class="notice ok" style="margin-top:10px">Posted · <span class="mono">${esc(short(ctx.data.posted.txid ?? "", 14))}</span> · fee ${sats(
              ctx.data.posted.fee ?? 0,
            )}</div>`
          : "") +
      `</div>` +
      `<div class="posts">` +
        (posts.length ? posts.map((p) => postCard(p, { mine: String(p.user?.id) === String(ctx.data.identity.sub) })).join("") : empty("The feed is empty.")) +
      `</div>`
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", (e) => {
      const cp = e.target.closest("[data-copy]");
      if (cp) return copy(cp.dataset.copy, "txid copied");
      const pr = e.target.closest("[data-profile]");
      if (pr && pr.dataset.profile) return ctx.go("twetch-profile", { userId: pr.dataset.profile });
      const ix = e.target.closest("[data-index]");
      if (ix) {
        return ctx.run(async () => {
          const res = await rpc("twetchIndex", { txid: ix.dataset.index });
          ctx.toast(res?.txid ? "Indexed on chain" : "Already indexed");
        });
      }
      const go = e.target.closest("[data-goto]");
      if (go) return ctx.go(go.dataset.goto);
    });
    root.addEventListener("submit", async (e) => {
      const form = e.target.closest('[data-form="post"]');
      if (!form) return;
      e.preventDefault();
      const content = form.content.value.trim();
      if (!content) return;
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Posting…";
      try {
        const params = { content };
        const file = form.media.files?.[0];
        if (file) {
          // Media rides as base64; the daemon signs and broadcasts it.
          const buf = new Uint8Array(await file.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          params.mediaBase64 = btoa(bin);
          params.mediaMime = file.type || "application/octet-stream";
        }
        ctx.data.posted = await rpc("twetchPost", params);
        ctx.toast("Posted");
        await ctx.reload();
      } catch (err) {
        ctx.fail(err);
      } finally {
        btn.disabled = false;
        btn.textContent = "Post";
      }
    });
  },
};

// ── Alerts ──────────────────────────────────────────────────────────────
export const alerts = {
  id: "twetch-alerts",
  title: "Alerts",
  group: "Twetch",
  note: "Likes, follows and replies to your posts.",
  async load(ctx) {
    await loadIdentity(ctx);
    const n = await tryRpc("twetchNotifications", { limit: 30 });
    ctx.data.notifications = n.ok ? n.value?.notifications ?? [] : [];
    ctx.data.postNotifications = n.ok ? n.value?.postNotifications ?? [] : [];
    ctx.data.error = n.ok ? null : n.error;
  },
  render(ctx) {
    if (!ctx.data.identity) return signedOut(ctx, "Alerts");
    if (ctx.data.error) return `<div class="error-box">${esc(String(ctx.data.error.message ?? ctx.data.error))}</div>`;
    const list = ctx.data.notifications ?? [];
    const postNotes = ctx.data.postNotifications ?? [];
    if (!list.length && !postNotes.length) return empty("Nothing yet. Alerts appear once people interact with you.");
    return (
      (list.length
        ? `<h2 class="sec">Activity (${list.length})</h2>` +
          rows(list, (n) =>
            `<div class="row">${avatar(n.actor, 28)}` +
            `<span class="grow"><b>${esc(n.actor?.name ?? "someone")}</b> ${esc(n.description ?? n.type ?? "")}</span>` +
            `<span class="dim">${timeAgo(Math.floor((n.createdAtMs ?? 0) / 1000))}</span>` +
            `<span class="actions">` +
              (n.actorUserId ? `<button class="btn tiny" data-profile="${esc(n.actorUserId)}">Profile</button>` : "") +
              (n.postId ? `<button class="btn tiny" data-post="${esc(n.postId)}">Open post</button>` : "") +
            `</span></div>`)
        : "") +
      (postNotes.length
        ? `<h2 class="sec">Replies to your posts (${postNotes.length})</h2>` + rows(postNotes, (p) => postCard(p))
        : "")
    );
  },
  bind(root, ctx) {
    bindCommon(root, ctx);
  },
};

// ── Profile ─────────────────────────────────────────────────────────────
export const profile = {
  id: "twetch-profile",
  title: "Profile",
  group: "Twetch",
  note: "A Twetch account and its posts.",
  async load(ctx) {
    await loadIdentity(ctx);
    const userId = ctx.params?.userId ?? ctx.data.identity?.sub;
    if (!userId) {
      ctx.data.profile = null;
      return;
    }
    const u = await tryRpc("twetchUser", { userId: Number(userId) });
    ctx.data.profile = u.ok ? u.value : null;
    ctx.data.profileError = u.ok ? null : u.error;
  },
  render(ctx) {
    if (!ctx.data.identity) return signedOut(ctx, "Profiles");
    if (ctx.data.profileError) return `<div class="error-box">${esc(String(ctx.data.profileError.message ?? ""))}</div>`;
    const p = ctx.data.profile;
    const user = p?.user ?? p;
    if (!user) return empty("Profile not found.");
    const posts = p?.posts ?? [];
    const mine = String(user.id) === String(ctx.data.identity.sub);
    return (
      `<div class="card" style="max-width:640px;margin-bottom:14px">` +
        `<div class="post-head">${avatar(user, 48)}` +
          `<div class="grow"><div class="post-name" style="font-size:16px">${esc(user.name ?? "unknown")}</div>` +
          `<div class="post-meta">#${esc(user.id ?? "?")}${user.handle ? ` · @${esc(user.handle)}` : ""}` +
          (user.isTwetchGreen ? ` · <span class="chip ok">green</span>` : "") + `</div></div>` +
          (mine ? chip("you", "self") : "") +
        `</div>` +
        (user.description ? `<p class="dim">${esc(user.description)}</p>` : "") +
        kv([
          ["followers", fmtInt(user.numFollowers ?? 0)],
          ["following", fmtInt(user.numFollowing ?? 0)],
          ["created", user.createdAtMs ? when(user.createdAtMs) : null],
        ]) +
        `<div class="card-actions">` +
          (user.profile ? `<button class="btn tiny" data-ext="${esc(user.profile)}">Open on twetch.com</button>` : "") +
        `</div>` +
      `</div>` +
      `<h2 class="sec">Posts (${posts.length})</h2>` +
      (posts.length ? `<div class="posts">${posts.map((x) => postCard(x)).join("")}</div>` : empty("No posts."))
    );
  },
  bind(root, ctx) {
    bindCommon(root, ctx);
  },
};

// ── Memes ───────────────────────────────────────────────────────────────
export const memes = {
  id: "twetch-memes",
  title: "Memes",
  group: "Twetch",
  note: "The community meme library.",
  async load(ctx) {
    const [f, m] = await Promise.all([tryRpc("twetchMemeFolders"), tryRpc("twetchMemes", { limit: 60 })]);
    ctx.data.folders = f.ok ? f.value?.folders ?? [] : [];
    ctx.data.memes = m.ok ? m.value?.memes ?? m.value?.items ?? [] : [];
    ctx.data.folder = ctx.data.folder ?? null;
    if (!ctx.data.folder && ctx.data.folders.length) ctx.data.folder = ctx.data.folders[0].slug;
  },
  render(ctx) {
    const folders = ctx.data.folders ?? [];
    const list = ctx.data.memes ?? [];
    return (
      (folders.length
        ? `<div class="card-actions" style="margin-bottom:12px;flex-wrap:wrap">` +
          folders
            .map(
              (f) =>
                `<button class="btn tiny ${f.slug === ctx.data.folder ? "primary" : ""}" data-folder="${esc(f.slug)}">${esc(
                  f.label ?? f.name ?? f.slug,
                )} <span class="dim">${fmtInt(f.count ?? 0)}</span></button>`,
            )
            .join("") +
          `</div>`
        : "") +
      (list.length
        ? `<div class="memes">` +
          list
            .map((m) => {
              const src = mediaUrl(m.url ?? m.mediaUrl ?? m.icon, "webp") ?? mediaUrl(m.url ?? m.mediaUrl);
              return (
                `<button class="meme" data-ext="${esc(src ?? "")}" ${src ? "" : "disabled"}>` +
                  (src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${esc(m.name ?? "?")}</span>`) +
                `</button>`
              );
            })
            .join("") +
          `</div>`
        : empty("No memes in this folder."))
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", (e) => {
      const f = e.target.closest("[data-folder]");
      if (f) {
        ctx.data.folder = f.dataset.folder;
        return ctx.run(async () => {
          const m = await rpc("twetchMemes", { folder: f.dataset.folder, limit: 60 });
          ctx.data.memes = m?.memes ?? m?.items ?? [];
          ctx.reload();
        });
      }
      const x = e.target.closest("[data-ext]");
      if (x?.dataset.ext) ctx.openExternal(x.dataset.ext);
    });
  },
};

// ── Market ──────────────────────────────────────────────────────────────
export const market = {
  id: "twetch-market",
  title: "Market",
  group: "Twetch",
  note: "Ordinals listed on Twetch. Buying spends through the wallet's policy.",
  async load(ctx) {
    await loadIdentity(ctx);
    const view = ctx.data.marketView ?? "listings";
    const r = await tryRpc("twetchMarket", { view, limit: 30 });
    ctx.data.marketView = view;
    ctx.data.items = r.ok ? r.value?.items ?? [] : [];
    ctx.data.error = r.ok ? null : r.error;
  },
  render(ctx) {
    if (ctx.data.error) return `<div class="error-box">${esc(String(ctx.data.error.message ?? ""))}</div>`;
    const items = ctx.data.items ?? [];
    const tabs = ["listings", "sales", "collections"];
    return (
      `<div class="card-actions" style="margin-bottom:12px">` +
        tabs.map((t) => `<button class="btn tiny ${ctx.data.marketView === t ? "primary" : ""}" data-view="${t}">${t}</button>`).join("") +
      `</div>` +
      (items.length
        ? `<div class="grid">` +
          items
            .map((it) => {
              const img = mediaUrl(it.imageUrl, "jpg") ?? mediaUrl(it.imageUrl);
              return (
                `<div class="card">` +
                  `<div class="card-top">` +
                    (img ? `<div class="icon"><img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` : `<div class="icon">◈</div>`) +
                    `<div class="grow"><h3>${esc(it.name ?? it.collectionName ?? "listing")}</h3>` +
                    `<div class="card-sub">${esc(it.collectionName ?? it.collection ?? "")}</div></div>` +
                  `</div>` +
                  kv([
                    ["price", it.priceSats != null ? sats(it.priceSats) : null],
                    ["rarity", it.rarity],
                    ["outpoint", it.outpoint ? short(it.outpoint, 12) : null],
                    ["seller", it.sellerAddress ? short(it.sellerAddress, 10) : null],
                  ]) +
                  (buyable(it)
                    ? `<div class="card-actions"><button class="btn tiny primary" data-buy="${esc(buyOutpoint(it))}" data-price="${it.priceSats}" data-seller="${esc(
                        it.sellerAddress,
                      )}" data-name="${esc(it.name ?? "item")}">Buy</button></div>`
                    : `<div class="card-meta">${chip("not buyable from here", "warn")}</div>`) +
                `</div>`
              );
            })
            .join("") +
          `</div>`
        : empty("Nothing listed in this view."))
    );
  },
  bind(root, ctx) {
    root.addEventListener("click", async (e) => {
      const v = e.target.closest("[data-view]");
      if (v) {
        ctx.data.marketView = v.dataset.view;
        return ctx.reload();
      }
      const b = e.target.closest("[data-buy]");
      if (!b) return;
      const price = Number(b.dataset.price) || 0;
      if (
        !(await confirmDialog(
          "Buy on Twetch",
          `${b.dataset.name} for ${sats(price)}. This spends real sats through the wallet's policy.`,
          "Buy",
        ))
      )
        return;
      return ctx.run(async () => {
        // swapBuyFor needs all three: outpoint, priceSats and sellerAddress.
        const res = await rpc("twetchBuy", {
          outpoint: b.dataset.buy,
          priceSats: price,
          sellerAddress: b.dataset.seller,
        });
        ctx.toast(`Bought · fee ${sats(res?.fee ?? 0)}`);
        await ctx.reload();
      });
    });
  },
};

function bindCommon(root, ctx) {
  root.addEventListener("click", (e) => {
    const cp = e.target.closest("[data-copy]");
    if (cp) return copy(cp.dataset.copy, "txid copied");
    const pr = e.target.closest("[data-profile]");
    if (pr && pr.dataset.profile) return ctx.go("twetch-profile", { userId: pr.dataset.profile });
    const ix = e.target.closest("[data-index]");
    if (ix) {
      return ctx.run(async () => {
        const res = await rpc("twetchIndex", { txid: ix.dataset.index });
        ctx.toast(res?.txid ? "Indexed on chain" : "Already indexed");
      });
    }
    const x = e.target.closest("[data-ext]");
    if (x?.dataset.ext) return ctx.openExternal(x.dataset.ext);
    const go = e.target.closest("[data-goto]");
    if (go) return ctx.go(go.dataset.goto);
    const pst = e.target.closest("[data-post]");
    if (pst) return ctx.openExternal(`https://twetch.com/t/${pst.dataset.post}`);
  });
}

export default [feed, alerts, profile, memes, market];
