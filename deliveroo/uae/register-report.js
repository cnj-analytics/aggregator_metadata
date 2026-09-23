// register-report.js – merges Register Branch job summaries into a Markdown report.
const fs = require('fs');
const path = require('path');
const dir = process.argv[2] || 'summaries';
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
const rows = [];
for (const f of files) { try { rows.push(...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (_) {} }

const ok = rows.filter(r => r.status === 'registered');
const bad = rows.filter(r => r.status !== 'registered');
const sum = k => ok.reduce((t, r) => t + (Number(r.detail?.[k]) || 0), 0);

let md = `## Register Branch – ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n\n`;
md += `| Total | Value |\n|---|---|\n| Partners processed | ${rows.length} |\n| Registered | ${ok.length} |\n| Failed / retrying | ${bad.length} |\n`;
md += `| New brands | ${ok.filter(r => r.detail?.brand_created).length} |\n| Delivery areas linked | ${sum('delivery_areas_added')} |\n`;
md += `| Ranking rows moved in | ${sum('rankings_moved')} |\n| Parked rows past the retention window (dropped) | ${sum('rankings_expired')} |\n\n`;

if (ok.length) {
  md += `### Registered\n\n| Branch | Brand | Area | New brand | Areas linked | Rankings moved |\n|---|---|---|---|---|---|\n`;
  for (const r of ok.slice(0, 300)) {
    md += `| ${r.detail.branch_name} | ${r.detail.brand_name} | ${r.detail.area_name} | ${r.detail.brand_created ? 'yes' : ''} | ${r.detail.delivery_areas_added} | ${r.detail.rankings_moved} |\n`;
  }
  if (ok.length > 300) md += `\n…${ok.length - 300} more\n`;
  md += '\n';
}
md += `### Failed / retrying (${bad.length})\n\n`;
md += bad.length
  ? `| Card name | Partner | Attempt | Error | Queue now |\n|---|---|---|---|---|\n` +
    bad.map(r => `| ${r.card_name || ''} | ${r.partner_id || ''} | ${r.attempt || ''} | ${r.detail || ''} | ${r.queue_status || ''} |`).join('\n') + '\n'
  : 'None.\n';
process.stdout.write(md);
