import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { migrate } from "../src/storage.ts";
import {
  cancelLogin,
  currentSession,
  discover,
  loginStatus,
  logout,
  pkce,
  setIdentityConfig,
  startLogin,
} from "../src/identity.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function makeIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256", use: "sig" };
  const control = {
    nonce: null,
    wrongNonce: false,
    tamper: false,
    audience: "bsv-os-test",
    expiresIn: 3600,
    failRefresh: false,
    sub: "user-42",
    handle: "satoshi",
    tokenCalls: [],
    revoked: [],
  };
  let base = "";

  function idToken(opts) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "ES256", typ: "JWT", kid: "k1" };
    const payload = {
      iss: base,
      aud: control.audience,
      sub: control.sub,
      preferred_username: opts.handle ?? control.handle,
      name: "Satoshi Nakamoto",
      picture: "https://example.test/avatar.png",
      twetch_pubkey: "02" + "ab".repeat(32),
      iat: now,
      exp: now + opts.expiresIn,
    };
    if (opts.nonce !== undefined) payload.nonce = opts.nonce;
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    let sig = cryptoSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
    if (control.tamper) sig = Buffer.alloc(sig.length);
    return `${signingInput}.${b64url(sig)}`;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, base || "http://127.0.0.1");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        revocation_endpoint: `${base}/revoke`,
      });
      return;
    }
    if (url.pathname === "/jwks") {
      json(200, { keys: [jwk] });
      return;
    }
    if (url.pathname === "/token" || url.pathname === "/revoke") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        if (url.pathname === "/revoke") {
          control.revoked.push(form.get("token"));
          json(200, {});
          return;
        }
        control.tokenCalls.push(Object.fromEntries(form));
        if (form.get("grant_type") === "refresh_token") {
          if (control.failRefresh) {
            json(401, { error: "invalid_client" });
            return;
          }
          json(200, {
            id_token: idToken({ handle: `${control.handle}-refreshed`, expiresIn: control.expiresIn }),
            access_token: "at-refreshed",
            refresh_token: "rt-refreshed",
            token_type: "Bearer",
            expires_in: control.expiresIn,
          });
          return;
        }
        json(200, {
          id_token: idToken({
            nonce: control.wrongNonce ? "wrong" : control.nonce ?? undefined,
            expiresIn: control.expiresIn,
          }),
          access_token: "at-1",
          refresh_token: "rt-1",
          token_type: "Bearer",
          expires_in: control.expiresIn,
          scope: "openid profile offline_access",
        });
      });
      return;
    }
    json(404, { error: "not_found" });
  });

  return {
    control,
    get base() {
      return base;
    },
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${server.address().port}`;
      return base;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function configured(db, issuer) {
  await setIdentityConfig(db, {
    issuer,
    clientId: "bsv-os-test",
    redirectPort: 0,
    scope: "openid profile offline_access",
  });
}

async function login(db, issuer, { code = "good", state } = {}) {
  const started = await startLogin(db);
  const auth = new URL(started.authUrl);
  issuer.control.nonce = auth.searchParams.get("nonce");
  const res = await fetch(
    `${started.redirectUri}?code=${code}&state=${encodeURIComponent(state ?? auth.searchParams.get("state"))}`,
  );
  return { started, auth, res };
}

test("discovery exposes the issuer endpoints and pkce is S256", async () => {
  const issuer = await makeIssuer();
  await issuer.start();
  try {
    const endpoints = await discover(issuer.base, { maxAgeMs: 0 });
    assert.equal(endpoints.authorization, `${issuer.base}/authorize`);
    assert.equal(endpoints.token, `${issuer.base}/token`);
    assert.equal(endpoints.revocation, `${issuer.base}/revoke`);
    const { verifier, challenge } = pkce();
    assert.equal(verifier.length, 43);
    assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  } finally {
    await issuer.stop();
  }
});

test("full PKCE login stores a verified session bound to the wallet", async () => {
  const db = await memdb();
  const issuer = await makeIssuer();
  await issuer.start();
  try {
    await configured(db, issuer.base);
    const { started, auth, res } = await login(db, issuer);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Signed in with Twetch/);

    assert.match(started.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.equal(auth.searchParams.get("response_type"), "code");
    assert.equal(auth.searchParams.get("client_id"), "bsv-os-test");
    const verifier = issuer.control.tokenCalls[0].code_verifier;
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), auth.searchParams.get("code_challenge"));

    const status = await loginStatus(db);
    assert.equal(status.state, "done");
    assert.equal(status.session.sub, "user-42");
    assert.equal(status.session.handle, "satoshi");
    assert.equal(status.session.twetchPubkey.startsWith("02"), true);
    assert.equal(status.session.emailVerified, false);
    assert.ok(status.session.idToken.length > 0);
    assert.equal(status.session.stale, undefined);

    const session = await currentSession(db);
    assert.equal(session.handle, "satoshi");
    assert.ok(session.expiresAt > Date.now());
  } finally {
    cancelLogin();
    await issuer.stop();
    await db.destroy();
  }
});

test("callback rejects state, nonce, audience and signature attacks", async () => {
  const db = await memdb();
  const issuer = await makeIssuer();
  await issuer.start();
  try {
    await configured(db, issuer.base);

    const evil = await login(db, issuer, { state: "forged" });
    assert.equal(evil.res.status, 400);
    let status = await loginStatus(db);
    assert.equal(status.state, "error");
    assert.equal(status.error.code, "STATE");

    issuer.control.wrongNonce = true;
    const badNonce = await login(db, issuer);
    assert.equal(badNonce.res.status, 400);
    status = await loginStatus(db);
    assert.equal(status.error.code, "BAD_TOKEN");
    assert.match(status.error.message, /nonce/);
    issuer.control.wrongNonce = false;

    issuer.control.tamper = true;
    const tampered = await login(db, issuer);
    assert.equal(tampered.res.status, 400);
    status = await loginStatus(db);
    assert.equal(status.error.code, "BAD_TOKEN");
    assert.match(status.error.message, /signature/);
    issuer.control.tamper = false;

    issuer.control.audience = "someone-else";
    const wrongAud = await login(db, issuer);
    assert.equal(wrongAud.res.status, 400);
    status = await loginStatus(db);
    assert.equal(status.error.code, "BAD_TOKEN");
    assert.match(status.error.message, /audience/);
    issuer.control.audience = "bsv-os-test";

    assert.equal((await loginStatus(db)).state, "idle");
  } finally {
    cancelLogin();
    await issuer.stop();
    await db.destroy();
  }
});

test("currentSession refreshes expired tokens, marks stale when refresh fails", async () => {
  const db = await memdb();
  const issuer = await makeIssuer();
  await issuer.start();
  try {
    await configured(db, issuer.base);
    await login(db, issuer);
    await db("identity_session").where({ id: 1 }).update({ expires_at: Date.now() - 1000 });

    const refreshed = await currentSession(db);
    assert.equal(refreshed.stale, undefined);
    assert.equal(refreshed.handle, "satoshi-refreshed");
    assert.equal(refreshed.refreshToken, "rt-refreshed");
    assert.ok(refreshed.expiresAt > Date.now());
    assert.equal(issuer.control.tokenCalls.at(-1).grant_type, "refresh_token");

    await db("identity_session").where({ id: 1 }).update({ expires_at: Date.now() - 1000 });
    issuer.control.failRefresh = true;
    const stale = await currentSession(db);
    assert.equal(stale.stale, true);
    assert.equal(stale.sub, "user-42");
  } finally {
    cancelLogin();
    await issuer.stop();
    await db.destroy();
  }
});

test("logout revokes the refresh token and clears the session", async () => {
  const db = await memdb();
  const issuer = await makeIssuer();
  await issuer.start();
  try {
    await configured(db, issuer.base);
    await login(db, issuer);
    const out = await logout(db);
    assert.equal(out.loggedOut, true);
    assert.deepEqual(issuer.control.revoked, ["rt-1"]);
    assert.equal(await currentSession(db), null);
    assert.equal((await loginStatus(db)).state, "idle");
  } finally {
    cancelLogin();
    await issuer.stop();
    await db.destroy();
  }
});

test("re-login is allowed once the stored session has expired", async () => {
  const db = await memdb();
  const issuer = await makeIssuer();
  await issuer.start();
  try {
    await configured(db, issuer.base);
    const first = await login(db, issuer);
    await first.res.text();
    await assert.rejects(startLogin(db), (e) => e.code === "ALREADY");
    await db("identity_session").update({ expires_at: Date.now() - 1000 });
    const second = await login(db, issuer);
    await second.res.text();
    const status = await loginStatus(db);
    assert.equal(status.state, "done");
    assert.equal(status.session.sub, "user-42");
  } finally {
    cancelLogin();
    await issuer.stop();
    await db.destroy();
  }
});
