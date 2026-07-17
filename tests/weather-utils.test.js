import test from "node:test";
import assert from "node:assert/strict";
import {
  haversineKm,
  isBelgium,
  isBuienradarCoverage,
  nearestObservation,
  parseBuienradarText,
  radarValueToMmPerHour,
  summarizeRain,
  weatherLabel
} from "../weather-utils.js";

test("Buienradar conversion matches its documented control value", () => {
  assert.ok(Math.abs(radarValueToMmPerHour(77) - 0.1) < 0.0001);
  assert.equal(radarValueToMmPerHour(0), 0);
});

test("Buienradar text becomes dated rain points", () => {
  const now = Date.parse("2026-07-17T16:30:00Z");
  const points = parseBuienradarText("000|18:35\n077|18:40", now, 7200);
  assert.equal(points.length, 2);
  assert.equal(new Date(points[0].time).toISOString(), "2026-07-17T16:35:00.000Z");
  assert.ok(Math.abs(points[1].mmPerHour - 0.1) < 0.0001);
});

test("rain summary returns language-neutral decision data", () => {
  const now = Date.parse("2026-07-17T16:00:00Z");
  const dry = summarizeRain([{ time: now + 300_000, mmPerHour: 0 }], { nowEpoch: now });
  assert.equal(dry.kind, "dry");
  assert.equal(dry.count, 1);

  const later = summarizeRain([
    { time: now + 900_000, mmPerHour: 0.5 },
    { time: now + 1_200_000, mmPerHour: 2 }
  ], { nowEpoch: now });
  assert.equal(later.kind, "upcoming");
  assert.equal(later.minutesUntil, 15);
  assert.equal(later.strongestMmPerHour, 2);
  assert.equal(later.endTime, now + 1_200_000 + 300_000);

  assert.equal(summarizeRain([], { nowEpoch: now }).kind, "unavailable");
});

test("nearest observation ignores stale reports", () => {
  const now = Date.parse("2026-07-17T18:00:00Z");
  const result = nearestObservation([
    { name: "Old", latitude: 51, longitude: 4.5, timestamp: "2026-07-17T10:00:00Z" },
    { name: "Fresh", latitude: 51.1, longitude: 4.5, timestamp: "2026-07-17T17:00:00Z" }
  ], 51.02, 4.48, 4, now);
  assert.equal(result.name, "Fresh");
});

test("Mechelen is in Belgian and Buienradar coverage", () => {
  assert.equal(isBelgium(51.0259, 4.4776), true);
  assert.equal(isBuienradarCoverage(51.0259, 4.4776), true);
  assert.ok(haversineKm(51.0259, 4.4776, 51.0751, 4.5246) < 7);
});

test("weather codes are given useful spoken labels", () => {
  assert.equal(weatherLabel(63), "Rain");
  assert.equal(weatherLabel(999), "Unknown conditions");
});
