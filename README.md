# N-400 Processing Times

A small phone-friendly web app that shows current **USCIS N-400 (Application for
Naturalization) processing times** for every field office.

- **San Jose, CA** is pinned at the top as a hero card.
- A **US heat map** colors each field office by wait time (green = fast → red = slow).
- Every office is listed, sortable and searchable, with the **change since the
  previous update** (delta) shown next to each.
- A **Refresh** button reloads the latest data; a **manual-entry** panel lets you
  override any value on your device if the automatic data is stale.

The live page is a single static file (`index.html`) — perfect for GitHub Pages.

## Why there's a scraper

USCIS's processing-times site (`egov.uscis.gov/processing-times`) sits behind
**Cloudflare's Turnstile bot challenge**. A static web page can't fetch it directly
(cross-origin + the JS challenge), and plain HTTP clients get a `403`. So the data
is collected by a scraper that drives a **real Chrome** (via
[`puppeteer-real-browser`](https://www.npmjs.com/package/puppeteer-real-browser),
which solves Turnstile), reads the "80% of cases are completed within N months"
figure for each office, and writes it to **`data.json`**. The web app just reads
`data.json` from the same origin — no CORS, no live USCIS call.

## Updating the data

Processing times change roughly monthly. There are two ways to refresh `data.json`:

### 1. On your Mac (reliable)
Runs from your home IP, which Cloudflare trusts.

```bash
npm install            # first time only
npm run scrape         # writes data.json (opens a Chrome window briefly)
# then commit & push, or in one step:
npm run update         # scrape + commit + push
```

The scraper preserves the prior snapshot inside `data.json` (`previous`), which is
what powers the "delta since last update" shown in the app.

### 2. GitHub Action (best effort)
`.github/workflows/update.yml` runs daily and on demand ("Actions → Refresh N-400
processing times → Run workflow"), driving Chrome under a virtual display. Because
it runs from a datacenter IP, Cloudflare may sometimes block it — that's the
expected occasional failure. When it works it commits `data.json` automatically.

Either way, tapping **Refresh** in the app pulls the newest committed `data.json`.

### Trends over time

The app shows each office's processing time over time: a chart on the San Jose
card, a sparkline on every row, and a full chart (tap any row or map dot) with
the list of changes. The data comes from `history/offices.json`, which
`scraper/history.mjs` builds by folding every committed `data.json` (plus the
current one) into one snapshot per day. The Action and `npm run update` rebuild
it after each scrape; `npm run history` rebuilds it by hand. Trends ignore manual
overrides.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The whole app (UI, map, list, deltas, manual entry). |
| `data.json` | Latest scraped numbers + the previous snapshot for deltas. |
| `us-states-10m.json` | US base-map geometry (drawn with D3 `geoAlbersUsa`). |
| `scraper/scrape.mjs` | Node scraper that produces `data.json`. |
| `scraper/history.mjs` | Folds git history of `data.json` into `history/offices.json` (no network). |
| `history/offices.json` | Every office's processing time on every scraped date; feeds the trend charts. |
| `.github/workflows/update.yml` | Scheduled/manual refresh job. |

## Deploy (GitHub Pages)

Push this folder to a GitHub repo, then **Settings → Pages → Build and deployment →
Deploy from a branch → `main` / root**. The app will be at
`https://<user>.github.io/<repo>/`. Open that on your iPhone and **Add to Home
Screen** for an app-like icon.

## Notes

- Data is scraped from the official USCIS site but this project is **unofficial**
  and for reference only. Always confirm on
  [egov.uscis.gov/processing-times](https://egov.uscis.gov/processing-times/).
- The map uses D3 + TopoJSON from a CDN; the base-map geometry and data are served
  locally from the repo. US territory offices (GU, PR, VI) are listed below the map
  since `geoAlbersUsa` doesn't place them.
