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
  note: "The community meme library. Search, sort and format filters run on the server; the tag filter runs on what is loaded, because the upstream API has no tag filter.",
  async load(ctx) {
    const d = ctx.data;
    // This is the whole ballgame. The old handler fetched a filtered list and
    // then called ctx.reload(), which re-ran this function with NO folder — so
    // the unfiltered results overwrote the filtered ones and the buttons looked
    // inert. load() is now the single source of truth for the query.
    d.folder ??= "";
    d.q ??= "";
    d.format ??= "";
    d.sort ??= "";
    d.tag ??= "";
    const [f, m] = await Promise.all([
      tryRpc("twetchMemeFolders"),
      tryRpc("twetchMemes", {
        limit: 60,
        ...(d.folder ? { folder: d.folder } : {}),
        ...(d.q ? { q: d.q } : {}),
        ...(d.format ? { format: d.format } : {}),
        ...(d.sort ? { sort: d.sort } : {}),
      }),
    ]);
    d.folders = f.ok ? f.value?.folders ?? [] : [];
    const res = m.ok ? m.value : null;
    d.items = res?.items ?? [];
    d.nextCursor = res?.nextCursor ?? null;
    d.total = res?.total ?? 0;
    d.loadError = m.ok ? null : m.error;
    d.tags = harvestTags(d.items);
  },
  render(ctx) {
    const d = ctx.data;
    if (d.loadError) return `<div class="error-box">${esc(String(d.loadError.message ?? ""))}</div>`;
    const folders = d.folders ?? [];
    const tags = d.tags ?? [];
    // Tag filtering is client-side: the upstream /v1/dank-rares `tag` param
    // means a CATEGORY and 400s on a real tag, and `q` is a fuzzy text search
    // that ignores tags entirely (q=awkward returns 341 hits, none tagged
    // awkward). So the chips filter the loaded page, and the count says so.
    const all = d.items ?? [];
    const shown = d.tag ? all.filter((m) => (m.tags ?? []).includes(d.tag)) : all;

    return (
      `<div class="card" style="max-width:760px;margin-bottom:12px">` +
        `<form data-form="memesearch">` +
          `<div class="form-row">` +
            `<label class="field"><span>Search</span><input name="q" value="${esc(d.q ?? "")}" placeholder="title or text"></label>` +
            `<label class="field"><span>Format</span><select name="format">` +
              [["", "any"], ["gif", "gif"], ["png", "png"], ["jpg", "jpg"], ["mp4", "mp4"], ["webm", "webm"]]
                .map(([v, l]) => `<option value="${v}"${(d.format ?? "") === v ? " selected" : ""}>${l}</option>`)
                .join("") +
            `</select></label>` +
            `<label class="field"><span>Sort</span><select name="sort">` +
              [["", "default"], ["recent", "recent"], ["oldest", "oldest"], ["popular", "popular"]]
                .map(([v, l]) => `<option value="${v}"${(d.sort ?? "") === v ? " selected" : ""}>${l}</option>`)
                .join("") +
            `</select></label>` +
            `<button class="btn primary" type="submit">Apply</button>` +
          `</div>` +
        `</form>` +
        (folders.length
          ? `<div class="card-actions" style="margin-top:10px;flex-wrap:wrap">` +
            `<button class="btn tiny ${!d.folder ? "primary" : ""}" data-folder="">All folders</button>` +
            folders
              .map(
                (f) =>
                  `<button class="btn tiny ${f.slug === d.folder ? "primary" : ""}" data-folder="${esc(f.slug)}">${esc(
                    f.label ?? f.name ?? f.slug,
                  )} <span class="dim">${fmtInt(f.count ?? 0)}</span></button>`,
              )
              .join("") +
            `</div>`
          : "") +
      `</div>` +

      (tags.length
        ? `<div class="card" style="max-width:760px;margin-bottom:12px">` +
          `<div class="card-sub" style="margin-bottom:7px">Tags in the ${all.length} loaded memes — this filter is local, the others are server-side.</div>` +
          `<div class="card-actions" style="flex-wrap:wrap">` +
            `<button class="btn tiny ${!d.tag ? "primary" : ""}" data-tag="">any tag</button>` +
            tags
              .map(
                (t) =>
                  `<button class="btn tiny ${t.name === d.tag ? "primary" : ""}" data-tag="${esc(t.name)}">${esc(t.name)} <span class="dim">${t.count}</span></button>`,
              )
              .join("") +
          `</div>` +
        `</div>`
        : "") +

      `<div class="card-sub" style="max-width:760px;margin-bottom:10px">` +
        `Showing ${shown.length} of ${fmtInt(d.total ?? 0)}` +
        (d.tag ? ` tagged “${esc(d.tag)}”` : "") +
        (d.nextCursor ? ` · more available` : "") +
      `</div>` +
      (shown.length
        ? `<div class="memes">` + shown.map(memeTile).join("") + `</div>`
        : empty(d.tag ? `No loaded memes carry the tag “${d.tag}”.` : "No memes match.")) +
      (d.nextCursor
        ? `<div class="card-actions" style="margin-top:12px"><button class="btn" data-more ${d.busy ? "disabled" : ""}>${
            d.busy ? "Loading…" : "Load more"
          }</button></div>`
        : "")
    );
  },
  bind(root, ctx) {
    const repaint = () => {
      root.innerHTML = memes.render(ctx);
      memes.bind(root, ctx);
    };

    root.addEventListener("click", async (e) => {
      const f = e.target.closest("[data-folder]");
      if (f) {
        ctx.data.folder = f.dataset.folder;
        ctx.data.tag = ""; // tags are harvested from the new result set
        return ctx.run(async () => {
          await memes.load(ctx);
          repaint();
        });
      }
      const t = e.target.closest("[data-tag]");
      if (t) {
        // Local, instant, no refetch: this is the one filter the API has no
        // support for.
        ctx.data.tag = t.dataset.tag;
        return repaint();
      }
      const more = e.target.closest("[data-more]");
      if (more) {
        ctx.data.busy = true;
        repaint();
        return ctx.run(async () => {
          const m = await tryRpc("twetchMemes", {
            limit: 60,
            cursor: ctx.data.nextCursor,
            ...(ctx.data.folder ? { folder: ctx.data.folder } : {}),
            ...(ctx.data.q ? { q: ctx.data.q } : {}),
            ...(ctx.data.format ? { format: ctx.data.format } : {}),
            ...(ctx.data.sort ? { sort: ctx.data.sort } : {}),
          });
          if (m.ok) {
            const more2 = m.value?.items ?? [];
            ctx.data.items = [...(ctx.data.items ?? []), ...more2];
            ctx.data.nextCursor = m.value?.nextCursor ?? null;
            ctx.data.tags = harvestTags(ctx.data.items);
          } else {
            ctx.fail(m.error);
          }
          ctx.data.busy = false;
          repaint();
        });
      }
      const x = e.target.closest("[data-ext]");
      if (x?.dataset.ext) return ctx.openExternal(x.dataset.ext);
    });

    root.addEventListener("submit", async (e) => {
      const form = e.target.closest('[data-form="memesearch"]');
      if (!form) return;
      e.preventDefault();
      ctx.data.q = form.q.value.trim();
      ctx.data.format = form.format.value;
      ctx.data.sort = form.sort.value;
      ctx.data.tag = "";
      return ctx.run(async () => {
        await memes.load(ctx);
        repaint();
      });
    });
  },
};

/** Tag chips from the loaded page, most common first. */
function harvestTags(items) {
  const counts = new Map();
  for (const m of items ?? []) {
    for (const t of m.tags ?? []) {
      const name = String(t).trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 24);
}

/**
 * One meme tile.
 *
 * The field names matter and got this wrong the first time: a meme item's
 * `url` is the twetch.com *web page* for it, not an image. Feeding that to
 * <img src> renders a broken image, because an HTML page is not a picture.
 * The actual bytes are `previewUrl` / `mediaUrl`, and for `format: "gif"` you
 * want the full `mediaUrl` (the preview is a static first frame). Video
 * formats need <video>, not <img>. `url` is only ever the outbound link.
 */
const VIDEO_FORMATS = new Set(["mp4", "webm", "mov", "m4v"]);

function memeTile(m) {
  const format = String(m?.format ?? "").toLowerCase();
  const isVideo = VIDEO_FORMATS.has(format);
  const src = isVideo
    ? mediaUrl(m.mediaUrl)
    : format === "gif"
      ? mediaUrl(m.mediaUrl)
      : mediaUrl(m.previewUrl) ?? mediaUrl(m.mediaUrl);
  const page = m.url ?? `https://twetch.com/meme-library/meme/${m.sha256 ?? ""}`;
  let media;
  if (!src) {
    media = `<span class="meme-fallback">no preview</span>`;
  } else if (isVideo) {
    media = `<video src="${esc(src)}" poster="${esc(mediaUrl(m.previewUrl) ?? "")}" muted loop playsinline preload="metadata"></video>`;
  } else {
    media = `<img src="${esc(src)}" alt="${esc(m.title ?? "meme")}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'meme-fallback',textContent:'preview unavailable'}))">`;
  }
  return (
    `<button class="meme" data-ext="${esc(page)}" title="${esc(m.title ?? "meme")}">` +
      media +
      `<span class="meme-cap">` +
        `<span class="meme-title">${esc(m.title ?? "untitled")}</span>` +
        `<span class="meme-sub">${esc([m.folder, m.format, m.tokenNumber ? `#${m.tokenNumber}` : null].filter(Boolean).join(" · "))}</span>` +
      `</span>` +
    `</button>`
  );
}

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
