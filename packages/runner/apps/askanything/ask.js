// AskAnything client-side validation: mirrors the daemon rules in
// packages/walletd/src/ask.ts so the form fails fast before any RPC.
// Pure functions, no DOM — unit-tested from
// packages/walletd/test/askanything.test.mjs. The daemon re-validates
// everything; this file is convenience, not trust.

export const ASK_BOARD = "askanything";
/** Pledges below this cannot cover an on-chain payout with room to spare. */
export const MIN_AMOUNT_SATS = 5000;
export const TITLE_MAX = 120;
export const DETAILS_MAX = 2000;
export const ANSWER_MAX = 2000;

function fail(message) {
  const err = new Error(message);
  err.code = "BAD_PARAM";
  throw err;
}

export function validateQuestion({ title, details, amountSats }) {
  const t = String(title ?? "").trim();
  if (!t) fail("question title required");
  if (t.length > TITLE_MAX) fail(`title over the ${TITLE_MAX}-char cap`);
  if (/\n/.test(t)) fail("title must be a single line");
  const d = String(details ?? "").trim();
  if (!d) fail("question details required");
  if (d.length > DETAILS_MAX) fail(`details over the ${DETAILS_MAX}-char cap`);
  const amount = Math.floor(Number(amountSats) || 0);
  if (!(amount >= MIN_AMOUNT_SATS)) fail(`amount must be at least ${MIN_AMOUNT_SATS} sats`);
  return { title: t, details: d, amountSats: amount };
}

export function validateAnswer({ text, payTo }) {
  const t = String(text ?? "").trim();
  if (!t) fail("answer text required");
  if (t.length > ANSWER_MAX) fail(`answer over the ${ANSWER_MAX}-char cap`);
  const addr = String(payTo ?? "").trim();
  // Loose client check (base58 P2PKH shape); the daemon validates strictly.
  if (!/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr)) fail("payTo does not look like a BSV address");
  return { text: t, payTo: addr };
}
