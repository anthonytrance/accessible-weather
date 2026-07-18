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

  // Pin metric units and English so assertions do not depend on the host locale.
  dom.window.localStorage.setItem("weather-clearly.v1", JSON.stringify({
    language: "en",
    temperatureUnit: "celsius",
    windUnit: "kmh",
    precipitationUnit: "mm",
    savedLocations: []
  }));

  try {
    await import(`../app.js?smoke=${Date.now()}`);
    await waitFor(() => !document.getElementById("weather-content").hidden);

    assert.equal(document.getElementById("weather-location-heading").textContent, "Mechelen");
    assert.match(document.getElementById("decision-summary").textContent, /Measured nearby 23\.6°C/);
    assert.equal(document.getElementById("measured-observation").hidden, false);
    assert.match(document.getElementById("station-description").textContent, /Sint-Katelijne-Waver/);

    const hourlyItems = document.querySelectorAll("#hourly-list li");
    assert.equal(hourlyItems.length, 12);
    assert.equal(hourlyItems[0].querySelectorAll(".wx-icon-holder").length, 1);
    assert.match(hourlyItems[0].textContent, /25\.0°C/);
    assert.equal(document.querySelectorAll("#daily-list li").length, 16);
    assert.match(document.querySelector("#daily-list li").textContent, /^Today\./);
    assert.equal(document.querySelectorAll("#rain-timeline li").length, 24);

    assert.equal(document.getElementById("sun-summary").hidden, false);
    assert.match(document.getElementById("sun-summary").textContent, /daylight/);
    assert.equal(document.getElementById("air-section").hidden, false);
    assert.match(document.getElementById("air-values").textContent, /European air quality index/);

    assert.match(document.getElementById("notif-status").textContent, /push notifications/i);

    const forecastTab = document.getElementById("tab-forecast");
    forecastTab.click();
    assert.equal(forecastTab.getAttribute("aria-selected"), "true");
    assert.equal(document.getElementById("view-now").hidden, true);
    assert.equal(document.getElementById("view-forecast").hidden, false);
    assert.equal(document.getElementById("forecast-content").hidden, false);

    forecastTab.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    assert.equal(document.getElementById("tab-now").getAttribute("aria-selected"), "true");
    assert.equal(document.getElementById("view-now").hidden, false);

    document.getElementById("tab-more").click();
    assert.equal(document.getElementById("view-more").hidden, false);
    assert.equal(document.getElementById("air-section").hidden, false);
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
  const dailyTimes = Array.from({ length: 16 }, (_, index) => new Date(localNow.getTime() + index * 86_400_000).toISOString().slice(0, 10));
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
      is_day: 1,
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
      dew_point_2m: hourlyTimes.map(() => 12.4),
      uv_index: hourlyTimes.map(() => 4.2),
      is_day: hourlyTimes.map(() => 1),
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
      sunset: dailyTimes.map((date) => `${date}T21:45`),
      daylight_duration: dailyTimes.map(() => 57_600),
      uv_index_max: dailyTimes.map(() => 5.4),
      wind_speed_10m_max: dailyTimes.map(() => 22)
    }
  };

  const air = {
    current: {
      european_aqi: 28,
      us_aqi: 41,
      pm2_5: 6.1,
      pm10: 11.4,
      ozone: 62,
      nitrogen_dioxide: 9.8,
      alder_pollen: 0,
      birch_pollen: 0,
      grass_pollen: 14,
      mugwort_pollen: 0,
      olive_pollen: 0,
      ragweed_pollen: 0
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
    if (url.includes("air-quality-api.open-meteo.com")) return jsonResponse(air);
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
