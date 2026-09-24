// ranking-setup.js
//
// Runs once per hourly scrape, before the 15 jobs start:
//   - works out the Dubai date + hour window this run belongs to, so all 15 jobs
//     use the same label even if some start late;
//   - makes sure that hour's section of deliveroo_ranking_analysis exists (retried: creating a
//     section briefly locks the table, so a long read such as the export can make it wait),
//     and also creates NEXT hour's section in advance, so the next run normally finds it ready;
//   - runs 24h retention (deliveroo_ranking_housekeeping): drops hour sections older than
//     24h that have a verified export in the Analytics Bucket, clears old parked rows and
//     old registered queue rows. A retention problem is logged but never stops the scrape.
//   - starts the run in Supabase (deliveroo_ranking_run_start), which queues every active
//     area in random order and from then on hands areas out to the jobs one at a time,
//     keeps the pace, takes planned breaks and pauses everyone on a 429/403. If another
//     run is still going, this run is skipped (never two runs at once).
// Writes scrape_date / scrape_hour / skip / run_id to $GITHUB_OUTPUT.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DRY_RUN,
//      SCRAPE_DATE_OVERRIDE (YYYY-MM-DD), SCRAPE_HOUR_OVERRIDE (HH:00),
//      AREA_IDS (optional comma list), GITHUB_RUN_ID,
//      GAP_SECONDS (1), PER_JOB_GAP_SECONDS (3), BATCH_SIZE (75), BATCH_PAUSE_SECONDS (90)

const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';

function dubaiNow() {
  // Dubai is UTC+4 all year (no daylight saving).
  const d = new Date(Date.now() + 4 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  console.log(`${k}=${v}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Returns the section name, or null if every attempt failed.
async function ensurePartition(date, hour, attempts) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/deliveroo_ranking_ensure_partition`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_date: date, p_hour: hour }),
      });
      const text = await resp.text();
      if (resp.ok) return text;
      console.log(`ensure_partition ${date} ${hour} attempt ${i}/${attempts}: ${resp.status} ${text.slice(0, 200)}`);
    } catch (e) {
      console.log(`ensure_partition ${date} ${hour} attempt ${i}/${attempts}: ${e.message}`);
    }
    if (i < attempts) await sleep(20000);
  }
  return null;
}

async function main() {
  const now = dubaiNow();
  const date = process.env.SCRAPE_DATE_OVERRIDE || now.date;
  const hourNum = process.env.SCRAPE_HOUR_OVERRIDE
    ? parseInt(process.env.SCRAPE_HOUR_OVERRIDE, 10)
    : now.hour;
  const hour = `${String(hourNum).padStart(2, '0')}:00`;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(hourNum) || hourNum < 0 || hourNum > 23) {
    throw new Error(`Bad date/hour: ${date} ${hour}`);
  }

  // No scraping in the 03:00–05:59 window (runs are 06:00 → 02:00).
  if (hourNum >= 3 && hourNum <= 5) {
    console.log(`Dubai hour ${hour} is inside the 03:00–05:00 pause – skipping this run.`);
    setOutput('skip', 'true');
    setOutput('scrape_date', date);
    setOutput('scrape_hour', hour);
    return;
  }

  if (!DRY_RUN) {
    const text = await ensurePartition(date, hour, 6);
    if (text === null) throw new Error(`ensure_partition failed for ${date} ${hour} after 6 attempts`);
    console.log(`Hour section ready: ${text}`);

    // Next hour's section in advance (not for the 03:00-05:00 pause). Never stops the scrape.
    const next = new Date(Date.parse(`${date}T${hour}:00Z`) + 3600 * 1000);
    const nextHour = next.getUTCHours();
    if (nextHour < 3 || nextHour > 5) {
      const nd = next.toISOString().slice(0, 10);
      const nh = `${String(nextHour).padStart(2, '0')}:00`;
      const nt = await ensurePartition(nd, nh, 2);
      console.log(nt === null ? `::warning::Could not pre-create ${nd} ${nh} (next run will create it)`
                              : `Next hour section ready: ${nt}`);
    }

    try {
      const hk = await fetch(`${SUPABASE_URL}/rest/v1/rpc/deliveroo_ranking_housekeeping`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const hkText = await hk.text();
      if (!hk.ok) console.log(`::warning::Retention step failed: ${hk.status} ${hkText.slice(0, 300)}`);
      else console.log(`Retention: ${hkText}`);
    } catch (e) {
      console.log(`::warning::Retention step failed: ${e.message}`);
    }
  }

  // Start the run in Supabase (also in dry runs: pacing and log still apply).
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const areaIds = (process.env.AREA_IDS || '').split(',').map(x => x.trim()).filter(Boolean).map(Number);
  const startResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/deliveroo_ranking_run_start`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_date: date,
      p_hour: hour,
      p_github_run_id: process.env.GITHUB_RUN_ID || null,
      p_area_ids: areaIds.length ? areaIds : null,
      p_dry_run: DRY_RUN,
      p_gap_seconds: num(process.env.GAP_SECONDS, 1),
      p_per_job_gap_seconds: num(process.env.PER_JOB_GAP_SECONDS, 3),
      p_batch_size: num(process.env.BATCH_SIZE, 75),
      p_batch_pause_seconds: num(process.env.BATCH_PAUSE_SECONDS, 90),
      // Started by hand (Run workflow button): 45 minutes from now instead of the :55 cutoff.
      p_manual: process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
    }),
  });
  const startText = await startResp.text();
  if (!startResp.ok) throw new Error(`run_start failed: ${startResp.status} ${startText.slice(0, 300)}`);
  const start = JSON.parse(startText);
  if (start.skip) {
    console.log(`::warning::Skipping this hour: ${start.reason}`);
    setOutput('skip', 'true');
    setOutput('scrape_date', date);
    setOutput('scrape_hour', hour);
    return;
  }
  console.log(`Run ${start.run_id} started: ${start.areas} areas queued, no new area after ${start.deadline} Dubai`);

  setOutput('skip', 'false');
  setOutput('run_id', start.run_id);
  setOutput('scrape_date', date);
  setOutput('scrape_hour', hour);
}

main().catch(e => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
