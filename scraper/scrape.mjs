#!/usr/bin/env node
// Scrapes USCIS N-400 processing times for every field office -> data.json.
//
// egov.uscis.gov sits behind Cloudflare's interactive Turnstile challenge, which
// plain HTTP clients (and even stealth headless browsers) can't pass. We use
// puppeteer-real-browser, which drives a real Chrome and solves Turnstile. Once
// the SPA loads we drive its form:  #formName -> #formCategory -> #officeSc ->
// "Get processing time" button, and read the rendered "80% of cases are
// completed within N Months" figure for each office.
//
// Env:
//   CHROME_PATH  Chrome/Chromium binary (defaults to macOS Google Chrome)
//   HEADLESS     "true" to run headless (needs xvfb on Linux); default visible
//   OUT          output path (default <repo>/data.json)
//   ONLY         comma-separated office codes to limit (debug)

import { connect } from 'puppeteer-real-browser';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT = process.env.OUT || resolve(REPO_ROOT, 'data.json');
const BASE = 'https://egov.uscis.gov/processing-times';
const FORM = 'N-400';
const CATEGORY = '160A'; // "Application for Naturalization"
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'])
    if (existsSync(p)) return p;
  return undefined; // let puppeteer-real-browser find one
}

const selectOptions = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return Array.from(el.options).map((o) => ({ v: o.value, t: (o.textContent || '').trim() }));
  }, sel);

async function waitOptions(page, sel, min = 2, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const o = await selectOptions(page, sel);
    if (o && o.length >= min) return o;
    await sleep(400);
  }
  return await selectOptions(page, sel);
}

// Load the site and wait for Turnstile to clear. From a datacenter IP the
// challenge sometimes never resolves on the first page load but does on a
// fresh one, so reload and try again a few times before giving up.
async function clearChallenge(page, attempts = 3) {
  for (let a = 1; a <= attempts; a++) {
    console.error(a === 1 ? 'Loading USCIS and clearing Cloudflare…'
                          : `Cloudflare not cleared, reloading (attempt ${a}/${attempts})…`);
    try { await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 90000 }); }
    catch (e) { console.error(`  load failed: ${e.message}`); continue; }
    for (let i = 0; i < 24; i++) {                       // up to ~60s per attempt
      const t = await page.title().catch(() => '?');
      if (!/just a moment|verif|attention required/i.test(t) && await page.$('#formName')) {
        console.error(`Cleared (title: ${t}).`); return true;
      }
      await sleep(2500);
    }
  }
  return false;
}

// Read the processing-time result currently shown for `officeName`.
async function readResult(page, officeName) {
  const re = new RegExp(`at\\s+${esc(officeName)}\\b`, 'i');
  for (let i = 0; i < 30; i++) {
    const info = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      return main ? main.innerText : '';
    });
    if (re.test(info)) {
      // grab the number after "completed within"
      const m = info.match(/completed within[^0-9]*([\d]+(?:\.\d+)?)\s*(month|week|day)/i);
      if (m) return { months: monthsFrom(Number(m[1]), m[2]), raw: `${m[1]} ${m[2]}` };
      // Some offices show no data / a message instead of a figure.
      if (/we are unable|no data|not available|currently unavailable/i.test(info))
        return { months: null, raw: 'no-data' };
    }
    await sleep(500);
  }
  return { months: null, raw: 'timeout' };
}

function monthsFrom(value, unit) {
  const u = (unit || 'month').toLowerCase();
  if (u.startsWith('week')) return Math.round((value / 4.345) * 10) / 10;
  if (u.startsWith('day')) return Math.round((value / 30.44) * 10) / 10;
  return value;
}

// "San Jose CA" -> { city:"San Jose", state:"CA" }
function splitOffice(name) {
  const m = name.match(/^(.*)\s+([A-Z]{2})$/);
  if (m) return { city: m[1].trim(), state: m[2] };
  return { city: name, state: '' };
}

async function main() {
  const { browser, page } = await connect({
    headless: (process.env.HEADLESS || '').toLowerCase() === 'true',
    turnstile: true,
    // In CI we provide our own virtual display via `xvfb-run`, so tell the lib
    // not to manage Xvfb itself (set DISABLE_XVFB=true in the workflow).
    disableXvfb: (process.env.DISABLE_XVFB || '').toLowerCase() === 'true',
    args: ['--window-size=1300,1000', '--lang=en-US'],
    customConfig: chromePath() ? { chromePath: chromePath() } : {},
  });

  try {
    if (!(await clearChallenge(page))) throw new Error('Could not clear Cloudflare challenge.');

    // Select form + category, then read the office list. The SPA sometimes
    // ignores a select or is slow to fill the office list, so retry a few times.
    let all = [];
    for (let attempt = 1; attempt <= 3 && !all.length; attempt++) {
      if (attempt > 1) console.error(`Office list empty, retrying (${attempt}/3)…`);
      await page.select('#formName', FORM);
      await sleep(1200);
      await waitOptions(page, '#formCategory', 2);
      await page.select('#formCategory', CATEGORY);
      await sleep(1500);
      all = ((await waitOptions(page, '#officeSc', 3, 60)) || [])
        .filter((o) => o.v && !/select one/i.test(o.t));
    }
    const offices = ONLY.length ? all.filter((o) => ONLY.includes(o.v)) : all;
    console.error(`Found ${all.length} offices for ${FORM}` +
      (ONLY.length ? `, ${offices.length} matching ONLY=${ONLY.join(',')}.` : '.'));
    if (!offices.length) throw new Error('No offices returned.');

    const results = [];
    for (let idx = 0; idx < offices.length; idx++) {
      const off = offices[idx];
      await page.select('#officeSc', off.v);
      await sleep(300);
      await page.click('#buttonGetProcessingTime').catch(() => {});
      let { months, raw } = await readResult(page, off.t);
      if (raw === 'timeout') {                      // the site's lookup stalls now and then; one more try
        await page.click('#buttonGetProcessingTime').catch(() => {});
        ({ months, raw } = await readResult(page, off.t));
        raw += ' (retried)';
      }
      const { city, state } = splitOffice(off.t);
      results.push({ code: off.v, office: off.t, city, state, months });
      console.error(`  [${idx + 1}/${offices.length}] ${off.t.padEnd(24)} ${months ?? '—'} mo  (${raw})`);
      await sleep(400);
    }

    // Preserve prior values so the app can show deltas.
    let previous = null;
    if (existsSync(OUT)) {
      try {
        const prev = JSON.parse(await readFile(OUT, 'utf8'));
        const byCode = {};
        for (const o of prev.offices || []) if (o.months != null) byCode[o.code] = o.months;
        previous = { updated: prev.updated, byCode };
      } catch {}
    }

    const payload = {
      form: FORM,
      category: CATEGORY,
      formLabel: 'Application for Naturalization (N-400)',
      unit: 'months',
      note: '80% of cases are completed within this many months',
      source: `${BASE}/`,
      updated: new Date().toISOString(),
      offices: results,
      previous,
    };
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, JSON.stringify(payload, null, 2));
    const ok = results.filter((r) => r.months != null).length;
    console.error(`\nWrote ${OUT} — ${ok}/${results.length} offices with data.`);
    if (ok === 0) throw new Error('No offices produced data — treating as failure.');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
