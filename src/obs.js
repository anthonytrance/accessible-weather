// Global surface observations from METAR aviation weather reports, served by
// the NOAA Aviation Weather Center data API (no key required). Responses are
// converted to the same observation schema the KMI feed uses so the client
// renders both identically.

const CACHE_TTL_SECONDS = 480;

export function relativeHumidityFromDewpoint(temperatureC, dewpointC) {
  if (!Number.isFinite(temperatureC) || !Number.isFinite(dewpointC)) return null;
  const magnus = (value) => Math.exp((17.625 * value) / (243.04 + value));
  const humidity = 100 * (magnus(dewpointC) / magnus(temperatureC));
  return Math.max(0, Math.min(100, Math.round(humidity)));
}

// Number(null) is 0, so missing METAR fields need an explicit null check.
function strictNumber(value) {
  return value == null || value === "" ? Number.NaN : Number(value);
}

export function metarToObservation(metar) {
  const temperature = strictNumber(metar.temp);
  if (!Number.isFinite(temperature)) return null;
  const latitude = strictNumber(metar.lat);
  const longitude = strictNumber(metar.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const obsEpoch = strictNumber(metar.obsTime);
  if (!Number.isFinite(obsEpoch) || obsEpoch <= 0) return null;

  const knotsToKmh = (value) => Number.isFinite(strictNumber(value)) ? strictNumber(value) * 1.852 : null;
  const direction = strictNumber(metar.wdir);

  return {
    code: String(metar.icaoId ?? ""),
    name: String(metar.name ?? metar.icaoId ?? "").split(",")[0].trim(),
    latitude,
    longitude,
    providerType: "METAR",
    observationPeriodMinutes: 60,
    timestamp: new Date(obsEpoch * 1000).toISOString(),
    validated: false,
    temperatureC: temperature,
    humidityPercent: relativeHumidityFromDewpoint(temperature, strictNumber(metar.dewp)),
    pressureHpa: Number.isFinite(strictNumber(metar.altim)) ? strictNumber(metar.altim) : null,
    windSpeedKmh: knotsToKmh(metar.wspd),
    windDirectionDegrees: Number.isFinite(direction) ? direction : null,
    windGustKmh: knotsToKmh(metar.wgst),
    precipitationMm: null
  };
}

export async function serveObservations(request, context) {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  }
  const params = new URL(request.url).searchParams;
  const latitude = Number(params.get("lat"));
  const longitude = Number(params.get("lon"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return jsonResponse({ error: "Invalid coordinates." }, 400);
  }

  // Snap to a half-degree grid so nearby requests share one cached METAR fetch.
  const gridLat = Math.round(latitude * 2) / 2;
  const gridLon = Math.round(longitude * 2) / 2;
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(`https://obs-cache.accessible-weather.invalid/metar?la=${gridLat}&lo=${gridLon}`);
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const south = Math.max(-89, gridLat - 1.3);
  const north = Math.min(89, gridLat + 1.3);
  const west = Math.max(-179.9, gridLon - 2);
  const east = Math.min(179.9, gridLon + 2);
  const upstream = new URL("https://aviationweather.gov/api/data/metar");
  upstream.search = new URLSearchParams({
    bbox: `${south},${west},${north},${east}`,
    format: "json",
    hours: "2"
  });

  let metars;
  try {
    const response = await fetch(upstream, {
      headers: { "user-agent": "accessible-weather (contact@xijaroandpitch.com)" }
    });
    if (!response.ok) throw new Error(`METAR upstream returned ${response.status}.`);
    metars = await response.json();
  } catch (error) {
    console.error("METAR fetch failed:", error);
    return jsonResponse({ error: "Observations unavailable." }, 502);
  }

  const observations = (Array.isArray(metars) ? metars : [])
    .map(metarToObservation)
    .filter(Boolean);

  const body = JSON.stringify({
    generatedAt: new Date().toISOString(),
    provider: "Aviation weather stations (METAR), NOAA Aviation Weather Center",
    observations
  });
  const result = new Response(body, {
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
