#!/usr/bin/env node
// noon/uae/queue-seed.js
//
// Seeds the noon_work_queue table with work items for the orchestrated workflow.
//
// mode=zones  Generate grid points (coarse + dense, same boxes as sync-areas.js)
//             and insert each as a 'zone' queue item.
// mode=areas  Read Talabat area centroids from Supabase + fill-in points for Noon
//             zones with no Talabat area, insert each as an 'area' queue item.
// mode=all    Both (zones first, then areas — areas needs zone table populated).
//
// A batch_id is generated from mode + timestamp, or set via NOON_BATCH_ID.
// The script prints the batch_id so the workflow can pass it to workers.
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   NOON_MODE            zones | areas | all   (default all)
//   NOON_BATCH_ID        override batch id     (default: auto-generated)
//   NOON_COARSE_STEP     deg (default 0.05)
//   NOON_DENSE_STEP      deg (default 0.01)
//   NOON_ONLY_ERRORED    'true' = seed only errored/never-probed areas
//   TEST_CITY_ID         Talabat city_id filter for areas mode

'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const MODE = (process.env.NOON_MODE || 'all').toLowerCase();
const COARSE_STEP = num('NOON_COARSE_STEP', 0.05);
const DENSE_STEP = num('NOON_DENSE_STEP', 0.01);
const ONLY_ERRORED = process.env.NOON_ONLY_ERRORED === 'true';
const TEST_CITY_ID = process.env.TEST_CITY_ID ? Number(process.env.TEST_CITY_ID) : null;

const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12); // 202610111200
const BATCH_ID = process.env.NOON_BATCH_ID || `${MODE}-${ts}`;

// Same grid boxes as sync-areas.js.
const UAE_BOX = { name: 'UAE (coarse)', latMin: 22.6, latMax: 26.1, lngMin: 51.5, lngMax: 56.4 };
const DENSE_REGIONS = [
  { name: 'Dubai',           latMin: 24.82, latMax: 25.36, lngMin: 54.89, lngMax: 55.55 },
  { name: 'Abu Dhabi',       latMin: 24.20, latMax: 24.55, lngMin: 54.30, lngMax: 54.80 },
  { name: 'Abu Dhabi North', latMin: 24.55, latMax: 24.75, lngMin: 54.55, lngMax: 54.80 },
  { name: 'Sharjah',         latMin: 25.20, latMax: 25.42, lngMin: 55.30, lngMax: 55.65 },
  { name: 'Ajman',           latMin: 25.36, latMax: 25.47, lngMin: 55.42, lngMax: 55.60 },
  { name: 'Umm Al Quwain',   latMin: 25.47, latMax: 25.62, lngMin: 55.53, lngMax: 55.72 },
  { name: 'Ras Al Khaimah',  latMin: 25.62, latMax: 25.85, lngMin: 55.85, lngMax: 56.05 },
  { name: 'Al Ain',          latMin: 24.10, latMax: 24.32, lngMin: 55.60, lngMax: 55.85 },
  { name: 'East Coast',      latMin: 24.95, latMax: 25.65, lngMin: 56.20, lngMax: 56.40 },
];

// ── Utilities ───────────────────────────────────────────────────────────────

function num(name, dflt) {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : Number(v);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d = 6) => Number(x.toFixed(d));

function gridPoints(box, step) {
  const pts = [];
  const nLat = Math.floor((box.latMax - box.latMin) / step + 1e-9);
  const nLng = Math.floor((box.lngMax - box.lngMin) / step + 1e-9);
  for (let i = 0; i <= nLat; i++) {
    for (let j = 0; j <= nLng; j++) {
      pts.push([round(box.latMin + i * step, 5), round(box.lngMin + j * step, 5)]);
    }
  }
  return pts;
}

// ── Supabase REST ───────────────────────────────────────────────────────────

async function supabase(path, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(SUPABASE_URL + '/rest/v1' + path, {
        method: opts.method || 'GET',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          ...(opts.headers || {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`Supabase ${opts.method || 'GET'} ${path} -> ${resp.status}: ${text.slice(0, 500)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}

async function selectAll(table, select, filters = '') {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await supabase(`/${table}?select=${select}${filters}&limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

async function insertBatch(rows, batchSize = 500) {
  for (let i = 0; i < rows.length; i += batchSize) {
    await supabase('/noon_work_queue', {
      method: 'POST',
      body: rows.slice(i, i + batchSize),
      headers: { Prefer: 'return=minimal' },
    });
    console.log(`[seed] inserted ${Math.min(i + batchSize, rows.length)}/${rows.length}`);
  }
}

// ── Seed: zones ─────────────────────────────────────────────────────────────

async function seedZones() {
  const seen = new Set();
  const points = [];
  const add = (p) => { const k = p.join(','); if (!seen.has(k)) { seen.add(k); points.push(p); } };
  gridPoints(UAE_BOX, COARSE_STEP).forEach(add);
  const coarseCount = points.length;
  for (const r of DENSE_REGIONS) gridPoints(r, DENSE_STEP).forEach(add);
  console.log(`[seed] zones: ${points.length} grid points (${coarseCount} coarse + ${points.length - coarseCount} dense)`);

  const rows = points.map(([lat, lng]) => ({
    batch_id: BATCH_ID,
    mode: 'zone',
    latitude: lat,
    longitude: lng,
    status: 'pending',
  }));

  await insertBatch(rows);
  console.log(`[seed] zones: ${rows.length} items inserted for batch ${BATCH_ID}`);
  return rows.length;
}

// ── Seed: areas ─────────────────────────────────────────────────────────────

async function seedAreas() {
  let areas;

  if (ONLY_ERRORED) {
    const rows = await selectAll('noon_area',
      'source_key,area_source,talabat_area_id,area_name,area_name_ar,area_slug,latitude,longitude',
      '&or=(probe_error.not.is.null,last_probed_at.is.null)');
    areas = rows.map((r) => ({
      source_key: r.source_key,
      area_source: r.area_source,
      talabat_area_id: r.talabat_area_id,
      area_name: r.area_name,
      area_name_ar: r.area_name_ar,
      area_slug: r.area_slug,
      latitude: r.latitude,
      longitude: r.longitude,
    }));
    console.log(`[seed] areas: ${areas.length} errored/never-probed area(s)`);
  } else {
    const filter = TEST_CITY_ID ? `&city_id=eq.${TEST_CITY_ID}` : '';
    const talabat = await selectAll('talabat_area', 'area_id,area_name,area_name_ar,area_slug,city_id,latitude,longitude',
      `&latitude=not.is.null&longitude=not.is.null${filter}&order=area_id.asc`);
    areas = talabat.map((t) => ({
      source_key: `talabat:${t.area_id}`,
      area_source: 'talabat',
      talabat_area_id: t.area_id,
      area_name: t.area_name,
      area_name_ar: t.area_name_ar,
      area_slug: t.area_slug,
      latitude: t.latitude,
      longitude: t.longitude,
    }));
    console.log(`[seed] areas: ${areas.length} Talabat area(s)${TEST_CITY_ID ? ` (city_id=${TEST_CITY_ID})` : ''}`);

    // Fill-ins: one point per Noon zone with no Talabat area.
    if (!TEST_CITY_ID) {
      const zones = await selectAll('noon_zone', 'noon_zone_code,zone_name,latitude,longitude', '&latitude=not.is.null');
      const covered = new Set((await selectAll('noon_area', 'noon_zone_code', '&area_source=eq.talabat&noon_zone_code=not.is.null'))
        .map((r) => r.noon_zone_code));
      const fills = zones.filter((z) => !covered.has(z.noon_zone_code)).map((z) => ({
        source_key: `zone:${z.noon_zone_code}`,
        area_source: 'noon_zone',
        talabat_area_id: null,
        area_name: `${z.zone_name} (Noon zone point)`,
        area_name_ar: null,
        area_slug: null,
        latitude: z.latitude,
        longitude: z.longitude,
      }));
      console.log(`[seed] areas: ${fills.length} Noon zone fill-in(s)`);
      areas.push(...fills);
    }
  }

  const rows = areas.map((a) => ({
    batch_id: BATCH_ID,
    mode: 'area',
    latitude: a.latitude,
    longitude: a.longitude,
    source_key: a.source_key,
    area_source: a.area_source,
    talabat_area_id: a.talabat_area_id,
    area_name: a.area_name,
    area_name_ar: a.area_name_ar,
    area_slug: a.area_slug,
    status: 'pending',
  }));

  await insertBatch(rows);
  console.log(`[seed] areas: ${rows.length} items inserted for batch ${BATCH_ID}`);
  return rows.length;
}

// ── Main ──────────────────────────────────────────────────────────────────

(async () => {
  if (typeof fetch !== 'function') throw new Error('Node 18+ required');
  if (!['zones', 'areas', 'all'].includes(MODE)) throw new Error(`NOON_MODE must be zones|areas|all, got ${MODE}`);

  console.log(`[seed] mode=${MODE} batch_id=${BATCH_ID}`);

  let totalItems = 0;
  if (MODE === 'zones' || MODE === 'all') totalItems += await seedZones();
  if (MODE === 'areas' || MODE === 'all') totalItems += await seedAreas();

  console.log(`[seed] total: ${totalItems} items seeded`);

  // Print batch_id on its own line so the workflow can capture it.
  console.log(`BATCH_ID=${BATCH_ID}`);
})().catch((e) => {
  console.error('[seed] FATAL:', e);
  process.exit(1);
});
