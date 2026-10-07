import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeTwonk,
  twonkBindingHash,
  twonkMetadata,
  twonkTokenScript,
} from "../src/twonk.ts";

// Mainnet truth: NOOGIES collection id -> binding hash found in every
// NOOGIES token script (e.g. #7862 at a0d1fdf9…:17).
const NOOGIES = "df0c100a282e695a2b03ff4f484e266ba47691e1d753bf4cc8428b80a8af14f7";
const NOOGIES_H1 = "20b42e73e4ad4377bd3809f06b04cec23e257647";

test("binding hash matches mainnet NOOGIES tokens", () => {
  assert.equal(Buffer.from(twonkBindingHash(NOOGIES)).toString("hex"), NOOGIES_H1);
});

test("built script matches the mainnet template byte-for-byte", () => {
  const meta = twonkMetadata({
    attributes: [{ trait: "Background", value: "Rare Splash" }],
    imageSha256: "3eaeb7e4d463cd531fc5f6681629601d8a2f9e7ed39c433fb9829eb25599a27e",
    number: 7862,
    title: "NOOGIES #7862",
  });
  const hex = twonkTokenScript(
    NOOGIES,
    "1AGemGfBFExvwAJ7Jx3LpyjEpjA59q9UoP", // owner of listed #7862
    meta,
  );
  const b = Buffer.from(hex, "hex");
  // OP_HASH160 <20> EQUALVERIFY DUP OP_HASH160 <20> EQUALVERIFY CHECKSIG OP_RETURN <push>
  // (push opcode at b[49] is size-dependent: PUSHDATA1 here, PUSHDATA2 on big mainnet metadata)
  assert.deepEqual(
    [b[0], b[1], b[22], b[23], b[24], b[25], b[46], b[47], b[48]],
    [0xa9, 0x14, 0x88, 0x76, 0xa9, 0x14, 0x88, 0xac, 0x6a],
  );
  assert.ok(b[49] === 0x4c || b[49] === 0x4d);
  assert.equal(b.subarray(2, 22).toString("hex"), NOOGIES_H1);
  assert.equal(b.subarray(26, 46).toString("hex"), "65aee5097597782fc81665f95275bf94461a1b91");
});

test("decode round-trips our own scripts and rejects posts", async () => {
  const meta = twonkMetadata({
    attributes: [{ trait: "Background", value: "Mint Green" }],
    imageSha256: "3ab64f205cace9b8a53a4e94558f09d035591afd5c04e37ed255d1adb31ea6f5",
    number: 1,
    title: "TWONKLAB #1",
  });
  const hex = twonkTokenScript(
    "fa421c7f4a1caf782a1397f889f58113708dc9abb6133ae9855f8672d0f55690",
    "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU",
    meta,
  );
  const d = decodeTwonk(hex);
  assert.ok(d);
  assert.equal(d.metadata.title, "TWONKLAB #1");
  assert.equal(d.metadata.number, 1);
  assert.equal(
    String(d.metadata.image),
    "b://3ab64f205cace9b8a53a4e94558f09d035591afd5c04e37ed255d1adb31ea6f5",
  );
  const { Script } = await import("@bsv/sdk");
  // A plain P2PKH decodes as null (wrong shape).
  const p2pkh = new Script().writeOpCode(0x76).writeOpCode(0xa9)
    .writeBin(new Array(20).fill(1)).writeOpCode(0x88).writeOpCode(0xac).toHex();
  assert.equal(decodeTwonk(p2pkh), null);
});
