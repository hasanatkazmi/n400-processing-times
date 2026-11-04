#!/usr/bin/env node
// Builds history/offices.json: every field office's N-400 processing time on
// every date we have a data.json for. No network, no Chrome.
//
// Sources: each commit of data.json in git history, plus the working-tree
// data.json (so a fresh, not-yet-committed scrape is included). One snapshot per
// UTC date; for the same date the newer `updated` timestamp wins.
//
// Run after scrape.mjs. The GitHub Action and `npm run update` do this; use
// `npm run history` to rebuild by hand. Needs full git history (the Action
// checks out with fetch-depth: 0).
//
// Output (arrays are aligned with `dates`; null = no figure for that day):
// {
//   "form": "N-400", "unit": "months", "note": "...", "source": "...",
//   "dates": ["2026-07-30", "2026-09-02", ...],
//   "offices": {
//     "SNJ": { "office": "San Jose CA", "city": "San Jose", "state": "CA", "months": [12.5, 14.5, ...] },
//     ...
//   }
// }

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DATA = resolve(REPO_ROOT, 'data.json');
const OUT = process.env.HISTORY_OUT || resolve(REPO_ROOT, 'history', 'offices.json');

const utcDate = (iso) => String(iso).slice(0, 10);

async function gitSnapshots() {
  const { stdout } = await run('git', ['log', '--format=%H', '--', 'data.json'], { cwd: REPO_ROOT });
  const hashes = stdout.split('\n').filter(Boolean);
  const out = [];
  for (const hash of hashes) {
    try {
      const { stdout: json } = await run('git', ['show', `${hash}:data.json`], { cwd: REPO_ROOT, maxBuffer: 1 << 26 });
      out.push(JSON.parse(json));
    } catch { /* commit without a parseable data.json */ }
  }
  return { snaps: out, commits: hashes.length };
}

async function main() {
  const { snaps, commits } = await gitSnapshots();
  if (existsSync(DATA)) {
    try { snaps.push(JSON.parse(await readFile(DATA, 'utf8'))); } catch { /* ignore unreadable working copy */ }
  }

  // One snapshot per UTC date; newest `updated` wins.
  const byDate = new Map();
  for (const s of snaps) {
    if (!s || !s.updated || !Array.isArray(s.offices)) continue;
    const d = utcDate(s.updated);
    const cur = byDate.get(d);
    if (!cur || s.updated > cur.updated) byDate.set(d, s);
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) throw new Error('No data.json snapshots found in git history or working tree.');

  const offices = {};
  dates.forEach((d, i) => {
    for (const o of byDate.get(d).offices) {
      if (!o || !o.code) continue;
      if (!offices[o.code]) offices[o.code] = { office: o.office, city: o.city, state: o.state, months: new Array(dates.length).fill(null) };
      const rec = offices[o.code];
      rec.office = o.office; rec.city = o.city; rec.state = o.state; // keep the latest naming
      rec.months[i] = o.months == null ? null : o.months;
    }
  });

  const latest = byDate.get(dates[dates.length - 1]);
  const codes = Object.keys(offices).sort((a, b) => String(offices[a].office).localeCompare(String(offices[b].office)));

  // Serialize one office per line so git diffs stay readable.
  const lines = ['{'];
  lines.push(`  "form": ${JSON.stringify(latest.form || 'N-400')},`);
  lines.push(`  "unit": ${JSON.stringify(latest.unit || 'months')},`);
  lines.push(`  "note": ${JSON.stringify(latest.note || '80% of cases are completed within this many months')},`);
  lines.push(`  "source": ${JSON.stringify(latest.source || 'https://egov.uscis.gov/processing-times/')},`);
  lines.push(`  "dates": ${JSON.stringify(dates)},`);
  lines.push('  "offices": {');
  codes.forEach((code, i) => {
    const o = offices[code];
    const body = `{"office": ${JSON.stringify(o.office)}, "city": ${JSON.stringify(o.city)}, "state": ${JSON.stringify(o.state)}, "months": ${JSON.stringify(o.months)}}`;
    lines.push(`    ${JSON.stringify(code)}: ${body}${i < codes.length - 1 ? ',' : ''}`);
  });
  lines.push('  }');
  lines.push('}');

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, lines.join('\n') + '\n');
  console.error(`Wrote ${OUT} — ${dates.length} dates (${dates[0]} to ${dates[dates.length - 1]}), ${codes.length} offices, from ${commits} commits + working tree.`);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
