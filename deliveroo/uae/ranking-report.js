// ranking-report.js – Markdown report of one worker machine's areas (its GitHub run summary).
// Usage: node ranking-report.js <dir-with-summary-json-files> >> $GITHUB_STEP_SUMMARY

const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || 'summaries';
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
const areas = [];
for (const f of files) {
  try { areas.push(...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (_) {}
}
areas.sort((a, b) => (a.area_id || 0) - (b.area_id || 0));

const sum = k => areas.reduce((t, a) => t + (Number(a[k]) || 0), 0);
const merge = k => {
  const o = {};
  for (const a of areas) for (const [x, n] of Object.entries(a[k] || {})) o[x] = (o[x] || 0) + n;
  return o;
};
// An area that went back into Supabase's queue (429 once, or a refusal on a flagged address)
// is listed as 'requeued_…' and is not counted as a separate area.
const total429 = areas.reduce((t, a) => t + (Number(a.rate_limits) || 0), 0);
areas.splice(0, areas.length, ...areas.filter(a => !/^requeued_/.test(a.status || '')));
const ok = areas.filter(a => /^ok/.test(a.status || ''));
const notFound = areas.filter(a => a.status === 'not_found');
const viaGeohash = areas.filter(a => /_geohash$/.test(a.status || ''));
const failed = areas.filter(a => !/^ok/.test(a.status || '') && a.status !== 'not_found');
const mb = b => (b / 1048576).toFixed(1);

let md = `## Ranking run ${process.env.RUN_ID || ''} · machine ${process.env.MACHINE_NO || ''}\n\n`;
md += `Full run log (all machines): Supabase table deliveroo_ranking_run_event / view deliveroo_ranking_run_overview.\n\n`;
md += `Areas: ${areas.length} (ok ${ok.length}, of which ${viaGeohash.length} via stored geohash · no public page ${notFound.length} · failed ${failed.length})\n\n`;
md += `| Total | Value |\n|---|---|\n`;
md += `| Cards read | ${sum('cards')} |\n| Ranking rows | ${sum('ranking_rows')} |\n| Pending rows (unknown partners) | ${sum('pending_rows')} |\n`;
md += `| Rows replaced (same hour re-run) | ${sum('replaced_rows')} |\n`;
md += `| Partners queued for registration | ${sum('queued_partners')} |\n| Delivery-area pairs added | ${sum('delivery_pairs_added')} |\n`;
md += `| Branch images updated | ${sum('images_updated')} |\n| Rank gaps | ${sum('rank_gaps')} |\n| Duplicate cards dropped | ${sum('duplicate_partners')} |\n`;
md += `| Downloaded | ${mb(sum('bytes'))} MB |\n| 429s | ${total429} |\n\n`;

md += `| Field | Split |\n|---|---|\n`;
md += `| Rating | rated ${sum('rated')} · not rated ${sum('not_rated')} · new ${sum('new')} |\n`;
md += `| Operating | open ${sum('open')} · closed ${sum('closed')} |\n`;
md += `| Fast tag | ${sum('fast')} |\n| Promo badge | ${sum('with_promo')} |\n`;
md += `| Promo scope | ${Object.entries(merge('scope')).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')} |\n\n`;

const unk = merge('unknown_promos');
md += `### Unrecognised promo badges (${Object.keys(unk).length})\n\n`;
md += Object.keys(unk).length ? Object.entries(unk).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k} (${v})`).join('\n') + '\n\n' : 'None.\n\n';
const an = merge('anomalies');
md += `### Anomalies (${Object.keys(an).length})\n\n`;
md += Object.keys(an).length ? Object.entries(an).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, v]) => `- ${k} (${v})`).join('\n') + '\n\n' : 'None.\n\n';

const imgs = areas.flatMap(a => (a.image_examples || []).map(x => ({ area: a.area_name, ...x })));
md += `### Image changes – examples (${sum('images_updated')} total)\n\n`;
md += imgs.length
  ? `| Area | Restaurant | Stored image | Card image |\n|---|---|---|---|\n` +
    imgs.map(x => `| ${x.area} | ${x.name || x.partner} | ${x.stored || '(none)'} | ${x.card} |`).join('\n') + '\n\n'
  : 'None.\n\n';

md += `### Per area\n\n| Machine | Area | Status | Cards / declared | Ranking | Pending | Pairs + | Images | MB | Fetch s | Total s |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const a of areas) {
  md += `| ${a.machine ?? ''} | ${a.area_name || ''} (${a.area_id || ''}) | ${a.status}${a.error ? ` – ${a.error}` : ''} | ${a.cards ?? ''} / ${a.declared_count ?? ''} | ${a.ranking_rows ?? ''} | ${a.pending_rows ?? ''} | ${a.delivery_pairs_added ?? ''} | ${a.images_updated ?? ''} | ${a.bytes ? mb(a.bytes) : ''} | ${a.fetch_ms ? (a.fetch_ms / 1000).toFixed(1) : ''} | ${a.total_ms ? (a.total_ms / 1000).toFixed(1) : ''} |\n`;
}
process.stdout.write(md);
