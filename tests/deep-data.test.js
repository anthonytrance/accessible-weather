import test from "node:test";
import assert from "node:assert/strict";
import {
  capeRatingKey,
  computeAtmosphere,
  computeClimate,
  computeEnsemble,
  computeModelComparison,
  liftedIndexRatingKey,
  moonPhase,
  pressureTrendKey
} from "../deep-data.js";

test("ensemble members become daily temperature ranges and rain frequencies", () => {
  const time = [
    "2026-07-18T00:00", "2026-07-18T12:00",
    "2026-07-19T00:00", "2026-07-19T12:00"
  ];
  const hourly = { time };
  for (let member = 0; member < 10; member += 1) {
    const suffix = member === 0 ? "" : `_member${String(member).padStart(2, "0")}`;
    hourly[`temperature_2m${suffix}`] = [member, member + 1, member + 2, member + 3];
    hourly[`precipitation${suffix}`] = member < 4 ? [0.3, 0.3, 0, 0] : [0, 0, 0, 0];
  }

  const result = computeEnsemble({ hourly }, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].members, 10);
  assert.equal(result[0].highMedian, 5.5);
  assert.equal(result[0].highP10, 1.9);
  assert.equal(result[0].highP90, 9.1);
  assert.equal(result[0].wetMembers, 4);
  assert.equal(result[0].wetPercent, 40);
});

test("model comparison detects meaningful temperature and rain disagreement", () => {
  const result = computeModelComparison({
    daily: {
      time: ["2026-07-18", "2026-07-19"],
      temperature_2m_max_ecmwf_ifs025: [21, 20],
      precipitation_sum_ecmwf_ifs025: [0, 0],
      temperature_2m_max_icon_seamless: [21, 22],
      precipitation_sum_icon_seamless: [0, 1],
      temperature_2m_max_gfs_seamless: [21, 25],
      precipitation_sum_gfs_seamless: [0, null]
    }
  });

  assert.equal(result.models.length, 3);
  assert.equal(result.spreadC, 5);
  assert.equal(result.agreement, "poor");
  assert.equal(result.models[2].rain, null);
});

test("climate context uses 1991-2020 normals and full-period records", () => {
  const time = [];
  const highs = [];
  const lows = [];
  const add = (date, high, low) => {
    time.push(date);
    highs.push(high);
    lows.push(low);
  };
  add("1940-07-18", 18, -5);
  for (let year = 1991; year <= 2020; year += 1) add(`${year}-07-18`, 20, 10);
  add("2022-07-18", 35, 12);
  add("2025-07-18", 24, 8);

  const result = computeClimate({
    daily: { time, temperature_2m_max: highs, temperature_2m_min: lows }
  }, "07-18");

  assert.equal(result.normalHigh, 20);
  assert.equal(result.normalLow, 10);
  assert.equal(result.recordHigh, 35);
  assert.equal(result.recordHighYear, 2022);
  assert.equal(result.recordLow, -5);
  assert.equal(result.recordLowYear, 1940);
  assert.equal(result.dataEndYear, 2025);
});

test("atmospheric data selects the current hour, pressure trend, and next-day CAPE peak", () => {
  const time = [
    "2026-07-18T09:00", "2026-07-18T10:00", "2026-07-18T11:00",
    "2026-07-18T12:00", "2026-07-18T13:00"
  ];
  const result = computeAtmosphere({
    hourly: {
      time,
      cape: [50, 100, 200, 400, 800],
      lifted_index: [3, 2, 1, -1, -3],
      freezing_level_height: [3000, 3100, 3200, 3300, 3400],
      visibility: [20000, 20000, 18000, 16000, 14000],
      cloud_cover_low: [10, 20, 30, 40, 50],
      cloud_cover_mid: [5, 10, 15, 20, 25],
      cloud_cover_high: [60, 50, 40, 30, 20],
      wet_bulb_temperature_2m: [12, 13, 14, 15, 16],
      pressure_msl: [1008, 1009, 1010, 1012, 1013]
    }
  }, "2026-07-18T12:15");

  assert.equal(result.cape, 400);
  assert.equal(result.liftedIndex, -1);
  assert.equal(result.pressureDelta3h, 4);
  assert.equal(result.capePeak, 800);
  assert.equal(result.capePeakTime, "2026-07-18T13:00");
});

test("analysis ratings and lunar cycle boundaries are stable", () => {
  assert.equal(capeRatingKey(299), "atmos.cape.stable");
  assert.equal(capeRatingKey(1000), "atmos.cape.moderate");
  assert.equal(liftedIndexRatingKey(-6), "atmos.li.veryUnstable");
  assert.equal(pressureTrendKey(-1.5), "atmos.trend.fallingFast");

  const epoch = Date.UTC(2000, 0, 6, 18, 14);
  const moon = moonPhase(epoch);
  assert.equal(moon.phaseIndex, 0);
  assert.ok(moon.illumination < 1e-12);
  assert.ok(moon.nextFullMs > epoch + 14 * 86_400_000);
  assert.ok(moon.nextNewMs > epoch + 29 * 86_400_000);
});
