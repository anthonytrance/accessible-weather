import {
  compassDirection,
  isBelgium,
  isBuienradarCoverage,
  localIsoToEpoch,
  nearestObservation,
  parseBuienradarText,
  rainIntensityLabel,
  summarizeRain,
  weatherLabel
} from "./weather-utils.js";

const STORAGE_KEY = "weather-clearly.v1";
const DEFAULT_LOCATION = {
  name: "Mechelen",
  detail: "Flanders, Belgium",
  latitude: 51.02574,
  longitude: 4.47762,
  timezone: "Europe/Brussels",
  countryCode: "BE"
};

const elements = Object.fromEntries([
  "search-form", "location-search", "gps-button", "refresh-button", "search-results",
  "search-results-heading", "search-results-list", "saved-locations", "saved-location-buttons",
  "status", "error", "weather-content", "weather-location-heading", "location-context",
  "save-location-button", "decision-summary", "summary-caveat", "weather-age",
  "measured-observation", "station-description", "measured-values", "current-values",
  "rain-summary", "rain-source-badge", "rain-visual", "rain-detail-intro", "rain-timeline",
  "forecast-short-tab", "forecast-long-tab", "forecast-short-panel", "forecast-long-panel",
  "hourly-list", "daily-list", "units-select", "forget-button", "buienradar-credit", "kmi-credit"
].map((id) => [id, document.getElementById(id)]));

let settings = loadSettings();
let currentLocation = settings.lastLocation ?? DEFAULT_LOCATION;
let latestWeather = null;
let latestRain = null;
let latestObservation = null;
let weatherRequestController = null;
let searchRequestController = null;

elements["units-select"].value = settings.units;
renderSavedLocations();
registerEvents();
registerServiceWorker();
loadWeather(currentLocation, { moveFocus: false });

function registerEvents() {
  elements["search-form"].addEventListener("submit", handleSearch);
  elements["gps-button"].addEventListener("click", useCurrentLocation);
  elements["refresh-button"].addEventListener("click", () => loadWeather(currentLocation, { moveFocus: false, refresh: true }));
  elements["save-location-button"].addEventListener("click", toggleSavedLocation);
  elements["units-select"].addEventListener("change", () => {
    settings.units = elements["units-select"].value;
    persistSettings();
    if (latestWeather) renderAll();
    announce(`Units changed to ${settings.units}.`);
  });
  elements["forget-button"].addEventListener("click", forgetSettings);
  const forecastTabs = [elements["forecast-short-tab"], elements["forecast-long-tab"]];
  forecastTabs.forEach((tab) => {
    tab.addEventListener("click", () => selectForecastTab(tab === forecastTabs[0] ? "short" : "long"));
    tab.addEventListener("keydown", (event) => handleForecastTabKeydown(event, forecastTabs));
  });
}

function selectForecastTab(range) {
  const shortSelected = range === "short";
  elements["forecast-short-tab"].setAttribute("aria-selected", String(shortSelected));
  elements["forecast-short-tab"].tabIndex = shortSelected ? 0 : -1;
  elements["forecast-long-tab"].setAttribute("aria-selected", String(!shortSelected));
  elements["forecast-long-tab"].tabIndex = shortSelected ? -1 : 0;
  elements["forecast-short-panel"].hidden = !shortSelected;
  elements["forecast-long-panel"].hidden = shortSelected;
}

function handleForecastTabKeydown(event, tabs) {
  const currentIndex = tabs.indexOf(event.currentTarget);
  let nextIndex = null;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabs.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
}

async function handleSearch(event) {
  event.preventDefault();
  const query = elements["location-search"].value.trim();
  if (query.length < 2) {
    showError("Enter at least two characters for the location.");
    elements["location-search"].focus();
    return;
  }

  searchRequestController?.abort();
  searchRequestController = new AbortController();
  clearError();
  announce(`Searching for ${query}.`);
  setFormBusy(true);

  try {
    const language = (navigator.language || "en").slice(0, 2).toLowerCase();
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.search = new URLSearchParams({ name: query, count: "8", language, format: "json" });
    const response = await fetch(url, { signal: searchRequestController.signal });
    if (!response.ok) throw new Error(`Location search returned ${response.status}.`);
    const data = await response.json();
    renderSearchResults(data.results ?? [], query);
  } catch (error) {
    if (error.name !== "AbortError") showError("Location search failed. Check your connection and try again.");
  } finally {
    setFormBusy(false);
  }
}

function renderSearchResults(results, query) {
  elements["search-results-list"].replaceChildren();
  elements["search-results"].hidden = false;

  if (!results.length) {
    const item = document.createElement("li");
    item.textContent = `No locations found for ${query}. Try a nearby town or postal code.`;
    elements["search-results-list"].append(item);
  } else {
    for (const result of results) {
      const location = {
        name: result.name,
        detail: [result.admin1, result.country].filter(Boolean).filter((value, index, list) => list.indexOf(value) === index).join(", "),
        latitude: result.latitude,
        longitude: result.longitude,
        timezone: result.timezone,
        countryCode: result.country_code
      };
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result-button";
      button.textContent = locationLabel(location);
      button.addEventListener("click", () => selectLocation(location));
      item.append(button);
      elements["search-results-list"].append(item);
    }
  }

  announce(`${results.length} ${results.length === 1 ? "location" : "locations"} found.`);
  elements["search-results-heading"].focus();
}

function selectLocation(location) {
  elements["search-results"].hidden = true;
  currentLocation = location;
  settings.lastLocation = location;
  persistSettings();
  loadWeather(location, { moveFocus: true });
}

function useCurrentLocation() {
  clearError();
  if (!navigator.geolocation) {
    showError("This browser does not provide GPS location access. Search for a place instead.");
    return;
  }

  announce("Waiting for location permission and GPS coordinates.");
  elements["gps-button"].disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const location = {
        name: "Current location",
        detail: `GPS accuracy about ${formatDistance(position.coords.accuracy / 1000)}`,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        timezone: null,
        countryCode: null
      };
      currentLocation = location;
      settings.lastLocation = location;
      persistSettings();
      elements["gps-button"].disabled = false;
      loadWeather(location, { moveFocus: true });
    },
    (error) => {
      elements["gps-button"].disabled = false;
      const messages = {
        1: "Location permission was not granted. You can still search for a place.",
        2: "Your location could not be determined. Try again outside or search for a place.",
        3: "Finding your location took too long. Try again or search for a place."
      };
      showError(messages[error.code] ?? "Your location could not be determined.");
    },
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5 * 60_000 }
  );
}

async function loadWeather(location, { moveFocus = false, refresh = false } = {}) {
  weatherRequestController?.abort();
  weatherRequestController = new AbortController();
  const { signal } = weatherRequestController;
  currentLocation = location;
  clearError();
  setWeatherBusy(true);
  announce(`${refresh ? "Refreshing" : "Getting"} weather for ${location.name}.`);

  try {
    const weatherPromise = fetchOpenMeteo(location, signal);
    const kmiPromise = isBelgium(location.latitude, location.longitude)
      ? fetchKmiObservation(location, signal)
      : Promise.resolve(null);

    latestWeather = await weatherPromise;
    currentLocation.timezone = latestWeather.timezone;

    const radarPromise = isBuienradarCoverage(location.latitude, location.longitude)
      ? fetchBuienradar(location, latestWeather.utc_offset_seconds, signal)
      : Promise.resolve(null);

    [latestRain, latestObservation] = await Promise.all([
      radarPromise.catch(() => null),
      kmiPromise.catch(() => null)
    ]);

    if (!latestRain) latestRain = modelRainPoints(latestWeather);
    settings.lastLocation = currentLocation;
    persistSettings();
    renderAll();
    elements["weather-content"].hidden = false;
    elements["refresh-button"].disabled = false;
    announce(`Weather loaded for ${location.name}. ${elements["decision-summary"].textContent}`);
    if (moveFocus) elements["weather-location-heading"].focus();
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      showError("Weather data could not be loaded. Check your connection and try again.");
    }
  } finally {
    setWeatherBusy(false);
  }
}

async function fetchOpenMeteo(location, signal) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,showers,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    minutely_15: "precipitation,rain,showers,weather_code",
    hourly: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,precipitation_sum,sunrise,sunset",
    timezone: "auto",
    forecast_days: "10"
  });
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Forecast returned ${response.status}.`);
  return response.json();
}

async function fetchBuienradar(location, utcOffsetSeconds, signal) {
  const url = new URL("https://gps.buienradar.nl/getrr.php");
  url.search = new URLSearchParams({ lat: String(location.latitude), lon: String(location.longitude) });
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Rain radar returned ${response.status}.`);
  const points = parseBuienradarText(await response.text(), Date.now(), utcOffsetSeconds);
  if (points.length < 12) throw new Error("Rain radar returned too few intervals.");
  return { source: "Buienradar radar nowcast", intervalMinutes: 5, points };
}

async function fetchKmiObservation(location, signal) {
  const time = Math.floor(Date.now() / 600_000);
  let data = null;
  for (const url of [`./api/kmi?time=${time}`, `./data/kmi-latest.json?time=${time}`]) {
    try {
      const response = await fetch(url, { signal, cache: "no-store" });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) continue;
      const candidate = await response.json();
      if (Array.isArray(candidate.observations)) {
        data = candidate;
        break;
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }
  }
  if (!data) return null;
  const observation = nearestObservation(data.observations ?? [], location.latitude, location.longitude, 4);
  return observation ? { ...observation, feedGeneratedAt: data.generatedAt } : null;
}

function modelRainPoints(weather) {
  const offset = weather.utc_offset_seconds ?? 0;
  const points = weather.minutely_15.time.map((time, index) => ({
    time: localIsoToEpoch(time, offset),
    mmPerHour: Number(weather.minutely_15.precipitation[index] ?? 0) * 4
  })).filter((point) => point.time >= Date.now() - 10 * 60_000).slice(0, 9);
  return { source: "Open-Meteo 15-minute model", intervalMinutes: 15, points };
}

function renderAll() {
  renderHeading();
  renderDecisionSummary();
  renderCurrentConditions();
  renderRain();
  renderHourly();
  renderDaily();
  renderSaveButton();
}

function renderHeading() {
  elements["weather-location-heading"].textContent = currentLocation.name;
  elements["location-context"].textContent = currentLocation.detail || coordinateLabel(currentLocation);
  const currentEpoch = localIsoToEpoch(latestWeather.current.time, latestWeather.utc_offset_seconds);
  elements["weather-age"].textContent = `Model time ${formatTime(currentEpoch)}.`;
}

function renderDecisionSummary() {
  const current = latestWeather.current;
  const rainSummary = summarizeRain(latestRain.points, {
    nowEpoch: Date.now(),
    formatTime,
    sourceLabel: latestRain.source.includes("Buienradar") ? "five-minute radar" : "15-minute model"
  });
  const measuredTemperature = latestObservation?.temperatureC;
  const temperatureSummary = Number.isFinite(Number(measuredTemperature))
    ? `Nearby measurement ${formatTemperature(measuredTemperature)}. Feels like ${formatTemperature(current.apparent_temperature)} here, model estimate.`
    : `Estimated here ${formatTemperature(current.temperature_2m)}, feels like ${formatTemperature(current.apparent_temperature)}.`;
  elements["decision-summary"].textContent = `${temperatureSummary} ${rainSummary.headline}`;
  elements["summary-caveat"].textContent = `${weatherLabel(current.weather_code)}. ${rainSummary.detail}`;
}

function renderCurrentConditions() {
  const current = latestWeather.current;
  renderDefinitionList(elements["current-values"], [
    ["Estimated temperature", formatTemperature(current.temperature_2m)],
    ["Feels like estimate", formatTemperature(current.apparent_temperature)],
    ["Humidity", `${Math.round(current.relative_humidity_2m)}%`],
    ["Wind", `${formatSpeed(current.wind_speed_10m)} from ${compassDirection(current.wind_direction_10m)}`],
    ["Gusts", formatSpeed(current.wind_gusts_10m)],
    ["Pressure", `${Math.round(current.pressure_msl)} hPa`],
    ["Cloud cover", `${Math.round(current.cloud_cover)}%`],
    ["Conditions", weatherLabel(current.weather_code)]
  ]);

  elements["kmi-credit"].hidden = !latestObservation;
  if (!latestObservation) {
    elements["measured-observation"].hidden = true;
    return;
  }

  const ageMinutes = Math.max(0, Math.round((Date.now() - Date.parse(latestObservation.timestamp)) / 60_000));
  elements["station-description"].textContent = `KMI ${titleCase(latestObservation.name)}, ${formatDistance(latestObservation.distanceKm)} away. ${formatTime(Date.parse(latestObservation.timestamp))}, ${ageMinutes} minutes ago. Preliminary.`;
  renderDefinitionList(elements["measured-values"], [
    ["Temperature", formatTemperature(latestObservation.temperatureC)],
    ["Humidity", formatOptional(latestObservation.humidityPercent, (value) => `${Math.round(value)}%`)],
    ["Wind", formatOptional(latestObservation.windSpeedKmh, (value) => `${formatSpeed(value)} from ${compassDirection(latestObservation.windDirectionDegrees)}`, true)],
    ["Gusts", formatOptional(latestObservation.windGustKmh, (value) => formatSpeed(value), true)],
    ["Pressure", formatOptional(latestObservation.pressureHpa, (value) => `${Math.round(value)} hPa`)],
    ["Recent rain", formatOptional(latestObservation.precipitationMm, (value) => formatPrecipitation(value))]
  ]);
  elements["measured-observation"].hidden = false;
}

function renderRain() {
  const isRadar = latestRain.source.includes("Buienradar");
  const summary = summarizeRain(latestRain.points, { nowEpoch: Date.now(), formatTime, sourceLabel: isRadar ? "five-minute radar" : "15-minute model" });
  elements["rain-summary"].textContent = `${summary.headline} ${summary.detail}`;
  elements["rain-source-badge"].textContent = isRadar ? "5-minute radar nowcast" : "15-minute model forecast";
  elements["rain-detail-intro"].textContent = isRadar
    ? "Radar echoes are extrapolated every five minutes. New showers can still form or disappear."
    : "Radar nowcasting is not available here, so these values come from a weather model and are less precise for exact start and stop times.";
  elements["buienradar-credit"].hidden = !isRadar;

  elements["rain-visual"].replaceChildren();
  elements["rain-timeline"].replaceChildren();
  const max = Math.max(1, ...latestRain.points.map((point) => point.mmPerHour));
  for (const point of latestRain.points) {
    const bar = document.createElement("span");
    bar.className = `rain-bar${point.mmPerHour >= 3 ? " heavy" : ""}`;
    bar.style.height = `${Math.max(4, Math.min(100, (point.mmPerHour / max) * 100))}%`;
    elements["rain-visual"].append(bar);

    const item = document.createElement("li");
    item.textContent = `${formatTime(point.time)}: ${rainIntensityLabel(point.mmPerHour)}, ${formatIntensity(point.mmPerHour)}.`;
    elements["rain-timeline"].append(item);
  }
}

function renderHourly() {
  elements["hourly-list"].replaceChildren();
  const offset = latestWeather.utc_offset_seconds;
  const now = Date.now() - 30 * 60_000;
  const indices = latestWeather.hourly.time
    .map((time, index) => ({ index, epoch: localIsoToEpoch(time, offset) }))
    .filter(({ epoch }) => epoch >= now)
    .slice(0, 12);

  for (const { index, epoch } of indices) {
    const item = document.createElement("li");
    const rainChance = Math.round(latestWeather.hourly.precipitation_probability[index] ?? 0);
    item.textContent = `${formatTime(epoch)}. ${weatherLabel(latestWeather.hourly.weather_code[index])}; ${formatTemperature(latestWeather.hourly.temperature_2m[index])}, feels ${formatTemperature(latestWeather.hourly.apparent_temperature[index])}; rain ${rainChance}%, ${formatPrecipitation(latestWeather.hourly.precipitation[index] ?? 0)}; wind ${formatSpeed(latestWeather.hourly.wind_speed_10m[index])}, gusts ${formatSpeed(latestWeather.hourly.wind_gusts_10m[index])}.`;
    elements["hourly-list"].append(item);
  }
}

function renderDaily() {
  elements["daily-list"].replaceChildren();
  latestWeather.daily.time.forEach((date, index) => {
    const item = document.createElement("li");
    const day = index === 0 ? "Today" : formatDay(date);
    const rainChance = Math.round(latestWeather.daily.precipitation_probability_max[index] ?? 0);
    item.textContent = `${day}. ${weatherLabel(latestWeather.daily.weather_code[index])}; high ${formatTemperature(latestWeather.daily.temperature_2m_max[index])}, low ${formatTemperature(latestWeather.daily.temperature_2m_min[index])}; rain ${rainChance}%, ${formatPrecipitation(latestWeather.daily.precipitation_sum[index] ?? 0)} total.`;
    elements["daily-list"].append(item);
  });
}

function renderDefinitionList(list, values) {
  list.replaceChildren();
  for (const [term, description] of values) {
    const wrapper = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = description;
    wrapper.append(dt, dd);
    list.append(wrapper);
  }
}

function renderSavedLocations() {
  elements["saved-location-buttons"].replaceChildren();
  const saved = settings.savedLocations ?? [];
  elements["saved-locations"].hidden = saved.length === 0;
  for (const location of saved) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button";
    button.textContent = location.name;
    button.setAttribute("aria-label", `Get weather for ${locationLabel(location)}`);
    button.addEventListener("click", () => selectLocation(location));
    elements["saved-location-buttons"].append(button);
  }
}

function toggleSavedLocation() {
  const saved = settings.savedLocations ?? [];
  const existingIndex = saved.findIndex((item) => sameLocation(item, currentLocation));
  if (existingIndex >= 0) {
    saved.splice(existingIndex, 1);
    announce(`${currentLocation.name} removed from saved locations.`);
  } else {
    saved.push(currentLocation);
    if (saved.length > 8) saved.shift();
    announce(`${currentLocation.name} saved in this browser.`);
  }
  settings.savedLocations = saved;
  persistSettings();
  renderSavedLocations();
  renderSaveButton();
}

function renderSaveButton() {
  const saved = (settings.savedLocations ?? []).some((item) => sameLocation(item, currentLocation));
  elements["save-location-button"].textContent = saved ? "Remove from saved locations" : "Save this location";
}

function forgetSettings() {
  localStorage.removeItem(STORAGE_KEY);
  settings = { units: "metric", savedLocations: [], lastLocation: DEFAULT_LOCATION };
  elements["units-select"].value = "metric";
  renderSavedLocations();
  renderSaveButton();
  if (latestWeather) renderAll();
  announce("Saved locations and preferences have been removed from this browser.");
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {
      units: parsed?.units === "imperial" ? "imperial" : "metric",
      savedLocations: Array.isArray(parsed?.savedLocations) ? parsed.savedLocations : [],
      lastLocation: parsed?.lastLocation ?? DEFAULT_LOCATION
    };
  } catch {
    return { units: "metric", savedLocations: [], lastLocation: DEFAULT_LOCATION };
  }
}

function persistSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The weather still works when private browsing blocks storage.
  }
}

function formatTemperature(celsius) {
  if (!Number.isFinite(Number(celsius))) return "not reported";
  if (settings.units === "imperial") return `${Math.round(Number(celsius) * 9 / 5 + 32)}°F`;
  return `${Math.round(Number(celsius))}°C`;
}

function formatSpeed(kmh, alreadyKmh = true) {
  if (!Number.isFinite(Number(kmh))) return "not reported";
  const metricValue = alreadyKmh ? Number(kmh) : Number(kmh) * 3.6;
  if (settings.units === "imperial") return `${Math.round(metricValue * 0.621371)} mph`;
  return `${Math.round(metricValue)} km/h`;
}

function formatDistance(km) {
  if (settings.units === "imperial") return `${(km * 0.621371).toFixed(km < 16 ? 1 : 0)} miles`;
  return `${km.toFixed(km < 10 ? 1 : 0)} kilometres`;
}

function formatPrecipitation(mm) {
  if (!Number.isFinite(Number(mm))) return "not reported";
  if (settings.units === "imperial") return `${(Number(mm) / 25.4).toFixed(2)} inches`;
  return `${Number(mm).toFixed(Number(mm) < 10 ? 1 : 0)} mm`;
}

function formatIntensity(mmPerHour) {
  if (settings.units === "imperial") return `${(mmPerHour / 25.4).toFixed(2)} inches per hour`;
  return `${mmPerHour.toFixed(mmPerHour < 10 ? 1 : 0)} mm per hour`;
}

function formatTime(epoch) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: currentLocation.timezone || latestWeather?.timezone || undefined
  }).format(epoch);
}

function formatDay(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(Date.UTC(year, month - 1, day));
}

function formatOptional(value, formatter, valueIsKmh = false) {
  if (!Number.isFinite(Number(value))) return "not reported";
  return formatter(Number(value), valueIsKmh);
}

function locationLabel(location) {
  return [location.name, location.detail].filter(Boolean).join(", ");
}

function coordinateLabel(location) {
  return `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
}

function sameLocation(a, b) {
  return Math.abs(a.latitude - b.latitude) < 0.0001 && Math.abs(a.longitude - b.longitude) < 0.0001;
}

function titleCase(value) {
  return String(value).toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function announce(message) {
  elements.status.textContent = "";
  window.setTimeout(() => { elements.status.textContent = message; }, 20);
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
  announce("An error occurred.");
}

function clearError() {
  elements.error.hidden = true;
  elements.error.textContent = "";
}

function setFormBusy(busy) {
  const submit = elements["search-form"].querySelector("button[type='submit']");
  submit.disabled = busy;
  elements["location-search"].setAttribute("aria-busy", String(busy));
}

function setWeatherBusy(busy) {
  elements["weather-content"].setAttribute("aria-busy", String(busy));
  elements["refresh-button"].disabled = busy || !latestWeather;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
}
