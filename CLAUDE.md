# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, phone-friendly web app showing USCIS N-400 (naturalization) processing times per field office, plus a Node scraper that produces the data. No build step, no tests, no linter. The whole app is `index.html`; the data it renders is `data.json` in the repo root.

## Commands

```bash
npm install          # first time only (pulls puppeteer-real-browser etc.)
npm run scrape       # runs scraper/scrape.mjs -> writes data.json (opens a visible Chrome window)
npm run update       # scrape + git add/commit/push data.json in one step
ONLY=SNJ,SFR npm run scrape   # debug: limit to specific office codes
OUT=/tmp/x.json npm run scrape # write somewhere other than data.json
npm run sanjose               # scrape San Jose only, append to history/sanjose.json, print history chart
npm run sanjose -- --show     # print saved San Jose history without scraping
npm run sanjose -- --backfill # also import San Jose readings from git history of data.json
```

Scraper env vars: `CHROME_PATH`, `HEADLESS=true`, `DISABLE_XVFB=true`, `OUT`, `ONLY` (documented at the top of `scraper/scrape.mjs`).

To preview the app, serve the repo root over HTTP (e.g. `npx serve .` or `python3 -m http.server`). Opening `index.html` via `file://` fails because it `fetch`es `./data.json` and `./us-states-10m.json`.

## Architecture

**Data flow:** USCIS site → `scraper/scrape.mjs` → `data.json` (committed) → `index.html` fetches it at runtime from the same origin. The app never calls USCIS directly.

**Why a real-browser scraper:** `egov.uscis.gov/processing-times` sits behind Cloudflare Turnstile, so plain HTTP and headless stealth browsers get 403. The scraper uses `puppeteer-real-browser` to drive a real Chrome, then operates the site's SPA form (`#formName` → `#formCategory` (160A) → `#officeSc` → `#buttonGetProcessingTime`) once per office and regex-parses the "80% of cases are completed within N months" text. Weeks/days are normalized to months. Office names like "San Jose CA" are split into `city`/`state`.

**San Jose history (`scraper/sanjose.mjs` → `history/sanjose.json`):** `data.json` only keeps one prior snapshot, so long-run history otherwise lives only in git. This script spawns `scrape.mjs` with `ONLY=SNJ` and a temp `OUT`, merges the reading into `history/sanjose.json` (one entry per local date, newer timestamp wins), and prints a chart. It can also backfill from every commit of `data.json`.

**Delta tracking lives in `data.json`:** on each run the scraper reads the existing `data.json` and stores its `{updated, byCode}` under `previous` before overwriting. `index.html` uses `previous.byCode` to show the change since the last update; if `previous` is absent it falls back to a per-device baseline in `localStorage`.

**`index.html` structure:** one inline `<script>` holding
- `OFFICE_COORDS`: hard-coded `[lng, lat]` per USCIS office code, used to place dots on the D3 `geoAlbersUsa` map (geometry from `us-states-10m.json`). A new office code returned by the scraper needs an entry here or it won't appear on the map. GU/PR/VI offices are listed below the map since `geoAlbersUsa` can't project them.
- `SJ = 'SNJ'`: San Jose is pinned as the hero card and on top of the list.
- `localStorage` keys `n400.overrides` (manual per-office value overrides from the in-app form) and `n400.baseline` (fallback delta baseline). `effMonths(code)` applies overrides over scraped values everywhere in the UI.
- D3 and topojson-client are loaded from jsDelivr CDN; everything else is local.

**GitHub Action (`.github/workflows/update.yml`):** runs the scraper daily (and on `workflow_dispatch`) under Xvfb and commits `data.json` if it changed. Cloudflare may block the datacenter IP, so failures there are expected and not a bug; the reliable path is running `npm run scrape` locally.

## Conventions

- Data-only commits use the message `Update N-400 processing times (YYYY-MM-DD)`, matching what the Action produces.
- `data.json` is a generated artifact; edit it only via the scraper. Treat `months: null` as "USCIS showed no data for that office", which the UI renders as a dash.
- The scraper exits non-zero if zero offices yielded data, so the Action doesn't commit an empty snapshot.
