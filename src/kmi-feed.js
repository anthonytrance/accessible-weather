const WFS_BASE = "https://opendata.meteo.be/geoserver/ows";

export async function fetchKmiFeed({ fetchImpl = fetch, now = Date.now() } = {}) {
  const since = new Date(now - 4 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const [synopStations, awsStations, synopData, awsData] = await Promise.all([
    fetchFeatures(fetchImpl, "synop:synop_station"),
    fetchFeatures(fetchImpl, "aws:aws_station"),
    fetchFeatures(fetchImpl, "synop:synop_data", `timestamp AFTER ${since}`),
    fetchFeatures(fetchImpl, "aws:aws_10min", `timestamp AFTER ${since}`)
  ]);

  return buildKmiFeed({
    synopStations,
    awsStations,
    synopData,
    awsData,
    generatedAt: new Date(now).toISOString()
  });
}

export function buildKmiFeed({ synopStations, awsStations, synopData, awsData, generatedAt }) {
  const stationMap = new Map();
  for (const feature of [...synopStations, ...awsStations]) {
    if (feature.properties.date_end) continue;
    stationMap.set(Number(feature.properties.code), {
      code: Number(feature.properties.code),
      name: feature.properties.name,
      longitude: feature.geometry.coordinates[0],
      latitude: feature.geometry.coordinates[1],
      altitudeM: feature.properties.altitude,
      wigosId: feature.properties.wigos_id
    });
  }

  const latestByStation = new Map();
  for (const feature of synopData) {
    addObservation(latestByStation, stationMap, feature, "hourly SYNOP", 60, mapSynop);
  }
  for (const feature of awsData) {
    addObservation(latestByStation, stationMap, feature, "automatic 10-minute", 10, mapAws);
  }

  const observations = [...latestByStation.values()]
    .filter((observation) => Number.isFinite(observation.latitude) && Number.isFinite(observation.longitude))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!observations.length) throw new Error("KMI returned no current station observations.");

  return {
    generatedAt,
    provider: "Royal Meteorological Institute of Belgium, KMI/IRM",
    notice: "Preliminary, unvalidated station observations.",
    observations
  };
}

async function fetchFeatures(fetchImpl, typeName, cqlFilter) {
  const url = new URL(WFS_BASE);
  url.search = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: typeName,
    outputFormat: "application/json",
    count: "2000"
  });
  if (cqlFilter) url.searchParams.set("CQL_FILTER", cqlFilter);

  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${typeName} returned HTTP ${response.status}`);
  const data = await response.json();
  return data.features ?? [];
}

function addObservation(latestByStation, stationMap, feature, providerType, observationPeriodMinutes, mapper) {
  const properties = feature.properties;
  const code = Number(properties.code);
  const station = stationMap.get(code);
  if (!station || !properties.timestamp) return;

  const observation = {
    ...station,
    providerType,
    observationPeriodMinutes,
    timestamp: properties.timestamp,
    validated: false,
    ...mapper(properties)
  };
  const existing = latestByStation.get(code);
  if (!existing || Date.parse(observation.timestamp) > Date.parse(existing.timestamp)) {
    latestByStation.set(code, observation);
  }
}

function mapSynop(properties) {
  return {
    temperatureC: finiteOrNull(properties.temp),
    humidityPercent: finiteOrNull(properties.humidity_relative),
    pressureHpa: finiteOrNull(properties.pressure),
    windSpeedKmh: convertSynopWind(properties.wind_speed, properties.wind_speed_unit),
    windDirectionDegrees: finiteOrNull(properties.wind_direction),
    windGustKmh: multiplyOrNull(properties.wind_peak_speed, 3.6),
    precipitationMm: finiteOrNull(properties.precip_quantity)
  };
}

function mapAws(properties) {
  return {
    temperatureC: finiteOrNull(properties.temp_dry_shelter_avg),
    humidityPercent: finiteOrNull(properties.humidity_rel_shelter_avg),
    pressureHpa: finiteOrNull(properties.pressure),
    windSpeedKmh: multiplyOrNull(properties.wind_speed_10m, 3.6),
    windDirectionDegrees: finiteOrNull(properties.wind_direction),
    windGustKmh: multiplyOrNull(properties.wind_gusts_speed, 3.6),
    precipitationMm: finiteOrNull(properties.precip_quantity)
  };
}

function convertSynopWind(value, unitCode) {
  const numeric = finiteOrNull(value);
  if (numeric === null) return null;
  if ([3, 4].includes(Number(unitCode))) return numeric * 1.852;
  return numeric * 3.6;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function multiplyOrNull(value, multiplier) {
  const numeric = finiteOrNull(value);
  return numeric === null ? null : numeric * multiplier;
}
