// Radar-based rain nowcast for the Nordic region via MET Norway's Nowcast 2.0
// API, proxied because api.met.no requires an identifying User-Agent header
// that browsers cannot set. Returns the same point shape the client uses for
// Buienradar, or 404 outside radar coverage so the client falls back to the
// Open-Meteo model nowcast.

const CACHE_TTL_SECONDS = 240;

export function metnoToPoints(payload, nowEpoch = Date.now()) {
  if (payload?.properties?.meta?.radar_coverage !== "ok") return null;
  const series = payload.properties?.timeseries;
  if (!Array.isArray(series)) return null;
  return series
    .map((entry) => ({
      time: Date.parse(entry.time),
      mmPerHour: Number(entry.data?.instant?.details?.precipitation_rate ?? Number.NaN)
    }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.mmPerHour))
    .filter((point) => point.time >= nowEpoch - 10 * 60_000)
    .slice(0, 24);
}

export async function serveNowcast(request, context) {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  }
  const params = new URL(request.url).searchParams;
  const latitude = Number(params.get("lat"));
  const longitude = Number(params.get("lon"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return jsonResponse({ error: "Invalid coordinates." }, 400);
  }

  const gridLat = Math.round(latitude * 20) / 20;
  const gridLon = Math.round(longitude * 20) / 20;
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(`https://nowcast-cache.accessible-weather.invalid/metno?la=${gridLat}&lo=${gridLon}`);
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let payload;
  try {
    const upstream = new URL("https://api.met.no/weatherapi/nowcast/2.0/complete");
    upstream.search = new URLSearchParams({ lat: String(gridLat), lon: String(gridLon) });
    const response = await fetch(upstream, {
      headers: { "user-agent": "accessible-weather (contact@xijaroandpitch.com)" }
    });
    if (response.status === 422) return jsonResponse({ error: "Outside radar coverage." }, 404);
    if (!response.ok) throw new Error(`Nowcast upstream returned ${response.status}.`);
    payload = await response.json();
  } catch (error) {
    console.error("MET Norway nowcast fetch failed:", error);
    return jsonResponse({ error: "Nowcast unavailable." }, 502);
  }

  const points = metnoToPoints(payload);
  if (!points || points.length < 12) return jsonResponse({ error: "Outside radar coverage." }, 404);

  const result = new Response(JSON.stringify({ source: "radar", intervalMinutes: 5, points }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=120, s-maxage=${CACHE_TTL_SECONDS}`
    }
  });
  if (cache && context) context.waitUntil(cache.put(cacheKey, result.clone()));
  return result;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
