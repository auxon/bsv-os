// AskAnything: funded questions over the wallet's boards, paid on accept.
// Same-origin RPC; the page never holds keys. Asking and answering are
// free and off-chain — only the accept payment moves sats, through the
// pay RPC (policy-gated) behind a two-step confirm that names amount and
// destination. Client validation lives in ask.js; the daemon re-validates.
import { ASK_BOARD, validateAnswer, validateQuestion } from "./ask.js";

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
const statusEl = $("status");

const state = {
  questions: [],
  detail: null, // { question, answers[] }
  grades: new Map(), // answerId -> grade
  balance: null,
  confirm: null, // { answerId, until } | null
  confirmTimer: null,
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const fmtSats = (n) => `${Number(n || 0).toLocaleString("en-US")} sats`;
const shortId = (id) => String(id ?? "").slice(0, 8);
const timeAgo = (ts) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function setStatus(t) {
  statusEl.textContent = t;
}

function failBox(el, err) {
  el.innerHTML = `<div class="notice bad">[${esc(err.code ?? "")}] ${esc(err.message)}</div>`;
}

async function boot() {
  try {
    await rpc("boardCreate", { name: ASK_BOARD, mode: "members" });
  } catch (err) {
    setStatus(`cannot open the board — unlock the wallet first (bsv unlock). [${err.code ?? ""}]`);
    return;
  }
  await Promise.all([refreshBalance(), refreshList()]);
}

async function refreshBalance() {
  try {
    state.balance = await rpc("balance");
  } catch {
    state.balance = null;
  }
}

async function refreshList() {
  const box = $("qlist");
  try {
    const res = await rpc("askList", { board: ASK_BOARD });
    state.questions = res?.questions ?? [];
    setStatus(state.questions.length
      ? `${state.questions.length} open question(s) on ${ASK_BOARD}`
      : `no open questions — ask the first one.`);
    box.innerHTML = state.questions.length ? state.questions.map((q) => (
      `<button type="button" class="card" data-q="${esc(q.id)}">` +
      `<h4>${esc(q.title)}</h4>` +
      `<p><span class="amt">${fmtSats(q.amountSats ?? 0)}</span> · ${esc(timeAgo(q.ts))}</p></button>`
    )).join("") : `<p class="hint">nothing asked yet.</p>`;
  } catch (err) {
    setStatus(`list failed: ${err.message}`);
    failBox(box, err);
  }
}

async function review() {
  const box = $("triage");
  let q;
  try {
    q = validateQuestion({ title: $("q-title").value, details: $("q-details").value, amountSats: $("q-amount").value });
  } catch (err) {
    failBox(box, err);
    return;
  }
  box.innerHTML = `<p class="hint">asking Jev…</p>`;
  try {
    const r = await rpc("askTriage", { board: ASK_BOARD, ...q });
    if (!r?.available) {
      box.innerHTML = `<div class="notice">triage unavailable (Jev off?) — you can still post.</div>`;
      return;
    }
    const dup = r.duplicate?.matchId
      ? `<p>This may duplicate <b>${esc(r.duplicate.matchTitle ?? r.duplicate.matchId)}</b> (confidence ${esc(Math.round((r.duplicate.confidence ?? 0) * 100))}%). Consider answering it instead.</p>`
      : `<p>No duplicates found among ${esc(r.openCount)} open question(s).</p>`;
    box.innerHTML = `<div class="notice">Clarity: <b>${esc(r.clarity?.level ?? "?")}</b>` +
      `${dup}</div>`;
  } catch (err) {
    failBox(box, err);
  }
}

async function post() {
  const box = $("triage");
  let q;
  try {
    q = validateQuestion({ title: $("q-title").value, details: $("q-details").value, amountSats: $("q-amount").value });
  } catch (err) {
    failBox(box, err);
    return;
  }
  setStatus("posting…");
  try {
    await rpc("askPost", { board: ASK_BOARD, ...q });
    $("q-title").value = "";
    $("q-details").value = "";
    box.innerHTML = "";
    setStatus("question posted — free, off-chain. It pays only when you accept an answer.");
    await refreshList();
  } catch (err) {
    setStatus("post failed.");
    failBox(box, err);
  }
}

async function openDetail(id) {
  const sec = $("detail");
  try {
    const thread = await rpc("boardThread", { id });
    const posts = thread?.posts ?? [];
    const root = posts.find((x) => x.id === id) ?? posts[0];
    if (!root) return;
    const answers = posts.filter((x) => x.kind === "result" && x.replyTo === root.id);
    state.detail = { question: root, answers };
    state.grades = new Map();
    state.confirm = null;
    // Titles travel in refs (board text cannot keep structure); fall back
    // to text for foreign posts, mirroring the daemon decoder.
    const titleRef = (root.refs ?? []).map((r) => /^title:(.+)$/.exec(r)?.[1]).find(Boolean);
    $("d-title").textContent = titleRef ?? root.text.slice(0, 120);
    const amt = (root.refs ?? []).map((r) => /^amount:(\d+)$/.exec(r)?.[1]).find(Boolean);
    $("d-meta").textContent = `${amt ? fmtSats(amt) : "no pledge"} · ${answers.length} answer(s)`;
    $("d-details").textContent = root.text;
    $("result").innerHTML = "";
    renderAnswers();
    sec.classList.remove("hidden");
    sec.scrollIntoView();
  } catch (err) {
    setStatus(`open failed: ${err.message}`);
  }
}

function renderAnswers() {
  const box = $("answers");
  const d = state.detail;
  if (!d) return;
  if (!d.answers.length) {
    box.innerHTML = `<p class="hint">no answers yet.</p>`;
    return;
  }
  box.innerHTML = d.answers.map((a) => {
    const g = state.grades.get(a.id);
    const grade = g ? ` <span class="grade">${esc(g.level)} ${esc(Math.round((g.confidence ?? 0) * 100))}%</span>` : "";
    const armed = state.confirm?.answerId === a.id ? "Confirm" : "Accept";
    return `<div class="answer"><p>${esc(a.text)}</p>` +
      `<p class="who">${esc(shortId(a.id))} · by ${esc(a.from.slice(0, 12))}…${grade}</p>` +
      `<button type="button" data-accept="${esc(a.id)}">${armed}</button></div>`;
  }).join("");
}

async function grade() {
  if (!state.detail) return;
  setStatus("grading…");
  try {
    for (const a of state.detail.answers) {
      const g = await rpc("askGrade", {
        question: state.detail.question.text,
        submission: a.text,
      });
      if (g?.available) state.grades.set(a.id, g);
    }
    if (!state.detail.answers.length) setStatus("nothing to grade.");
    else if (state.grades.size === 0) setStatus("grading unavailable (Jev off?) — settle by reading.");
    else setStatus("graded — blind scores, you still decide.");
    renderAnswers();
  } catch (err) {
    setStatus(`grade failed: ${err.message}`);
  }
}

function disarm() {
  state.confirm = null;
  clearTimeout(state.confirmTimer);
  renderAnswers();
}

async function accept(answerId) {
  if (state.confirm?.answerId === answerId) {
    return fireAccept(answerId);
  }
  // First click resolves the preview; the button arms with amount + address.
  try {
    const prev = await rpc("askAccept", { board: ASK_BOARD, answerId });
    state.confirm = { answerId, until: Date.now() + 10000, preview: prev };
    clearTimeout(state.confirmTimer);
    state.confirmTimer = setTimeout(disarm, 10000);
    renderAnswers();
    const btn = document.querySelector(`[data-accept="${CSS.escape(answerId)}"]`);
    if (btn) btn.textContent = `Confirm pay ${fmtSats(prev.amountSats)} to ${prev.payTo.slice(0, 12)}…`;
    setStatus(`confirm: pay ${fmtSats(prev.amountSats)} to ${prev.payTo}. Second click fires.`);
  } catch (err) {
    setStatus(`accept failed: ${err.message}`);
  }
}

async function fireAccept(answerId) {
  const prev = state.confirm?.preview;
  clearTimeout(state.confirmTimer);
  state.confirm = null;
  renderAnswers();
  if (!prev) return;
  setStatus(`paying ${fmtSats(prev.amountSats)}…`);
  try {
    const res = await rpc("pay", { to: prev.payTo, sats: prev.amountSats, note: `ask ${prev.questionId.slice(0, 8)}` });
    const txid = res?.txid ?? "";
    $("result").innerHTML = `<div class="notice ok">paid ${fmtSats(prev.amountSats)}` +
      (txid ? ` <span class="mono">${esc(txid)}</span><br><a href="https://whatsonchain.com/tx/${esc(txid)}" target="_blank" rel="noopener">chain</a>` : "") +
      `</div>`;
    setStatus("paid — answer settled on-chain.");
    refreshBalance();
  } catch (err) {
    $("result").innerHTML = "";
    failBox($("result"), err);
    setStatus("payment failed.");
  }
}

async function answer() {
  const box = $("result");
  if (!state.detail) return;
  let a;
  try {
    a = validateAnswer({ text: $("a-text").value, payTo: $("a-payto").value });
  } catch (err) {
    failBox(box, err);
    return;
  }
  setStatus("submitting answer…");
  try {
    await rpc("askAnswer", { board: ASK_BOARD, replyTo: state.detail.question.id, ...a });
    $("a-text").value = "";
    setStatus("answer posted — free, off-chain. It earns if accepted.");
    await openDetail(state.detail.question.id);
  } catch (err) {
    setStatus("answer failed.");
    failBox(box, err);
  }
}

$("review-btn").addEventListener("click", () => void review());
$("post-btn").addEventListener("click", () => void post());
$("refresh-btn").addEventListener("click", () => void refreshList());
$("grade-btn").addEventListener("click", () => void grade());
$("back-btn").addEventListener("click", () => {
  $("detail").classList.add("hidden");
  state.detail = null;
});
$("fill-addr-btn").addEventListener("click", async () => {
  try {
    const bal = state.balance ?? await rpc("balance");
    state.balance = bal;
    if (bal?.address) $("a-payto").value = bal.address;
  } catch { /* leave the field alone */ }
});
$("answer-btn").addEventListener("click", () => void answer());
$("qlist").addEventListener("click", (e) => {
  const t = e.target.closest("[data-q]");
  if (t) void openDetail(t.dataset.q);
});
$("answers").addEventListener("click", (e) => {
  const t = e.target.closest("[data-accept]");
  if (t) void accept(t.dataset.accept);
});
document.querySelectorAll("#q-title,#q-details,#q-amount").forEach((el) => {
  el.addEventListener("input", () => { $("triage").innerHTML = ""; });
});

void boot();
