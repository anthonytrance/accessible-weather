# Weather

A blind-first, installable weather website for precise current conditions and short-term rain timing. It is deployed as a static Cloudflare Worker at [accessible-weather.pitch-363.workers.dev](https://accessible-weather.pitch-363.workers.dev/), requires no account, and stores preferences only in the visitor's browser.

## What it does

- Searches towns and postal codes worldwide, in the interface language.
- Uses browser GPS only after the visitor presses the location button.
- Leads with a short decision-oriented summary suitable for a screen reader, including how today compares to yesterday and today's sunrise, sunset and daylight length.
- Speaks five languages (English, Dutch, French, German, Spanish), auto-detected with a manual override, covering every label, sentence, weather description, compass point and Beaufort name.
- Shows temperatures with one decimal everywhere, with locale-aware number formatting.
- Offers independent unit preferences: Celsius or Fahrenheit, wind in km/h, mph, m/s or Beaufort, precipitation in millimetres or inches.
- Provides radar-based five-minute rain nowcasts where radar data exists: Buienradar in the Benelux region and MET Norway in the Nordic region, falling back to Open-Meteo 15-minute model precipitation everywhere else.
- Shows real measured observations worldwide: preliminary KMI/IRM station observations in Belgium, and the nearest airport weather station (METAR, via the NOAA Aviation Weather Center) everywhere else, always with the station distance and observation age.
- Displays UV index, dew point, air quality (European AQI, particulates, ozone, NO2) and pollen for Europe.
- Keeps advanced data in a separate Analysis tab: 51-member ECMWF ensemble confidence, ECMWF/ICON/GFS comparison, 1991-2020 normals and records from global ERA5 reanalysis, CAPE, lifted index, freezing level, visibility, cloud layers, wet-bulb temperature, pressure trend and moon phase.
- Sends web push notifications: a rain alert shortly before rain starts at a chosen place, and an optional daily briefing at a chosen hour, in the chosen language and units.
- Has a share button, decorative weather icons that never replace spoken text, and can be installed as a progressive web app.

## Data architecture

The browser calls Open-Meteo (forecast, geocoding, air quality) and Buienradar directly. KMI's GeoServer does not currently send a browser CORS header, so the Cloudflare Worker reads its public WFS observation layers every ten minutes through a Cron Trigger, stores the snapshot in Workers KV and serves it from `/api/kmi`.

Two more Worker endpoints make the app global. `/api/obs` proxies METAR aviation observations from the NOAA Aviation Weather Center for a bounding box around the requested point, converts them to the KMI observation schema (including deriving relative humidity from the dewpoint), and caches results on a half-degree grid for eight minutes. `/api/nowcast` proxies MET Norway's radar Nowcast 2.0 (which requires an identifying User-Agent that browsers cannot send) and returns 404 outside radar coverage so the client falls back to the model nowcast.

Push notifications also live in the Worker. Subscriptions are stored in the same KV namespace (`push:{id}` where the id is the SHA-256 of the push endpoint). The cron job checks each subscription's location: Buienradar nowcast in coverage, Open-Meteo minutely model elsewhere, and queues a localized message under `pushmsg:{id}` before sending a payload-free, VAPID-signed push "tickle". The service worker then fetches `/api/push/pending` and shows the notification, which avoids Web Push payload encryption entirely. VAPID keys are Worker secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY_JWK`).

Open-Meteo's "current" conditions are model values, not station measurements. The interface labels that distinction explicitly.

The Analysis tab loads only when opened. Its forecast confidence comes from the Open-Meteo Ensemble API, the model comparison requests three independent global model families, and the climate card uses one consistent ERA5 series from 1940 through the last complete year. Failed analysis sources hide only their own cards, so they never delay or break the main weather views.

## Local use

Serve the directory over HTTP so location and service-worker behaviour match production. For example:

```powershell
python -m http.server 4173
```

Then open `http://localhost:4173`.

Run the dependency-free unit tests with:

```powershell
npm test
```

Refresh the checked-in KMI data with:

```powershell
npm run update-kmi
```

Build and deploy the static site and Worker to Cloudflare with:

```powershell
npm run deploy:cloudflare
```

To rotate the push keys, generate a P-256 pair, then pipe the raw base64url public key into `wrangler secret put VAPID_PUBLIC_KEY` and the private JWK JSON into `wrangler secret put VAPID_PRIVATE_KEY_JWK`. Pipe from a POSIX shell, not PowerShell, to avoid a UTF-8 BOM corrupting the secret. Existing subscriptions must re-subscribe after a rotation.

## Sources and licences

- Forecast, ensemble, model comparison, ERA5 reanalysis, geocoding and air quality: [Open-Meteo](https://open-meteo.com/), weather data under CC BY 4.0, air quality based on CAMS.
- Two-hour rain nowcast: [Buienradar.nl](https://www.buienradar.nl/overbuienradar/gratis-weerdata), noncommercial website use with attribution.
- Belgian station observations: [KMI/IRM Open Data](https://opendata.meteo.be/).

This project is intended as a personal, noncommercial website. Weather can change quickly, and official warnings should be used for safety-critical decisions.
