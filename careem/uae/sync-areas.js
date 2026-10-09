// careem/uae/sync-areas.js
//
// Careem UAE — Area Discovery & Active-Status Sync
//
// Careem has no native area concept, so we take Talabat's 497 UAE areas as
// the reference grid and probe each centroid against Careem's listings
// endpoint. An area is "active" for Careem iff the listings endpoint returns
// at least one restaurant for that lat/lng. A city rolls up as active iff
// any of its areas is active.
//
// Clean-run guarantees:
//   * Probing is strictly serial (concurrency = 1) with a small inter-probe
//     delay, so Careem's rate limiter is never hit. If an unexpected 429 does
//     occur, the script pauses globally for 30s and retries that probe before
//     any further requests go out.
//   * A failed probe NEVER demotes a previously-active area to inactive.
//     is_active and restaurant_count are only updated when the probe actually
//     returned data. The error text is stored in probe_error so we can see
//     which area needs re-probing.
//   * If any area is still errored after all retries, the script exits with
//     a non-zero code so the GitHub Actions run is red — successful probes
//     are still upserted, so a re-run only has to pick up the stragglers.
//   * An area that returns a clean 200 with zero restaurants IS treated as
//     inactive — Careem simply does not operate there.
//
// Data flow:
//   1. Pull the live guest token from Supabase (careem_token_latest() RPC).
//   2. Seed careem_city from a hard-coded Talabat->Careem city map.
//   3. Read all talabat_area rows.
//   4. Probe each area serially with retries. Collect results.
//   5. Upsert the successful probes into careem_area.
//   6. Recompute careem_city.is_active from the fresh area rows.
//   7. If any probe ultimately failed, exit 1; otherwise exit 0.
//
// Env vars:
//   SUPABASE_URL                — required
//   SUPABASE_SERVICE_ROLE_KEY   — required (service_role bypasses RLS)
//   CAREEM_MAX_CONCURRENT       — optional, default 1 (serial, safest)
//   CAREEM_BATCH_DELAY_MS       — optional, default 1500 (ms between probes;
//                                 enforces a per-area minimum spacing)
//   CAREEM_MIN_RESTAURANTS      — optional, default 1 (active cutoff)
//   CAREEM_PROBE_RETRIES        — optional, default 4 (per-probe attempts)
//   CAREEM_RATE_LIMIT_PAUSE_MS  — optional, default 30000 (sleep after 429)
//   CAREEM_ONLY_ERRORED         — optional, "true" to re-probe only areas
//                                 whose previous probe failed (probe_error
//                                 IS NOT NULL OR restaurant_count IS NULL)
//   TEST_MODE / TEST_CITY_ID    — optional, probe only one Talabat city_id

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const UAE_COUNTRY_ID = '27780a1f-e345-4ff8-939a-ef5d879186b1';

const MAX_CONCURRENT = Number(process.env.CAREEM_MAX_CONCURRENT || 1);
const BATCH_DELAY_MS = Number(process.env.CAREEM_BATCH_DELAY_MS || 1500);
const MIN_RESTAURANTS_FOR_ACTIVE = Number(process.env.CAREEM_MIN_RESTAURANTS || 1);
const PROBE_RETRIES = Number(process.env.CAREEM_PROBE_RETRIES || 4);
const RATE_LIMIT_PAUSE_MS = Number(process.env.CAREEM_RATE_LIMIT_PAUSE_MS || 30000);
const ONLY_ERRORED = process.env.CAREEM_ONLY_ERRORED === 'true';
const TEST_MODE = process.env.TEST_MODE === 'true';
const TEST_CITY_ID = process.env.TEST_CITY_ID ? Number(process.env.TEST_CITY_ID) : null;

// ── Device + listings endpoint profile ─────────────────────────────────
// Mirrors the Careem iOS app that minted the current guest token.
// Must stay in sync with careem/uae/test-fetch.js so Careem can't tell
// the two scripts apart.

const DEVICE = {
  app_version: '26.39.0',
  os: 'iOS/27.0.1',
  appengine_api_version: '2026-09-17',
  device_id: 'D0O8gpXoJdQ2L5lC',
};

// Listings endpoint — the component variant takes a page/offset and returns
// a flat list of restaurant cards, which is cleaner for counting than the
// full home-feed tree. Page 1 is enough to decide active/inactive.
const LISTINGS_URL =
  'https://appengine.careemapis.com/v1/page/food-discovery-home/component/v/1/food-discovery-all-restaurants-v2' +
  '?sp_page=1&sp_offset=0&sp_category=food_disc_all_restaurants';

// ── Talabat → Careem city map ──────────────────────────────────────────
// Native Careem serviceAreaIds confirmed via /v2/cities on
// location-service.core.gw.prod.careem-rh.com (see reverse-engineering doc §2).
// Where no Careem ID exists we use -(talabat_city_id) as a stable placeholder
// so the FK into careem_city still resolves; it can be swapped for a real
// Careem ID later without rewriting any areas.

const CITY_MAP = [
  { talabat_city_id: 35,  talabat_name: 'Dubai',        careem_city_id: 1,    careem_name: 'Dubai' },
  { talabat_city_id: 43,  talabat_name: 'Abu Dhabi',    careem_city_id: 21,   careem_name: 'Abu Dhabi' },
  { talabat_city_id: 44,  talabat_name: 'Sharjah',      careem_city_id: 49,   careem_name: 'Sharjah' },
  { talabat_city_id: 48,  talabat_name: 'Ras Al Khaima',careem_city_id: -48,  careem_name: 'Ras Al Khaimah' },
  { talabat_city_id: 49,  talabat_name: 'Al Ain',       careem_city_id: 63,   careem_name: 'Al Ain' },
  { talabat_city_id: 50,  talabat_name: 'Ajman',        careem_city_id: -50,  careem_name: 'Ajman' },
  { talabat_city_id: 96,  talabat_name: 'Fujairah',     careem_city_id: 62,   careem_name: 'Fujairah' },
  { talabat_city_id: 125, talabat_name: 'Umm Al-Quwain',careem_city_id: -125, careem_name: 'Umm Al Quwain' },
];

const TALABAT_TO_CAREEM_CITY = new Map(CITY_MAP.map(r => [r.talabat_city_id, r.careem_city_id]));

// ── Utilities ──────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sessionId() {
  return 'SYNC-' + Math.random().toString(36).slice(2, 10).toUpperCase() + '-NODE';
}

function decodeJwtSub(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/') + '===';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).sub;
  } catch { return null; }
}

// ── Supabase REST helper ───────────────────────────────────────────────

async function supabase(path, opts = {}) {
  const resp = await fetch(SUPABASE_URL + '/rest/v1' + path, {
    method: opts.method || 'GET',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Supabase ${opts.method || 'GET'} ${path} -> ${resp.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getToken() {
  const rows = await supabase('/rpc/careem_token_latest', { method: 'POST' });
  if (!rows || rows.length === 0) throw new Error('careem_token_latest() returned no rows');
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row.access_token) throw new Error('Token row has no access_token');
  const expires = row.expires_at ? new Date(row.expires_at) : null;
  const now = new Date();
  const minsLeft = expires ? Math.round((expires - now) / 60000) : null;
  if (expires && expires < now) {
    throw new Error(`Token expired at ${row.expires_at} (${Math.abs(minsLeft)} min ago)`);
  }
  return {
    access_token: row.access_token,
    jti: row.jwt_jti,
    expires_at: row.expires_at,
    captured_at: row.captured_at,
    mins_left: minsLeft,
  };
}

async function getTalabatAreas() {
  const rows = await supabase(
    '/talabat_area?select=area_id,area_name,area_name_ar,area_slug,city_id,latitude,longitude,geohash' +
    '&latitude=not.is.null&longitude=not.is.null&limit=1000',
    { headers: { Accept: 'application/json' } }
  );
  return rows || [];
}

async function getPreviouslyErroredAreaIds() {
  // Used by CAREEM_ONLY_ERRORED mode: fetch area_ids that need re-probing.
  const rows = await supabase(
    '/careem_area?select=careem_area_id&or=(probe_error.not.is.null,restaurant_count.is.null)&limit=1000',
    { headers: { Accept: 'application/json' } }
  );
  return new Set((rows || []).map(r => r.careem_area_id));
}

async function upsertCities(rows) {
  if (rows.length === 0) return;
  await supabase('/careem_city?on_conflict=careem_city_id', {
    method: 'POST',
    body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
}

async function upsertAreasBatched(records) {
  const BATCH = 50;
  for (let i = 0; i < records.length; i += BATCH) {
    const slice = records.slice(i, i + BATCH);
    try {
      await supabase('/careem_area?on_conflict=careem_area_id', {
        method: 'POST',
        body: slice,
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      });
      console.log(`  upserted ${Math.min(i + BATCH, records.length)}/${records.length}`);
    } catch (e) {
      console.error(`  batch ${i}-${i + BATCH} failed: ${e.message}`);
      // Fall back to per-row upsert so one bad row doesn't lose a batch.
      for (const row of slice) {
        try {
          await supabase('/careem_area?on_conflict=careem_area_id', {
            method: 'POST',
            body: [row],
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          });
        } catch (e2) {
          console.error(`    area_id=${row.careem_area_id} failed: ${e2.message}`);
        }
      }
    }
  }
}

async function updateCityActiveFlags() {
  // Read every area row and roll up per city. The city list is small
  // enough that one PATCH per city is cheaper than a stored proc.
  const rows = await supabase(
    '/careem_area?select=careem_city_id,is_active',
    { headers: { Accept: 'application/json' } }
  );
  const perCity = new Map();
  for (const r of rows || []) {
    const bucket = perCity.get(r.careem_city_id) || { total: 0, active: 0 };
    bucket.total++;
    if (r.is_active) bucket.active++;
    perCity.set(r.careem_city_id, bucket);
  }
  const results = [];
  for (const [cityId, { total, active }] of perCity.entries()) {
    const is_active = active > 0;
    await supabase(`/careem_city?careem_city_id=eq.${cityId}`, {
      method: 'PATCH',
      body: { is_active },
      headers: { Prefer: 'return=minimal' },
    });
    results.push({ careem_city_id: cityId, total, active, is_active });
  }
  return results;
}

// ── Careem probe ───────────────────────────────────────────────────────

function careemHeaders(token, user_id, lat, lng, sessId) {
  return {
    Host: 'appengine.careemapis.com',
    SESSION_ID: sessId,
    'X-Careem-Beta': 'false',
    'User-Agent': 'ICMA/' + DEVICE.app_version,
    'X-Careem-Agent': 'ICMA',
    'X-Careem-Session-Id': sessId,
    Agent: 'ICMA',
    'Time-Zone': 'Asia/Dubai',
    lng: String(lng),
    lat: String(lat),
    'x-careem-userid': String(user_id || ''),
    Version: DEVICE.app_version,
    'X-Careem-Version': DEVICE.app_version,
    'x-careem-user-location': `${lat},${lng}`,
    'x-careem-appengine-api-version': DEVICE.appengine_api_version,
    'X-Careem-Operating-System': DEVICE.os,
    Authorization: 'Bearer ' + token,
    'x-careem-permissions': 'location:granted',
    'Accept-Language': 'en',
    'x-careem-device-id': DEVICE.device_id,
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
  };
}

/**
 * Walk the component response and count anything that looks like a restaurant
 * card. Careem's food-discovery payloads nest cards inside component arrays
 * with varying key names, so instead of hard-coding a path we recurse and
 * count objects that carry (name|title) AND (id|merchant_id|brand_id).
 *
 * This is only a probe — we don't persist the walked rows. Phase 2 does.
 */
function countRestaurants(node, seen = new Set(), depth = 0) {
  if (!node || depth > 20) return seen.size;
  if (Array.isArray(node)) {
    for (const n of node) countRestaurants(n, seen, depth + 1);
    return seen.size;
  }
  if (typeof node !== 'object') return seen.size;

  const name = node.title || node.name || node.brand_name || node.merchant_name;
  const id = node.id || node.merchant_id || node.outlet_id || node.restaurant_id || node.brand_id;
  if (name && id && typeof name === 'string') {
    seen.add(String(id));
  }
  for (const k in node) countRestaurants(node[k], seen, depth + 1);
  return seen.size;
}

async function fetchOnce(token, sub, area) {
  const sessId = sessionId();
  const headers = careemHeaders(token, sub, area.latitude, area.longitude, sessId);
  const t0 = Date.now();
  try {
    const resp = await fetch(LISTINGS_URL, { headers, redirect: 'follow' });
    const text = await resp.text();
    if (resp.status >= 200 && resp.status < 300) {
      // 204 No Content, or any 2xx with an empty body, means Careem answered
      // cleanly with "nothing here" — that's a legitimate inactive signal, not
      // a failure to retry.
      if (resp.status === 204 || !text || text.trim().length === 0) {
        return { ok: true, count: 0, status: resp.status, ms: Date.now() - t0 };
      }
      try {
        const json = JSON.parse(text);
        return { ok: true, count: countRestaurants(json), status: resp.status, ms: Date.now() - t0 };
      } catch (e) {
        return { ok: false, status: resp.status, error: 'JSON parse: ' + e.message, ms: Date.now() - t0 };
      }
    }
    return {
      ok: false,
      status: resp.status,
      error: `HTTP ${resp.status}: ${text.slice(0, 200)}`,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, status: 0, error: 'network: ' + e.message, ms: Date.now() - t0 };
  }
}

/**
 * Probe one area with retries. Backoff schedule for non-429 errors:
 *   attempt 2 → 2s, attempt 3 → 5s, attempt 4 → 10s, attempt 5+ → 20s
 * On HTTP 429 specifically, pause RATE_LIMIT_PAUSE_MS (30s default) so the
 * rate-limit window resets before any further requests go out — the pause
 * is global, driven by the probeArea caller's loop.
 */
async function probeArea(token, sub, area) {
  let last = null;
  for (let attempt = 1; attempt <= PROBE_RETRIES; attempt++) {
    const r = await fetchOnce(token, sub, area);
    if (r.ok) return { ok: true, count: r.count, status: r.status, ms: r.ms, attempts: attempt };
    last = r;
    // On the last attempt, don't sleep further — we return the failure.
    if (attempt === PROBE_RETRIES) break;
    if (r.status === 429) {
      console.warn(`    [429] area_id=${area.area_id} rate-limited — pausing ${RATE_LIMIT_PAUSE_MS}ms`);
      await sleep(RATE_LIMIT_PAUSE_MS);
    } else {
      const backoff = [2000, 5000, 10000, 20000][attempt - 1] || 20000;
      console.warn(`    [${r.status || 'net'}] area_id=${area.area_id} attempt ${attempt}/${PROBE_RETRIES} — sleep ${backoff}ms`);
      await sleep(backoff);
    }
  }
  return {
    ok: false,
    status: last ? last.status : 0,
    error: last ? last.error : 'unknown',
    ms: last ? last.ms : 0,
    attempts: PROBE_RETRIES,
  };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log('===================================================');
  console.log(' Careem UAE — Area active-status sync');
  console.log('===================================================');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Config:  concurrency=${MAX_CONCURRENT}  delay=${BATCH_DELAY_MS}ms  retries=${PROBE_RETRIES}  rate_pause=${RATE_LIMIT_PAUSE_MS}ms  only_errored=${ONLY_ERRORED}\n`);

  // 1. Token
  console.log('STEP 1: Pull token from Supabase');
  const tok = await getToken();
  const sub = decodeJwtSub(tok.access_token);
  console.log(`  jti=${(tok.jti || '').slice(0, 8)} sub=${sub || '?'} mins_left=${tok.mins_left}\n`);

  // 2. Seed cities (upsert, don't touch is_active yet — step 6 recomputes it)
  console.log('STEP 2: Seed careem_city');
  const cityRows = CITY_MAP.map(c => ({
    careem_city_id:   c.careem_city_id,
    careem_city_name: c.careem_name,
    country_id:       UAE_COUNTRY_ID,
    talabat_city_id:  c.talabat_city_id,
  }));
  await upsertCities(cityRows);
  console.log(`  upserted ${cityRows.length} cities\n`);

  // 3. Load Talabat reference areas
  console.log('STEP 3: Load talabat_area reference grid');
  let areas = await getTalabatAreas();
  console.log(`  loaded ${areas.length} Talabat areas`);
  if (TEST_MODE && TEST_CITY_ID != null) {
    areas = areas.filter(a => a.city_id === TEST_CITY_ID);
    console.log(`  TEST_MODE: filtered to Talabat city_id=${TEST_CITY_ID} → ${areas.length} areas`);
  }
  if (ONLY_ERRORED) {
    const errored = await getPreviouslyErroredAreaIds();
    areas = areas.filter(a => errored.has(a.area_id));
    console.log(`  CAREEM_ONLY_ERRORED: filtered to ${areas.length} previously-errored areas`);
  }
  if (areas.length === 0) {
    console.log('No areas to probe — exiting cleanly.');
    return;
  }

  // 4. Probe each area serially with retries. Collect successes and failures.
  console.log(`\nSTEP 4: Probe ${areas.length} areas`);
  const successes = [];
  const failures = [];
  const nowIso = new Date().toISOString();
  let probed = 0;
  const probeOne = async (area) => {
    const careemCityId = TALABAT_TO_CAREEM_CITY.get(area.city_id);
    if (careemCityId == null) {
      console.warn(`  area_id=${area.area_id} has unknown talabat city_id=${area.city_id} — skipping`);
      return;
    }
    const r = await probeArea(tok.access_token, sub, area);
    if (r.ok) {
      const isActive = r.count >= MIN_RESTAURANTS_FOR_ACTIVE;
      successes.push({
        careem_area_id:   area.area_id,
        area_name:        area.area_name,
        area_name_ar:     area.area_name_ar,
        area_slug:        area.area_slug,
        careem_city_id:   careemCityId,
        latitude:         area.latitude,
        longitude:        area.longitude,
        geohash:          area.geohash,
        is_active:        isActive,
        restaurant_count: r.count,
        last_probed_at:   nowIso,
        probe_error:      null,
      });
    } else {
      // On failure, DO NOT touch is_active / restaurant_count. Only record
      // the error text and the attempt time, so a previously-active area is
      // never silently demoted to inactive by a transient 429 or 5xx.
      failures.push({
        area_id:       area.area_id,
        area_name:     area.area_name,
        careem_city_id:careemCityId,
        status:        r.status,
        error:         r.error,
        attempts:      r.attempts,
      });
    }
  };

  // Serial path (default). The pool path handles concurrency > 1 if ever set.
  if (MAX_CONCURRENT <= 1) {
    for (const area of areas) {
      await probeOne(area);
      probed++;
      if (probed % 25 === 0 || probed === areas.length) {
        console.log(`  progress ${probed}/${areas.length}  ok=${successes.length} fail=${failures.length}`);
      }
      if (probed < areas.length) await sleep(BATCH_DELAY_MS);
    }
  } else {
    for (let i = 0; i < areas.length; i += MAX_CONCURRENT) {
      const batch = areas.slice(i, i + MAX_CONCURRENT);
      await Promise.all(batch.map(probeOne));
      probed += batch.length;
      if (probed % 25 === 0 || probed >= areas.length) {
        console.log(`  progress ${probed}/${areas.length}  ok=${successes.length} fail=${failures.length}`);
      }
      if (probed < areas.length) await sleep(BATCH_DELAY_MS);
    }
  }

  // 5. Upsert the successful probes (and mark error-only rows for failures
  // so operators can see which areas still need re-probing).
  console.log(`\nSTEP 5: Upsert ${successes.length} successful area rows`);
  await upsertAreasBatched(successes);

  if (failures.length > 0) {
    console.log(`\nSTEP 5b: Record probe_error on ${failures.length} failed area(s) (is_active NOT changed)`);
    // Build minimal rows that just set probe_error + last_probed_at. Insert
    // via upsert so first-time failures still create the row (with other
    // columns NULL). careem_city_id is required (NOT NULL) so include it.
    const errRows = failures.map(f => ({
      careem_area_id:  f.area_id,
      area_name:       f.area_name,
      careem_city_id:  f.careem_city_id,
      probe_error:     `[attempts=${f.attempts}] ${f.error}`,
      last_probed_at:  nowIso,
    }));
    await upsertAreasBatched(errRows);
  }

  // 6. Roll up city.is_active
  console.log('\nSTEP 6: Recompute careem_city.is_active');
  const cityRollup = await updateCityActiveFlags();
  for (const r of cityRollup) {
    const city = CITY_MAP.find(c => c.careem_city_id === r.careem_city_id);
    const label = city ? city.careem_name : `city_id=${r.careem_city_id}`;
    console.log(`  ${label.padEnd(20)} active=${r.active}/${r.total}  → is_active=${r.is_active}`);
  }

  // 7. Summary + exit code
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n===================================================');
  console.log(' Summary');
  console.log('===================================================');
  console.log(`  Areas probed    : ${areas.length}`);
  console.log(`  Succeeded       : ${successes.length}`);
  console.log(`  Failed          : ${failures.length}`);
  console.log(`  Elapsed         : ${elapsed}s`);
  console.log(`  Finished        : ${new Date().toISOString()}`);

  if (failures.length > 0) {
    console.log('\nFailed areas (listed; is_active left unchanged):');
    // Group by city, cap listing per city to keep logs short
    const byCity = new Map();
    for (const f of failures) {
      if (!byCity.has(f.careem_city_id)) byCity.set(f.careem_city_id, []);
      byCity.get(f.careem_city_id).push(f);
    }
    for (const [cid, list] of byCity.entries()) {
      const city = CITY_MAP.find(c => c.careem_city_id === cid);
      const label = city ? city.careem_name : `city_id=${cid}`;
      console.log(`  ${label}: ${list.length} failed`);
      for (const f of list.slice(0, 8)) {
        console.log(`    area_id=${f.area_id}  "${f.area_name}"  status=${f.status}  err=${(f.error || '').slice(0, 120)}`);
      }
      if (list.length > 8) console.log(`    ... and ${list.length - 8} more`);
    }
    console.log('\nRe-run with CAREEM_ONLY_ERRORED=true to retry just these areas.');
    process.exit(1);
  }
  console.log('\nClean run — all areas probed successfully.');
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  console.error(e.stack);
  process.exit(1);
});
