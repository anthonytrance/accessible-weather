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

## Future ideas (not this pass)

- Official severe-weather warnings via MeteoAlarm CAP feeds (per-country formats, likely need worker proxying and caching; research first).
- More KMI station fields; historical "this day last year"; moon phase; visibility.
- More languages (the i18n table makes this cheap).

## Status

ALL of the numbered scope above LANDED and DEPLOYED on 2026-07-18 (21/21 tests green, live at accessible-weather.pitch-363.workers.dev). VAPID secrets are set on the Worker (regenerated once because a PowerShell pipe BOM'd the first pair; always pipe secrets from a POSIX shell). The push subscribe/pending/unsubscribe endpoints were verified live. Real-device push (Anthony's phone) not yet exercised; that is the remaining validation step, plus the Future ideas list.
