// Meme Library vectors for the Swift port.
//
// MemeStudio's search goes through the public Dank Rares API; the daemon maps
// the payload with `asMeme` (media-URL rewriting, slug building, tolerant
// field reads). A fake fetch pins both the request URL and the mapped page, so
// the Swift client must ask the same question and produce the same items.
import { memeLibrary } from "../../src/twetch.ts";

const raw = {
  items: [
    {
      id: "1",
      title: "Café ☕ Meme!",
      sha256: "aa".repeat(32),
      mediaUrl: "b://" + "bb".repeat(32),
      previewUrl: "/v1/media/cc.jpg?v=4",
      format: "gif",
      tags: ["fun", "", 42],
      bytes: "1234",
      tokenNumber: "7",
      ownerUserId: 5,
      uploadedAtMs: 1700000000000,
      folder: "Memes",
      folderSlug: "memes",
      extra: "ignored",
    },
    { id: "2", title: "plain", mediaUrl: "https://cdn.example/x.png", format: "png" },
    { id: "3", mediaUrl: "d".repeat(64), tokenNumber: null, ownerUserId: null },
    { id: "4", title: "Ord", mediaUrl: "e".repeat(40), path: "/v1/foo" },
    { id: "5", title: "http", mediaUrl: "http://cdn.example/y.png" },
  ],
  nextCursor: "c1",
  total: "5",
};

let requestUrl = null;
const ok = async (url) => {
  requestUrl = String(url);
  return new Response(JSON.stringify(raw), { status: 200, headers: { "content-type": "application/json" } });
};
const page = await memeLibrary(ok, {
  q: "meme template",
  format: "gif",
  sort: "recent",
  cursor: "abc",
  limit: 24,
});

let error = null;
const failing = async () => new Response("boom", { status: 503 });
try {
  await memeLibrary(failing, { q: "x" });
} catch (e) {
  error = { code: e.code, message: e.message };
}

console.log(JSON.stringify({ requestUrl, responseBody: JSON.stringify(raw), page, error }, null, 2));
