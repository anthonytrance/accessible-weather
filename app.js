import {
  isBelgium,
  isBuienradarCoverage,
  localIsoToEpoch,
  nearestObservation,
  parseBuienradarText,
  summarizeRain
} from "./weather-utils.js";
import {
  LANGUAGES,
  beaufortForce,
  createTranslator,
  europeanAqiRatingKey,
  formatRainSummary,
  intensityKey,
  localizedCompass,
  localizedWeatherLabel,
  resolveLanguage,
  usAqiRatingKey,
  uvRatingKey
} from "./i18n.js";
import { iconElement, iconNameFor, svgIcon } from "./icons.js";

const STORAGE_KEY = "weather-clearly.v1";
const DEFAULT_LOCATION = {
  name: "Mechelen",
  detail: "Flanders, Belgium",
  latitude: 51.02574,
  longitude: 4.47762,
  timezone: "Europe/Brussels",
  countryCode: "BE"
};
const BRIEFING_HOURS = [6, 7, 8, 9, 12, 18, 21];

const elements = Object.fromEntries([
  "search-form", "location-search", "gps-button", "refresh-button", "search-results",
  "search-results-heading", "search-results-list", "saved-locations", "saved-location-buttons",
  "status", "error", "weather-content", "weather-location-heading", "location-context",
  "save-location-button", "share-button", "hero-icon", "decision-summary", "summary-caveat",
  "summary-comparison", "sun-summary", "weather-age",
  "measured-observation", "station-description", "measured-values", "current-values",
  "rain-summary", "rain-source-badge", "rain-visual", "rain-detail-intro", "rain-timeline",
  "forecast-short-tab", "forecast-long-tab", "forecast-short-panel", "forecast-long-panel",
  "hourly-list", "daily-list", "air-section", "air-values",
  "notif-status", "notif-enable-button", "notif-disable-button", "briefing-select", "briefing-row",
  "language-select", "temperature-select", "wind-select", "precip-select",
  "forget-button", "buienradar-credit", "kmi-credit"
].map((id) => [id, document.getElementById(id)]));

const PUSH_SUPPORTED = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

let settings = loadSettings();
let lang = resolveLanguage(settings.language, navigator.language);
let t = createTranslator(lang);
let locale = pickLocale();
let currentLocation = settings.lastLocation ?? DEFAULT_LOCATION;
let latestWeather = null;
let latestRain = null;
let latestObservation = null;
let latestAir = null;
let weatherRequestController = null;
let searchRequestController = null;

buildLanguageOptions();
buildBriefingOptions();
applyLanguage();
syncPreferenceControls();
renderSavedLocations();
renderNotifications();
registerEvents();
registerServiceWorker();
loadWeather(currentLocation, { moveFocus: false });

function registerEvents() {
  elements["search-form"].addEventListener("submit", handleSearch);
  elements["gps-button"].addEventListener("click", useCurrentLocation);
  elements["refresh-button"].addEventListener("click", () => loadWeather(currentLocation, { moveFocus: false, refresh: true }));
  elements["save-location-button"].addEventListener("click", toggleSavedLocation);
  elements["share-button"].addEventListener("click", shareWeather);
  elements["forget-button"].addEventListener("click", forgetSettings);
  elements["notif-enable-button"].addEventListener("click", enableNotifications);
  elements["notif-disable-button"].addEventListener("click", disableNotifications);
  elements["briefing-select"].addEventListener("change", handleBriefingChange);

  elements["language-select"].addEventListener("change", () => {
    settings.language = elements["language-select"].value;
    persistSettings();
    applyLanguage();
    syncPreferenceControls();
    renderSavedLocations();
    renderNotifications();
    if (latestWeather) renderAll();
    const label = LANGUAGES.find((entry) => entry.code === lang)?.label ?? lang;
    announce(t("status.languageChanged", { language: label }));
  });

  const unitControls = [
    ["temperature-select", "temperatureUnit"],
    ["wind-select", "windUnit"],
    ["precip-select", "precipitationUnit"]
  ];
  for (const [id, key] of unitControls) {
    elements[id].addEventListener("change", () => {
      settings[key] = elements[id].value;
      persistSettings();
      if (latestWeather) renderAll();
      announce(t("status.unitsChanged"));
      syncSubscriptionIfEnabled();
    });
  }

  const forecastTabs = [elements["forecast-short-tab"], elements["forecast-long-tab"]];
  forecastTabs.forEach((tab) => {
    tab.addEventListener("click", () => selectForecastTab(tab === forecastTabs[0] ? "short" : "long"));
    tab.addEventListener("keydown", (event) => handleForecastTabKeydown(event, forecastTabs));
  });
}

function pickLocale() {
  const navigatorLocale = navigator.language || "";
  return navigatorLocale.toLowerCase().startsWith(lang) ? navigatorLocale : lang;
}

function applyLanguage() {
  lang = resolveLanguage(settings.language, navigator.language);
  t = createTranslator(lang);
  locale = pickLocale();
  document.documentElement.lang = lang;
  document.title = t("app.name");
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.getAttribute("data-i18n"));
  }
  for (const node of document.querySelectorAll("[data-i18n-aria]")) {
    node.setAttribute("aria-label", t(node.getAttribute("data-i18n-aria")));
  }
  const detected = resolveLanguage("auto", navigator.language);
  const detectedLabel = LANGUAGES.find((entry) => entry.code === detected)?.label ?? detected;
  const autoOption = elements["language-select"].querySelector('option[value="auto"]');
  if (autoOption) autoOption.textContent = t("settings.language.auto", { language: detectedLabel });
  buildBriefingOptions();
  renderSaveButton();
}

function buildLanguageOptions() {
  const select = elements["language-select"];
  select.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "auto";
  select.append(auto);
  for (const entry of LANGUAGES) {
    const option = document.createElement("option");
    option.value = entry.code;
    option.textContent = entry.label;
    select.append(option);
  }
  select.value = settings.language;
}

function buildBriefingOptions() {
  const select = elements["briefing-select"];
  const previous = select.value;
  select.replaceChildren();
  const off = document.createElement("option");
  off.value = "off";
  off.textContent = t("notif.briefing.off");
  select.append(off);
  for (const hour of BRIEFING_HOURS) {
    const option = document.createElement("option");
    option.value = String(hour);
    option.textContent = t("notif.briefing.at", { time: formatHourLabel(hour) });
    select.append(option);
  }
  const target = settings.notifications?.briefingHour;
  select.value = previous && [...select.options].some((option) => option.value === previous)
    ? previous
    : (Number.isInteger(target) ? String(target) : "off");
}

function formatHourLabel(hour) {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(Date.UTC(2026, 0, 1, hour, 0)));
}

function syncPreferenceControls() {
  elements["language-select"].value = settings.language;
  elements["temperature-select"].value = settings.temperatureUnit;
  elements["wind-select"].value = settings.windUnit;
  elements["precip-select"].value = settings.precipitationUnit;
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
    showError(t("error.minChars"));
    elements["location-search"].focus();
    return;
  }

  searchRequestController?.abort();
  searchRequestController = new AbortController();
  clearError();
  announce(t("status.searching", { query }));
  setFormBusy(true);

  try {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.search = new URLSearchParams({ name: query, count: "8", language: lang, format: "json" });
    const response = await fetch(url, { signal: searchRequestController.signal });
    if (!response.ok) throw new Error(`Location search returned ${response.status}.`);
    const data = await response.json();
    renderSearchResults(data.results ?? [], query);
  } catch (error) {
    if (error.name !== "AbortError") showError(t("error.search"));
  } finally {
    setFormBusy(false);
  }
}

function renderSearchResults(results, query) {
  elements["search-results-list"].replaceChildren();
  elements["search-results"].hidden = false;

  if (!results.length) {
    const item = document.createElement("li");
    item.textContent = t("results.none", { query });
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

  announce(results.length === 1 ? t("results.count.one") : t("results.count.many", { count: results.length }));
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
    showError(t("error.gpsUnsupported"));
    return;
  }

  announce(t("status.gpsWait"));
  elements["gps-button"].disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const location = {
        name: t("gps.currentLocation"),
        detail: t("gps.accuracy", { distance: formatDistance(position.coords.accuracy / 1000) }),
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
        1: t("error.gpsDenied"),
        2: t("error.gpsUnavailable"),
        3: t("error.gpsTimeout")
      };
      showError(messages[error.code] ?? t("error.gpsUnavailable"));
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
  announce(t(refresh ? "status.refreshing" : "status.getting", { name: location.name }));

  try {
    const weatherPromise = fetchOpenMeteo(location, signal);
    const kmiPromise = isBelgium(location.latitude, location.longitude)
      ? fetchKmiObservation(location, signal)
      : Promise.resolve(null);
    const airPromise = fetchAirQuality(location, signal).catch(() => null);

    latestWeather = await weatherPromise;
    currentLocation.timezone = latestWeather.timezone;

    const radarPromise = isBuienradarCoverage(location.latitude, location.longitude)
      ? fetchBuienradar(location, signal)
      : Promise.resolve(null);

    [latestRain, latestObservation, latestAir] = await Promise.all([
      radarPromise.catch(() => null),
      kmiPromise.catch(() => null),
      airPromise
    ]);

    if (!latestRain) latestRain = modelRainPoints(latestWeather);
    settings.lastLocation = currentLocation;
    persistSettings();
    renderAll();
    elements["weather-content"].hidden = false;
    elements["refresh-button"].disabled = false;
    announce(`${t("status.loaded", { name: location.name })} ${elements["decision-summary"].textContent}`);
    if (moveFocus) elements["weather-location-heading"].focus();
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      showError(t("error.weather"));
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
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    minutely_15: "precipitation,rain,showers,weather_code",
    hourly: "temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,uv_index,is_day,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,daylight_duration,uv_index_max,wind_speed_10m_max",
    timezone: "auto",
    past_days: "1",
    forecast_days: "10"
  });
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Forecast returned ${response.status}.`);
  return response.json();
}

async function fetchAirQuality(location, signal) {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: "european_aqi,us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen",
    timezone: "auto"
  });
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Air quality returned ${response.status}.`);
  return response.json();
}

async function fetchBuienradar(location, signal) {
  const url = new URL("https://gps.buienradar.nl/getrr.php");
  url.search = new URLSearchParams({ lat: String(location.latitude), lon: String(location.longitude) });
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Rain radar returned ${response.status}.`);
  const points = parseBuienradarText(await response.text(), Date.now(), latestWeather.utc_offset_seconds);
  if (points.length < 12) throw new Error("Rain radar returned too few intervals.");
  return { source: "radar", intervalMinutes: 5, points };
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
  return { source: "model", intervalMinutes: 15, points };
}

function renderAll() {
  renderHeading();
  renderDecisionSummary();
  renderCurrentConditions();
  renderRain();
  renderHourly();
  renderDaily();
  renderAirQuality();
  renderSaveButton();
  renderNotifications();
}

function renderHeading() {
  elements["weather-location-heading"].textContent = currentLocation.name;
  elements["location-context"].textContent = currentLocation.detail || coordinateLabel(currentLocation);
  const currentEpoch = localIsoToEpoch(latestWeather.current.time, latestWeather.utc_offset_seconds);
  elements["weather-age"].textContent = t("modelTime", { time: formatTime(currentEpoch) });
  const isDay = Number(latestWeather.current.is_day ?? 1) !== 0;
  elements["hero-icon"].innerHTML = svgIcon(iconNameFor(latestWeather.current.weather_code, isDay), "wx-icon wx-icon-hero");
}

function currentHourIndex() {
  const target = String(latestWeather.current.time).slice(0, 13);
  return latestWeather.hourly.time.findIndex((time) => String(time).startsWith(target));
}

function todayDateString() {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    timeZone: currentLocation.timezone || latestWeather?.timezone || undefined
  }).format(Date.now());
}

function renderDecisionSummary() {
  const current = latestWeather.current;
  const rain = formatRainSummary(lang, summarizeRain(latestRain.points, { nowEpoch: Date.now() }), formatTime, latestRain.source);
  const measuredTemperature = latestObservation?.temperatureC;
  const temperatureSummary = Number.isFinite(Number(measuredTemperature))
    ? t("summary.measured", { measured: formatTemperature(measuredTemperature), feels: formatTemperature(current.apparent_temperature) })
    : t("summary.estimated", { temp: formatTemperature(current.temperature_2m), feels: formatTemperature(current.apparent_temperature) });
  elements["decision-summary"].textContent = `${temperatureSummary} ${rain.headline}`;
  elements["summary-caveat"].textContent = `${localizedWeatherLabel(lang, current.weather_code)}. ${rain.detail}`;
  renderYesterdayComparison();
  renderSunSummary();
}

function renderYesterdayComparison() {
  const target = elements["summary-comparison"];
  target.textContent = "";
  target.hidden = true;
  const index = currentHourIndex();
  if (index < 24) return;
  const yesterday = Number(latestWeather.hourly.temperature_2m[index - 24]);
  const now = Number(latestWeather.current.temperature_2m);
  if (!Number.isFinite(yesterday) || !Number.isFinite(now)) return;
  const delta = now - yesterday;
  let sentence;
  if (Math.abs(delta) < 1) {
    sentence = t("summary.sameAsYesterday");
  } else {
    const key = delta > 0 ? "summary.warmerThanYesterday" : "summary.colderThanYesterday";
    sentence = t(key, { amount: formatTemperatureDelta(Math.abs(delta)) });
  }
  target.textContent = sentence;
  target.hidden = false;
}

function renderSunSummary() {
  const target = elements["sun-summary"];
  target.textContent = "";
  target.hidden = true;
  const daily = latestWeather.daily;
  if (!daily?.sunrise) return;
  const todayIndex = daily.time.indexOf(todayDateString());
  if (todayIndex < 0) return;
  const offset = latestWeather.utc_offset_seconds;
  const sunrise = formatTime(localIsoToEpoch(daily.sunrise[todayIndex], offset));
  const sunset = formatTime(localIsoToEpoch(daily.sunset[todayIndex], offset));
  const daylight = formatDuration(daily.daylight_duration?.[todayIndex]);
  if (!daylight) return;
  target.textContent = t("summary.sun", { sunrise, sunset, daylight });
  target.hidden = false;
}

function renderCurrentConditions() {
  const current = latestWeather.current;
  const hourIndex = currentHourIndex();
  const dewPoint = hourIndex >= 0 ? latestWeather.hourly.dew_point_2m?.[hourIndex] : null;
  const uvNow = hourIndex >= 0 ? latestWeather.hourly.uv_index?.[hourIndex] : null;

  const rows = [
    [t("value.estimatedTemperature"), formatTemperature(current.temperature_2m)],
    [t("value.feelsLike"), formatTemperature(current.apparent_temperature)],
    [t("value.humidity"), `${formatNumber(current.relative_humidity_2m, 0)}%`],
    [t("value.dewPoint"), formatTemperature(dewPoint)],
    [t("value.wind"), formatWindWithDirection(current.wind_speed_10m, current.wind_direction_10m)],
    [t("value.gusts"), formatSpeed(current.wind_gusts_10m)],
    [t("value.pressure"), `${formatNumber(current.pressure_msl, 0)} hPa`],
    [t("value.cloudCover"), `${formatNumber(current.cloud_cover, 0)}%`]
  ];
  if (Number.isFinite(Number(uvNow))) {
    rows.push([t("value.uvNow"), t("uv.display", { value: formatNumber(uvNow, 1), rating: t(uvRatingKey(Number(uvNow))) })]);
  }
  rows.push([t("value.conditions"), localizedWeatherLabel(lang, current.weather_code)]);
  renderDefinitionList(elements["current-values"], rows);

  elements["kmi-credit"].hidden = !latestObservation;
  if (!latestObservation) {
    elements["measured-observation"].hidden = true;
    return;
  }

  const ageMinutes = Math.max(0, Math.round((Date.now() - Date.parse(latestObservation.timestamp)) / 60_000));
  elements["station-description"].textContent = t("station.description", {
    name: titleCase(latestObservation.name),
    distance: formatDistance(latestObservation.distanceKm),
    time: formatTime(Date.parse(latestObservation.timestamp)),
    minutes: ageMinutes
  });
  renderDefinitionList(elements["measured-values"], [
    [t("value.temperature"), formatTemperature(latestObservation.temperatureC)],
    [t("value.humidity"), formatOptional(latestObservation.humidityPercent, (value) => `${formatNumber(value, 0)}%`)],
    [t("value.wind"), formatOptional(latestObservation.windSpeedKmh, (value) => formatWindWithDirection(value, latestObservation.windDirectionDegrees))],
    [t("value.gusts"), formatOptional(latestObservation.windGustKmh, (value) => formatSpeed(value))],
    [t("value.pressure"), formatOptional(latestObservation.pressureHpa, (value) => `${formatNumber(value, 0)} hPa`)],
    [t("value.recentRain"), formatOptional(latestObservation.precipitationMm, (value) => formatPrecipitation(value))]
  ]);
  elements["measured-observation"].hidden = false;
}

function renderRain() {
  const isRadar = latestRain.source === "radar";
  const summary = formatRainSummary(lang, summarizeRain(latestRain.points, { nowEpoch: Date.now() }), formatTime, latestRain.source);
  elements["rain-summary"].textContent = `${summary.headline} ${summary.detail}`;
  elements["rain-source-badge"].textContent = t(isRadar ? "rain.badge.radar" : "rain.badge.model");
  elements["rain-detail-intro"].textContent = t(isRadar ? "rain.intro.radar" : "rain.intro.model");
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
    item.textContent = t("rain.timelineItem", {
      time: formatTime(point.time),
      intensity: t(intensityKey(point.mmPerHour)),
      amount: formatIntensity(point.mmPerHour)
    });
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
    const hourly = latestWeather.hourly;
    const isDay = Number(hourly.is_day?.[index] ?? 1) !== 0;
    const sentence = t("hourly.item", {
      time: formatTime(epoch),
      conditions: localizedWeatherLabel(lang, hourly.weather_code[index]),
      temp: formatTemperature(hourly.temperature_2m[index]),
      feels: formatTemperature(hourly.apparent_temperature[index]),
      chance: formatNumber(hourly.precipitation_probability[index] ?? 0, 0),
      amount: formatPrecipitation(hourly.precipitation[index] ?? 0),
      wind: formatSpeed(hourly.wind_speed_10m[index]),
      gusts: formatSpeed(hourly.wind_gusts_10m[index])
    });
    appendForecastItem(item, hourly.weather_code[index], isDay, sentence);
    elements["hourly-list"].append(item);
  }
}

function renderDaily() {
  elements["daily-list"].replaceChildren();
  const today = todayDateString();
  const daily = latestWeather.daily;
  daily.time.forEach((date, index) => {
    if (date < today) return;
    const item = document.createElement("li");
    let day;
    if (date === today) day = t("daily.today");
    else if (isTomorrow(date, today)) day = t("daily.tomorrow");
    else day = formatDay(date);
    const offset = latestWeather.utc_offset_seconds;
    const uvValue = daily.uv_index_max?.[index];
    const sentence = t("daily.item", {
      day,
      conditions: localizedWeatherLabel(lang, daily.weather_code[index]),
      high: formatTemperature(daily.temperature_2m_max[index]),
      low: formatTemperature(daily.temperature_2m_min[index]),
      chance: formatNumber(daily.precipitation_probability_max[index] ?? 0, 0),
      amount: formatPrecipitation(daily.precipitation_sum[index] ?? 0),
      uv: Number.isFinite(Number(uvValue))
        ? t("uv.display", { value: formatNumber(uvValue, 1), rating: t(uvRatingKey(Number(uvValue))) })
        : t("value.notReported"),
      sunrise: formatTime(localIsoToEpoch(daily.sunrise[index], offset)),
      sunset: formatTime(localIsoToEpoch(daily.sunset[index], offset))
    });
    appendForecastItem(item, daily.weather_code[index], true, sentence);
    elements["daily-list"].append(item);
  });
}

function appendForecastItem(item, code, isDay, sentence) {
  item.append(iconElement(document, code, isDay));
  const text = document.createElement("span");
  text.className = "forecast-text";
  text.textContent = sentence;
  item.append(text);
}

function isTomorrow(date, today) {
  const [year, month, day] = today.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return date === next.toISOString().slice(0, 10);
}

function renderAirQuality() {
  const section = elements["air-section"];
  const current = latestAir?.current;
  if (!current) {
    section.hidden = true;
    return;
  }

  const rows = [];
  const euAqi = Number(current.european_aqi);
  const usAqi = Number(current.us_aqi);
  if (Number.isFinite(euAqi)) {
    rows.push([t("air.aqiEuropean"), t("air.display", { value: formatNumber(euAqi, 0), rating: t(europeanAqiRatingKey(euAqi)) })]);
  } else if (Number.isFinite(usAqi)) {
    rows.push([t("air.aqiUs"), t("air.display", { value: formatNumber(usAqi, 0), rating: t(usAqiRatingKey(usAqi)) })]);
  }
  const pollutants = [
    ["air.pm25", current.pm2_5],
    ["air.pm10", current.pm10],
    ["air.ozone", current.ozone],
    ["air.no2", current.nitrogen_dioxide]
  ];
  for (const [key, value] of pollutants) {
    if (Number.isFinite(Number(value))) rows.push([t(key), `${formatNumber(value, 0)} µg/m³`]);
  }
  const pollens = [
    ["air.pollen.alder", current.alder_pollen],
    ["air.pollen.birch", current.birch_pollen],
    ["air.pollen.grass", current.grass_pollen],
    ["air.pollen.mugwort", current.mugwort_pollen],
    ["air.pollen.olive", current.olive_pollen],
    ["air.pollen.ragweed", current.ragweed_pollen]
  ];
  for (const [key, value] of pollens) {
    if (Number.isFinite(Number(value))) rows.push([t(key), `${formatNumber(value, 0)} gr/m³`]);
  }

  if (!rows.length) {
    section.hidden = true;
    return;
  }
  renderDefinitionList(elements["air-values"], rows);
  section.hidden = false;
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
    button.setAttribute("aria-label", t("saved.buttonLabel", { label: locationLabel(location) }));
    button.addEventListener("click", () => selectLocation(location));
    elements["saved-location-buttons"].append(button);
  }
}

function toggleSavedLocation() {
  const saved = settings.savedLocations ?? [];
  const existingIndex = saved.findIndex((item) => sameLocation(item, currentLocation));
  if (existingIndex >= 0) {
    saved.splice(existingIndex, 1);
    announce(t("status.removed", { name: currentLocation.name }));
  } else {
    saved.push(currentLocation);
    if (saved.length > 8) saved.shift();
    announce(t("status.saved", { name: currentLocation.name }));
  }
  settings.savedLocations = saved;
  persistSettings();
  renderSavedLocations();
  renderSaveButton();
}

function renderSaveButton() {
  const saved = (settings.savedLocations ?? []).some((item) => sameLocation(item, currentLocation));
  elements["save-location-button"].textContent = t(saved ? "action.unsave" : "action.save");
}

async function shareWeather() {
  const text = [
    elements["decision-summary"].textContent,
    elements["summary-comparison"].hidden ? "" : elements["summary-comparison"].textContent,
    elements["summary-caveat"].textContent
  ].filter(Boolean).join(" ").trim();
  const title = t("share.title", { name: currentLocation.name });
  try {
    if (navigator.share) {
      await navigator.share({ title, text });
      announce(t("status.shared"));
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(`${title}. ${text}`);
      announce(t("status.copied"));
    }
  } catch (error) {
    if (error.name !== "AbortError") announce(t("status.error"));
  }
}

function forgetSettings() {
  localStorage.removeItem(STORAGE_KEY);
  settings = defaultSettings();
  applyLanguage();
  syncPreferenceControls();
  renderSavedLocations();
  renderSaveButton();
  renderNotifications();
  if (latestWeather) renderAll();
  announce(t("status.forgotten"));
}

function defaultSettings() {
  const region = String(navigator.language || "").toUpperCase();
  const imperial = region.endsWith("-US");
  return {
    language: "auto",
    temperatureUnit: imperial ? "fahrenheit" : "celsius",
    windUnit: imperial ? "mph" : "kmh",
    precipitationUnit: imperial ? "inch" : "mm",
    savedLocations: [],
    lastLocation: DEFAULT_LOCATION,
    notifications: { enabled: false, locationName: null, briefingHour: null }
  };
}

function loadSettings() {
  const defaults = defaultSettings();
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!parsed || typeof parsed !== "object") return defaults;
    const migratedImperial = parsed.units === "imperial";
    return {
      language: typeof parsed.language === "string" ? parsed.language : defaults.language,
      temperatureUnit: ["celsius", "fahrenheit"].includes(parsed.temperatureUnit)
        ? parsed.temperatureUnit
        : (migratedImperial ? "fahrenheit" : defaults.temperatureUnit),
      windUnit: ["kmh", "mph", "ms", "bft"].includes(parsed.windUnit)
        ? parsed.windUnit
        : (migratedImperial ? "mph" : defaults.windUnit),
      precipitationUnit: ["mm", "inch"].includes(parsed.precipitationUnit)
        ? parsed.precipitationUnit
        : (migratedImperial ? "inch" : defaults.precipitationUnit),
      savedLocations: Array.isArray(parsed.savedLocations) ? parsed.savedLocations : [],
      lastLocation: parsed.lastLocation ?? DEFAULT_LOCATION,
      notifications: parsed.notifications && typeof parsed.notifications === "object"
        ? {
            enabled: Boolean(parsed.notifications.enabled),
            locationName: parsed.notifications.locationName ?? null,
            briefingHour: Number.isInteger(parsed.notifications.briefingHour) ? parsed.notifications.briefingHour : null
          }
        : defaults.notifications
    };
  } catch {
    return defaults;
  }
}

function persistSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The weather still works when private browsing blocks storage.
  }
}

// --- Notifications -----------------------------------------------------------

function renderNotifications() {
  const status = elements["notif-status"];
  const enable = elements["notif-enable-button"];
  const disable = elements["notif-disable-button"];
  const briefingRow = elements["briefing-row"];

  if (!PUSH_SUPPORTED) {
    status.textContent = t("notif.unsupported");
    enable.hidden = true;
    disable.hidden = true;
    briefingRow.hidden = true;
    return;
  }

  if (Notification.permission === "denied") {
    status.textContent = t("notif.denied");
    enable.hidden = true;
    disable.hidden = !settings.notifications.enabled;
    briefingRow.hidden = true;
    return;
  }

  const active = settings.notifications.enabled;
  status.textContent = active
    ? t("notif.activeFor", { name: settings.notifications.locationName ?? "" })
    : t("notif.inactive");

  const sameSpot = active && settings.notifications.locationName === currentLocation.name;
  enable.hidden = sameSpot;
  enable.textContent = active && !sameSpot
    ? t("notif.updateTo", { name: currentLocation.name })
    : t("notif.enableFor", { name: currentLocation.name });
  disable.hidden = !active;
  briefingRow.hidden = false;
  const briefingHour = settings.notifications.briefingHour;
  elements["briefing-select"].value = Number.isInteger(briefingHour) ? String(briefingHour) : "off";
}

async function enableNotifications() {
  if (!PUSH_SUPPORTED) return;
  clearError();
  announce(t("notif.saving"));
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      renderNotifications();
      return;
    }
    const subscription = await ensurePushSubscription();
    await postSubscription(subscription);
    settings.notifications.enabled = true;
    settings.notifications.locationName = currentLocation.name;
    persistSettings();
    renderNotifications();
    announce(t("notif.enabledStatus", { name: currentLocation.name }));
  } catch (error) {
    console.error(error);
    showError(t("notif.error"));
  }
}

async function ensurePushSubscription() {
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  const response = await fetch("./api/push/vapid-public-key");
  if (!response.ok) throw new Error(`VAPID key request returned ${response.status}.`);
  const { key } = await response.json();
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key)
  });
}

async function postSubscription(subscription) {
  const briefingValue = elements["briefing-select"].value;
  const briefingHour = briefingValue === "off" ? null : Number(briefingValue);
  settings.notifications.briefingHour = briefingHour;
  const body = {
    subscription: subscription.toJSON(),
    location: {
      name: currentLocation.name,
      latitude: currentLocation.latitude,
      longitude: currentLocation.longitude,
      timezone: currentLocation.timezone || latestWeather?.timezone || "UTC"
    },
    language: lang,
    units: {
      temperatureUnit: settings.temperatureUnit,
      windUnit: settings.windUnit
    },
    prefs: { rainAlerts: true, briefingHour }
  };
  const response = await fetch("./api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Subscribe returned ${response.status}.`);
}

async function syncSubscriptionIfEnabled() {
  if (!PUSH_SUPPORTED || !settings.notifications.enabled) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await postSubscription(subscription);
  } catch {
    // Preference sync is best-effort; alerts keep their previous settings.
  }
}

async function handleBriefingChange() {
  const value = elements["briefing-select"].value;
  settings.notifications.briefingHour = value === "off" ? null : Number(value);
  persistSettings();
  if (!settings.notifications.enabled) return;
  announce(t("notif.saving"));
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await postSubscription(subscription);
      announce(t("notif.enabledStatus", { name: settings.notifications.locationName ?? currentLocation.name }));
    }
  } catch (error) {
    console.error(error);
    showError(t("notif.error"));
  }
}

async function disableNotifications() {
  if (!PUSH_SUPPORTED) return;
  announce(t("notif.saving"));
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await fetch("./api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint })
      }).catch(() => {});
      await subscription.unsubscribe();
    }
    settings.notifications.enabled = false;
    settings.notifications.locationName = null;
    persistSettings();
    renderNotifications();
    announce(t("notif.disabledStatus"));
  } catch (error) {
    console.error(error);
    showError(t("notif.error"));
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

// --- Formatting --------------------------------------------------------------

function formatNumber(value, digits) {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(Number(value));
}

function formatTemperature(celsius) {
  if (!Number.isFinite(Number(celsius))) return t("value.notReported");
  if (settings.temperatureUnit === "fahrenheit") return `${formatNumber(Number(celsius) * 9 / 5 + 32, 1)}°F`;
  return `${formatNumber(Number(celsius), 1)}°C`;
}

function formatTemperatureDelta(deltaCelsius) {
  const digits = 1;
  if (settings.temperatureUnit === "fahrenheit") return `${formatNumber(deltaCelsius * 9 / 5, digits)}°F`;
  return `${formatNumber(deltaCelsius, digits)}°C`;
}

function formatSpeed(kmh) {
  if (!Number.isFinite(Number(kmh))) return t("value.notReported");
  const value = Number(kmh);
  switch (settings.windUnit) {
    case "mph": return `${formatNumber(value * 0.621371, 0)} mph`;
    case "ms": return `${formatNumber(value / 3.6, 1)} m/s`;
    case "bft": {
      const force = beaufortForce(value);
      return t("wind.force", { force, name: t(`beaufort.${force}`) });
    }
    default: return `${formatNumber(value, 0)} km/h`;
  }
}

function formatWindWithDirection(kmh, degrees) {
  if (!Number.isFinite(Number(kmh))) return t("value.notReported");
  const direction = localizedCompass(lang, degrees);
  if (settings.windUnit === "bft") {
    return t("wind.from", { speed: formatSpeed(kmh), direction });
  }
  const force = beaufortForce(Number(kmh));
  return t("wind.withBeaufort", { speed: formatSpeed(kmh), beaufort: t(`beaufort.${force}`), direction });
}

function formatDistance(km) {
  if (settings.precipitationUnit === "inch") {
    const miles = km * 0.621371;
    return `${formatNumber(miles, miles < 16 ? 1 : 0)} mi`;
  }
  return `${formatNumber(km, km < 10 ? 1 : 0)} km`;
}

function formatPrecipitation(mm) {
  if (!Number.isFinite(Number(mm))) return t("value.notReported");
  if (settings.precipitationUnit === "inch") return `${formatNumber(Number(mm) / 25.4, 2)} in`;
  return `${formatNumber(Number(mm), Number(mm) < 10 ? 1 : 0)} mm`;
}

function formatIntensity(mmPerHour) {
  if (settings.precipitationUnit === "inch") return `${formatNumber(mmPerHour / 25.4, 2)} in/h`;
  return `${formatNumber(mmPerHour, mmPerHour < 10 ? 1 : 0)} mm/h`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return null;
  const total = Math.round(Number(seconds) / 60);
  return t("duration.hoursMinutes", { hours: Math.floor(total / 60), minutes: total % 60 });
}

function formatTime(epoch) {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: currentLocation.timezone || latestWeather?.timezone || undefined
  }).format(epoch);
}

function formatDay(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(Date.UTC(year, month - 1, day));
}

function formatOptional(value, formatter) {
  if (!Number.isFinite(Number(value))) return t("value.notReported");
  return formatter(Number(value));
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
  announce(t("status.error"));
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
