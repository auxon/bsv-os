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

test("lists the eight wallet tools", async () => {
  const { client, server } = await pair(async () => ({}));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "anchor_tip", "get_version", "jev_decide", "jev_status",
    "list_pending", "wallet_balance", "wallet_status", "x402_pay",
  ]);
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

test("jev_decide forwards state and questions to the daemon", async () => {
  let seen = null;
  const { client, server } = await pair(async (method, params) => {
    seen = { method, params };
    return { model: "typesafe/jev-1.13", answers: { q: { type: "noul", noul: 0.9 } } };
  });
  const questions = { q: { type: "noul", instructions: "yes?" } };
  const res = await client.callTool({ name: "jev_decide", arguments: { state: { a: 1 }, questions } });
  assert.equal(seen.method, "jevDecide");
  assert.deepEqual(seen.params.state, { a: 1 });
  assert.deepEqual(seen.params.questions, questions);
  assert.equal(JSON.parse(res.content[0].text).answers.q.noul, 0.9);
  await assert.rejects(client.callTool({ name: "jev_decide", arguments: { questions } }), /state is required/);
  await assert.rejects(client.callTool({ name: "jev_decide", arguments: { state: "x" } }), /questions map is required/);
  await client.close();
  await server.close();
});

test("jev_status reports the advisor config and a missing key is actionable", async () => {
  const { client, server } = await pair(async (method) => {
    assert.equal(method, "jevStatus");
    return { enabled: false, model: "typesafe/jev-1.13", auto: { minVerdictProb: 0.7, maxRisk: 0.5, minConfidence: 0.6 } };
  });
  const res = await client.callTool({ name: "jev_status", arguments: {} });
  assert.equal(JSON.parse(res.content[0].text).enabled, false);
  await client.close();
  await server.close();

  const { client: c2, server: s2 } = await pair(async () => {
    throw { code: "NO_KEY", message: "OPENROUTER_API_KEY is not set" };
  });
  await assert.rejects(
    c2.callTool({ name: "jev_decide", arguments: { state: "x", questions: { q: { type: "noul", instructions: "y" } } } }),
    /OPENROUTER_API_KEY/,
  );
  await c2.close();
  await s2.close();
});

