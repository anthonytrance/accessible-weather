import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

test("the app loads Mechelen weather and renders its decision-first interface", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://example.test/", pretendToBeVisual: true });
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    localStorage: globalThis.localStorage,
    fetch: globalThis.fetch
  };

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.localStorage = dom.window.localStorage;
  globalThis.fetch = createFetchMock();

  try {
    await import(`../app.js?smoke=${Date.now()}`);
    await waitFor(() => !document.getElementById("weather-content").hidden);

    assert.equal(document.getElementById("weather-location-heading").textContent, "Mechelen");
    assert.match(document.getElementById("decision-summary").textContent, /No rain expected/);
    assert.equal(document.getElementById("measured-observation").hidden, false);
    assert.match(document.getElementById("station-description").textContent, /Sint-Katelijne-Waver/);
    assert.equal(document.querySelectorAll("#hourly-body tr").length, 12);
    assert.equal(document.querySelectorAll("#daily-list article").length, 5);
    assert.equal(document.querySelectorAll("#rain-timeline li").length, 24);
  } finally {
    globalThis.window = original.window;
    globalThis.document = original.document;
    Object.defineProperty(globalThis, "navigator", { value: original.navigator, configurable: true });
    globalThis.localStorage = original.localStorage;
    globalThis.fetch = original.fetch;
    dom.window.close();
  }
});

function createFetchMock() {
  const offsetSeconds = 7200;
  const now = Date.now();
  const localNow = new Date(now + offsetSeconds * 1000);
  const currentIso = localNow.toISOString().slice(0, 16);
  const hourlyTimes = Array.from({ length: 120 }, (_, index) => new Date(localNow.getTime() + index * 3_600_000).toISOString().slice(0, 16));
  const minutelyTimes = Array.from({ length: 48 }, (_, index) => new Date(localNow.getTime() + index * 900_000).toISOString().slice(0, 16));
  const dailyTimes = Array.from({ length: 5 }, (_, index) => new Date(localNow.getTime() + index * 86_400_000).toISOString().slice(0, 10));
  const radarStart = Math.ceil((now + offsetSeconds * 1000) / 300_000) * 300_000;
  const radarText = Array.from({ length: 24 }, (_, index) => {
    const time = new Date(radarStart + index * 300_000);
    return `000|${String(time.getUTCHours()).padStart(2, "0")}:${String(time.getUTCMinutes()).padStart(2, "0")}`;
  }).join("\n");

  const weather = {
    timezone: "Europe/Brussels",
    utc_offset_seconds: offsetSeconds,
    current: {
      time: currentIso,
      temperature_2m: 25.2,
      apparent_temperature: 23.3,
      relative_humidity_2m: 43,
      precipitation: 0,
      rain: 0,
      showers: 0,
      weather_code: 1,
      cloud_cover: 40,
      pressure_msl: 1014,
      wind_speed_10m: 17,
      wind_direction_10m: 328,
      wind_gusts_10m: 37
    },
    minutely_15: {
      time: minutelyTimes,
      precipitation: minutelyTimes.map(() => 0),
      rain: minutelyTimes.map(() => 0),
      showers: minutelyTimes.map(() => 0),
      weather_code: minutelyTimes.map(() => 1)
    },
    hourly: {
      time: hourlyTimes,
      temperature_2m: hourlyTimes.map(() => 25),
      apparent_temperature: hourlyTimes.map(() => 23),
      relative_humidity_2m: hourlyTimes.map(() => 45),
      precipitation_probability: hourlyTimes.map(() => 0),
      precipitation: hourlyTimes.map(() => 0),
      weather_code: hourlyTimes.map(() => 1),
      wind_speed_10m: hourlyTimes.map(() => 15),
      wind_gusts_10m: hourlyTimes.map(() => 25)
    },
    daily: {
      time: dailyTimes,
      weather_code: dailyTimes.map(() => 1),
      temperature_2m_max: dailyTimes.map(() => 26),
      temperature_2m_min: dailyTimes.map(() => 15),
      apparent_temperature_max: dailyTimes.map(() => 25),
      apparent_temperature_min: dailyTimes.map(() => 14),
      precipitation_probability_max: dailyTimes.map(() => 10),
      precipitation_sum: dailyTimes.map(() => 0),
      sunrise: dailyTimes.map((date) => `${date}T05:45`),
      sunset: dailyTimes.map((date) => `${date}T21:45`)
    }
  };

  const kmi = {
    generatedAt: new Date(now).toISOString(),
    observations: [{
      name: "SINT-KATELIJNE-WAVER",
      providerType: "automatic 10-minute",
      observationPeriodMinutes: 10,
      latitude: 51.075,
      longitude: 4.525,
      timestamp: new Date(now - 600_000).toISOString(),
      temperatureC: 23.6,
      humidityPercent: 55,
      pressureHpa: 1014,
      windSpeedKmh: 16,
      windDirectionDegrees: 299,
      windGustKmh: 25,
      precipitationMm: 0
    }]
  };

  return async (input) => {
    const url = String(input);
    if (url.includes("api.open-meteo.com/v1/forecast")) return jsonResponse(weather);
    if (url.includes("gps.buienradar.nl")) return new Response(radarText, { status: 200 });
    if (url.includes("/api/kmi") || url.includes("data/kmi-latest.json")) return jsonResponse(kmi);
    throw new Error(`Unexpected test request: ${url}`);
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the app to render.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
