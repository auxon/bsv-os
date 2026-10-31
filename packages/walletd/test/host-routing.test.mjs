import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { handler } from "../src/index.ts";

function get(server, { path: urlPath = "/", host }) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET", headers: { host } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            type: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("GET / with Host: cast.localhost serves Cast HTML, not POST-only", async () => {
  const server = http.createServer(handler());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const out = await get(server, { host: "cast.localhost" });
    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    assert.match(out.type, /text\/html/);
    assert.match(out.body, /<title>Cast/);
    assert.doesNotMatch(out.body, /POST only/);

    const withPort = await get(server, { host: "cast.localhost:2121" });
    assert.equal(withPort.status, 200);
    assert.match(withPort.body, /<title>Cast/);

    const pathUrl = await get(server, { host: "127.0.0.1:2121", path: "/cast/" });
    assert.equal(pathUrl.status, 200);
    assert.match(pathUrl.body, /<title>Cast/);

    const api = await get(server, { host: "127.0.0.1:2121", path: "/" });
    assert.equal(api.status, 405);
    assert.match(api.body, /POST only/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
