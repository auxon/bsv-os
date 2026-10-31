import { applyOverlayTx } from "./apply.ts";
import { D1ListingStore } from "./d1-store.ts";
import { overlayTxFromJson } from "./json-tx.ts";
import { LOOKUP_DOCS, lookupLicense, lookupListings, type ListingQuery } from "./lookup.ts";
import { configFromEnv, LOOKUP, TOPIC } from "./protocol.ts";
import { TOPIC_MANAGER_DOCS } from "./topic-manager.ts";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-topics, x-bsv-topic",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });
}

function cfgOf(env: Env) {
  return configFromEnv({
    STORE_ADDRESS: env.STORE_ADDRESS,
    STORE_PUBKEY: env.STORE_PUBKEY,
    PUBLISHING_FEE_SATS: env.PUBLISHING_FEE_SATS,
    STORE_CUT_BPS: env.STORE_CUT_BPS,
  });
}

function queryFromUrl(url: URL): ListingQuery {
  const q: ListingQuery = {};
  const name = url.searchParams.get("name") ?? url.searchParams.get("q");
  const category = url.searchParams.get("category");
  const publisher = url.searchParams.get("publisher");
  const domain = url.searchParams.get("domain");
  if (name) q.name = name;
  if (category) q.category = category;
  if (publisher) q.publisher = publisher;
  if (domain) q.domain = domain;
  q.latest = url.searchParams.get("latest") !== "0";
  return q;
}

function queryFromBody(raw: unknown): ListingQuery {
  if (!raw || typeof raw !== "object") return { latest: true };
  const o = raw as Record<string, unknown>;
  const q: ListingQuery = { latest: o.latest !== false };
  if (typeof o.name === "string") q.name = o.name;
  if (typeof o.category === "string") q.category = o.category;
  if (typeof o.publisher === "string") q.publisher = o.publisher;
  if (typeof o.domain === "string") q.domain = o.domain;
  if (o.includeSpent === true) q.includeSpent = true;
  return q;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const store = new D1ListingStore(env.DB);
    const topic = env.TOPIC || TOPIC;
    const lookup = env.LOOKUP || LOOKUP;

    try {
      if (path === "/" && request.method === "GET") {
        return json({
          topic,
          lookup,
          storeConfigured: Boolean(env.STORE_ADDRESS),
          docs: "/getDocumentationForTopicManager",
        });
      }
      if (path === "/health" && request.method === "GET") {
        return json({ ok: true, topic, lookup });
      }
      if (path === "/listTopicManagers" && request.method === "GET") {
        return json({
          [topic]: { name: "bsvOS App Store", shortDescription: "Listing tokens for Metanet apps" },
        });
      }
      if (path === "/listLookupServiceProviders" && request.method === "GET") {
        return json({
          [lookup]: { name: "bsvOS App Store lookup", shortDescription: "Search listings and licenses" },
        });
      }
      if (path === "/getDocumentationForTopicManager" && request.method === "GET") {
        return text(TOPIC_MANAGER_DOCS);
      }
      if (path === "/getDocumentationForLookupServiceProvider" && request.method === "GET") {
        return text(LOOKUP_DOCS);
      }
      if (path === "/apps" && request.method === "GET") {
        const rows = await lookupListings(store, queryFromUrl(url));
        return json({ service: lookup, apps: rows });
      }
      if (path === "/lookup" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          service?: unknown;
          query?: unknown;
        } | null;
        if (!body || body.service !== lookup) {
          return json({ error: `unknown service (this host serves ${lookup})` }, 400);
        }
        const q = body.query;
        if (q && typeof q === "object" && "licensed" in (q as object)) {
          const lic = (q as { licensed?: { listingOutpoint?: string; paymentTxid?: string } }).licensed ?? {};
          return json({ type: "freeform-results", result: await lookupLicense(store, lic) });
        }
        const rows = await lookupListings(store, queryFromBody(q));
        return json({
          type: "freeform-results",
          result: rows,
        });
      }
      if (path === "/submit" && request.method === "POST") {
        const cfg = cfgOf(env);
        const topicsHeader = request.headers.get("x-topics") ?? request.headers.get("X-Topics");
        let topics: string[] = [];
        if (topicsHeader) {
          try {
            topics = JSON.parse(topicsHeader) as string[];
          } catch {
            return json({ error: "X-Topics must be a JSON array" }, 400);
          }
        }
        const ct = request.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const body = (await request.json()) as { topics?: unknown; tx?: unknown };
          if (Array.isArray(body.topics)) topics = body.topics.map(String);
          if (!topics.includes(topic)) return json({ error: `this host admits ${topic} only` }, 400);
          const tx = overlayTxFromJson(body.tx);
          const applied = await applyOverlayTx(store, tx, cfg);
          return json({
            [topic]: {
              outputsToAdmit: applied.admitted ? [applied.outpoint] : [],
              coinsToRetain: [],
              ok: applied.ok,
              kind: applied.kind,
              reason: applied.reason,
            },
          }, applied.ok ? 200 : 400);
        }
        return json({
          error: "BEEF submit is accepted on this host once framed; until then POST JSON { topics, tx }",
        }, 415);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ level: "error", msg: message, path }));
      return json({ error: message }, 500);
    }
  },
} satisfies { fetch(request: Request, env: Env): Promise<Response> };
