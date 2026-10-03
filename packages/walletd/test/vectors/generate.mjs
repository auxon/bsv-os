// Generate reference vectors for the Swift port from the SAME library the daemon
// uses (@bsv/sdk), by the same calls custody.ts makes. These are the contract:
// if the Swift reproduces them byte for byte, the two implementations are the
// same wallet — which is what "same seed on both" requires.
//
// Run from packages/walletd so the dependency resolves.
import { Mnemonic, HD, PrivateKey } from "@bsv/sdk";

const PHRASES = [
  // The BIP39 specification's own test vector.
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  // A second, non-trivial phrase, so a passing test cannot be a coincidence of
  // the first one's structure.
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  // And the daemon's own derivation path, exercised with a phrase that has no
  // BIP39 special-casing.
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
];

const PATHS = ["m/0/0", "m/0/1", "m/44'/0'/0'/0/0"];

const out = [];
for (const phrase of PHRASES) {
  const seed = new Mnemonic(phrase).toSeed();
  const hd = HD.fromSeed(seed);
  const paths = {};
  for (const path of PATHS) {
    const child = hd.derive(path);
    if (!child.privKey) throw new Error(`no privKey for ${path}`);
    const priv = child.privKey;
    paths[path] = {
      privateKeyHex: priv.toHex(),
      publicKeyHex: priv.toPublicKey().toString(),
      address: priv.toPublicKey().toAddress(),
      wif: priv.toWif(),
    };
  }
  out.push({
    phrase,
    seedHex: Buffer.from(seed).toString("hex"),
    paths,
  });
}

// A signing vector: a fixed digest signed by the m/0/0 key of the first phrase,
// so the Swift can prove it produces a valid, verifiable signature rather than
// merely a well-formed one.
const first = new Mnemonic(PHRASES[0]).toSeed();
const key = HD.fromSeed(first).derive("m/0/0").privKey;
const digest = "11".repeat(32);
const sig = key.sign(Array.from(Buffer.from(digest, "hex")), "all", true);
out[0].signingVector = {
  digestHex: digest,
  // @bsv/sdk returns DER for "all" with the sighash byte appended.
  signatureHex: sig.toDER ? Buffer.from(sig.toDER()).toString("hex") : null,
  r: sig.r ? sig.r.toString(16) : null,
};

console.log(JSON.stringify(out, null, 2));
