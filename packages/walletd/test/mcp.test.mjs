import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp.ts";

async function pair(stub) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(stub, "test-agent");
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(clientT);
  return { client, server };
}

test("lists the six wallet tools", async () => {
  const { client, server } = await pair(async () => ({}));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["anchor_tip", "get_version", "list_pending", "wallet_balance", "wallet_status", "x402_pay"]);
  await client.close();
  await server.close();
});

test("wallet_status passes daemon shape through", async () => {
  const shape = { authenticated: true, locked: false, hasWallet: true };
  const { client, server } = await pair(async (method) => {
    assert.equal(method, "isAuthenticated");
    return shape;
  });
  const res = await client.callTool({ name: "wallet_status", arguments: {} });
  assert.deepEqual(JSON.parse(res.content[0].text), shape);
  await client.close();
  await server.close();
});

test("anchor stamps the agent origin", async () => {
  let seen = null;
  const { client, server } = await pair(async (method, params) => {
    seen = { method, params };
    return { txid: "a".repeat(64), fee: 200 };
  });
  await client.callTool({ name: "anchor_tip", arguments: { sha256: "b".repeat(64) } });
  assert.equal(seen.method, "anchor");
  assert.equal(seen.params.origin, "test-agent");
  assert.equal(seen.params.sha256, "b".repeat(64));
  await client.close();
  await server.close();
});

test("x402_pay stamps the agent origin and requires a url", async () => {
  let seen = null;
  const { client, server } = await pair(async (method, params) => {
    seen = { method, params };
    return { paid: true };
  });
  await client.callTool({ name: "x402_pay", arguments: { url: "https://example.com/paid" } });
  assert.equal(seen.method, "x402Pay");
  assert.equal(seen.params.origin, "test-agent");
  assert.equal(seen.params.url, "https://example.com/paid");
  await assert.rejects(client.callTool({ name: "x402_pay", arguments: {} }), /url is required/);
  await client.close();
  await server.close();
});

test("policy denial tells the agent exactly what to ask for", async () => {
  const { client, server } = await pair(async () => {
    throw { code: "POLICY_DENY", message: "first-run approval required" };
  });
  await assert.rejects(
    client.callTool({ name: "anchor_tip", arguments: { sha256: "b".repeat(64) } }),
    /bsv allow test-agent/,
  );
  await client.close();
  await server.close();
});

test("locked wallet and bad input surface cleanly", async () => {
  const { client, server } = await pair(async () => {
    throw { code: "WALLET_LOCKED", message: "wallet locked" };
  });
  await assert.rejects(client.callTool({ name: "wallet_balance", arguments: {} }), /unlock/);
  await assert.rejects(client.callTool({ name: "anchor_tip", arguments: {} }), /sha256/);
  await assert.rejects(client.callTool({ name: "nope", arguments: {} }), /unknown tool/);
  await client.close();
  await server.close();
});

