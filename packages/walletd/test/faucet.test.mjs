import { test } from "node:test";
import assert from "node:assert/strict";

// Partitioned keyring namespace (see custody.ts svc()).
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-faucet";
import { BSM, PublicKey, Signature } from "@bsv/sdk";
import { __resetCache, createWallet, destroyWallet, hasWallet, identityPubkeyHex, selfAddress } from "../src/custody.ts";
import { claimMessage, faucetClaim, faucetStatus } from "../src/faucet.ts";

function sats(n) {
  return new Response(JSON.stringify(n), { status: 200, headers: { "content-type": "application/json" } });
}

test("claim message is domain-separated and deterministic", () => {
  const m = claimMessage("nonce123", "1Addr", "02".repeat(33));
  assert.equal(m, `bsvos-faucet-v1|nonce123|1Addr|${"02".repeat(33)}`);
  assert.equal(claimMessage("n", "a", "A".repeat(66)), `bsvos-faucet-v1|n|a|${"a".repeat(66)}`);
});

test("status degrades cleanly when the faucet is down", async () => {
  const down = await faucetStatus("https://faucet.test", async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal(down.ok, false);
  assert.equal(down.claimed, false);
  assert.match(down.detail, /ECONNREFUSED/);
  const healthy = await faucetStatus("https://faucet.test", async () =>
    sats({ funded: true, amount: 25000, address: "1Faucet", detail: "" }),
  );
  assert.deepEqual(
    { ok: healthy.ok, funded: healthy.funded, amount: healthy.amount, address: healthy.address },
    { ok: true, funded: true, amount: 25000, address: "1Faucet" },
  );
});

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("claim signs a challenge with the identity key and the faucet verifies it", async () => {
  await createWallet();
  try {
    const identityKey = identityPubkeyHex();
    const address = selfAddress();
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/challenge")) return sats({ nonce: "n-1" });
      if (url.endsWith("/v1/claim")) {
        const body = JSON.parse(init.body);
        assert.equal(body.identityKey, identityKey);
        assert.equal(body.address, address);
        assert.equal(body.nonce, "n-1");
        // The faucet side only needs the pubkey to verify — no keys leak.
        const ok = BSM.verify(
          Array.from(Buffer.from(claimMessage("n-1", address, identityKey), "utf8")),
          Signature.fromCompact(body.sig, "base64"),
          PublicKey.fromString(identityKey),
        );
        assert.equal(ok, true);
        return sats({ txid: "ab".repeat(32), amount: 25000 });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const r = await faucetClaim("https://faucet.test/", fetchFn);
    assert.equal(r.txid, "ab".repeat(32));
    assert.equal(r.amount, 25000);
    assert.equal(r.address, address);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://faucet.test/v1/challenge");
    assert.equal(calls[1].url, "https://faucet.test/v1/claim");

    // A refused second claim surfaces as ALREADY, not a generic failure.
    const already = async (url) => {
      if (url.endsWith("/v1/challenge")) return sats({ nonce: "n-2" });
      return new Response(JSON.stringify({ code: "ALREADY", detail: "already claimed" }), { status: 409 });
    };
    await assert.rejects(faucetClaim("https://faucet.test", already), (e) => e.code === "ALREADY");
  } finally {
    await destroyWallet();
    __resetCache();
  }
});
