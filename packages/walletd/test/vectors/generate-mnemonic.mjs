// Mnemonic-generation vectors for the Swift port (S4).
//
// The daemon creates phrases with `Mnemonic.fromRandom()` (@bsv/sdk) and
// `entropyToMnemonic` (@scure/bip39). The random half cannot be replayed, so
// these vectors pin the deterministic half: entropy in, words out, and the
// m/0/0 key the phrase derives — the same contract S1's file pins for
// derivation, extended upstream to generation.
//
// Run from packages/walletd so the dependencies resolve:
//   node test/vectors/generate-mnemonic.mjs > test/vectors/mnemonic-vectors.json
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Mnemonic, HD } from "@bsv/sdk";

// Edge-shaped entropies: all-zero, a leading 1 bit, a trailing 1 bit, all-ones,
// a counter, and the BIP39 specification's own example.
const ENTROPIES = [
  "00000000000000000000000000000000",
  "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
  "80808080808080808080808080808080",
  "ffffffffffffffffffffffffffffffff",
  "000102030405060708090a0b0c0d0e0f",
  "9e885d952ad362caeb4efe34a8e91bd2",
];

const vectors = ENTROPIES.map((entropyHex) => {
  const entropy = Buffer.from(entropyHex, "hex");
  const phrase = entropyToMnemonic(entropy, wordlist);
  if (!Mnemonic.isValid(phrase)) throw new Error(`generated an invalid phrase: ${phrase}`);
  const seed = new Mnemonic(phrase).toSeed();
  const priv = HD.fromSeed(seed).derive("m/0/0").privKey;
  // The daemon's identity key is the *master* public key (custody.identityOf),
  // not a derived path — so the same phrase produces the same identity on the
  // phone, which is what lets an app see one identity across both front ends.
  const master = HD.fromSeed(seed);
  return {
    entropyHex,
    phrase,
    seedHex: Buffer.from(seed).toString("hex"),
    identityKeyHex: master.privKey.toPublicKey().toString(),
    privateKeyHex: priv.toHex(),
    publicKeyHex: priv.toPublicKey().toString(),
    address: priv.toPublicKey().toAddress(),
  };
});

console.log(JSON.stringify({ vectors }, null, 2));
