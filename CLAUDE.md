# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, phone-friendly web app showing USCIS N-400 (naturalization) processing times per field office, with each office's trend over time, plus a Node scraper that produces the data. No build step, no tests, no linter. The whole app is `index.html`; it reads `data.json` (latest snapshot) and `history/offices.json` (all snapshots) from the repo root.

## Commands

```bash
npm install          # first time only (pulls puppeteer-real-browser etc.)
npm run scrape       # runs scraper/scrape.mjs -> writes data.json (opens a visible Chrome window)
npm run history      # runs scraper/history.mjs -> rebuilds history/offices.json from git history + data.json (no network)
npm run update       # scrape + rebuild history + git add/commit/push both files
ONLY=SNJ,SFR npm run scrape   # debug: limit to specific office codes
OUT=/tmp/x.json npm run scrape # write somewhere other than data.json
```

Scraper env vars: `CHROME_PATH`, `HEADLESS=true`, `DISABLE_XVFB=true`, `OUT`, `ONLY` (documented at the top of `scraper/scrape.mjs`).

To preview the app, serve the repo root over HTTP (e.g. `npx serve .` or `python3 -m http.server`). Opening `index.html` via `file://` fails because it `fetch`es `./data.json`, `./history/offices.json` and `./us-states-10m.json`.

## Architecture

**Data flow:** USCIS site → `scraper/scrape.mjs` → `data.json` → `scraper/history.mjs` → `history/offices.json`. Both JSON files are committed; `index.html` fetches them at runtime from the same origin. The app never calls USCIS directly.

**Why a real-browser scraper:** `egov.uscis.gov/processing-times` sits behind Cloudflare Turnstile, so plain HTTP and headless stealth browsers get 403. The scraper uses `puppeteer-real-browser` to drive a real Chrome, then operates the site's SPA form (`#formName` → `#formCategory` (160A) → `#officeSc` → `#buttonGetProcessingTime`) once per office and regex-parses the "80% of cases are completed within N months" text. Weeks/days are normalized to months. Office names like "San Jose CA" are split into `city`/`state`. Three retries are built in because the site is flaky: the Turnstile clear is attempted on up to three fresh page loads, the form selection is repeated if the office dropdown stays empty, and an office whose lookup times out is read once more.

**Real Google Chrome matters.** In CI, the Chromium build from the setup-chrome action was blocked by Cloudflare run after run; the Google Chrome preinstalled on GitHub's runner image (`/usr/bin/google-chrome`) clears it. Do not switch the workflow back to a Chromium build.

**History (`scraper/history.mjs` → `history/offices.json`):** `data.json` only keeps one prior snapshot under `previous`. The history builder folds every commit of `data.json` plus the working-tree copy into one snapshot per UTC date (newer `updated` wins), as a `dates[]` array with an aligned `months[]` per office and `null` where USCIS showed no figure. It needs full git history, which is why the workflow checks out with `fetch-depth: 0`. The file is written one office per line so diffs stay readable.

**`index.html` structure:** one inline `<script>` holding
- `OFFICE_COORDS`: hard-coded `[lng, lat]` per USCIS office code, used to place dots on the D3 `geoAlbersUsa` map (geometry from `us-states-10m.json`). A new office code returned by the scraper needs an entry here or it won't appear on the map. GU/PR/VI offices are listed below the map since `geoAlbersUsa` can't project them.
- `SJ = 'SNJ'`: San Jose is pinned as the hero card and on top of the list.
- Trends: `prepHistory()` runs once per load and precomputes each office's series, change points and sparkline SVG string, so `renderList()` (which reruns on every search keystroke) only pastes strings. `drawTrend()` draws the full step chart (`curveStepAfter`, change-point markers, reading-date rug, crosshair tooltip) into the hero card and the detail sheet. Everything trend-related hides when `history/offices.json` fails to load. Trends ignore manual overrides.
- `localStorage` keys `n400.overrides` (manual per-office value overrides from the in-app form) and `n400.baseline` (fallback delta baseline). `effMonths(code)` applies overrides over scraped values in the current-value UI only.
- D3 and topojson-client are loaded from jsDelivr CDN; everything else is local.

**GitHub Action (`.github/workflows/update.yml`):** runs the scraper at 11:17 and 23:41 UTC (two chances per day against Cloudflare) and on `workflow_dispatch`, under Xvfb, then rebuilds the history and commits both files if they changed. A Cloudflare block still happens some days; that is expected, and the next run refreshes.

## Branches and deployment

- Upstream is `sknallt23/n400-processing-times` (read-only for us; its Pages site builds from `main`). Our fork is `hasanatkazmi/n400-processing-times`, remote name `fork`.
- `office-trends` is the clean code branch and the head of upstream PR #2. Make code changes here.
- `preview` is the fork's default branch and its Pages source (live at https://www.danglingpointer.net/n400-processing-times/, a custom domain on the account). The scheduled Action runs here and commits data to it, so it is always ahead of `office-trends` by bot commits. To get code changes onto the preview: `git checkout preview && git pull --ff-only fork preview && git merge office-trends && git push fork preview`.
- Never use GitHub's "Sync fork" button on the fork: it would merge upstream `main` into `preview` and conflict on the data files.

## Conventions

- Data-only commits use the message `Update N-400 processing times (YYYY-MM-DD)`, matching what the Action produces.
- `data.json` and `history/offices.json` are generated artifacts; edit them only via the scraper and `npm run history`. Treat `months: null` as "USCIS showed no data for that office", which the UI renders as a dash and the trend charts skip.
- The scraper exits non-zero if zero offices yielded data, so the Action doesn't commit an empty snapshot.
