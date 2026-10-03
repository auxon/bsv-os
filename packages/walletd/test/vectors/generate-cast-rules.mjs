// Cast-rule vectors for the Swift port: splits, tick intervals, the HLS
// playlist, and the id/file/media allowlists — all from the daemon's own
// `cast.ts` and `streams.ts`.
import { parseSplits, livePlaylist, liveIdValid, liveFileValid, mediaExt, mediaFileValid } from "../../src/cast.ts";
import { parseTick } from "../../src/streams.ts";
import { p2pkhScript } from "../../src/tx.ts";

const valid = (address) => {
  try {
    p2pkhScript(address);
    return true;
  } catch {
    return false;
  }
};

const splitInputs = [
  "13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz:100",
  "13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz:70,1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA:30",
  "13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz:33.33,1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA:66.67",
  "",
  "13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz",
  "13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz:70,1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA:20",
  "13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz:0,1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA:100",
  "13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz:60,13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz:40",
  "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA:50,not-an-address:50",
  "13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz:70,1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA:30,1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2:1",
];
const splits = splitInputs.map((input) => {
  try {
    return { input, splits: parseSplits(input, valid) };
  } catch (e) {
    return { input, error: { code: e.code ?? "ERROR", message: e.message } };
  }
});

const tickInputs = ["90s", "5m", "1h", "1H", "30s", "25h", "abc", "0s", " 90s "];
const ticks = tickInputs.map((input) => {
  try {
    return { input, ms: parseTick(input) };
  } catch (e) {
    return { input, error: { code: e.code ?? "ERROR", message: e.message } };
  }
});

const playlists = [
  { segments: 0, ended: false },
  { segments: 3, ended: false },
  { segments: 25, ended: false },
  { segments: 3, ended: true },
].map((c) => ({ ...c, body: livePlaylist(c.segments, c.ended) }));

const validators = {
  liveIds: ["abc123", "ABC123", "short", "a".repeat(17), "abc-123"].map((id) => ({ id, valid: liveIdValid(id) })),
  liveFiles: ["index.m3u8", "init.mp4", "seg-0.m4s", "seg-499.m4s", "seg-500.m4s", "seg-x.m4s", "../init.mp4"].map((name) => ({ name, valid: liveFileValid(name) })),
  mediaFiles: ["abcdefghijkl.mp4", "abcdefghijkl.webm", "abcdefghijkl.mkv", "short.mp4", "ABCDEFGHIJKL.mp4"].map((name) => ({ name, valid: mediaFileValid(name) })),
  mediaExts: ["video/mp4", "video/mp4;codecs=avc1", "audio/ogg", "video/avi", "VIDEO/WEBM"].map((mime) => ({ mime, ext: mediaExt(mime) })),
};

console.log(JSON.stringify({ splits, ticks, playlists, validators }, null, 2));
