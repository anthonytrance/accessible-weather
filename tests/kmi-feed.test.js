import test from "node:test";
import assert from "node:assert/strict";
import { buildKmiFeed } from "../src/kmi-feed.js";

test("KMI feed keeps the newest observation and preserves missing values as null", () => {
  const station = {
    type: "Feature",
    geometry: { coordinates: [4.525, 51.075] },
    properties: {
      code: 6431,
      name: "SINT-KATELIJNE-WAVER",
      altitude: 10,
      wigos_id: "0-20000-0-06431",
      date_end: null
    }
  };
  const older = {
    properties: {
      code: 6431,
      timestamp: "2026-07-17T19:00:00Z",
      temp_dry_shelter_avg: 20,
      humidity_rel_shelter_avg: 50,
      pressure: 1014,
      wind_speed_10m: 2,
      wind_direction: 300,
      wind_gusts_speed: 4,
      precip_quantity: 0
    }
  };
  const newer = {
    properties: {
      ...older.properties,
      timestamp: "2026-07-17T19:10:00Z",
      temp_dry_shelter_avg: 21.5,
      humidity_rel_shelter_avg: null
    }
  };

  const feed = buildKmiFeed({
    synopStations: [],
    awsStations: [station],
    synopData: [],
    awsData: [older, newer],
    generatedAt: "2026-07-17T19:11:00Z"
  });

  assert.equal(feed.observations.length, 1);
  assert.equal(feed.observations[0].timestamp, newer.properties.timestamp);
  assert.equal(feed.observations[0].temperatureC, 21.5);
  assert.equal(feed.observations[0].humidityPercent, null);
  assert.equal(feed.observations[0].windSpeedKmh, 7.2);
});
