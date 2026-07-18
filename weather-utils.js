export const WEATHER_CODES = new Map([
  [0, "Clear"],
  [1, "Mostly clear"],
  [2, "Partly cloudy"],
  [3, "Overcast"],
  [45, "Fog"],
  [48, "Freezing fog"],
  [51, "Light drizzle"],
  [53, "Drizzle"],
  [55, "Heavy drizzle"],
  [56, "Light freezing drizzle"],
  [57, "Freezing drizzle"],
  [61, "Light rain"],
  [63, "Rain"],
  [65, "Heavy rain"],
  [66, "Light freezing rain"],
  [67, "Freezing rain"],
  [71, "Light snow"],
  [73, "Snow"],
  [75, "Heavy snow"],
  [77, "Snow grains"],
  [80, "Light rain showers"],
  [81, "Rain showers"],
  [82, "Heavy rain showers"],
  [85, "Light snow showers"],
  [86, "Heavy snow showers"],
  [95, "Thunderstorms"],
  [96, "Thunderstorms with light hail"],
  [99, "Thunderstorms with heavy hail"]
]);

export function weatherLabel(code) {
  return WEATHER_CODES.get(Number(code)) ?? "Unknown conditions";
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function localIsoToEpoch(isoString, utcOffsetSeconds = 0) {
  if (!isoString) return Number.NaN;
  return Date.parse(`${isoString}Z`) - utcOffsetSeconds * 1000;
}

export function radarValueToMmPerHour(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return 0;
  return 10 ** ((numericValue - 109) / 32);
}

export function parseBuienradarText(text, nowEpoch = Date.now(), utcOffsetSeconds = 0) {
  const localNow = new Date(nowEpoch + utcOffsetSeconds * 1000);
  const year = localNow.getUTCFullYear();
  const month = localNow.getUTCMonth();
  const day = localNow.getUTCDate();

  return String(text)
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rawValue, rawTime] = line.split("|");
      const [hour, minute] = String(rawTime).split(":").map(Number);
      let epoch = Date.UTC(year, month, day, hour, minute) - utcOffsetSeconds * 1000;
      if (epoch < nowEpoch - 10 * 60 * 1000) epoch += 24 * 60 * 60 * 1000;
      return {
        time: epoch,
        mmPerHour: radarValueToMmPerHour(rawValue),
        rawValue: Number(rawValue)
      };
    })
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.mmPerHour));
}

export function rainIntensityLabel(mmPerHour) {
  if (mmPerHour < 0.05) return "dry";
  if (mmPerHour < 0.2) return "very light rain";
  if (mmPerHour < 1) return "light rain";
  if (mmPerHour < 3) return "moderate rain";
  if (mmPerHour < 8) return "heavy rain";
  return "very heavy rain";
}

// Returns language-neutral rain-summary data; i18n.js formatRainSummary()
// turns it into localized sentences for the app and for push notifications.
export function summarizeRain(points, options = {}) {
  const { nowEpoch = Date.now() } = options;

  const future = points.filter((point) => point.time >= nowEpoch - 6 * 60 * 1000);
  if (!future.length) return { kind: "unavailable" };

  const wet = future.filter((point) => point.mmPerHour >= 0.05);
  if (!wet.length) return { kind: "dry", count: future.length };

  const first = wet[0];
  const last = wet.at(-1);
  const strongest = wet.reduce((maximum, point) => point.mmPerHour > maximum.mmPerHour ? point : maximum, wet[0]);
  const minutesUntil = Math.max(0, Math.round((first.time - nowEpoch) / 60000));
  const rainingNow = minutesUntil <= 7;

  return {
    kind: rainingNow ? "raining" : "upcoming",
    count: future.length,
    minutesUntil,
    firstTime: first.time,
    endTime: last.time + 5 * 60 * 1000,
    strongestTime: strongest.time,
    firstMmPerHour: first.mmPerHour,
    strongestMmPerHour: strongest.mmPerHour
  };
}

export function nearestObservation(observations, latitude, longitude, maxAgeHours = 4, nowEpoch = Date.now()) {
  const candidates = observations
    .map((observation) => ({
      ...observation,
      distanceKm: haversineKm(latitude, longitude, observation.latitude, observation.longitude),
      ageHours: (nowEpoch - Date.parse(observation.timestamp)) / 3_600_000
    }))
    .filter((observation) => observation.ageHours >= -0.25 && observation.ageHours <= maxAgeHours)
    .sort((a, b) => a.distanceKm - b.distanceKm || a.ageHours - b.ageHours);
  return candidates[0] ?? null;
}

export function isBuienradarCoverage(latitude, longitude) {
  return latitude >= 49.25 && latitude <= 53.75 && longitude >= 2.3 && longitude <= 7.6;
}

// Rough bounding box for MET Norway's radar nowcast (Nordics and Baltics);
// the Worker's /api/nowcast returns 404 where actual radar coverage ends.
export function isMetnoCoverage(latitude, longitude) {
  return latitude >= 54 && latitude <= 72.5 && longitude >= -1 && longitude <= 33;
}

// Conservative box around Germany proper for the DWD RV radar composite via
// Bright Sky. The composite grid extends further, but pixels beyond real
// radar reach read as a permanent zero, so we stay well inside.
export function isDwdCoverage(latitude, longitude) {
  return latitude >= 47 && latitude <= 55.2 && longitude >= 5.5 && longitude <= 15.3;
}

export function isBelgium(latitude, longitude) {
  return latitude >= 49.45 && latitude <= 51.55 && longitude >= 2.45 && longitude <= 6.45;
}

export function compassDirection(degrees) {
  if (!Number.isFinite(Number(degrees))) return "unknown direction";
  const labels = ["north", "north-northeast", "northeast", "east-northeast", "east", "east-southeast", "southeast", "south-southeast", "south", "south-southwest", "southwest", "west-southwest", "west", "west-northwest", "northwest", "north-northwest"];
  return labels[Math.round(Number(degrees) / 22.5) % 16];
}

export function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}
