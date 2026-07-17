import { isBuienradarCoverage, parseBuienradarText, summarizeRain } from "../weather-utils.js";
import { formatRainSummary, isSupportedLanguage, localizedWeatherLabel, translate } from "../i18n.js";

const RAIN_LEAD_MINUTES = 30;
const RAIN_COOLDOWN_MS = 90 * 60_000;
const PENDING_TTL_SECONDS = 1800;

export function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(value) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export async function subscriptionIdFromEndpoint(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createVapidJwt(endpoint, env, now = Date.now()) {
  const audience = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:contact@xijaroandpitch.com"
  };
  const input = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(env.VAPID_PRIVATE_KEY_JWK),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// Sends a payload-free push "tickle"; the service worker fetches the pending
// messages itself, which avoids Web Push payload encryption entirely.
async function sendTickle(endpoint, env) {
  const jwt = await createVapidJwt(endpoint, env);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      TTL: "600",
      Urgency: "high",
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
    }
  });
  return response.status;
}

export async function queueAndSend(env, id, record, message) {
  const pendingKey = `pushmsg:${id}`;
  const pending = (await env.KMI_DATA.get(pendingKey, { type: "json" })) ?? [];
  pending.push(message);
  await env.KMI_DATA.put(pendingKey, JSON.stringify(pending.slice(-5)), { expirationTtl: PENDING_TTL_SECONDS });
  const status = await sendTickle(record.subscription.endpoint, env);
  if (status === 404 || status === 410) {
    await env.KMI_DATA.delete(`push:${id}`);
    await env.KMI_DATA.delete(pendingKey);
    return false;
  }
  return true;
}

export function sanitizeSubscriptionRecord(body, existing = null) {
  const subscription = body?.subscription;
  const endpoint = subscription?.endpoint;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) return null;
  const location = body?.location ?? {};
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const briefingHour = Number.isInteger(body?.prefs?.briefingHour) && body.prefs.briefingHour >= 0 && body.prefs.briefingHour <= 23
    ? body.prefs.briefingHour
    : null;
  return {
    subscription: { endpoint, keys: subscription.keys ?? {} },
    location: {
      name: String(location.name ?? "").slice(0, 80),
      latitude,
      longitude,
      timezone: String(location.timezone ?? "UTC").slice(0, 60)
    },
    language: isSupportedLanguage(body?.language) ? body.language : "en",
    units: {
      temperatureUnit: body?.units?.temperatureUnit === "fahrenheit" ? "fahrenheit" : "celsius",
      windUnit: ["kmh", "mph", "ms", "bft"].includes(body?.units?.windUnit) ? body.units.windUnit : "kmh"
    },
    prefs: {
      rainAlerts: body?.prefs?.rainAlerts !== false,
      briefingHour
    },
    state: existing?.state ?? {},
    updatedAt: new Date().toISOString()
  };
}

export async function processPushSubscriptions(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY_JWK) return;
  const list = await env.KMI_DATA.list({ prefix: "push:" });
  for (const entry of list.keys) {
    try {
      const record = await env.KMI_DATA.get(entry.name, { type: "json" });
      if (!record?.subscription?.endpoint) continue;
      await processRecord(env, entry.name, record);
    } catch (error) {
      console.error(`Push processing failed for ${entry.name}:`, error);
    }
  }
}

async function processRecord(env, kvKey, record) {
  const id = kvKey.slice("push:".length);
  const lang = isSupportedLanguage(record.language) ? record.language : "en";
  const state = record.state ?? {};
  const before = JSON.stringify(state);

  if (record.prefs?.rainAlerts) {
    await maybeSendRainAlert(env, id, record, lang, state);
  }
  if (Number.isInteger(record.prefs?.briefingHour)) {
    await maybeSendBriefing(env, id, record, lang, state);
  }

  if (JSON.stringify(state) !== before) {
    record.state = state;
    const fresh = await env.KMI_DATA.get(kvKey, { type: "json" });
    if (fresh) await env.KMI_DATA.put(kvKey, JSON.stringify({ ...fresh, state }));
  }
}

async function maybeSendRainAlert(env, id, record, lang, state) {
  const points = await fetchRainPoints(record.location);
  if (!points) return;
  const summary = summarizeRain(points.points, { nowEpoch: Date.now() });
  const imminent = summary.kind === "raining"
    || (summary.kind === "upcoming" && summary.minutesUntil <= RAIN_LEAD_MINUTES);
  const wasDry = state.lastRainState !== "wet";
  const cooledDown = Date.now() - (state.lastRainAlertAt ?? 0) > RAIN_COOLDOWN_MS;

  if (imminent && wasDry && cooledDown) {
    const formatTime = timeFormatter(lang, record.location.timezone);
    const sentence = formatRainSummary(lang, summary, formatTime, points.source);
    const sent = await queueAndSend(env, id, record, {
      title: translate(lang, "push.rain.title", { name: record.location.name }),
      body: sentence.headline,
      tag: "rain-alert",
      lang
    });
    if (sent) state.lastRainAlertAt = Date.now();
  }
  state.lastRainState = imminent ? "wet" : "dry";
}

async function maybeSendBriefing(env, id, record, lang, state) {
  const timezone = record.location.timezone || "UTC";
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now());
  const localHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "numeric", hour12: false }).format(Date.now()));
  if (localHour !== record.prefs.briefingHour || state.lastBriefingDate === localDate) return;

  const daily = await fetchDailyForecast(record.location, timezone);
  if (!daily) return;
  const formatTime = timeFormatter(lang, timezone);
  const body = translate(lang, "push.briefing.body", {
    conditions: localizedWeatherLabel(lang, daily.weather_code[0]),
    high: formatTemperature(lang, record.units, daily.temperature_2m_max[0]),
    low: formatTemperature(lang, record.units, daily.temperature_2m_min[0]),
    chance: Math.round(daily.precipitation_probability_max[0] ?? 0),
    wind: formatWind(lang, record.units, daily.wind_speed_10m_max?.[0]),
    sunrise: formatTime(localIso(daily.sunrise[0], timezone)),
    sunset: formatTime(localIso(daily.sunset[0], timezone))
  });
  const sent = await queueAndSend(env, id, record, {
    title: translate(lang, "push.briefing.title", { name: record.location.name }),
    body,
    tag: "daily-briefing",
    lang
  });
  if (sent) state.lastBriefingDate = localDate;
}

// The Open-Meteo daily API returns local ISO strings without an offset; turn
// one into an epoch using the IANA timezone.
function localIso(isoString, timezone) {
  const assumed = Date.parse(`${isoString}:00Z`);
  return assumed - timezoneOffsetMs(timezone, new Date(assumed));
}

export function timezoneOffsetMs(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const hour = values.hour === 24 ? 0 : values.hour;
  const asUtc = Date.UTC(values.year, values.month - 1, values.day, hour, values.minute, values.second);
  return asUtc - date.getTime();
}

function timeFormatter(lang, timezone) {
  return (epoch) => new Intl.DateTimeFormat(lang, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone || "UTC"
  }).format(epoch);
}

function formatTemperature(lang, units, celsius) {
  if (!Number.isFinite(Number(celsius))) return translate(lang, "value.notReported");
  const fahrenheit = units?.temperatureUnit === "fahrenheit";
  const value = fahrenheit ? Number(celsius) * 9 / 5 + 32 : Number(celsius);
  const formatted = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
  return `${formatted}°${fahrenheit ? "F" : "C"}`;
}

function formatWind(lang, units, kmh) {
  if (!Number.isFinite(Number(kmh))) return translate(lang, "value.notReported");
  const value = Number(kmh);
  switch (units?.windUnit) {
    case "mph": return `${Math.round(value * 0.621371)} mph`;
    case "ms": return `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(value / 3.6)} m/s`;
    default: return `${Math.round(value)} km/h`;
  }
}

async function fetchRainPoints(location) {
  if (isBuienradarCoverage(location.latitude, location.longitude)) {
    try {
      const url = new URL("https://gps.buienradar.nl/getrr.php");
      url.search = new URLSearchParams({ lat: String(location.latitude), lon: String(location.longitude) });
      const response = await fetch(url);
      if (response.ok) {
        const offsetSeconds = timezoneOffsetMs("Europe/Amsterdam") / 1000;
        const points = parseBuienradarText(await response.text(), Date.now(), offsetSeconds);
        if (points.length >= 12) return { source: "radar", points };
      }
    } catch {
      // Fall through to the model nowcast below.
    }
  }

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      minutely_15: "precipitation",
      forecast_days: "1",
      timezone: "UTC"
    });
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const points = data.minutely_15.time.map((time, index) => ({
      time: Date.parse(`${time}Z`),
      mmPerHour: Number(data.minutely_15.precipitation[index] ?? 0) * 4
    })).filter((point) => point.time >= Date.now() - 10 * 60_000).slice(0, 9);
    return points.length ? { source: "model", points } : null;
  } catch {
    return null;
  }
}

async function fetchDailyForecast(location, timezone) {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,wind_speed_10m_max",
      forecast_days: "1",
      timezone
    });
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data.daily?.time?.length ? data.daily : null;
  } catch {
    return null;
  }
}
