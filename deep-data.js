// Pure computation for the Analysis view: ensemble spread, model comparison,
// climate context, atmospheric instability and moon phase. Everything here is
// language-neutral; app.js turns the numbers into localized sentences.

function toFiniteNumber(value) {
  return value == null || value === "" ? Number.NaN : Number(value);
}

function percentile(sorted, p) {
  if (!sorted.length) return Number.NaN;
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

// --- Ensemble ---------------------------------------------------------------

// The ensemble API returns the control run as "temperature_2m" and the other
// members as "temperature_2m_memberNN". Days are grouped by the local date in
// hourly.time; index 0 is today.
export function computeEnsemble(payload, dayCount = 3) {
  const hourly = payload?.hourly;
  if (!hourly?.time) return null;

  const memberSuffixes = Object.keys(hourly)
    .filter((key) => key.startsWith("temperature_2m"))
    .map((key) => key.slice("temperature_2m".length));
  if (memberSuffixes.length < 10) return null;

  const dates = [];
  const indicesByDate = new Map();
  hourly.time.forEach((time, index) => {
    const date = String(time).slice(0, 10);
    if (!indicesByDate.has(date)) {
      indicesByDate.set(date, []);
      dates.push(date);
    }
    indicesByDate.get(date).push(index);
  });

  const days = [];
  for (const date of dates.slice(0, dayCount)) {
    const indices = indicesByDate.get(date);
    const highs = [];
    let wet = 0;
    let members = 0;
    for (const suffix of memberSuffixes) {
      const temps = hourly[`temperature_2m${suffix}`];
      const precip = hourly[`precipitation${suffix}`];
      if (!temps) continue;
      let high = Number.NaN;
      let rain = 0;
      for (const index of indices) {
        const temp = toFiniteNumber(temps[index]);
        if (Number.isFinite(temp) && (!Number.isFinite(high) || temp > high)) high = temp;
        const p = toFiniteNumber(precip?.[index]);
        if (Number.isFinite(p)) rain += p;
      }
      if (!Number.isFinite(high)) continue;
      members += 1;
      highs.push(high);
      if (rain >= 0.5) wet += 1;
    }
    if (members < 10) continue;
    highs.sort((a, b) => a - b);
    days.push({
      date,
      members,
      highMedian: percentile(highs, 0.5),
      highP10: percentile(highs, 0.1),
      highP90: percentile(highs, 0.9),
      wetMembers: wet,
      wetPercent: Math.round((wet / members) * 100)
    });
  }
  return days.length ? days : null;
}

// --- Model comparison -------------------------------------------------------

export const COMPARISON_MODELS = [
  { id: "ecmwf_ifs025", label: "ECMWF" },
  { id: "icon_seamless", label: "ICON" },
  { id: "gfs_seamless", label: "GFS" }
];

// dayIndex 1 = tomorrow (daily arrays start today).
export function computeModelComparison(payload, dayIndex = 1) {
  const daily = payload?.daily;
  if (!daily?.time || daily.time.length <= dayIndex) return null;

  const models = [];
  for (const model of COMPARISON_MODELS) {
    const high = toFiniteNumber(daily[`temperature_2m_max_${model.id}`]?.[dayIndex]);
    const rain = toFiniteNumber(daily[`precipitation_sum_${model.id}`]?.[dayIndex]);
    if (!Number.isFinite(high)) continue;
    models.push({ id: model.id, label: model.label, high, rain: Number.isFinite(rain) ? rain : null });
  }
  if (models.length < 2) return null;

  const highs = models.map((model) => model.high);
  const spread = Math.max(...highs) - Math.min(...highs);
  const reportedRain = models.filter((model) => model.rain !== null);
  const wetCount = reportedRain.filter((model) => model.rain >= 0.5).length;
  const rainSplit = reportedRain.length >= 2 && wetCount > 0 && wetCount < reportedRain.length;
  let agreement = "good";
  if (spread > 3 || rainSplit) agreement = "poor";
  else if (spread > 1.5) agreement = "some";

  return { date: daily.time[dayIndex], models, spreadC: spread, agreement };
}

// --- Climate context --------------------------------------------------------

function monthDayOf(dateString) {
  return String(dateString).slice(5, 10);
}

function dayOfYearDistance(a, b) {
  const [am, ad] = a.split("-").map(Number);
  const [bm, bd] = b.split("-").map(Number);
  // Use a leap-year calendar so February 29 remains distinct from March 1.
  const doy = (m, d) => [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335][m - 1] + d;
  let diff = Math.abs(doy(am, ad) - doy(bm, bd));
  if (diff > 183) diff = 366 - diff;
  return diff;
}

// Computes 1991-2020 normals (±3-day window) and since-1940 records for one
// calendar date from an archive payload of daily values.
export function computeClimate(payload, targetMonthDay) {
  const daily = payload?.daily;
  if (!daily?.time) return null;

  let normalHighSum = 0;
  let normalLowSum = 0;
  let normalCount = 0;
  let recordHigh = Number.NEGATIVE_INFINITY;
  let recordHighYear = null;
  let recordLow = Number.POSITIVE_INFINITY;
  let recordLowYear = null;
  let dataEndYear = null;

  daily.time.forEach((date, index) => {
    const monthDay = monthDayOf(date);
    const year = Number(String(date).slice(0, 4));
    const high = toFiniteNumber(daily.temperature_2m_max?.[index]);
    const low = toFiniteNumber(daily.temperature_2m_min?.[index]);
    if ((Number.isFinite(high) || Number.isFinite(low)) && (dataEndYear === null || year > dataEndYear)) {
      dataEndYear = year;
    }

    if (year >= 1991 && year <= 2020 && dayOfYearDistance(monthDay, targetMonthDay) <= 3) {
      if (Number.isFinite(high) && Number.isFinite(low)) {
        normalHighSum += high;
        normalLowSum += low;
        normalCount += 1;
      }
    }
    if (monthDay === targetMonthDay) {
      if (Number.isFinite(high) && high > recordHigh) {
        recordHigh = high;
        recordHighYear = year;
      }
      if (Number.isFinite(low) && low < recordLow) {
        recordLow = low;
        recordLowYear = year;
      }
    }
  });

  if (!normalCount || recordHighYear === null || recordLowYear === null) return null;
  return {
    normalHigh: normalHighSum / normalCount,
    normalLow: normalLowSum / normalCount,
    recordHigh,
    recordHighYear,
    recordLow,
    recordLowYear,
    dataEndYear
  };
}

// --- Atmosphere -------------------------------------------------------------

export function computeAtmosphere(payload, targetLocalTime) {
  const hourly = payload?.hourly;
  if (!hourly?.time?.length) return null;

  const targetHour = String(targetLocalTime ?? "").slice(0, 13);
  let index = hourly.time.findIndex((time) => String(time).startsWith(targetHour));
  if (index < 0) {
    for (let candidate = 0; candidate < hourly.time.length; candidate += 1) {
      if (String(hourly.time[candidate]) <= String(targetLocalTime)) index = candidate;
      else break;
    }
  }
  if (index < 0) return null;

  const valueAt = (key, at = index) => {
    const value = toFiniteNumber(hourly[key]?.[at]);
    return Number.isFinite(value) ? value : null;
  };

  const pressure = valueAt("pressure_msl");
  const previousPressure = index >= 3 ? valueAt("pressure_msl", index - 3) : null;
  const pressureDelta3h = pressure !== null && previousPressure !== null
    ? pressure - previousPressure
    : null;

  let capePeak = null;
  let capePeakTime = null;
  const peakEnd = Math.min(hourly.time.length, index + 25);
  for (let candidate = index; candidate < peakEnd; candidate += 1) {
    const cape = valueAt("cape", candidate);
    if (cape !== null && (capePeak === null || cape > capePeak)) {
      capePeak = cape;
      capePeakTime = hourly.time[candidate];
    }
  }

  const result = {
    time: hourly.time[index],
    cape: valueAt("cape"),
    liftedIndex: valueAt("lifted_index"),
    freezingLevelM: valueAt("freezing_level_height"),
    visibilityM: valueAt("visibility"),
    cloudLow: valueAt("cloud_cover_low"),
    cloudMid: valueAt("cloud_cover_mid"),
    cloudHigh: valueAt("cloud_cover_high"),
    wetBulbC: valueAt("wet_bulb_temperature_2m"),
    pressureHpa: pressure,
    pressureDelta3h,
    capePeak,
    capePeakTime
  };

  const hasData = Object.entries(result).some(([key, value]) => key !== "time" && key !== "capePeakTime" && value !== null);
  return hasData ? result : null;
}

export function capeRatingKey(cape) {
  if (cape < 300) return "atmos.cape.stable";
  if (cape < 1000) return "atmos.cape.slight";
  if (cape < 2500) return "atmos.cape.moderate";
  if (cape < 4000) return "atmos.cape.high";
  return "atmos.cape.extreme";
}

export function liftedIndexRatingKey(li) {
  if (li > 1) return "atmos.li.stable";
  if (li > -2) return "atmos.li.marginal";
  if (li > -6) return "atmos.li.unstable";
  return "atmos.li.veryUnstable";
}

export function pressureTrendKey(deltaPer3h) {
  if (deltaPer3h >= 1.5) return "atmos.trend.risingFast";
  if (deltaPer3h >= 0.5) return "atmos.trend.rising";
  if (deltaPer3h > -0.5) return "atmos.trend.steady";
  if (deltaPer3h > -1.5) return "atmos.trend.falling";
  return "atmos.trend.fallingFast";
}

// --- Moon -------------------------------------------------------------------

const SYNODIC_DAYS = 29.530588853;
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14);

export function moonPhase(nowMs = Date.now()) {
  const days = (nowMs - NEW_MOON_EPOCH) / 86_400_000;
  const fraction = ((days / SYNODIC_DAYS) % 1 + 1) % 1;
  const illumination = (1 - Math.cos(2 * Math.PI * fraction)) / 2;
  const phaseIndex = Math.round(fraction * 8) % 8;
  const toNext = (target) => {
    let cycles = (target - fraction + 1) % 1;
    if (cycles < 1e-9) cycles = 1;
    return cycles * SYNODIC_DAYS * 86_400_000;
  };
  return {
    fraction,
    illumination,
    phaseIndex,
    nextFullMs: nowMs + toNext(0.5),
    nextNewMs: nowMs + toNext(0)
  };
}

export const MOON_PHASE_KEYS = [
  "moon.new",
  "moon.waxingCrescent",
  "moon.firstQuarter",
  "moon.waxingGibbous",
  "moon.full",
  "moon.waningGibbous",
  "moon.lastQuarter",
  "moon.waningCrescent"
];
