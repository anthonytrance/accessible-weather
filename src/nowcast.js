// Radar-based rain nowcasts proxied through the Worker: MET Norway Nowcast
// 2.0 for the Nordic region (api.met.no requires an identifying User-Agent
// that browsers cannot set) and the DWD RV radar composite via Bright Sky for
// Germany and surroundings. Both return the same point shape the client uses
// for Buienradar, or 404 outside radar coverage so the client falls back to
// the Open-Meteo model nowcast.

import { isDwdCoverage, isMetnoCoverage } from "../weather-utils.js";

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

// Bright Sky serves DWD RV values as hundredths of a millimetre per five
// minutes; one unit therefore equals 0.12 mm/h.
export function brightskyToPoints(payload, nowEpoch = Date.now()) {
  const frames = payload?.radar;
  if (!Array.isArray(frames)) return null;
  return frames
    .map((frame) => ({
      time: Date.parse(frame.timestamp),
      mmPerHour: Number(frame.precipitation_5?.[0]?.[0] ?? Number.NaN) * 0.12
    }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.mmPerHour) && point.mmPerHour >= 0)
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

  let provider = null;
  if (isMetnoCoverage(latitude, longitude)) provider = "metno";
  else if (isDwdCoverage(latitude, longitude)) provider = "dwd";
  if (!provider) return jsonResponse({ error: "Outside radar coverage." }, 404);

  const gridLat = Math.round(latitude * 20) / 20;
  const gridLon = Math.round(longitude * 20) / 20;
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(`https://nowcast-cache.accessible-weather.invalid/${provider}?la=${gridLat}&lo=${gridLon}`);
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let points;
  try {
    points = provider === "metno"
      ? await fetchMetnoPoints(gridLat, gridLon)
      : await fetchDwdPoints(gridLat, gridLon);
  } catch (error) {
    console.error(`${provider} nowcast fetch failed:`, error);
    return jsonResponse({ error: "Nowcast unavailable." }, 502);
  }
  if (points === "outside") return jsonResponse({ error: "Outside radar coverage." }, 404);
  if (!points || points.length < 12) return jsonResponse({ error: "Outside radar coverage." }, 404);

  const result = new Response(JSON.stringify({ source: "radar", provider, intervalMinutes: 5, points }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=120, s-maxage=${CACHE_TTL_SECONDS}`
    }
  });
  if (cache && context) context.waitUntil(cache.put(cacheKey, result.clone()));
  return result;
}

async function fetchMetnoPoints(latitude, longitude) {
  const upstream = new URL("https://api.met.no/weatherapi/nowcast/2.0/complete");
  upstream.search = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
  const response = await fetch(upstream, {
    headers: { "user-agent": "accessible-weather (contact@xijaroandpitch.com)" }
  });
  if (response.status === 422) return "outside";
  if (!response.ok) throw new Error(`MET Norway returned ${response.status}.`);
  return metnoToPoints(await response.json());
}

async function fetchDwdPoints(latitude, longitude) {
  const upstream = new URL("https://api.brightsky.dev/radar");
  upstream.search = new URLSearchParams({
    lat: String(latitude),
    lon: String(longitude),
    distance: "0",
    format: "plain"
  });
  const response = await fetch(upstream, {
    headers: { "user-agent": "accessible-weather (contact@xijaroandpitch.com)" }
  });
  if (response.status === 404) return "outside";
  if (!response.ok) throw new Error(`Bright Sky returned ${response.status}.`);
  return brightskyToPoints(await response.json());
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
