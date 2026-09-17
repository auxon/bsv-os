// Twetch companion: same-origin JSON-RPC against bsv-walletd. Reads are
// keyless; posting is policy-gated and signed by the imported Twetch key.

let rpcId = 1;

async function rpc(method, params = {}) {
  const res = await fetch("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params, id: rpcId++ }),
  });
  const body = await res.json();
  if (body && body.error) {
    const err = new Error(body.error.message || body.error.code || "rpc error");
    err.code = body.error.code;
    throw err;
  }
  return body ? body.result : null;
}

const $ = (id) => document.getElementById(id);
const feedEl = $("feed");
const notifEl = $("notifications");
const badgeEl = $("notif-badge");

let identity = null;
let tab = "feed";
let pollTimer = null;

function timeAgo(ms) {
  if (!ms) return "";
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s]+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const a = document.createElement("a");
    a.href = m[0];
    a.textContent = m[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    frag.append(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

// Twetch media resolver: b:// (or bare txid) -> api.twetch.com media,
// relative filenames -> media.ordinalswallet.com, http(s) as-is.
function mediaUrl(raw, type = "jpg") {
  const s = (raw ?? "").toString().trim();
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

function avatarFallback(user) {
  const el = document.createElement("span");
  el.className = "post-avatar avatar-fallback";
  el.textContent = ((user?.name || user?.handle || "?").trim()[0] || "?").toUpperCase();
  return el;
}

function avatarEl(user) {
  const url = mediaUrl(user?.icon);
  if (!url) return avatarFallback(user);
  const img = document.createElement("img");
  img.className = "post-avatar";
  img.alt = "";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.src = url;
  img.onerror = () => img.replaceWith(avatarFallback(user));
  return img;
}

function renderPost(post) {
  const el = document.createElement("article");
  el.className = "post";

  const head = document.createElement("div");
  head.className = "post-head";
  const img = avatarEl(post.user);
  const who = document.createElement("div");
  const name = document.createElement("div");
  name.className = "post-name";
  name.textContent = post.user?.name || post.user?.handle || `user ${post.userId}`;
  const meta = document.createElement("div");
  meta.className = "post-meta";
  meta.textContent = `@${post.user?.handle || post.userId} · ${timeAgo(post.postedAtMs)}`;
  who.append(name, meta);
  head.append(img, who);
  el.append(head);

  const body = document.createElement("div");
  body.className = "post-body";
  body.append(linkify(post.content || ""));
  el.append(body);

  const foot = document.createElement("div");
  foot.className = "post-foot";
  foot.append(
    Object.assign(document.createElement("span"), { textContent: `${post.numLikes} likes` }),
    Object.assign(document.createElement("span"), { textContent: `${post.numReplies} replies` }),
  );
  if (post.txid) {
    const link = document.createElement("a");
    link.href = `https://twetch.com/t/${post.txid}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "on-chain";
    foot.append(link);
  }
  el.append(foot);
  return el;
}

function renderList(target, items, renderer, emptyText) {
  target.textContent = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = emptyText;
    target.append(empty);
    return;
  }
  for (const item of items) target.append(renderer(item));
}

function showError(target, err) {
  target.textContent = "";
  const el = document.createElement("div");
  el.className = "error";
  el.textContent = err instanceof Error ? err.message : String(err);
  target.append(el);
}

async function loadStatus() {
  try {
    const status = await rpc("twetchStatus");
    identity = status?.identity ?? null;
    const handle = $("me-handle");
    const hint = $("me-hint");
    if (identity?.handle || identity?.name) {
      handle.textContent = `@${identity.handle || identity.name}`;
      hint.textContent = "signed in with Twetch";
      hint.classList.remove("warn");
      if (identity.picture) {
        const av = $("me-avatar");
        const url = mediaUrl(identity.picture);
        if (url) {
          av.src = url;
          av.referrerPolicy = "no-referrer";
          av.classList.remove("hidden");
        }
      }
    } else {
      handle.textContent = "not signed in";
      hint.textContent = "run: bsv login";
      hint.classList.add("warn");
      $("me-avatar").classList.add("hidden");
    }
    if (status?.account && !status.account.imported) {
      hint.textContent = `${hint.textContent} · posting: tap "Import to Twetch" in the wallet panel`;
      hint.classList.add("warn");
    }
  } catch (e) {
    $("me-hint").textContent = e.message;
    $("me-hint").classList.add("warn");
  }
}

async function loadFeed() {
  try {
    const page = await rpc("twetchFeed", { limit: 30 });
    renderList(feedEl, page?.posts ?? [], renderPost, "No posts yet.");
  } catch (e) {
    showError(feedEl, e);
  }
}

async function loadNotifications() {
  try {
    const page = await rpc("twetchNotifications", { limit: 30 });
    const rows = (page?.notifications ?? []).map((n) => {
      const el = document.createElement("article");
      el.className = "post notif";
      el.append(avatarEl(n.actor));
      const type = document.createElement("span");
      type.className = "notif-type";
      type.textContent = n.type || "activity";
      const text = document.createElement("span");
      const actor = n.actor?.name || n.actor?.handle || `user ${n.actorUserId}`;
      text.textContent = `${actor} ${n.description || ""} · ${timeAgo(n.createdAtMs)}`;
      el.append(type, text);
      return el;
    });
    renderList(notifEl, rows, (x) => x, "No notifications.");
    badgeEl.classList.add("hidden");
  } catch (e) {
    showError(notifEl, e);
  }
}

function setTab(next) {
  tab = next;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === next);
  $("feed-view").classList.toggle("hidden", next !== "feed");
  $("notifications-view").classList.toggle("hidden", next !== "notifications");
  if (next === "feed") loadFeed();
  else loadNotifications();
}

$("compose").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("compose-text").value.trim();
  const status = $("compose-status");
  if (!text) return;
  if (!identity) {
    status.textContent = "sign in first: bsv login";
    status.className = "status warn";
    return;
  }
  const btn = $("post-btn");
  btn.disabled = true;
  status.className = "status";
  status.textContent = "posting on-chain…";
  try {
    const res = await rpc("twetchPost", { content: text, origin: "twetch" });
    status.className = "status ok";
    status.textContent = res.submitted
      ? `posted ${res.txid.slice(0, 12)}…`
      : `on-chain ${res.txid.slice(0, 12)}… (${res.submitDetail})`;
    $("compose-text").value = "";
    await loadFeed();
  } catch (err) {
    status.className = "status warn";
    status.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    btn.disabled = false;
  }
});

$("refresh").addEventListener("click", () => {
  loadStatus();
  setTab(tab);
});

for (const b of document.querySelectorAll(".tab")) {
  b.addEventListener("click", () => setTab(b.dataset.tab));
}

async function boot() {
  await loadStatus();
  await loadFeed();
  await loadNotifications();
  pollTimer = setInterval(() => {
    loadStatus();
    if (tab === "feed") loadFeed();
    else loadNotifications();
  }, 60_000);
  window.addEventListener("beforeunload", () => clearInterval(pollTimer));
}

boot();