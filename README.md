# Weather, clearly

A blind-first, installable weather website for precise current conditions and short-term rain timing. It is deployed as a static Cloudflare Worker at [accessible-weather.pitch-363.workers.dev](https://accessible-weather.pitch-363.workers.dev/), requires no account, and stores preferences only in the visitor's browser. GitHub Pages remains available as a fallback.

## What it does

- Searches towns and postal codes worldwide.
- Uses browser GPS only after the visitor presses the location button.
- Leads with a short decision-oriented summary suitable for a screen reader.
- Provides Buienradar five-minute rain nowcasts in its supported region.
- Falls back to Open-Meteo 15-minute model precipitation elsewhere.
- Shows preliminary KMI/IRM station observations in Belgium, including the station distance and observation age.
- Exposes detailed rain values as text, while keeping them collapsed until requested.
- Supports metric and imperial display units.
- Can be installed as a progressive web app.

## Data architecture

The browser calls Open-Meteo and Buienradar directly. KMI's GeoServer does not currently send a browser CORS header, so a scheduled GitHub Action reads its public WFS observation layers, converts them to a small JSON file, and redeploys the site when observations change.

GitHub can disable scheduled workflows in a public repository after 60 days without repository activity. The observation commits normally keep this repository active, but the KMI refresh workflow can also be re-enabled manually from GitHub Actions if necessary.

Open-Meteo's “current” conditions are model values, not station measurements. The interface labels that distinction explicitly.

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

Build and deploy the static site to Cloudflare with:

```powershell
npm run deploy:cloudflare
```

## Sources and licences

- Forecast and geocoding: [Open-Meteo](https://open-meteo.com/), weather data under CC BY 4.0.
- Two-hour rain nowcast: [Buienradar.nl](https://www.buienradar.nl/overbuienradar/gratis-weerdata), noncommercial website use with attribution.
- Belgian station observations: [KMI/IRM Open Data](https://opendata.meteo.be/).

This project is intended as a personal, noncommercial website. Weather can change quickly, and official warnings should be used for safety-critical decisions.
