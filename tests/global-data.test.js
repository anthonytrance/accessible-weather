import test from "node:test";
import assert from "node:assert/strict";
import { metarToObservation, relativeHumidityFromDewpoint, serveObservations } from "../src/obs.js";
import { brightskyToPoints, metnoToPoints, serveNowcast } from "../src/nowcast.js";
import { isDwdCoverage, isMetnoCoverage } from "../weather-utils.js";

const SAMPLE_METAR = {
  icaoId: "EBAW",
  obsTime: 1784332200,
  temp: 19,
  dewp: 14,
  wdir: 340,
  wspd: 5,
  altim: 1016,
  lat: 51.189,
  lon: 4.46,
  name: "Antwerp Intl, VA, BE"
};

test("relative humidity is derived from temperature and dewpoint", () => {
  assert.equal(relativeHumidityFromDewpoint(19, 14), 73);
  assert.equal(relativeHumidityFromDewpoint(20, 20), 100);
  assert.equal(relativeHumidityFromDewpoint(null, 10), null);
});

test("METAR reports convert to the shared observation schema", () => {
  const observation = metarToObservation(SAMPLE_METAR);
  assert.equal(observation.name, "Antwerp Intl");
  assert.equal(observation.temperatureC, 19);
  assert.equal(observation.pressureHpa, 1016);
  assert.equal(observation.windDirectionDegrees, 340);
  assert.ok(Math.abs(observation.windSpeedKmh - 9.26) < 0.01);
  assert.equal(observation.windGustKmh, null);
  assert.equal(observation.timestamp, new Date(1784332200 * 1000).toISOString());

  assert.equal(metarToObservation({ ...SAMPLE_METAR, temp: null }), null);
  assert.equal(metarToObservation({ ...SAMPLE_METAR, obsTime: null }), null);
  const variableWind = metarToObservation({ ...SAMPLE_METAR, wdir: "VRB" });
  assert.equal(variableWind.windDirectionDegrees, null);
});

test("the observations endpoint proxies and converts METAR data", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamUrl = null;
  globalThis.fetch = async (url) => {
    upstreamUrl = String(url instanceof URL ? url : url);
    return new Response(JSON.stringify([SAMPLE_METAR, { ...SAMPLE_METAR, temp: null }]), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const response = await serveObservations(new Request("https://weather.test/api/obs?lat=51.02&lon=4.47"), null);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.observations.length, 1);
    assert.equal(data.observations[0].code, "EBAW");
    assert.match(upstreamUrl, /aviationweather\.gov/);
    assert.match(upstreamUrl, /bbox=/);

    const invalid = await serveObservations(new Request("https://weather.test/api/obs?lat=abc&lon=4"), null);
    assert.equal(invalid.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MET Norway nowcast payloads become rain points inside coverage only", () => {
  const now = Date.parse("2026-07-18T10:00:00Z");
  const payload = {
    properties: {
      meta: { radar_coverage: "ok" },
      timeseries: Array.from({ length: 18 }, (_, index) => ({
        time: new Date(now + index * 300_000).toISOString(),
        data: { instant: { details: { precipitation_rate: index === 3 ? 1.2 : 0 } } }
      }))
    }
  };
  const points = metnoToPoints(payload, now);
  assert.equal(points.length, 18);
  assert.equal(points[3].mmPerHour, 1.2);
  assert.equal(points[0].time, now);

  assert.equal(metnoToPoints({ properties: { meta: { radar_coverage: "outside" }, timeseries: [] } }, now), null);
});

test("the nowcast endpoint reports 404 outside radar coverage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 422 });
  try {
    const response = await serveNowcast(new Request("https://weather.test/api/nowcast?lat=48.8&lon=2.35"), null);
    assert.equal(response.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the Nordic coverage box includes Oslo but not Brussels", () => {
  assert.equal(isMetnoCoverage(59.91, 10.75), true);
  assert.equal(isMetnoCoverage(50.85, 4.35), false);
});

test("Bright Sky DWD radar frames convert to rain points", () => {
  const now = Date.parse("2026-07-18T19:00:00Z");
  const payload = {
    radar: Array.from({ length: 15 }, (_, index) => ({
      timestamp: new Date(now + index * 300_000).toISOString(),
      // 0.01 mm per 5 minutes: a value of 45 equals 5.4 mm/h.
      precipitation_5: [[index === 2 ? 45 : 0]]
    }))
  };
  const points = brightskyToPoints(payload, now);
  assert.equal(points.length, 15);
  assert.ok(Math.abs(points[2].mmPerHour - 5.4) < 0.001);
  assert.equal(points[0].mmPerHour, 0);
  assert.equal(brightskyToPoints({}, now), null);
});

test("the DWD coverage box includes Cologne but not Brussels or Paris", () => {
  assert.equal(isDwdCoverage(50.94, 6.96), true);
  assert.equal(isDwdCoverage(50.85, 4.35), false);
  assert.equal(isDwdCoverage(48.85, 2.35), false);
});
