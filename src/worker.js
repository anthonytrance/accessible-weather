import { fetchKmiFeed } from "./kmi-feed.js";
import { processPushSubscriptions, sanitizeSubscriptionRecord, subscriptionIdFromEndpoint } from "./push.js";
import { serveObservations } from "./obs.js";
import { serveNowcast } from "./nowcast.js";

const KMI_KEY = "latest";

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === "/api/kmi") return serveKmi(request, env);
    if (url.pathname === "/api/obs") return serveObservations(request, context);
    if (url.pathname === "/api/nowcast") return serveNowcast(request, context);
    if (url.pathname === "/api/push/vapid-public-key") return serveVapidKey(request, env);
    if (url.pathname === "/api/push/subscribe") return handleSubscribe(request, env);
    if (url.pathname === "/api/push/unsubscribe") return handleUnsubscribe(request, env);
    if (url.pathname === "/api/push/pending") return servePending(request, env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, context) {
    context.waitUntil(Promise.allSettled([refreshKmi(env), processPushSubscriptions(env)]));
  }
};

export async function refreshKmi(env, options) {
  const data = await fetchKmiFeed(options);
  await env.KMI_DATA.put(KMI_KEY, JSON.stringify(data));
  return data;
}

async function serveKmi(request, env) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const data = await env.KMI_DATA.get(KMI_KEY, { type: "json", cacheTtl: 60 });
  if (!data) {
    const fallbackUrl = new URL("/data/kmi-latest.json", request.url);
    return env.ASSETS.fetch(new Request(fallbackUrl, request));
  }

  return new Response(request.method === "HEAD" ? null : JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
      "x-weather-data-source": "cloudflare-kv"
    }
  });
}

function serveVapidKey(request, env) {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  }
  if (!env.VAPID_PUBLIC_KEY) {
    return jsonResponse({ error: "Push is not configured." }, 503);
  }
  return jsonResponse({ key: env.VAPID_PUBLIC_KEY });
}

async function handleSubscribe(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON." }, 400);
  }
  const endpoint = body?.subscription?.endpoint;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    return jsonResponse({ error: "Invalid subscription." }, 400);
  }
  const id = await subscriptionIdFromEndpoint(endpoint);
  const existing = await env.KMI_DATA.get(`push:${id}`, { type: "json" });
  const record = sanitizeSubscriptionRecord(body, existing);
  if (!record) return jsonResponse({ error: "Invalid subscription." }, 400);
  await env.KMI_DATA.put(`push:${id}`, JSON.stringify(record));
  return jsonResponse({ id });
}

async function handleUnsubscribe(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON." }, 400);
  }
  if (typeof body?.endpoint !== "string") return jsonResponse({ error: "Missing endpoint." }, 400);
  const id = await subscriptionIdFromEndpoint(body.endpoint);
  await env.KMI_DATA.delete(`push:${id}`);
  await env.KMI_DATA.delete(`pushmsg:${id}`);
  return jsonResponse({ ok: true });
}

async function servePending(request, env) {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  }
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f]{64}$/.test(id)) return jsonResponse({ error: "Invalid id." }, 400);
  const key = `pushmsg:${id}`;
  const messages = (await env.KMI_DATA.get(key, { type: "json" })) ?? [];
  if (messages.length) await env.KMI_DATA.delete(key);
  return jsonResponse({ messages });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
