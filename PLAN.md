# Accessible Weather — big upgrade pass (2026-07-18)

Anthony's brief: don't just add decimals. Look at everything, make it genuinely better, invent features he'd like, keep it blind-first with a great screen reader experience AND aesthetically pleasing, make it fully international, add notifications, make it a weather app worth using daily anywhere on earth.

## Project state (context for a fresh session)

- App lives in `C:\Users\Anthony\codetest\accessible-weather`, deployed at https://accessible-weather.pitch-363.workers.dev/ via `npm run deploy:cloudflare`.
- Cloudflare Worker (`src/worker.js`) serves static `dist/` assets, proxies KMI Belgian observations (cron every 10 min → KV `KMI_DATA` → `/api/kmi`).
- Browser calls Open-Meteo (forecast + geocoding) and Buienradar (BE/NL rain nowcast) directly.
- Tests: `npm test` (node --test, jsdom + axe-core). Build: `npm run build` (copies files to dist).

## Scope of this pass — all being implemented now

1. Decimal temperatures everywhere (obs, current, hourly, daily), imperial too. One decimal, always printed, predictable for screen readers.
2. Full internationalization: language picker + auto-detect (English, Dutch, French, German, Spanish). New `i18n.js` with every UI string, dynamic sentence templates, weather-code labels, compass names, rain intensity words, Beaufort names. `document.documentElement.lang` follows. Dates/times formatted in the chosen language via Intl. Geocoding search uses chosen language. First-run unit defaults from locale (US → imperial).
3. Units as separate preferences: temperature (°C/°F), wind (km/h, mph, m/s, Beaufort), precipitation (mm, inches). Old `settings.units` migrated.
4. New weather data:
   - Sunrise, sunset, daylight length in daily forecast + today's hero.
   - UV index: daily max + current-hour value with plain-language rating.
   - Dew point at current hour (mugginess indicator).
   - "Compared to yesterday" line in the decision summary (Open-Meteo `past_days=1`, same-hour comparison). NOTE: with past_days=1, daily/hourly arrays start yesterday — renderDaily must skip past days.
   - Air quality + pollen section (Open-Meteo Air Quality API, `european_aqi`/`us_aqi`, PM2.5, PM10, ozone, pollen in Europe). Collapsible, hidden if the fetch fails.
5. Web push notifications (the marquee feature):
   - Rain alerts: worker cron checks each subscription's location every 10 min (Buienradar in coverage, Open-Meteo minutely elsewhere), pushes when rain is about to start; dedupe via per-subscription state in KV.
   - Daily briefing: optional, at a chosen local hour, with today's summary.
   - Architecture: VAPID ES256 JWT signed in the worker (WebCrypto); pushes are payload-free "tickles"; the service worker fetches `/api/push/pending?id=…` and calls `showNotification`. Avoids RFC 8291 payload encryption entirely.
   - Endpoints: POST `/api/push/subscribe`, POST `/api/push/unsubscribe`, GET `/api/push/pending`, GET `/api/push/vapid-public-key`. Subscriptions in KV as `push:{id}` (id = SHA-256 of endpoint), storing subscription, location, language, units, prefs, dedupe state.
   - Secrets: `VAPID_PUBLIC_KEY` (base64url raw P-256 point) and `VAPID_PRIVATE_KEY_JWK` via `wrangler secret put`. Contact `mailto:contact@xijaroandpitch.com` in JWT `sub`.
   - Notification text localized worker-side using the same i18n dictionaries (bundled).
   - Client UI: Notifications card; enable rain alerts for the currently shown location, briefing time select, disable button, status line; graceful messaging when push is unsupported (works on iOS only when installed to home screen).
6. Visual polish while keeping the sentence-first SR experience:
   - Inline SVG icon set (new `icons.js`): clear day/night, partly cloudy day/night, cloud, fog, drizzle, rain, heavy rain, snow, sleet, thunder. All `aria-hidden`, used in hero, hourly and daily items.
   - Hourly/daily items get visual structure (time and temps emphasized) without changing the read-aloud sentence order.
   - Refined palette, hero gradient, card hierarchy; dark mode kept.
7. Share button: navigator.share of the decision summary, clipboard fallback.
8. sw.js: push + notificationclick handlers, cache list includes i18n.js and icons.js, cache name bumped.
9. Tests: update those that assert whole degrees or English strings; add i18n key-parity test and push helper tests.
10. README + this file updated; build, test, deploy to Cloudflare; git commit.

## Follow-up pass, 2026-07-18 evening (landed, commits 2e7ccf0 + 7718277)

- Long-range forecast extended to 16 days (Open-Meteo maximum).
- Page shortened: air quality, notifications, preferences and sources are collapsible details sections; tighter mobile spacing; tagline hidden on phones. Anthony chose collapsibles over separate pages.
- New-visitor defaults are always metric/Celsius (US-locale imperial detection removed).

## Global pass, 2026-07-18 late (LANDED, deployed)

- Worldwide live observations: Worker `/api/obs` proxies NOAA aviationweather.gov METAR (keyless), converts to the KMI schema (`src/obs.js`, RH derived from dewpoint via Magnus), caches 8 min on a 0.5° grid. Client shows nearest airport station within 150 km wherever KMI doesn't apply; KMI still wins in Belgium with METAR as fallback.
- Nordic radar nowcast: Worker `/api/nowcast` proxies MET Norway Nowcast 2.0 (needs UA header, hence proxy; `src/nowcast.js`), 404 outside radar coverage → client falls back to Open-Meteo model. Verified live: Oslo/Copenhagen/Helsinki radar yes, Riga/Tallinn/Paris no.
- Air quality confirmed already global (CAMS, both EAQI and US AQI worldwide; pollen stays Europe-only, a data limitation).
- New i18n keys station.metar.description / sources.metar / sources.metno in all 5 languages; new credits lis; 27 tests green.

## App-view redesign, 2026-07-18 late (LANDED, deployed, commit 0bc6087)

- Anthony approved tabs over collapsibles. Three views: Now (location + hero + rain + conditions), Forecast (hourly + 16-day stacked, inner sub-tabs removed), More (air, notifications, preferences, sources). One tablist renders as a fixed bottom bar on phones, segmented top bar on desktop. Collapsibles removed again.
- Same session fixed: null API values rendering as 0° (Number(null)===0 across all formatters, trailing empty forecast days now trimmed), clearer iOS location-permission error, wording coherence pass ("Updated {time}" not "Model time", terser hero/station sentences).

## Fix pass, 2026-07-19 (LANDED, deployed, commit af498e6)

- Briefing-hour bug (reported by Anthony: set 9, fired 8): formatHourLabel built labels from Date.UTC formatted in the browser zone, shifting labels by the UTC offset. Now a local Date. Worker localHour uses hourCycle h23. Anthony's KV subscription patched 8→9, but his localStorage still says 8: he must re-pick "Around 09:00" once, otherwise any later unit change re-posts 8.
- Stale-data bug: app now auto-reloads on visibilitychange/pageshow when data >5 min old, re-renders relative wording otherwise.
- Tabs verdict: three tabs stay; air quality moved to Now (it is weather, not settings); third tab renamed Settings (sliders icon) in all languages.
- NOTE: a separate session added commit e288423 (collapsible location picker in Now, compact daily list with "Show more days", dynamic aria-labels, wording compaction). Check app.js on disk before assuming structure.

## Analysis tab pass, 2026-07-18 (LANDED)

- Fourth tab, Analysis, deliberately leaves Now, Forecast and Settings uncluttered.
- Forecast confidence summarizes all 51 members of the global ECMWF IFS ensemble for three days: median high, central 80% range and member-based measurable-rain frequency.
- Tomorrow compares ECMWF, ICON and GFS, then states whether temperature and rain guidance agree.
- Climate context uses the fixed global ERA5 reanalysis from 1940 through the last complete year, with 1991-2020 normals and exact-date records. It does not mix changing historical model families.
- Atmosphere card adds CAPE, lifted index, freezing level, visibility, low/mid/high clouds, wet-bulb temperature, three-hour pressure trend and a meaningful next-24-hour CAPE peak.
- Moon phase, illumination, next full moon and next new moon are calculated locally.
- All network-heavy analysis calls are lazy and independent. They run only when Analysis is opened, failures hide only affected cards, and the main weather load remains unchanged.
- Complete in all five interface languages, four-tab keyboard behavior and screen-reader relationships tested. Test suite is 32/32 green.

## Radar research pass, 2026-07-19 (research + DWD landed, f6deef3)

Researched numeric point-query radar nowcast APIs (no tile decoding). Findings: Bright Sky /radar = real DWD RV composite, free, keyless, 0.01mm/5min units, 2h forecast, point query with distance=0 — LANDED as third radar region (conservative Germany box; grid edges read permanent zero so don't widen carelessly). Yahoo Japan weather API = real radar point nowcast for Japan, 60 min, free but needs a Yahoo Japan developer Client ID — NOT built, awaiting Anthony's decision. US: no free numeric radar nowcast point API exists (MRMS is GRIB/archives, NWS gridpoints are model, AccuWeather MinuteCast free tier only 50 calls/day, Tomorrow.io minutely is premium, Meteosource minutely paid, Pirate Weather minutely is HRRR model not radar, OWM minutely is a proprietary model blend). RainViewer stays the only radar route for US/global and means tile pixel sampling.

## Future ideas (not yet built)

- Official severe-weather warnings via MeteoAlarm CAP feeds (per-country formats, likely need worker proxying and caching; research first).
- More KMI station fields; historical "this day last year"; decoded raw METAR; coastal marine conditions.
- More languages (the i18n table makes this cheap).

## Declutter pass, 2026-07-19 (LANDED, deployed, commit 7093f8b)

- Anthony flagged the rain timeline as "numbered" clutter: `#rain-timeline` was the only list missing `list-style: none`, so it showed literal 1/2/3 markers. Fixed; replaced with a thin left-border rail.
- Rain timeline also dropped the redundant "dry, 0.0mm/h" wording, since the intensity word already says there's no rain; amount clause only prints when non-dry.
- Hourly/daily forecast cards were one run-on sentence (time, conditions, temp, feels, rain%, amount, wind all inline). Split into a bold headline (time + conditions) and a muted meta line (temp/feels/rain/wind), same words and order, purely a visual/typographic split — screen readers get the same content.
- Hourly/daily meta line drops the precipitation amount when it rounds to zero, keeping rain% (still informative) without repeated "0.0mm" noise across every dry hour/day.
- All 5 languages updated in lockstep, i18n key-parity test green, 34/34 suite green.

## Status

All completed passes above are live at accessible-weather.pitch-363.workers.dev. VAPID secrets are set on the Worker (regenerated once because a PowerShell pipe BOM'd the first pair; always pipe secrets from a POSIX shell). Push was exercised on Anthony's phone; the follow-up fixed the one-hour briefing-label shift. The current suite is 32/32 green.
