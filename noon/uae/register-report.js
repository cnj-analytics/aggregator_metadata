// register-report.js
//
// Reads register-job-*.json summaries emitted by register-branch.js and prints
// a one-page report to GITHUB_STEP_SUMMARY. Pure read-only (no network).

'use strict';
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || 'summaries';
if (!fs.existsSync(dir)) { console.log('(no summaries)'); process.exit(0); }

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const rows = [];
for (const f of files) {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (Array.isArray(arr)) rows.push(...arr);
  } catch (_) {}
}

const by = (k) => rows.reduce((a, r) => { a[r[k]] = (a[r[k]] || 0) + 1; return a; }, {});
const byStatus = by('status');
const okRows   = rows.filter(r => r.status === 'registered');
const failRows = rows.filter(r => r.status === 'failed');
const avgMs    = okRows.length ? Math.round(okRows.reduce((a, r) => a + (r.ms || 0), 0) / okRows.length) : 0;

const skipRows = rows.filter(r => r.status === 'skipped');
const skipByReason = skipRows.reduce((a, r) => {
  const k = (r.detail && r.detail.reason) || 'unknown';
  a[k] = (a[k] || 0) + 1;
  return a;
}, {});

const totals = {
  processed:     rows.length,
  registered:    byStatus.registered || 0,
  skipped:       byStatus.skipped || 0,
  failed:        byStatus.failed || 0,
  fatal:         byStatus.fatal || 0,
  avg_ms:        avgMs,
  brands_new:    okRows.reduce((a, r) => a + (r.detail && r.detail.brand_created ? 1 : 0), 0),
  rankings_moved: okRows.reduce((a, r) => a + ((r.detail && r.detail.rankings_moved) || 0), 0),
};

console.log('## Noon register-branch report');
console.log('');
console.log('| metric | value |');
console.log('|---|---|');
for (const [k, v] of Object.entries(totals)) console.log(`| ${k} | ${v} |`);
console.log('');

if (Object.keys(skipByReason).length) {
  console.log('### Skipped by reason');
  console.log('');
  console.log('| reason | count |');
  console.log('|---|---|');
  for (const [k, v] of Object.entries(skipByReason).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${k} | ${v} |`);
  }
  console.log('');
}

if (failRows.length) {
  console.log('### Failures (first 20)');
  console.log('');
  console.log('| outlet | name | error |');
  console.log('|---|---|---|');
  for (const r of failRows.slice(0, 20)) {
    console.log(`| ${r.outlet_code} | ${(r.name || '').slice(0, 40)} | ${(r.detail || '').slice(0, 80)} |`);
  }
}
