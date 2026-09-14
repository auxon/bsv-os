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
