// ranking-run-log.js – closes the run in Supabase (deliveroo_ranking_run_finish) and prints
// the run log as Markdown: pacing, pauses, 429s/403s and every area that did not complete.
// Usage: node ranking-run-log.js >> $GITHUB_STEP_SUMMARY
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RUN_ID

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY, RUN_ID } = process.env;

async function main() {
  if (!RUN_ID) { process.stdout.write('## Run log\n\nNo run id (run was skipped).\n'); return; }
  let v = null;
  for (let i = 0; i < 4 && !v; i++) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/deliveroo_ranking_run_finish`, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_run_id: Number(RUN_ID) }),
      });
      if (r.ok) v = await r.json(); else await new Promise(res => setTimeout(res, 5000));
    } catch (_) { await new Promise(res => setTimeout(res, 5000)); }
  }
  if (!v) { process.stdout.write(`## Run log\n\nCould not read run ${RUN_ID} from Supabase.\n`); return; }
  const run = v.run, bs = v.by_status || {};
  const t = x => (x ? new Date(x).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai' }) : '–');
  let md = `## Run log (Supabase run ${run.run_id})\n\n`;
  md += `| Item | Value |\n|---|---|\n`;
  md += `| Result | **${run.status}**${run.stop_reason ? ` – ${run.stop_reason}` : ''} |\n`;
  md += `| Started / first request / last area done | ${t(run.started_at)} / ${v.first_request || '–'} / ${v.last_finish || '–'} (Dubai) |\n`;
  md += `| No new area after | ${t(run.deadline_at)} |\n`;
  md += `| Pacing | ${run.gap_seconds}s between requests (all jobs) · ≥${run.per_job_gap_seconds}s per machine · ${run.batch_pause_seconds}s break every ${run.batch_size} requests |\n`;
  md += `| Areas | ${Object.entries(bs).sort().map(([k, n]) => `${k} ${n}`).join(' · ')} |\n`;
  md += `| 429s / 403s / pauses | ${run.rate_limits} / ${run.blocks} / ${run.pauses} |\n\n`;
  const p = v.problems || [];
  md += `### Areas not completed (${p.length})\n\n`;
  md += p.length
    ? `| Area | Status | Job | Error |\n|---|---|---|---|\n` + p.map(x => `| ${x.area} (${x.area_id}) | ${x.status} | ${x.job ?? ''} | ${x.error ?? ''} |`).join('\n') + '\n'
    : 'None.\n';
  process.stdout.write(md);
}
main().catch(e => { process.stdout.write(`## Run log\n\nError: ${e.message}\n`); });
