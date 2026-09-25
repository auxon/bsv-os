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

test("lists the nineteen wallet tools", async () => {
  const { client, server } = await pair(async () => ({}));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "anchor_tip", "board_get", "board_post", "board_reply", "board_wait",
    "events_poll", "get_version", "jev_decide", "jev_status", "list_pending",
    "market_browse", "market_buy", "market_list", "market_sync", "p2p_peers",
    "policy_probe", "wallet_balance", "wallet_status", "x402_pay",
  ]);
  await client.close();
  await server.close();
});

test("market tools stamp the agent origin and validate input", async () => {
  const seen = [];
  const { client, server } = await pair(async (method, params) => {
    seen.push({ method, params });
    return { listings: [] };
  });
  await client.callTool({ name: "market_browse", arguments: { kind: "ordinal" } });
  assert.deepEqual(seen[0], { method: "marketBrowse", params: { kind: "ordinal" } });
  await client.callTool({ name: "market_buy", arguments: { listing: "a.b", maxPrice: 5000 } });
  assert.deepEqual(seen[1], {
    method: "marketBuy",
    params: { listing: "a.b", origin: "test-agent", maxPrice: 5000 },
  });
  await client.callTool({
    name: "market_list",
    arguments: { outpoint: "a_0", priceSats: 2500, title: "T" },
  });
  assert.deepEqual(seen[2], {
    method: "marketList",
    params: { outpoint: "a_0", priceSats: 2500, origin: "test-agent", title: "T" },
  });
  await assert.rejects(client.callTool({ name: "market_buy", arguments: {} }), /listing/);
  await assert.rejects(
    client.callTool({ name: "market_list", arguments: { outpoint: "a_0", priceSats: 0 } }),
    /priceSats/,
  );
  await client.callTool({ name: "market_sync", arguments: { listing: "a.b", txid: "AB".repeat(32) } });
  assert.deepEqual(seen[3], { method: "marketSync", params: { listing: "a.b", txid: "AB".repeat(32) } });
  await assert.rejects(
    client.callTool({ name: "market_sync", arguments: { listing: "a.b", txid: "zz" } }),
    /txid/,
  );
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

test("policy_probe stamps the agent origin and validates input", async () => {
  let seen = null;
  const { client, server } = await pair(async (method, params) => {
    seen = { method, params };
    return { verdict: "allow", pending: false, mode: "allow", capSats: 0, budgetCovered: false };
  });
  await client.callTool({
    name: "policy_probe",
    arguments: { action: "app-spend", amountSats: 264, label: "PULL" },
  });
  assert.equal(seen.method, "policyProbe");
  assert.equal(seen.params.origin, "test-agent");
  assert.equal(seen.params.action, "app-spend");
  assert.equal(seen.params.amountSats, 264);
  assert.equal(seen.params.label, "PULL");
  await assert.rejects(client.callTool({ name: "policy_probe", arguments: {} }), /action is required/);
  await client.close();
  await server.close();
});
test("events_poll stamps the agent origin and forwards the cursor", async () => {
  let seen = null;
  const { client, server } = await pair(async (method, params) => {
    seen = { method, params };
    return { events: [] };
  });
  await client.callTool({ name: "events_poll", arguments: { since: 4, wait_seconds: 5 } });
  assert.equal(seen.method, "eventsPoll");
  assert.equal(seen.params.origin, "test-agent");
  assert.equal(seen.params.since, 4);
  assert.equal(seen.params.waitMs, 5000);
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

