#!/usr/bin/env node
// Pulls the current N-400 processing time for the San Jose field office,
// saves it to history/sanjose.json, and prints every saved reading over time.
//
// Usage:
//   npm run sanjose                  scrape USCIS now, save the reading, show history
//   npm run sanjose -- --show        show saved history only (no scrape, no Chrome)
//   npm run sanjose -- --backfill    also import readings from the git history of data.json
//
// Flags combine: `--backfill --show` imports from git and prints without scraping.
// On the very first run (no history file yet) the git import happens automatically.
//
// The scrape reuses scraper/scrape.mjs with ONLY=SNJ, so it opens a real Chrome
// window briefly to get past Cloudflare. CHROME_PATH / HEADLESS apply as usual.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRAPER = resolve(__dirname, 'scrape.mjs');
const HISTORY = resolve(REPO_ROOT, 'history', 'sanjose.json');
const OFFICE = 'SNJ';
const OFFICE_NAME = 'San Jose CA';

const args = new Set(process.argv.slice(2));
const SHOW_ONLY = args.has('--show');
const BACKFILL = args.has('--backfill');

const fmt = (m) => (m == null ? '—' : Number.isInteger(m) ? String(m) : m.toFixed(1));
const pad2 = (n) => String(n).padStart(2, '0');
// Local calendar date of an ISO timestamp, e.g. 2026-11-02.
function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* ---------- history file ---------- */
async function loadHistory() {
  if (!existsSync(HISTORY)) return [];
  try { return JSON.parse(await readFile(HISTORY, 'utf8')).readings || []; }
  catch { return []; }
}

async function saveHistory(readings) {
  readings.sort((a, b) => a.updated.localeCompare(b.updated));
  await mkdir(dirname(HISTORY), { recursive: true });
  const doc = {
    office: OFFICE,
    officeName: OFFICE_NAME,
    form: 'N-400',
    unit: 'months',
    note: '80% of cases are completed within this many months',
    readings,
  };
  await writeFile(HISTORY, JSON.stringify(doc, null, 2) + '\n');
}

// Keep one reading per local date; for the same date the newer timestamp wins.
function merge(existing, incoming) {
  const byDate = new Map(existing.map((r) => [r.date, r]));
  for (const r of incoming) {
    const cur = byDate.get(r.date);
    if (!cur || r.updated > cur.updated) byDate.set(r.date, r);
  }
  return [...byDate.values()];
}

// Extract the San Jose reading from a data.json-shaped payload.
function readingFrom(payload, source) {
  const o = (payload.offices || []).find((x) => x.code === OFFICE);
  if (!o) return null;
  return { date: localDate(payload.updated), updated: payload.updated, months: o.months, source };
}

/* ---------- sources ---------- */
async function backfillFromGit() {
  const { stdout } = await run('git', ['log', '--format=%H', '--', 'data.json'], { cwd: REPO_ROOT });
  const out = [];
  for (const hash of stdout.split('\n').filter(Boolean)) {
    try {
      const { stdout: json } = await run('git', ['show', `${hash}:data.json`], { cwd: REPO_ROOT, maxBuffer: 1 << 24 });
      const r = readingFrom(JSON.parse(json), 'git');
      if (r && r.months != null) out.push(r);
    } catch { /* commit without a parseable data.json */ }
  }
  return out;
}

function spawnP(cmd, argv, opts) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, opts);
    p.on('error', rej);
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited with code ${code}`))));
  });
}

async function scrape() {
  const tmp = join(tmpdir(), `n400-${OFFICE}-${Date.now()}.json`);
  try {
    await spawnP(process.execPath, [SCRAPER], {
      cwd: REPO_ROOT,
      env: { ...process.env, ONLY: OFFICE, OUT: tmp },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const r = readingFrom(JSON.parse(await readFile(tmp, 'utf8')), 'scrape');
    if (!r || r.months == null) throw new Error(`USCIS returned no figure for ${OFFICE_NAME}.`);
    return r;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/* ---------- display ---------- */
function show(readings) {
  if (!readings.length) { console.log('No readings yet.'); return; }
  const vals = readings.map((r) => r.months).filter((m) => m != null);
  const max = Math.max(...vals);
  const W = 40;

  console.log(`\n${OFFICE_NAME} — N-400: months until 80% of cases are completed\n`);
  console.log('Date         Months  Change   ');
  let prev = null;
  for (const r of readings) {
    const m = r.months;
    let chg = '';
    if (m != null && prev != null) {
      const d = Math.round((m - prev) * 10) / 10;
      chg = d > 0 ? `▲ +${fmt(d)}` : d < 0 ? `▼ ${fmt(d)}` : '';
    }
    const bar = m == null ? '' : '█'.repeat(Math.max(1, Math.round((m / max) * W)));
    console.log(`${r.date}   ${fmt(m).padStart(5)}   ${chg.padEnd(8)} ${bar}`);
    if (m != null) prev = m;
  }

  const steps = [];
  for (const r of readings) {
    if (r.months == null) continue;
    if (!steps.length || steps[steps.length - 1].months !== r.months) steps.push(r);
  }
  console.log('\nChanges:  ' + steps.map((s) => `${fmt(s.months)} (${s.date})`).join('  →  '));
  const first = steps[0], last = steps[steps.length - 1];
  if (first !== last) {
    const d = Math.round((last.months - first.months) * 10) / 10;
    console.log(`Overall:  ${d > 0 ? '+' : ''}${fmt(d)} months since ${first.date}`);
  }
  const newest = readings[readings.length - 1];
  console.log(`Readings: ${readings.length}, latest ${newest.date} (${fmt(newest.months)} months)\n`);
}

/* ---------- main ---------- */
async function main() {
  let readings = await loadHistory();

  if (BACKFILL || !readings.length) {
    console.error('Importing readings from git history of data.json…');
    const fromGit = await backfillFromGit();
    readings = merge(readings, fromGit);
    await saveHistory(readings);
    console.error(`  ${fromGit.length} readings found in git.`);
  }

  if (!SHOW_ONLY) {
    try {
      const r = await scrape();
      readings = merge(readings, [r]);
      await saveHistory(readings);
      console.error(`\n${OFFICE_NAME}: ${fmt(r.months)} months as of ${r.date} (saved to history/sanjose.json)`);
    } catch (e) {
      console.error(`\nScrape failed: ${e.message}\nShowing saved history only; run again to retry.`);
      process.exitCode = 1;
    }
  }

  show(readings);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
