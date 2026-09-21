/**
 * Built-in MCP server: agents automate the wallet through here, never around it.
 *
 * Architecture: this server holds NO keys and NO chain state. Every tool call
 * forwards to the daemon over its RPC surface, stamped with the agent's
 * origin — so daemon policy (allow/deny/ask + caps) and the custody lock
 * apply to agents exactly like any other caller. A locked wallet or a
 * first-run denial surfaces as a plain-English MCP error telling the agent
 * what to ask its human for.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./rpc.ts";

export type DaemonCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export const MCP_AGENT_DEFAULT = "agent";

const TOOLS = [
  {
    name: "get_version",
    description: "Daemon version and BRC-100 support flag.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "wallet_status",
    description: "Whether the wallet is unlocked and enrolled. Call first; most tools need unlocked.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "wallet_balance",
    description: "Confirmed/unconfirmed balance and UTXO count of the daemon wallet.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "anchor_tip",
    description: "Timestamp a SHA-256 hash on-chain (OP_RETURN). Goes through spending policy for this agent.",
    inputSchema: {
      type: "object" as const,
      properties: { sha256: { type: "string", description: "64 hex chars" } },
      required: ["sha256"],
    },
  },
  {
    name: "list_pending",
    description: "Transactions the daemon is watching to confirmation.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "p2p_peers",
    description: "Other bsvOS wallets discovered on the local network by the daemon's direct P2P channel: identity key, address, online flag. Messages to online peers are delivered directly; others fall back to the encrypted relay.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "x402_pay",
    description: "Pay-per-call metered fetch: quotes, pays from this agent's budget through policy, retries with proof, returns the resource + receipt. Denials work exactly like anchor_tip.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "http(s) URL of the metered resource" },
        method: { type: "string", description: "GET (default) or POST" },
        data: { type: "object", description: "optional JSON body for POST" },
      },
      required: ["url"],
    },
  },
  {
    name: "jev_decide",
    description: "Ask Jev (TypeSafe System One) for a calibrated decision: a state (facts) plus typed questions — noul (yes/no probability), choice (pick from a set you define), score (rate on ordered levels) — returns probabilities and confidence in ~250 ms. Batch all questions into one call. ~$0.00002/call. Use for classification, routing, risk scoring, triage; not for writing or open-ended reasoning.",
    inputSchema: {
      type: "object" as const,
      properties: {
        state: { description: "facts to judge: string, object, or array (redact secrets)" },
        questions: {
          type: "object" as const,
          description: 'map of id -> { type: "noul"|"choice"|"score", instructions, criteria? }; choice needs { option: description }, score needs >=2 level strings',
        },
        model: { type: "string", description: "default typesafe/jev-1.13" },
      },
      required: ["state", "questions"],
    },
  },
  {
    name: "jev_status",
    description: "Whether Jev is configured in the daemon, which model is used, and the auto-approval thresholds.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "policy_probe",
    description: "Dry-run the spending gate for a hypothetical spend: runs caps, your sub-wallet budget, and Jev, and reports the verdict (allow/deny), reason, and Jev score — without writing a request or moving money. Use before spending to see whether an action would pass and what approval it needs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: "spend action, e.g. app-spend, app-inscribe, send" },
        amountSats: { type: "number", description: "total sats that would leave the wallet (payments + fee)" },
        label: { type: "string", description: "optional human label, e.g. POCKETPETS-PULL" },
        description: { type: "string", description: "optional one-line description of what the spend buys" },
      },
      required: ["action", "amountSats"],
    },
  },
  {
    name: "events_poll",
    description: "Wait for approval-lifecycle events for this agent: request created/approved/denied, budget minted/revoked. Returns new events since `since` (an event id; 0 first, then track the last id seen), or holds up to `wait_seconds` (max 60) until something happens. Poll this in a loop instead of diffing requests or balance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        since: { type: "number", description: "only events with id greater than this" },
        wait_seconds: { type: "number", description: "long-poll up to this many seconds (default 0 = return immediately, max 60)" },
      },
    },
  },
  {
    name: "market_browse",
    description: "Browse the atomic market: active listings of ordinals and BSV21 tokens with prices, sellers, and fees. Read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        kind: { type: "string", description: "optional filter: ordinal or bsv21" },
      },
    },
  },
  {
    name: "market_buy",
    description: "Buy a market listing end to end: the daemon fetches the terms, verifies the seller and price, signs, broadcasts, and posts the settlement. Payment + asset move in one atomic tx when the seller published an offer. Spends from YOUR budget through policy; denials work like anchor_tip.",
    inputSchema: {
      type: "object" as const,
      properties: {
        listing: { type: "string", description: "asset outpoint from market_browse, e.g. <txid>.<vout>" },
        maxPrice: { type: "number", description: "optional ceiling in sats (defaults to the listing price)" },
      },
      required: ["listing"],
    },
  },
  {
    name: "market_list",
    description: "List one of the wallet's ordinals or BSV21 token UTXOs for atomic sale: signs the offer and posts it with the market's operator fee. The asset stays in the wallet until bought.",
    inputSchema: {
      type: "object" as const,
      properties: {
        outpoint: { type: "string", description: "asset outpoint to list, e.g. <txid>_<vout>" },
        priceSats: { type: "number", description: "asking price in sats" },
        kind: { type: "string", description: "ordinal (default) or bsv21" },
        tokenId: { type: "string", description: "bsv21 token id (<txid>_<vout>), required for bsv21" },
        tokenAmount: { type: "string", description: "bsv21 base units (exact UTXO amount), required for bsv21" },
        title: { type: "string", description: "optional listing title" },
      },
      required: ["outpoint", "priceSats"],
    },
  },
  {
    name: "market_sync",
    description: "Reconcile a completed buy with the market when the immediate post failed (indexers lag fresh broadcasts): posts the buy (+settle for atomic swaps) for a txid that already exists. Idempotent when the listing already recorded that txid.",
    inputSchema: {
      type: "object" as const,
      properties: {
        listing: { type: "string", description: "asset outpoint of the listing that was bought" },
        txid: { type: "string", description: "64-hex txid of the broadcast buy" },
      },
      required: ["listing", "txid"],
    },
  },
];

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Map daemon error envelopes to agent-actionable MCP errors. */
export function friendlyError(agent: string, err: unknown): McpError {
  const code =
    (err as { code?: string })?.code ??
    (err as { error?: { code?: string } })?.error?.code ??
    "INTERNAL";
  const message =
    (err as Error)?.message ??
    (err as { error?: { message?: string } })?.error?.message ??
    String(err);
  if (code === "POLICY_DENY") {
    return new McpError(
      ErrorCode.InvalidRequest,
      `spending denied (${message}). Ask your human to run: bsv allow ${agent}`,
    );
  }
  if (code === "WALLET_LOCKED" || code === "NO_WALLET") {
    return new McpError(ErrorCode.InvalidRequest, `wallet unavailable (${message}). Ask your human to unlock it.`);
  }
  if (code === "NO_KEY" || code === "JEV_UNAVAILABLE" || code === "JEV_TIMEOUT") {
    return new McpError(
      ErrorCode.InvalidRequest,
      `Jev unavailable (${message}). Ask your human to set OPENROUTER_API_KEY for the daemon.`,
    );
  }
  return new McpError(ErrorCode.InternalError, `${code}: ${message}`.slice(0, 500));
}

export function buildMcpServer(callDaemon: DaemonCall, agent: string): Server {
  const server = new Server(
    { name: "bsv-walletd", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "get_version":
          return text({ version: VERSION, brc100: true, agent });
        case "wallet_status":
          return text(await callDaemon("isAuthenticated"));
        case "wallet_balance":
          return text(await callDaemon("balance"));
        case "anchor_tip": {
          if (typeof args.sha256 !== "string") {
            throw new McpError(ErrorCode.InvalidParams, "sha256 (64 hex chars) is required");
          }
          return text(await callDaemon("anchor", { sha256: args.sha256, origin: agent }));
        }
        case "list_pending":
          return text(await callDaemon("pending"));
        case "p2p_peers":
          return text(await callDaemon("p2pPeers"));
        case "x402_pay": {
          if (typeof args.url !== "string" || !args.url) {
            throw new McpError(ErrorCode.InvalidParams, "url is required");
          }
          return text(await callDaemon("x402Pay", {
            url: args.url,
            method: typeof args.method === "string" ? args.method : "GET",
            body: args.data ?? undefined,
            origin: agent,
          }));
        }
        case "jev_decide": {
          if (args.state === undefined || args.state === null) {
            throw new McpError(ErrorCode.InvalidParams, "state is required");
          }
          if (args.questions === null || typeof args.questions !== "object") {
            throw new McpError(ErrorCode.InvalidParams, "questions map is required");
          }
          return text(await callDaemon("jevDecide", {
            state: args.state,
            questions: args.questions,
            ...(typeof args.model === "string" && args.model ? { model: args.model } : {}),
          }));
        }
        case "jev_status":
          return text(await callDaemon("jevStatus"));
        case "events_poll":
          return text(await callDaemon("eventsPoll", {
            origin: agent,
            ...(Number.isFinite(Number(args.since)) ? { since: Number(args.since) } : {}),
            ...(Number.isFinite(Number(args.wait_seconds)) ? { waitMs: Math.floor(Number(args.wait_seconds) * 1000) } : {}),
          }));
        case "market_browse":
          return text(await callDaemon("marketBrowse", {
            ...(typeof args.kind === "string" && args.kind ? { kind: args.kind } : {}),
          }));
        case "market_buy": {
          if (typeof args.listing !== "string" || !args.listing) {
            throw new McpError(ErrorCode.InvalidParams, "listing (asset outpoint) is required");
          }
          return text(await callDaemon("marketBuy", {
            listing: args.listing,
            origin: agent,
            ...(Number.isFinite(Number(args.maxPrice)) ? { maxPrice: Number(args.maxPrice) } : {}),
          }));
        }
        case "market_list": {
          if (typeof args.outpoint !== "string" || !args.outpoint) {
            throw new McpError(ErrorCode.InvalidParams, "outpoint is required");
          }
          if (!(Number(args.priceSats) > 0)) {
            throw new McpError(ErrorCode.InvalidParams, "priceSats must be a positive sat number");
          }
          return text(await callDaemon("marketList", {
            outpoint: args.outpoint,
            priceSats: Number(args.priceSats),
            origin: agent,
            ...(typeof args.kind === "string" && args.kind ? { kind: args.kind } : {}),
            ...(typeof args.tokenId === "string" ? { tokenId: args.tokenId } : {}),
            ...(typeof args.tokenAmount === "string" ? { tokenAmount: args.tokenAmount } : {}),
            ...(typeof args.title === "string" && args.title ? { title: args.title } : {}),
          }));
        }
        case "market_sync": {
          if (typeof args.listing !== "string" || !args.listing) {
            throw new McpError(ErrorCode.InvalidParams, "listing (asset outpoint) is required");
          }
          if (typeof args.txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(args.txid)) {
            throw new McpError(ErrorCode.InvalidParams, "txid must be a 64-hex transaction id");
          }
          return text(await callDaemon("marketSync", { listing: args.listing, txid: args.txid }));
        }
        case "policy_probe": {
          if (typeof args.action !== "string" || !args.action) {
            throw new McpError(ErrorCode.InvalidParams, "action is required");
          }
          if (!(Number(args.amountSats) > 0)) {
            throw new McpError(ErrorCode.InvalidParams, "amountSats must be a positive sat number");
          }
          return text(await callDaemon("policyProbe", {
            origin: agent,
            action: args.action,
            amountSats: Number(args.amountSats),
            ...(typeof args.label === "string" && args.label ? { label: args.label } : {}),
            ...(typeof args.description === "string" && args.description ? { description: args.description } : {}),
          }));
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw friendlyError(agent, err);
    }
  });

  return server;
}
