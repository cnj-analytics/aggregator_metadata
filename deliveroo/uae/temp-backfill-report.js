// temp-backfill-report.js  (TEMPORARY – delete with the backfill workflow)
//
// Merges the per-shard CSVs into:
//   all-results.csv      every row processed
//   drn-mismatches.csv   page drnId != our partner ID (NOT written; needs investigation)
//   not-updated.csv      everything that was not written, for any reason
// and prints a Markdown summary to stdout (piped into the job summary).

const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || 'shard-results';
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.csv')).sort() : [];

function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

let header = null;
const rows = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
  if (!lines.length) continue;
  header = header || lines[0];
  for (const l of lines.slice(1)) rows.push(l);
}

const cols = header ? parseLine(header) : [];
const idx = n => cols.indexOf(n);
const recs = rows.map(l => ({ raw: l, v: parseLine(l) }));
const get = (r, n) => r.v[idx(n)];

const write = (name, list) =>
  fs.writeFileSync(name, (header ? header + '\n' : '') + list.map(r => r.raw).join('\n') + (list.length ? '\n' : ''));

const OK = new Set(['updated', 'ok_dry_run']);
const mismatches = recs.filter(r => get(r, 'status') === 'drn_mismatch');
const notUpdated = recs.filter(r => !OK.has(get(r, 'status')));
write('all-results.csv', recs);
write('drn-mismatches.csv', mismatches);
write('not-updated.csv', notUpdated);

const counts = {};
for (const r of recs) counts[get(r, 'status')] = (counts[get(r, 'status')] || 0) + 1;

const ms = recs.map(r => Number(get(r, 'ms'))).filter(n => n > 0).sort((a, b) => a - b);
const pct = p => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : 0);
const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0;
const retries = recs.reduce((a, r) => a + Number(get(r, 'retries') || 0), 0);

let md = `## Branch coordinates backfill – report\n\n`;
md += `Job result files: ${files.length} · Rows processed: ${recs.length}\n\n`;
md += `| Status | Count |\n|---|---|\n`;
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) md += `| ${k} | ${v} |\n`;
md += `\n**Timing per URL (fetch + parse + write, excl. 0.3s pause):** avg ${(avg / 1000).toFixed(2)}s · p50 ${(pct(0.5) / 1000).toFixed(2)}s · p95 ${(pct(0.95) / 1000).toFixed(2)}s · max ${(pct(1) / 1000).toFixed(2)}s · total retries ${retries}\n\n`;
const perUrl = avg / 1000 + 0.3;
md += `**Estimated full run:** ~${Math.ceil(16189 / 20)} URLs per job × ${perUrl.toFixed(2)}s ≈ ${Math.ceil((16189 / 20) * perUrl / 60)} min per job (20 jobs in parallel)\n\n`;

md += `### drnId mismatches (${mismatches.length}) – not written\n\n`;
if (mismatches.length) {
  md += `| partner_id (ours) | page drnId | url | final_url |\n|---|---|---|---|\n`;
  for (const r of mismatches.slice(0, 200))
    md += `| ${get(r, 'partner_id')} | ${get(r, 'page_drn_id')} | ${get(r, 'url')} | ${get(r, 'final_url')} |\n`;
  if (mismatches.length > 200) md += `\n…${mismatches.length - 200} more in drn-mismatches.csv\n`;
} else md += `None.\n`;

const other = notUpdated.filter(r => get(r, 'status') !== 'drn_mismatch');
md += `\n### Other rows not written (${other.length})\n\n`;
if (other.length) {
  md += `| status | partner_id | url | error |\n|---|---|---|---|\n`;
  for (const r of other.slice(0, 100))
    md += `| ${get(r, 'status')} | ${get(r, 'partner_id')} | ${get(r, 'url')} | ${get(r, 'error')} |\n`;
  if (other.length > 100) md += `\n…${other.length - 100} more in not-updated.csv\n`;
} else md += `None.\n`;

md += `\nFull CSVs are in the **backfill-report** artifact.\n`;
process.stdout.write(md);
