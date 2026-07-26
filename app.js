import {
  haversineKm,
  isBelgium,
  isBuienradarCoverage,
  isDwdCoverage,
  isMetnoCoverage,
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
import { dropletSvg, iconElement, iconNameFor, sunArcSvg, svgIcon, windArrowSvg } from "./icons.js";
import {
  MOON_PHASE_KEYS,
  capeRatingKey,
  computeAtmosphere,
  computeClimate,
  computeEnsemble,
  computeModelComparison,
  liftedIndexRatingKey,
  moonPhase,
  pressureTrendKey
} from "./deep-data.js";

const STORAGE_KEY = "weather-clearly.v1";
// Shown in the collapsed sources panel so "did the update arrive?" is a fact
// you can read out rather than a guess.
const APP_VERSION = "2026-07-27.3";
const DEFAULT_LOCATION = {
  name: "Mechelen",
  detail: "Flanders, Belgium",
  latitude: 51.02574,
  longitude: 4.47762,
  timezone: "Europe/Brussels",
  countryCode: "BE"
};
const BRIEFING_HOURS = [6, 7, 8, 9, 12, 18, 21];
// Earlier versions stored a GPS fix under a translated "Current location"
// label and no marker, so it was reloaded forever without ever being re-fixed.
// Recognising those labels turns them back into a live position. Declared up
// here because loadSettings() runs before the rest of the module body.
const LEGACY_GPS_NAMES = new Set([
  "Current location",
  "Huidige locatie",
  "Position actuelle",
  "Aktueller Standort",
  "Ubicación actual"
]);

const elements = Object.fromEntries([
  "search-form", "location-search", "gps-button", "refresh-button", "search-results",
  "search-results-heading", "search-results-list", "saved-locations", "saved-location-buttons",
  "location-picker", "location-current-name", "gps-fix", "gps-fix-values",
  "status", "error", "weather-content", "weather-location-heading", "location-context",
  "save-location-button", "share-button", "hero-icon", "decision-summary",
  "summary-comparison", "sun-summary-row", "sun-summary", "sun-arc", "weather-age",
  "measured-observation", "station-description", "measured-values", "current-values", "model-heading",
  "rain-summary", "rain-source-badge", "rain-visual", "rain-detail-intro", "rain-timeline",
  "tab-now", "tab-forecast", "tab-deep", "tab-more",
  "view-now", "view-forecast", "view-deep", "view-more",
  "forecast-content", "hourly-list", "hourly-more-button", "daily-list", "daily-more-button", "air-section", "air-values",
  "quarter-details", "quarter-toggle", "quarter-source", "quarter-list",
  "deep-status", "ens-card", "ens-note", "ens-body", "models-card", "models-note", "models-body",
  "climate-card", "climate-note", "climate-body", "atmos-card", "atmos-values", "atmos-peak",
  "moon-card", "moon-body",
  "notif-heading", "notif-status", "notif-enable-button", "notif-disable-button", "briefing-select", "briefing-row",
  "language-select", "temperature-select", "wind-select", "precip-select",
  "forget-button", "buienradar-credit", "kmi-credit", "metar-credit", "metno-credit", "dwd-credit",
  "bigdatacloud-credit", "version-note"
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
let latestAnalysis = emptyAnalysisState(null);
let weatherRequestController = null;
let searchRequestController = null;
let analysisRequestController = null;
let activeViewTab = "tab-now";
const viewScrollPositions = { "tab-now": 0, "tab-forecast": 0, "tab-deep": 0, "tab-more": 0 };
const climateCache = new Map();
const CLIMATE_STORAGE_KEY = "weather-clearly.climate.v1";
const CLIMATE_STORAGE_LIMIT = 20;
let dailyExpanded = false;
let hourlyExpanded = false;
let lastLoadedAt = 0;
let lastLoadedKey = null;
let gpsRefreshInFlight = false;
let latestQuarter = null;
let quarterRequestController = null;
let quarterLoadingKey = null;
const STALE_AFTER_MS = 5 * 60_000;
const ANALYSIS_STALE_AFTER_MS = 30 * 60_000;
const QUARTER_STALE_AFTER_MS = 10 * 60_000;
// A new fix this far from the stored one is a different place, so refetch.
const GPS_MOVED_KM = 0.75;

buildLanguageOptions();
buildBriefingOptions();
applyLanguage();
syncPreferenceControls();
renderSavedLocations();
renderNotifications();
registerEvents();
registerServiceWorker();
registerStaleRefresh();
renderGpsFix();
loadWeather(currentLocation, { moveFocus: false });
// A stored GPS place is only "where you are" if we re-fix on every launch.
void refreshGpsFix();
// A migrated or unnamed fix gets a place name even when no new fix arrives.
if (currentLocation.source === "gps" && !currentLocation.detail) void resolvePlaceName(currentLocation);

// Reload weather when the app comes back to the foreground (home-screen
// launch, tab switch, back-forward cache) instead of showing stale data.
function registerStaleRefresh() {
  document.addEventListener("visibilitychange", refreshIfStale);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) refreshIfStale();
  });
}

function refreshIfStale() {
  if (document.visibilityState !== "visible" || !latestWeather) return;
  if (Date.now() - lastLoadedAt >= STALE_AFTER_MS) {
    void refreshGpsFix();
    loadWeather(currentLocation, { moveFocus: false, refresh: true });
  } else {
    // Data is fresh enough, but relative wording ("12 minutes ago", the rain
    // timeline) may have aged while the app was in the background.
    renderAll();
  }
}

function registerEvents() {
  elements["search-form"].addEventListener("submit", handleSearch);
  elements["gps-button"].addEventListener("click", useCurrentLocation);
  elements["refresh-button"].addEventListener("click", () => {
    void refreshGpsFix();
    loadWeather(currentLocation, { moveFocus: false, refresh: true });
  });
  elements["quarter-details"].addEventListener("toggle", () => {
    if (elements["quarter-details"].open) void ensureQuarterLoaded();
  });
  elements["save-location-button"].addEventListener("click", toggleSavedLocation);
  elements["share-button"].addEventListener("click", shareWeather);
  elements["forget-button"].addEventListener("click", forgetSettings);
  elements["notif-enable-button"].addEventListener("click", enableNotifications);
  elements["notif-disable-button"].addEventListener("click", disableNotifications);
  elements["briefing-select"].addEventListener("change", handleBriefingChange);
  elements["daily-more-button"].addEventListener("click", () => {
    dailyExpanded = !dailyExpanded;
    renderDaily();
    elements["daily-more-button"].focus();
  });
  elements["hourly-more-button"].addEventListener("click", () => {
    hourlyExpanded = !hourlyExpanded;
    renderHourly();
    elements["hourly-more-button"].focus();
  });

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

  const appTabs = [elements["tab-now"], elements["tab-forecast"], elements["tab-deep"], elements["tab-more"]];
  appTabs.forEach((tab) => {
    tab.addEventListener("click", () => selectView(tab.id));
    tab.addEventListener("keydown", (event) => handleTabKeydown(event, appTabs));
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
  renderActionLabels();
  elements["version-note"].textContent = t("sources.version", { version: APP_VERSION });
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
  // A local-time Date, so the label always shows exactly the stored hour.
  // (A UTC date here shifted every label by the browser's offset, which made
  // a briefing set to "09:00" actually fire at 08:00.)
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(2026, 0, 1, hour, 0));
}

function syncPreferenceControls() {
  elements["language-select"].value = settings.language;
  elements["temperature-select"].value = settings.temperatureUnit;
  elements["wind-select"].value = settings.windUnit;
  elements["precip-select"].value = settings.precipitationUnit;
}

const VIEW_FOR_TAB = {
  "tab-now": "view-now",
  "tab-forecast": "view-forecast",
  "tab-deep": "view-deep",
  "tab-more": "view-more"
};

function selectView(tabId) {
  if (!(tabId in VIEW_FOR_TAB)) return;
  const sameView = tabId === activeViewTab;
  viewScrollPositions[activeViewTab] = sameView ? 0 : currentScrollPosition();

  for (const [tab, view] of Object.entries(VIEW_FOR_TAB)) {
    const selected = tab === tabId;
    elements[tab].setAttribute("aria-selected", String(selected));
    elements[tab].tabIndex = selected ? 0 : -1;
    elements[view].hidden = !selected;
  }

  activeViewTab = tabId;
  restoreViewScroll(sameView ? 0 : viewScrollPositions[tabId]);
  if (tabId === "tab-deep") void ensureAnalysisLoaded();
  if (tabId === "tab-forecast") void ensureQuarterLoaded();
}

function currentScrollPosition() {
  return Number.isFinite(Number(window.scrollY)) ? Number(window.scrollY) : 0;
}

function restoreViewScroll(position) {
  if (typeof window.scrollTo !== "function" || /jsdom/i.test(navigator.userAgent)) return;
  requestAnimationFrame(() => window.scrollTo({ top: position ?? 0, left: 0, behavior: "auto" }));
}

function handleTabKeydown(event, tabs) {
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
    if (error.name !== "AbortError") {
      showError(t("error.search"));
      elements["location-search"].focus();
    }
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
  renderGpsFix();
  loadWeather(location, { moveFocus: true });
}

async function useCurrentLocation() {
  clearError();
  if (!navigator.geolocation) {
    showError(t("error.gpsUnsupported"));
    return;
  }

  announce(t("status.gpsWait"));
  elements["gps-button"].disabled = true;
  try {
    const position = await requestPosition({ maximumAge: 0 });
    const location = gpsLocation(position, currentLocation);
    elements["gps-button"].disabled = false;
    adoptGpsLocation(location);
    loadWeather(location, { moveFocus: true });
  } catch (error) {
    elements["gps-button"].disabled = false;
    const messages = {
      1: t("error.gpsDenied"),
      2: t("error.gpsUnavailable"),
      3: t("error.gpsTimeout")
    };
    showError(messages[error?.code] ?? t("error.gpsUnavailable"));
    elements["gps-button"].focus();
  }
}

function requestPosition({ maximumAge = 60_000, timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout,
      maximumAge
    });
  });
}

// A GPS place keeps the last resolved place name until the reverse geocode
// for the new fix comes back, so the heading never falls back to a bare label.
function gpsLocation(position, previous) {
  const reuseName = previous?.source === "gps" && previous.name ? previous.name : null;
  return {
    name: reuseName ?? coordinateLabel(position.coords),
    detail: reuseName ? previous.detail ?? null : null,
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    timezone: reuseName ? previous.timezone ?? null : null,
    countryCode: reuseName ? previous.countryCode ?? null : null,
    source: "gps",
    accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    fixedAt: Date.now()
  };
}

function adoptGpsLocation(location) {
  currentLocation = location;
  settings.lastLocation = location;
  persistSettings();
  renderGpsFix();
  void resolvePlaceName(location);
}

// Re-fixes a stored GPS location on launch and on every return to the app, so
// "where you are" is never yesterday's position wearing today's label.
async function refreshGpsFix() {
  if (currentLocation.source !== "gps" || !navigator.geolocation || gpsRefreshInFlight) return;
  if (await geolocationPermission() === "denied") {
    renderGpsFix();
    return;
  }

  gpsRefreshInFlight = true;
  const previous = currentLocation;
  try {
    const position = await requestPosition({ maximumAge: 60_000, timeout: 12_000 });
    const location = gpsLocation(position, previous);
    const moved = haversineKm(previous.latitude, previous.longitude, location.latitude, location.longitude);
    adoptGpsLocation(location);
    if (moved >= GPS_MOVED_KM) {
      announce(t("status.gpsMoved"));
      loadWeather(location, { moveFocus: false });
    } else if (latestWeather) {
      renderHeading();
    }
  } catch {
    // No new fix: keep the stored one, which renderGpsFix() marks as older.
    renderGpsFix();
  } finally {
    gpsRefreshInFlight = false;
  }
}

async function geolocationPermission() {
  try {
    const status = await navigator.permissions?.query({ name: "geolocation" });
    return status?.state ?? "unknown";
  } catch {
    return "unknown";
  }
}

// Free client endpoint, no key. A failure only costs us the place name.
async function resolvePlaceName(location) {
  const url = new URL("https://api.bigdatacloud.net/data/reverse-geocode-client");
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    localityLanguage: lang
  });
  try {
    const response = await fetch(url);
    if (!response.ok) return;
    const place = await response.json();
    const name = place.city || place.locality || place.principalSubdivision || place.countryName;
    if (!name || location !== currentLocation) return;
    const detail = [place.locality !== name ? place.locality : null, place.principalSubdivision, place.countryName]
      .filter((part) => part && part !== name)
      .join(", ");
    currentLocation.name = name;
    currentLocation.detail = detail || null;
    currentLocation.countryCode = place.countryCode ?? null;
    settings.lastLocation = currentLocation;
    persistSettings();
    if (latestWeather) renderHeading();
    renderGpsFix();
  } catch {
    // Offline or blocked: the coordinates already label the place.
  }
}

// Lives inside the folded-out location panel: what was measured, how precisely
// and when, so a stale fix is visible instead of implied.
function renderGpsFix() {
  const panel = elements["gps-fix"];
  elements["bigdatacloud-credit"].hidden = currentLocation.source !== "gps";
  if (currentLocation.source !== "gps") {
    panel.hidden = true;
    return;
  }

  const rows = [[t("gps.place"), locationLabel(currentLocation)], [t("gps.coordinates"), coordinateLabel(currentLocation)]];
  if (Number.isFinite(toFiniteNumber(currentLocation.accuracyM))) {
    rows.push([t("gps.accuracyLabel"), formatAccuracy(currentLocation.accuracyM)]);
  }
  if (Number.isFinite(toFiniteNumber(currentLocation.fixedAt))) {
    const age = Date.now() - Number(currentLocation.fixedAt);
    rows.push([
      t("gps.fixedAt"),
      age < 90_000 ? t("gps.fixedJustNow") : formatClockOrDate(Number(currentLocation.fixedAt))
    ]);
  }
  renderDefinitionList(elements["gps-fix-values"], rows);
  panel.hidden = false;
}

function formatClockOrDate(epoch) {
  if (Date.now() - epoch < 12 * 3_600_000) return formatTime(epoch);
  return `${formatCalendarDate(epoch)}, ${formatTime(epoch)}`;
}

async function loadWeather(location, { moveFocus = false, refresh = false } = {}) {
  if (!refresh) {
    dailyExpanded = false;
    hourlyExpanded = false;
  }
  const requestedAnalysisKey = analysisLocationKey(location);
  if (latestAnalysis.locationKey !== requestedAnalysisKey) resetAnalysis(location);
  weatherRequestController?.abort();
  weatherRequestController = new AbortController();
  const { signal } = weatherRequestController;
  currentLocation = location;
  clearError();
  setWeatherBusy(true);
  // Only worth announcing the wait when the place changes; a refresh of the
  // same place would otherwise say everything twice.
  const movedElsewhere = lastLoadedKey !== analysisLocationKey(location);
  if (movedElsewhere) announce(t("status.getting", { name: location.name }));

  try {
    const weatherPromise = fetchOpenMeteo(location, signal);
    const observationPromise = fetchObservation(location, signal);
    const airPromise = fetchAirQuality(location, signal).catch(() => null);

    latestWeather = await weatherPromise;
    currentLocation.timezone = latestWeather.timezone;

    let radarPromise = Promise.resolve(null);
    if (isBuienradarCoverage(location.latitude, location.longitude)) {
      radarPromise = fetchBuienradar(location, signal);
    } else if (isMetnoCoverage(location.latitude, location.longitude) || isDwdCoverage(location.latitude, location.longitude)) {
      radarPromise = fetchProxiedNowcast(location, signal);
    }

    [latestRain, latestObservation, latestAir] = await Promise.all([
      radarPromise.catch(() => null),
      observationPromise.catch(() => null),
      airPromise
    ]);

    if (!latestRain) latestRain = modelRainPoints(latestWeather);
    lastLoadedAt = Date.now();
    lastLoadedKey = analysisLocationKey(location);
    if (refresh) latestAnalysis.loadedAt = 0;
    settings.lastLocation = currentLocation;
    persistSettings();
    renderAll();
    elements["weather-content"].hidden = false;
    elements["forecast-content"].hidden = false;
    elements["refresh-button"].disabled = false;
    announce(`${t("status.loaded", { name: location.name })} ${elements["decision-summary"].textContent}`);
    if (activeViewTab === "tab-deep") void ensureAnalysisLoaded({ force: refresh });
    if (activeViewTab === "tab-forecast") void ensureQuarterLoaded();
    if (moveFocus) {
      elements["location-picker"].open = false;
      elements["weather-location-heading"].focus();
    } else if (!elements["location-picker"].contains(document.activeElement)) {
      elements["location-picker"].open = false;
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      showError(t("error.weather"));
      if (moveFocus) {
        elements["location-picker"].open = true;
        elements["location-search"].focus();
      }
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
    forecast_days: "16"
  });
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Forecast returned ${response.status}.`);
  return response.json();
}

// Open-Meteo only publishes genuine 15-minute steps from convection-resolving
// models; anywhere else its minutely_15 block is hourly data interpolated, so
// we ask these models by name and show nothing when none of them answers.
const QUARTER_MODELS = [
  { id: "icon_d2", label: "DWD ICON-D2" },
  { id: "arome_france_hd", label: "Météo-France AROME HD" },
  { id: "ncep_hrrr_conus", label: "NOAA HRRR" }
];
const QUARTER_FIELDS = ["temperature_2m", "apparent_temperature", "precipitation", "weather_code", "wind_speed_10m", "wind_gusts_10m"];

async function fetchQuarterHourly(location, signal) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    minutely_15: QUARTER_FIELDS.join(","),
    models: QUARTER_MODELS.map((model) => model.id).join(","),
    timezone: "auto",
    forecast_minutely_15: "24"
  });
  const response = await fetch(url, { signal });
  const data = await response.json().catch(() => null);
  // Outside every high-resolution domain the API answers with an error body.
  if (!response.ok || !data || data.error || !data.minutely_15) return null;
  return pickQuarterModel(data);
}

function pickQuarterModel(data) {
  const block = data.minutely_15;
  for (const model of QUARTER_MODELS) {
    const suffixed = QUARTER_FIELDS.every((field) => `${field}_${model.id}` in block);
    if (!suffixed) continue;
    const series = readQuarterSeries(block, `_${model.id}`);
    if (series) return { label: model.label, offset: data.utc_offset_seconds, ...series };
  }
  // A single matching model comes back without the model suffix.
  const series = readQuarterSeries(block, "");
  if (!series) return null;
  return { label: null, offset: data.utc_offset_seconds, ...series };
}

function readQuarterSeries(block, suffix) {
  const temperatures = block[`temperature_2m${suffix}`];
  if (!Array.isArray(temperatures) || !temperatures.some((value) => Number.isFinite(toFiniteNumber(value)))) return null;
  const series = { time: block.time };
  for (const field of QUARTER_FIELDS) series[field] = block[`${field}${suffix}`] ?? [];
  return { series };
}

async function ensureQuarterLoaded() {
  if (!latestWeather) return;
  const locationKey = analysisLocationKey(currentLocation);
  const fresh = latestQuarter
    && latestQuarter.locationKey === locationKey
    && Date.now() - latestQuarter.loadedAt < QUARTER_STALE_AFTER_MS;
  if (fresh) {
    renderQuarter();
    return;
  }
  // Opening the disclosure while the tab's own request is still running must
  // not cancel it: the aborted render would pull the panel out from under you.
  if (quarterLoadingKey === locationKey) return;

  quarterRequestController?.abort();
  quarterRequestController = new AbortController();
  quarterLoadingKey = locationKey;
  try {
    const data = await fetchQuarterHourly(currentLocation, quarterRequestController.signal);
    latestQuarter = { locationKey, loadedAt: Date.now(), data };
    renderQuarter();
  } catch (error) {
    if (error.name !== "AbortError") {
      latestQuarter = { locationKey, loadedAt: Date.now(), data: null };
      renderQuarter();
    }
  } finally {
    if (quarterLoadingKey === locationKey) quarterLoadingKey = null;
  }
}

function renderQuarter() {
  const details = elements["quarter-details"];
  const rows = quarterRows();
  if (!rows.length) {
    // Leave `open` alone: if the data comes back it should reappear the way
    // you left it, not silently collapsed.
    details.hidden = true;
    return;
  }

  details.hidden = false;
  elements["quarter-source"].textContent = latestQuarter.data.label
    ? t("quarter.source", { model: latestQuarter.data.label })
    : t("quarter.sourceGeneric");
  elements["quarter-list"].replaceChildren();
  for (const row of rows) {
    const item = document.createElement("li");
    const headline = t("quarter.headline", {
      time: formatTime(row.epoch),
      conditions: localizedWeatherLabel(lang, row.weatherCode)
    });
    const meta = t(row.rainMm < 0.05 ? "quarter.metaDry" : "quarter.meta", {
      temp: formatTemperature(row.temperature),
      amount: formatPrecipitation(row.rainMm),
      wind: formatSpeed(row.wind),
      gusts: formatSpeed(row.gusts)
    });
    appendForecastItem(item, row.weatherCode, row.isDay, headline, meta, null);
    elements["quarter-list"].append(item);
  }
}

function quarterRows() {
  const data = latestQuarter?.data;
  if (!data?.series?.time || !latestWeather) return [];
  if (latestQuarter.locationKey !== analysisLocationKey(currentLocation)) return [];
  const { series, offset } = data;
  const dayByHour = new Map(latestWeather.hourly.time.map((time, index) => [String(time).slice(0, 13), latestWeather.hourly.is_day?.[index]]));
  const now = Date.now() - 5 * 60_000;
  const rows = [];
  for (let index = 0; index < series.time.length && rows.length < 12; index += 1) {
    const epoch = localIsoToEpoch(series.time[index], offset);
    if (epoch < now) continue;
    const temperature = toFiniteNumber(series.temperature_2m?.[index]);
    if (!Number.isFinite(temperature)) continue;
    rows.push({
      epoch,
      temperature,
      rainMm: Number(series.precipitation?.[index] ?? 0),
      weatherCode: series.weather_code?.[index],
      wind: series.wind_speed_10m?.[index],
      gusts: series.wind_gusts_10m?.[index],
      isDay: Number(dayByHour.get(String(series.time[index]).slice(0, 13)) ?? 1) !== 0
    });
  }
  return rows;
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

function emptyAnalysisState(locationKey) {
  return {
    locationKey,
    ensemble: null,
    models: null,
    climate: null,
    atmosphere: null,
    loadedAt: 0,
    loading: false
  };
}

function analysisLocationKey(location) {
  return `${Number(location.latitude).toFixed(4)},${Number(location.longitude).toFixed(4)}`;
}

function resetAnalysis(location) {
  analysisRequestController?.abort();
  analysisRequestController = null;
  latestAnalysis = emptyAnalysisState(analysisLocationKey(location));
  elements["view-deep"].setAttribute("aria-busy", "false");
  elements["deep-status"].hidden = true;
  renderAnalysis();
}

async function ensureAnalysisLoaded({ force = false } = {}) {
  if (!latestWeather) return;
  const locationKey = analysisLocationKey(currentLocation);
  if (latestAnalysis.locationKey !== locationKey) resetAnalysis(currentLocation);
  if (latestAnalysis.loading) return;
  if (!force && latestAnalysis.loadedAt && Date.now() - latestAnalysis.loadedAt < ANALYSIS_STALE_AFTER_MS) {
    renderAnalysis();
    return;
  }

  analysisRequestController?.abort();
  const controller = new AbortController();
  analysisRequestController = controller;
  latestAnalysis.loading = true;
  elements["view-deep"].setAttribute("aria-busy", "true");
  elements["deep-status"].textContent = t("status.deepLoading", { name: currentLocation.name });
  elements["deep-status"].hidden = false;
  announce(t("status.deepLoading", { name: currentLocation.name }));

  const targetDate = todayDateString();
  const targetMonthDay = targetDate.slice(5);
  const endYear = Number(targetDate.slice(0, 4)) - 1;
  const targetLocalTime = latestWeather.current.time;

  try {
    const results = await Promise.allSettled([
      fetchEnsembleAnalysis(currentLocation, controller.signal),
      fetchModelAnalysis(currentLocation, controller.signal),
      fetchClimateAnalysis(currentLocation, targetMonthDay, endYear, controller.signal),
      fetchAtmosphereAnalysis(currentLocation, targetLocalTime, controller.signal)
    ]);
    if (controller.signal.aborted || analysisRequestController !== controller || latestAnalysis.locationKey !== locationKey) return;

    const previous = latestAnalysis;
    latestAnalysis = {
      locationKey,
      ensemble: settledAnalysisValue(results[0], previous.ensemble),
      models: settledAnalysisValue(results[1], previous.models),
      climate: settledAnalysisValue(results[2], previous.climate),
      atmosphere: settledAnalysisValue(results[3], previous.atmosphere),
      loadedAt: Date.now(),
      loading: false
    };
    renderAnalysis();

    const availableCount = [
      latestAnalysis.ensemble,
      latestAnalysis.models,
      latestAnalysis.climate,
      latestAnalysis.atmosphere
    ].filter(Boolean).length;
    if (availableCount) {
      elements["deep-status"].hidden = true;
      announce(t("status.deepLoaded", { name: currentLocation.name }));
    } else {
      elements["deep-status"].textContent = t("status.deepUnavailable");
      elements["deep-status"].hidden = false;
      announce(t("status.deepUnavailable"));
    }
  } finally {
    if (analysisRequestController === controller) {
      latestAnalysis.loading = false;
      elements["view-deep"].setAttribute("aria-busy", "false");
      analysisRequestController = null;
    }
  }
}

function settledAnalysisValue(result, previous) {
  return result.status === "fulfilled" ? result.value : previous;
}

async function fetchEnsembleAnalysis(location, signal) {
  const url = new URL("https://ensemble-api.open-meteo.com/v1/ensemble");
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    hourly: "temperature_2m,precipitation",
    models: "ecmwf_ifs025",
    forecast_days: "3",
    timezone: "auto"
  });
  const payload = await fetchAnalysisJson(url, signal, "Ensemble forecast");
  return computeEnsemble(payload, 3);
}

async function fetchModelAnalysis(location, signal) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    daily: "temperature_2m_max,precipitation_sum",
    models: "ecmwf_ifs025,icon_seamless,gfs_seamless",
    forecast_days: "2",
    timezone: "auto"
  });
  const payload = await fetchAnalysisJson(url, signal, "Model comparison");
  return computeModelComparison(payload, 1);
}

async function fetchClimateAnalysis(location, targetMonthDay, endYear, signal) {
  const cacheKey = `${analysisLocationKey(location)}:${targetMonthDay}:${endYear}`;
  if (climateCache.has(cacheKey)) return climateCache.get(cacheKey);
  const persisted = readPersistedClimate(cacheKey);
  if (persisted) {
    climateCache.set(cacheKey, persisted);
    return persisted;
  }

  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    start_date: "1940-01-01",
    end_date: `${endYear}-12-31`,
    daily: "temperature_2m_max,temperature_2m_min",
    models: "era5",
    timezone: "auto"
  });
  const payload = await fetchAnalysisJson(url, signal, "Climate history");
  const result = computeClimate(payload, targetMonthDay);
  if (result) {
    climateCache.set(cacheKey, result);
    persistClimate(cacheKey, result);
  }
  return result;
}

// The archive download is around a megabyte; the computed summary is a few
// numbers, so it is worth keeping across page loads.
function readPersistedClimate(cacheKey) {
  try {
    const store = JSON.parse(localStorage.getItem(CLIMATE_STORAGE_KEY)) ?? {};
    return store[cacheKey]?.value ?? null;
  } catch {
    return null;
  }
}

function persistClimate(cacheKey, value) {
  try {
    const store = JSON.parse(localStorage.getItem(CLIMATE_STORAGE_KEY)) ?? {};
    store[cacheKey] = { value, at: Date.now() };
    const keys = Object.keys(store).sort((a, b) => (store[a].at ?? 0) - (store[b].at ?? 0));
    while (keys.length > CLIMATE_STORAGE_LIMIT) delete store[keys.shift()];
    localStorage.setItem(CLIMATE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Private browsing may block storage; the in-memory cache still applies.
  }
}

async function fetchAtmosphereAnalysis(location, targetLocalTime, signal) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    hourly: "cape,lifted_index,freezing_level_height,visibility,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wet_bulb_temperature_2m,pressure_msl",
    forecast_hours: "25",
    past_hours: "3",
    timezone: "auto"
  });
  const payload = await fetchAnalysisJson(url, signal, "Atmospheric forecast");
  return computeAtmosphere(payload, targetLocalTime);
}

async function fetchAnalysisJson(url, signal, label) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${label} returned ${response.status}.`);
  return response.json();
}

async function fetchBuienradar(location, signal) {
  const url = new URL("https://gps.buienradar.nl/getrr.php");
  url.search = new URLSearchParams({ lat: String(location.latitude), lon: String(location.longitude) });
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Rain radar returned ${response.status}.`);
  const points = parseBuienradarText(await response.text(), Date.now(), latestWeather.utc_offset_seconds);
  if (points.length < 12) throw new Error("Rain radar returned too few intervals.");
  return { source: "radar", provider: "buienradar", intervalMinutes: 5, points };
}

async function fetchProxiedNowcast(location, signal) {
  const response = await fetch(`./api/nowcast?lat=${location.latitude}&lon=${location.longitude}`, { signal });
  if (!response.ok) throw new Error(`Nowcast returned ${response.status}.`);
  const data = await response.json();
  if (!Array.isArray(data.points) || data.points.length < 12) throw new Error("Nowcast returned too few intervals.");
  return { source: "radar", provider: data.provider === "dwd" ? "dwd" : "metno", intervalMinutes: 5, points: data.points };
}

async function fetchObservation(location, signal) {
  if (isBelgium(location.latitude, location.longitude)) {
    try {
      const kmi = await fetchKmiObservation(location, signal);
      if (kmi) return { ...kmi, sourceType: "kmi" };
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }
  }
  const metar = await fetchMetarObservation(location, signal);
  return metar ? { ...metar, sourceType: "metar" } : null;
}

async function fetchMetarObservation(location, signal) {
  try {
    const response = await fetch(`./api/obs?lat=${location.latitude}&lon=${location.longitude}`, { signal });
    if (!response.ok) return null;
    const data = await response.json();
    const observation = nearestObservation(data.observations ?? [], location.latitude, location.longitude, 2);
    if (!observation || observation.distanceKm > 150) return null;
    return observation;
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return null;
  }
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
  return { source: "model", provider: "model", intervalMinutes: 15, points };
}

function renderAll() {
  renderHeading();
  renderDecisionSummary();
  renderCurrentConditions();
  renderRain();
  renderQuarter();
  renderHourly();
  renderDaily();
  renderAirQuality();
  renderAnalysis();
  renderSaveButton();
  renderNotifications();
}

function renderHeading() {
  elements["weather-location-heading"].textContent = currentLocation.name;
  elements["location-current-name"].textContent = currentLocation.name;
  renderActionLabels();
  renderGpsFix();
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
  const temperatureSummary = Number.isFinite(toFiniteNumber(measuredTemperature))
    ? t("summary.measured", { measured: formatTemperature(measuredTemperature), feels: formatTemperature(current.apparent_temperature) })
    : t("summary.estimated", { temp: formatTemperature(current.temperature_2m), feels: formatTemperature(current.apparent_temperature) });
  // One sentence for the whole decision: sky, temperature, rain. Timing detail
  // lives in the rain section instead of being repeated here.
  const sky = localizedWeatherLabel(lang, current.weather_code);
  elements["decision-summary"].textContent = `${sky}. ${temperatureSummary} ${rain.headline}`;
  renderYesterdayComparison();
  renderSunSummary();
}

function renderYesterdayComparison() {
  const target = elements["summary-comparison"];
  target.textContent = "";
  target.hidden = true;
  const index = currentHourIndex();
  if (index < 24) return;
  const yesterday = toFiniteNumber(latestWeather.hourly.temperature_2m[index - 24]);
  const now = toFiniteNumber(latestWeather.current.temperature_2m);
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
  const row = elements["sun-summary-row"];
  target.textContent = "";
  row.hidden = true;
  const daily = latestWeather.daily;
  if (!daily?.sunrise) return;
  const todayIndex = daily.time.indexOf(todayDateString());
  if (todayIndex < 0) return;
  const offset = latestWeather.utc_offset_seconds;
  const sunriseEpoch = localIsoToEpoch(daily.sunrise[todayIndex], offset);
  const sunsetEpoch = localIsoToEpoch(daily.sunset[todayIndex], offset);
  const sunrise = formatTime(sunriseEpoch);
  const sunset = formatTime(sunsetEpoch);
  const daylight = formatDuration(daily.daylight_duration?.[todayIndex]);
  if (!daylight) return;
  target.textContent = t("summary.sun", { sunrise, sunset, daylight });
  const fraction = (Date.now() - sunriseEpoch) / (sunsetEpoch - sunriseEpoch);
  elements["sun-arc"].innerHTML = sunArcSvg(Math.max(0, Math.min(1, fraction)));
  row.hidden = false;
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
    [t("value.wind"), formatWindWithDirection(current.wind_speed_10m, current.wind_direction_10m), windArrowElement(current.wind_direction_10m)],
    [t("value.gusts"), formatSpeed(current.wind_gusts_10m)],
    [t("value.pressure"), `${formatNumber(current.pressure_msl, 0)} hPa`],
    [t("value.cloudCover"), `${formatNumber(current.cloud_cover, 0)}%`]
  ];
  if (Number.isFinite(toFiniteNumber(uvNow))) {
    const uvKey = uvRatingKey(Number(uvNow));
    rows.push([t("value.uvNow"), t("uv.display", { value: formatNumber(uvNow, 1), rating: t(uvKey) }), ratingDot(UV_RATING_TIER[uvKey])]);
  }
  rows.push([t("value.conditions"), localizedWeatherLabel(lang, current.weather_code)]);
  renderDefinitionList(elements["current-values"], rows);

  const observationSource = latestObservation?.sourceType ?? null;
  elements["kmi-credit"].hidden = observationSource !== "kmi";
  elements["metar-credit"].hidden = observationSource !== "metar";
  // With no measured block on screen there is nothing to tell it apart from.
  elements["model-heading"].hidden = !latestObservation;
  if (!latestObservation) {
    elements["measured-observation"].hidden = true;
    return;
  }

  const ageMinutes = Math.max(0, Math.round((Date.now() - Date.parse(latestObservation.timestamp)) / 60_000));
  const descriptionKey = observationSource === "metar" ? "station.metar.description" : "station.description";
  elements["station-description"].textContent = t(descriptionKey, {
    name: titleCase(latestObservation.name),
    distance: formatDistance(latestObservation.distanceKm),
    minutes: ageMinutes
  });
  renderDefinitionList(elements["measured-values"], [
    [t("value.temperature"), formatTemperature(latestObservation.temperatureC)],
    [t("value.humidity"), formatOptional(latestObservation.humidityPercent, (value) => `${formatNumber(value, 0)}%`)],
    [t("value.wind"), formatOptional(latestObservation.windSpeedKmh, (value) => formatWindWithDirection(value, latestObservation.windDirectionDegrees)), windArrowElement(latestObservation.windDirectionDegrees)],
    [t("value.gusts"), formatOptional(latestObservation.windGustKmh, (value) => formatSpeed(value))],
    [t("value.pressure"), formatOptional(latestObservation.pressureHpa, (value) => `${formatNumber(value, 0)} hPa`)],
    [t("value.recentRain"), formatOptional(latestObservation.precipitationMm, (value) => formatPrecipitation(value))]
  ]);
  elements["measured-observation"].hidden = false;
}

function renderRain() {
  const isRadar = latestRain.source === "radar";
  const decision = summarizeRain(latestRain.points, { nowEpoch: Date.now() });
  const summary = formatRainSummary(lang, decision, formatTime, latestRain.source);
  // The hero already carries the headline, so this section only adds timing
  // detail, and says nothing at all when there is no rain to time.
  const hasTiming = decision.kind === "raining" || decision.kind === "upcoming";
  elements["rain-summary"].textContent = hasTiming ? summary.detail : "";
  elements["rain-summary"].hidden = !hasTiming;
  elements["rain-source-badge"].textContent = t(isRadar ? "rain.badge.radar" : "rain.badge.model");
  elements["rain-detail-intro"].textContent = t(isRadar ? "rain.intro.radar" : "rain.intro.model");
  elements["buienradar-credit"].hidden = latestRain.provider !== "buienradar";
  elements["metno-credit"].hidden = latestRain.provider !== "metno";
  elements["dwd-credit"].hidden = latestRain.provider !== "dwd";

  elements["rain-visual"].replaceChildren();
  elements["rain-timeline"].replaceChildren();
  const hasVisibleRain = latestRain.points.some((point) => toFiniteNumber(point.mmPerHour) > 0.01);
  elements["rain-visual"].hidden = !hasVisibleRain;
  const max = Math.max(1, ...latestRain.points.map((point) => point.mmPerHour));
  for (const point of latestRain.points) {
    if (hasVisibleRain) {
      const bar = document.createElement("span");
      bar.className = `rain-bar${point.mmPerHour >= 3 ? " heavy" : ""}`;
      bar.style.height = `${Math.max(4, Math.min(100, (point.mmPerHour / max) * 100))}%`;
      elements["rain-visual"].append(bar);
    }

    const item = document.createElement("li");
    const isDry = point.mmPerHour < 0.05;
    item.textContent = isDry
      ? t("rain.timelineItemDry", { time: formatTime(point.time), intensity: t(intensityKey(point.mmPerHour)) })
      : t("rain.timelineItem", {
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
  const available = latestWeather.hourly.time
    .map((time, index) => ({ index, epoch: localIsoToEpoch(time, offset) }))
    .filter(({ epoch }) => epoch >= now)
    .slice(0, 24);
  const indices = hourlyExpanded ? available : available.slice(0, 12);

  for (const { index, epoch } of indices) {
    const item = document.createElement("li");
    const hourly = latestWeather.hourly;
    const isDay = Number(hourly.is_day?.[index] ?? 1) !== 0;
    const rainMm = Number(hourly.precipitation[index] ?? 0);
    const chancePercent = Number(hourly.precipitation_probability[index] ?? 0);
    const headline = t("hourly.headline", {
      time: formatTime(epoch),
      conditions: localizedWeatherLabel(lang, hourly.weather_code[index])
    });
    // "Feels like" only earns its words when it differs from the reading.
    const temperature = toFiniteNumber(hourly.temperature_2m[index]);
    const apparent = toFiniteNumber(hourly.apparent_temperature[index]);
    const notable = Number.isFinite(temperature) && Number.isFinite(apparent) && Math.abs(apparent - temperature) >= 1.5;
    const wet = rainMm >= 0.05;
    const metaKey = notable
      ? (wet ? "hourly.meta" : "hourly.metaNoAmount")
      : (wet ? "hourly.metaPlain" : "hourly.metaPlainNoAmount");
    const meta = t(metaKey, {
      temp: formatTemperature(hourly.temperature_2m[index]),
      feels: formatTemperature(hourly.apparent_temperature[index]),
      chance: formatNumber(chancePercent, 0),
      amount: formatPrecipitation(rainMm),
      wind: formatSpeed(hourly.wind_speed_10m[index]),
      gusts: formatSpeed(hourly.wind_gusts_10m[index])
    });
    appendForecastItem(item, hourly.weather_code[index], isDay, headline, meta, chancePercent);
    elements["hourly-list"].append(item);
  }

  const remaining = available.length - indices.length;
  elements["hourly-more-button"].hidden = remaining === 0 && !hourlyExpanded;
  elements["hourly-more-button"].setAttribute("aria-expanded", String(hourlyExpanded));
  elements["hourly-more-button"].textContent = t(hourlyExpanded ? "hourly.showFewer" : "hourly.showMore", { count: remaining });
}

function renderDaily() {
  elements["daily-list"].replaceChildren();
  const today = todayDateString();
  const daily = latestWeather.daily;
  const availableDays = daily.time
    .map((date, index) => ({ date, index }))
    .filter(({ date, index }) => date >= today && Number.isFinite(toFiniteNumber(daily.temperature_2m_max[index])));
  const visibleDays = dailyExpanded ? availableDays : availableDays.slice(0, 7);

  visibleDays.forEach(({ date, index }, position) => {
    const item = document.createElement("li");
    let day;
    if (date === today) day = t("daily.today");
    else if (isTomorrow(date, today)) day = t("daily.tomorrow");
    else day = formatDay(date);
    const offset = latestWeather.utc_offset_seconds;
    const uvValue = daily.uv_index_max?.[index];
    const rainMm = Number(daily.precipitation_sum[index] ?? 0);
    const chancePercent = Number(daily.precipitation_probability_max[index] ?? 0);
    const headline = t("daily.headline", { day, conditions: localizedWeatherLabel(lang, daily.weather_code[index]) });
    // Sun times shift by a minute a day, so only today and tomorrow carry them.
    const near = position <= 1;
    const wet = rainMm >= 0.05;
    const metaKey = near
      ? (wet ? "daily.meta" : "daily.metaNoAmount")
      : (wet ? "daily.metaShort" : "daily.metaShortNoAmount");
    const meta = t(metaKey, {
      high: formatTemperature(daily.temperature_2m_max[index]),
      low: formatTemperature(daily.temperature_2m_min[index]),
      chance: formatNumber(chancePercent, 0),
      amount: formatPrecipitation(rainMm),
      uv: Number.isFinite(toFiniteNumber(uvValue))
        ? t("uv.display", { value: formatNumber(uvValue, 1), rating: t(uvRatingKey(Number(uvValue))) })
        : t("value.notReported"),
      sunrise: formatTime(localIsoToEpoch(daily.sunrise[index], offset)),
      sunset: formatTime(localIsoToEpoch(daily.sunset[index], offset))
    });
    appendForecastItem(item, daily.weather_code[index], true, headline, meta, chancePercent);
    elements["daily-list"].append(item);
  });

  const remaining = Math.max(0, availableDays.length - 7);
  elements["daily-more-button"].hidden = remaining === 0;
  elements["daily-more-button"].setAttribute("aria-expanded", String(dailyExpanded));
  elements["daily-more-button"].textContent = t(dailyExpanded ? "daily.showFewer" : "daily.showMore", { count: remaining });
}

// Screen readers should land on a forecast row once and hear the whole line.
// The visual layer (icon, chance chip, two text rows) is hidden from them and
// replaced by one off-screen sentence. It has to be real text: VoiceOver skips
// a list item whose only name is an attribute and whose content is hidden.
function appendForecastItem(item, code, isDay, headline, meta, chancePercent) {
  item.append(iconElement(document, code, isDay));
  const text = document.createElement("span");
  text.className = "forecast-text";
  text.setAttribute("aria-hidden", "true");

  const topRow = document.createElement("span");
  topRow.className = "forecast-top-row";
  const headlineEl = document.createElement("span");
  headlineEl.className = "forecast-headline";
  headlineEl.textContent = headline;
  topRow.append(headlineEl);
  const chip = Number.isFinite(chancePercent) ? rainChanceChip(chancePercent) : null;
  if (chip) topRow.append(chip);

  const metaEl = document.createElement("span");
  metaEl.className = "forecast-meta";
  metaEl.textContent = meta;

  text.append(topRow, metaEl);

  const spoken = document.createElement("span");
  spoken.className = "visually-hidden";
  spoken.textContent = `${headline} ${meta}`;
  item.append(text, spoken);
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
  const euAqi = toFiniteNumber(current.european_aqi);
  const usAqi = toFiniteNumber(current.us_aqi);
  if (Number.isFinite(euAqi)) {
    const euKey = europeanAqiRatingKey(euAqi);
    rows.push([t("air.aqiEuropean"), t("air.display", { value: formatNumber(euAqi, 0), rating: t(euKey) }), ratingDot(AQI_RATING_TIER[euKey])]);
  } else if (Number.isFinite(usAqi)) {
    const usKey = usAqiRatingKey(usAqi);
    rows.push([t("air.aqiUs"), t("air.display", { value: formatNumber(usAqi, 0), rating: t(usKey) }), ratingDot(AQI_RATING_TIER[usKey])]);
  }
  const pollutants = [
    ["air.pm25", current.pm2_5],
    ["air.pm10", current.pm10],
    ["air.ozone", current.ozone],
    ["air.no2", current.nitrogen_dioxide]
  ];
  for (const [key, value] of pollutants) {
    if (Number.isFinite(toFiniteNumber(value))) rows.push([t(key), `${formatNumber(value, 0)} µg/m³`]);
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
    if (Number.isFinite(toFiniteNumber(value))) {
      rows.push([t(key), t("unit.pollenDensity", { value: formatNumber(value, 0) })]);
    }
  }

  if (!rows.length) {
    section.hidden = true;
    return;
  }
  renderDefinitionList(elements["air-values"], rows);
  section.hidden = false;
}

function renderAnalysis() {
  renderEnsembleAnalysis();
  renderModelAnalysis();
  renderClimateAnalysis();
  renderAtmosphereAnalysis();
  renderMoonAnalysis();
  if (latestAnalysis.loading) {
    elements["deep-status"].textContent = t("status.deepLoading", { name: currentLocation.name });
    elements["deep-status"].hidden = false;
  }
}

function renderEnsembleAnalysis() {
  const days = latestAnalysis.ensemble;
  if (!Array.isArray(days) || !days.length) {
    elements["ens-card"].hidden = true;
    return;
  }

  elements["ens-note"].textContent = t("ens.note", { count: days[0].members });
  const list = document.createElement("ul");
  list.className = "analysis-list";
  for (const day of days) {
    const item = document.createElement("li");
    appendAnalysisSentence(item, t("ens.temp", {
      day: formatDay(day.date),
      median: formatTemperature(day.highMedian),
      low: formatTemperature(day.highP10),
      high: formatTemperature(day.highP90)
    }));
    appendAnalysisSentence(item, t("ens.rain", {
      day: formatDay(day.date),
      wet: day.wetMembers,
      count: day.members,
      pct: day.wetPercent
    }));
    list.append(item);
  }
  elements["ens-body"].replaceChildren(list);
  elements["ens-card"].hidden = false;
}

function renderModelAnalysis() {
  const comparison = latestAnalysis.models;
  if (!comparison?.models?.length) {
    elements["models-card"].hidden = true;
    return;
  }

  elements["models-note"].textContent = t("models.note", {
    date: formatDay(comparison.date),
    count: comparison.models.length
  });
  const list = document.createElement("ul");
  list.className = "analysis-list compact";
  const countryKeys = {
    ecmwf_ifs025: "models.country.ecmwf",
    icon_seamless: "models.country.icon",
    gfs_seamless: "models.country.gfs"
  };
  for (const model of comparison.models) {
    const item = document.createElement("li");
    let rain = t("value.notReported");
    if (model.rain !== null) {
      rain = model.rain < 0.05
        ? t("models.dry")
        : t("models.rain", { amount: formatPrecipitation(model.rain) });
    }
    item.textContent = t("models.line", {
      model: model.label,
      country: t(countryKeys[model.id]),
      high: formatTemperature(model.high),
      rain
    });
    list.append(item);
  }
  const verdict = document.createElement("p");
  verdict.className = "analysis-verdict";
  verdict.textContent = t(`models.agree.${comparison.agreement}`);
  elements["models-body"].replaceChildren(list, verdict);
  elements["models-card"].hidden = false;
}

function renderClimateAnalysis() {
  const climate = latestAnalysis.climate;
  if (!climate) {
    elements["climate-card"].hidden = true;
    return;
  }

  const today = todayDateString();
  const todayIndex = latestWeather?.daily?.time?.indexOf(today) ?? -1;
  const forecastHigh = todayIndex >= 0
    ? toFiniteNumber(latestWeather.daily.temperature_2m_max?.[todayIndex])
    : Number.NaN;
  const paragraphs = [];
  paragraphs.push(t("climate.normal", {
    high: formatTemperature(climate.normalHigh),
    low: formatTemperature(climate.normalLow)
  }));
  if (Number.isFinite(forecastHigh)) {
    const difference = forecastHigh - climate.normalHigh;
    const key = Math.abs(difference) < 1
      ? "climate.near"
      : (difference > 0 ? "climate.above" : "climate.below");
    paragraphs.push(t(key, { amount: formatTemperatureDelta(Math.abs(difference)) }));
  }
  paragraphs.push(t("climate.records", {
    date: formatDay(today),
    endYear: climate.dataEndYear,
    high: formatTemperature(climate.recordHigh),
    highYear: climate.recordHighYear,
    low: formatTemperature(climate.recordLow),
    lowYear: climate.recordLowYear
  }));

  elements["climate-note"].textContent = t("climate.note", { endYear: climate.dataEndYear });
  elements["climate-body"].replaceChildren(...paragraphs.map(analysisParagraph));
  elements["climate-card"].hidden = false;
}

function renderAtmosphereAnalysis() {
  const atmosphere = latestAnalysis.atmosphere;
  if (!atmosphere) {
    elements["atmos-card"].hidden = true;
    return;
  }

  const rows = [];
  if (atmosphere.cape !== null) {
    rows.push([t("atmos.cape"), t("atmos.capeValue", {
      value: formatNumber(atmosphere.cape, 0),
      rating: t(capeRatingKey(atmosphere.cape))
    })]);
  }
  if (atmosphere.liftedIndex !== null) {
    rows.push([t("atmos.li"), t("atmos.liValue", {
      value: formatNumber(atmosphere.liftedIndex, 1),
      rating: t(liftedIndexRatingKey(atmosphere.liftedIndex))
    })]);
  }
  if (atmosphere.freezingLevelM !== null) {
    rows.push([t("atmos.freezing"), formatHeight(atmosphere.freezingLevelM)]);
  }
  if (atmosphere.visibilityM !== null) {
    rows.push([t("atmos.visibility"), formatDistance(atmosphere.visibilityM / 1000)]);
  }
  if ([atmosphere.cloudLow, atmosphere.cloudMid, atmosphere.cloudHigh].every((value) => value !== null)) {
    rows.push([t("atmos.clouds"), t("atmos.cloudsValue", {
      low: formatNumber(atmosphere.cloudLow, 0),
      mid: formatNumber(atmosphere.cloudMid, 0),
      high: formatNumber(atmosphere.cloudHigh, 0)
    })]);
  }
  if (atmosphere.wetBulbC !== null) {
    rows.push([t("atmos.wetBulb"), formatTemperature(atmosphere.wetBulbC)]);
  }
  if (atmosphere.pressureHpa !== null && atmosphere.pressureDelta3h !== null) {
    rows.push([t("atmos.pressureTrend"), t("atmos.pressureValue", {
      value: formatNumber(atmosphere.pressureHpa, 0),
      trend: t(pressureTrendKey(atmosphere.pressureDelta3h)),
      delta: formatNumber(Math.abs(atmosphere.pressureDelta3h) < 0.05 ? 0 : atmosphere.pressureDelta3h, 1)
    })]);
  }

  if (!rows.length) {
    elements["atmos-card"].hidden = true;
    return;
  }
  renderDefinitionList(elements["atmos-values"], rows);
  const showPeak = atmosphere.capePeak !== null
    && atmosphere.capePeakTime
    && atmosphere.capePeak >= 300
    && atmosphere.capePeak > (atmosphere.cape ?? 0) + 50;
  elements["atmos-peak"].hidden = !showPeak;
  if (showPeak) {
    const peakEpoch = localIsoToEpoch(atmosphere.capePeakTime, latestWeather.utc_offset_seconds);
    elements["atmos-peak"].textContent = t("atmos.capePeak", {
      time: formatTime(peakEpoch),
      value: formatNumber(atmosphere.capePeak, 0)
    });
  }
  elements["atmos-card"].hidden = false;
}

function renderMoonAnalysis() {
  if (!latestWeather) {
    elements["moon-card"].hidden = true;
    return;
  }
  const moon = moonPhase();
  const current = analysisParagraph(t("moon.now", {
    phase: t(MOON_PHASE_KEYS[moon.phaseIndex]),
    pct: Math.round(moon.illumination * 100)
  }));
  const next = analysisParagraph(t("moon.next", {
    full: formatCalendarDate(moon.nextFullMs),
    new: formatCalendarDate(moon.nextNewMs)
  }));
  elements["moon-body"].replaceChildren(current, next);
  elements["moon-card"].hidden = false;
}

function analysisParagraph(text) {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  return paragraph;
}

function appendAnalysisSentence(parent, text) {
  parent.append(analysisParagraph(text));
}

function renderDefinitionList(list, values) {
  list.replaceChildren();
  for (const [term, description, decoration] of values) {
    const wrapper = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    if (decoration) {
      dd.append(decoration, document.createTextNode(` ${description}`));
    } else {
      dd.textContent = description;
    }
    wrapper.append(dt, dd);
    list.append(wrapper);
  }
}

// Rating word -> colour-tier class, low/good at tier-1 through worst at tier-5/6.
// Colour is always paired with the existing rating word, never used alone.
const UV_RATING_TIER = {
  "uv.rating.low": "tier-1",
  "uv.rating.moderate": "tier-2",
  "uv.rating.high": "tier-3",
  "uv.rating.veryHigh": "tier-4",
  "uv.rating.extreme": "tier-5"
};
const AQI_RATING_TIER = {
  "air.rating.good": "tier-1",
  "air.rating.fair": "tier-2",
  "air.rating.moderate": "tier-3",
  "air.rating.poor": "tier-4",
  "air.rating.veryPoor": "tier-5",
  "air.rating.extremelyPoor": "tier-6"
};

function ratingDot(tierClass) {
  if (!tierClass) return null;
  const dot = document.createElement("span");
  dot.className = `rating-dot ${tierClass}`;
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

function windArrowElement(degrees) {
  if (!Number.isFinite(Number(degrees))) return null;
  const span = document.createElement("span");
  span.className = "wind-arrow-holder";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = windArrowSvg();
  span.style.transform = `rotate(${(Number(degrees) + 180) % 360}deg)`;
  return span;
}

function rainChanceTier(percent) {
  if (percent >= 70) return "tier-high";
  if (percent >= 40) return "tier-medium";
  return "tier-low";
}

function rainChanceChip(percent) {
  if (!Number.isFinite(percent) || percent < 10) return null;
  const chip = document.createElement("span");
  chip.className = `rain-chip ${rainChanceTier(percent)}`;
  chip.setAttribute("aria-hidden", "true");
  chip.innerHTML = dropletSvg();
  const value = document.createElement("span");
  value.className = "rain-chip-value";
  value.textContent = `${Math.round(percent)}%`;
  chip.append(value);
  return chip;
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
    // A saved place is a pin, not a live fix: drop the GPS bookkeeping so
    // picking it again never re-points the app at wherever you are now.
    saved.push(pinnedLocation(currentLocation));
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
  elements["save-location-button"].setAttribute(
    "aria-label",
    t(saved ? "action.unsaveLabel" : "action.saveLabel", { name: currentLocation.name })
  );
}

function renderActionLabels() {
  elements["refresh-button"].setAttribute("aria-label", t("action.refreshLabel", { name: currentLocation.name }));
  elements["share-button"].setAttribute("aria-label", t("action.shareLabel", { name: currentLocation.name }));
}

async function shareWeather() {
  const text = [
    elements["decision-summary"].textContent,
    elements["summary-comparison"].hidden ? "" : elements["summary-comparison"].textContent
  ].filter(Boolean).join(" ").trim();
  const title = t("share.title", { name: currentLocation.name });
  try {
    if (navigator.share) {
      await navigator.share({ title, text });
      announce(t("status.shared"));
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(`${title}. ${text}`);
      announce(t("status.copied"));
    } else {
      showError(t("error.share"));
    }
  } catch (error) {
    if (error.name !== "AbortError") showError(t("error.share"));
  }
}

function forgetSettings() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CLIMATE_STORAGE_KEY);
  climateCache.clear();
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
  // Metric and Celsius for everyone; visitors who want imperial can switch.
  return {
    language: "auto",
    temperatureUnit: "celsius",
    windUnit: "kmh",
    precipitationUnit: "mm",
    savedLocations: [],
    lastLocation: DEFAULT_LOCATION,
    notifications: { enabled: false, locationName: null, briefingHour: null }
  };
}

function migrateLocation(location) {
  if (!location || typeof location !== "object") return null;
  if (location.source || !LEGACY_GPS_NAMES.has(location.name)) return location;
  return { ...location, name: coordinateLabel(location), detail: null, source: "gps", accuracyM: null, fixedAt: null };
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
      lastLocation: migrateLocation(parsed.lastLocation) ?? DEFAULT_LOCATION,
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
  briefingRow.hidden = !active;
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
      elements["notif-heading"].focus();
      return;
    }
    const subscription = await ensurePushSubscription();
    await postSubscription(subscription);
    settings.notifications.enabled = true;
    settings.notifications.locationName = currentLocation.name;
    persistSettings();
    renderNotifications();
    elements["notif-heading"].focus();
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
    elements["notif-heading"].focus();
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

// Number(null) is 0, so missing values need an explicit null check before
// any "is this finite" test, or nulls render as zeroes.
function toFiniteNumber(value) {
  return value == null || value === "" ? Number.NaN : Number(value);
}

function formatNumber(value, digits) {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(Number(value));
}

function formatTemperature(celsius) {
  if (!Number.isFinite(toFiniteNumber(celsius))) return t("value.notReported");
  if (settings.temperatureUnit === "fahrenheit") return `${formatNumber(Number(celsius) * 9 / 5 + 32, 1)}°F`;
  return `${formatNumber(Number(celsius), 1)}°C`;
}

function formatTemperatureDelta(deltaCelsius) {
  const digits = 1;
  if (settings.temperatureUnit === "fahrenheit") return `${formatNumber(deltaCelsius * 9 / 5, digits)}°F`;
  return `${formatNumber(deltaCelsius, digits)}°C`;
}

function formatSpeed(kmh) {
  if (!Number.isFinite(toFiniteNumber(kmh))) return t("value.notReported");
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
  if (!Number.isFinite(toFiniteNumber(kmh))) return t("value.notReported");
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

// GPS accuracy is a radius of a few metres to a few hundred, so metres are the
// only unit that says anything useful.
function formatAccuracy(meters) {
  const value = Number(meters);
  if (settings.precipitationUnit === "inch") {
    const feet = value * 3.28084;
    if (feet < 1000) return `${formatNumber(feet, 0)} ft`;
    return `${formatNumber(feet / 5280, 1)} mi`;
  }
  if (value < 1000) return `${formatNumber(value, 0)} m`;
  return `${formatNumber(value / 1000, 1)} km`;
}

function formatHeight(meters) {
  if (settings.precipitationUnit === "inch") {
    return `${formatNumber(meters * 3.28084, 0)} ft`;
  }
  return `${formatNumber(meters, 0)} m`;
}

function formatPrecipitation(mm) {
  if (!Number.isFinite(toFiniteNumber(mm))) return t("value.notReported");
  if (settings.precipitationUnit === "inch") return `${formatNumber(Number(mm) / 25.4, 2)} in`;
  return `${formatNumber(Number(mm), Number(mm) < 10 ? 1 : 0)} mm`;
}

function formatIntensity(mmPerHour) {
  if (settings.precipitationUnit === "inch") return `${formatNumber(mmPerHour / 25.4, 2)} in/h`;
  return `${formatNumber(mmPerHour, mmPerHour < 10 ? 1 : 0)} mm/h`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(toFiniteNumber(seconds))) return null;
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

function formatCalendarDate(epoch) {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: currentLocation.timezone || latestWeather?.timezone || undefined
  }).format(epoch);
}

function formatOptional(value, formatter) {
  if (!Number.isFinite(toFiniteNumber(value))) return t("value.notReported");
  return formatter(Number(value));
}

function pinnedLocation(location) {
  return {
    name: location.name,
    detail: location.detail ?? null,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: location.timezone ?? null,
    countryCode: location.countryCode ?? null
  };
}

function locationLabel(location) {
  return [location.name, location.detail].filter(Boolean).join(", ");
}

function coordinateLabel(location) {
  return `${Number(location.latitude).toFixed(4)}, ${Number(location.longitude).toFixed(4)}`;
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
  elements["forecast-content"].setAttribute("aria-busy", String(busy));
  elements["refresh-button"].disabled = busy || !latestWeather;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
}
