import { fetchKmiFeed } from "./kmi-feed.js";

const KMI_KEY = "latest";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/kmi") return serveKmi(request, env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, context) {
    context.waitUntil(refreshKmi(env));
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
