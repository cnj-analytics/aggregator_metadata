// careem/uae/ranking-control.js
//
// Careem UAE — Ranking control helper. Not used by the main control
// workflow (that one calls Supabase via psql directly), but kept for
// parity with Talabat's node-based control and for manual debugging.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TRIGGER      = process.env.TRIGGER   || 'manual';
const AREA_IDS     = process.env.AREA_IDS  || '';
const DRY_RUN      = process.env.DRY_RUN === 'true';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

async function rpc(fn, body) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`RPC ${fn} ${resp.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const areaIds = AREA_IDS
    ? AREA_IDS.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
    : null;
  console.log(`Careem ranking control — trigger=${TRIGGER} dry_run=${DRY_RUN} ` +
              `areas=${areaIds ? areaIds.join(',') : 'ALL'}`);

  const result = await rpc('careem_ranking_run_begin', {
    p_trigger:  TRIGGER,
    p_area_ids: areaIds,
    p_dry_run:  DRY_RUN,
  });
  console.log(JSON.stringify(result, null, 2));

  if (result?.skip) {
    console.log(`skipped: ${result.reason}`);
    return;
  }
  console.log(`started run_id=${result.run_id} areas=${result.areas} ` +
              `pool=${result.pool} concurrent=${result.concurrent} ` +
              `pace=${result.pace_seconds}s deadline=${result.deadline}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
