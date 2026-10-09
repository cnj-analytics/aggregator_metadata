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
// Data flow:
//   1. Pull the live guest token from Supabase (careem_token_latest() RPC).
//   2. Seed careem_city from a hard-coded Talabat→Careem city map. The 5
//      known Careem serviceAreaIds (Dubai=1, Abu Dhabi=21, Sharjah=49,
//      Al Ain=63, Fujairah=62) are used where available; the other three
//      Talabat emirates get negative placeholder IDs.
//   3. Read all talabat_area rows (bulk, keyed on area_id, name, city_id,
//      lat/lng, geohash).
//   4. Probe each area against Careem food-discovery with the area centroid
//      in the lat/lng headers. We fetch page 1 only and count the restaurant
//      cards in the response — enough to decide active/inactive. Full catalog
//      pulls, dedup, and radius-overlap handling are phase 2.
//   5. Upsert all 497 areas into careem_area with is_active + restaurant_count
//      + last_probed_at.
//   6. Recompute careem_city.is_active from the fresh area rows.
//
// Env vars:
//   SUPABASE_URL                — required
//   SUPABASE_SERVICE_ROLE_KEY   — required (service_role bypasses RLS)
//   CAREEM_MAX_CONCURRENT       — optional, default 5
//   CAREEM_BATCH_DELAY_MS       — optional, default 150
//   CAREEM_MIN_RESTAURANTS      — optional, default 1 (active cutoff)
//   TEST_MODE / TEST_CITY_ID    — optional, probe only one Talabat city_id
//
// Run locally (Node 20+):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node careem/uae/sync-areas.js
//
// In CI: wire into a GitHub Actions workflow mirroring the Careem test-fetch
// one (same two secrets). Not every run needs the full probe — once a week
// is plenty for coverage drift.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const UAE_COUNTRY_ID = '27780a1f-e345-4ff8-939a-ef5d879186b1';

const MAX_CONCURRENT = Number(process.env.CAREEM_MAX_CONCURRENT || 5);
const BATCH_DELAY_MS = Number(process.env.CAREEM_BATCH_DELAY_MS || 150);
const MIN_RESTAURANTS_FOR_ACTIVE = Number(process.env.CAREEM_MIN_RESTAURANTS || 1);
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
  // One SQL round-trip per city via PostgREST — simpler than a stored proc
  // and the city list is small. The rpc path is unavailable without a
  // custom function, so we read area counts and PATCH each city.
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

async function probeArea(token, sub, area) {
  const sessId = sessionId();
  const headers = careemHeaders(token, sub, area.latitude, area.longitude, sessId);
  const t0 = Date.now();
  let status, bytes, count = 0, error = null;
  try {
    const resp = await fetch(LISTINGS_URL, { headers, redirect: 'follow' });
    status = resp.status;
    const text = await resp.text();
    bytes = text.length;
    if (resp.ok) {
      try {
        const json = JSON.parse(text);
        count = countRestaurants(json);
      } catch (e) {
        error = 'JSON parse: ' + e.message;
      }
    } else {
      error = `HTTP ${status}: ${text.slice(0, 200)}`;
    }
  } catch (e) {
    error = e.message;
  }
  return { status, bytes, count, error, ms: Date.now() - t0 };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log('===================================================');
  console.log(' Careem UAE — Area active-status sync');
  console.log('===================================================');
  console.log(`Started: ${new Date().toISOString()}\n`);

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
  if (areas.length === 0) {
    console.error('ABORT: no areas to probe');
    process.exit(1);
  }

  // 4. Probe each area (concurrency MAX_CONCURRENT, serial batches)
  console.log(`\nSTEP 4: Probe ${areas.length} areas (concurrency=${MAX_CONCURRENT}, delay=${BATCH_DELAY_MS}ms)`);
  const records = [];
  const now = new Date().toISOString();
  let active = 0, inactive = 0, errored = 0;
  for (let i = 0; i < areas.length; i += MAX_CONCURRENT) {
    const batch = areas.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(batch.map(a => probeArea(tok.access_token, sub, a)));
    for (let j = 0; j < batch.length; j++) {
      const area = batch[j];
      const r = results[j];
      const careemCityId = TALABAT_TO_CAREEM_CITY.get(area.city_id);
      if (careemCityId == null) {
        console.warn(`  area_id=${area.area_id} has unknown talabat city_id=${area.city_id} — skipping`);
        continue;
      }
      const probeOk = r.status === 200 && !r.error;
      const isActive = probeOk && r.count >= MIN_RESTAURANTS_FOR_ACTIVE;
      if (!probeOk) errored++;
      else if (isActive) active++;
      else inactive++;

      records.push({
        careem_area_id:   area.area_id,
        area_name:        area.area_name,
        area_name_ar:     area.area_name_ar,
        area_slug:        area.area_slug,
        careem_city_id:   careemCityId,
        latitude:         area.latitude,
        longitude:        area.longitude,
        geohash:          area.geohash,
        is_active:        isActive,
        restaurant_count: probeOk ? r.count : null,
        last_probed_at:   now,
      });
    }
    // Progress + pacing
    if ((i + MAX_CONCURRENT) % 50 === 0 || i + MAX_CONCURRENT >= areas.length) {
      console.log(
        `  progress ${Math.min(i + MAX_CONCURRENT, areas.length)}/${areas.length}` +
        `  active=${active} inactive=${inactive} errored=${errored}`
      );
    }
    if (i + MAX_CONCURRENT < areas.length && BATCH_DELAY_MS > 0) await sleep(BATCH_DELAY_MS);
  }

  // 5. Upsert all area probe results
  console.log(`\nSTEP 5: Upsert ${records.length} area rows`);
  await upsertAreasBatched(records);

  // 6. Roll up city.is_active
  console.log('\nSTEP 6: Recompute careem_city.is_active');
  const cityRollup = await updateCityActiveFlags();
  for (const r of cityRollup) {
    const city = CITY_MAP.find(c => c.careem_city_id === r.careem_city_id);
    const label = city ? city.careem_name : `city_id=${r.careem_city_id}`;
    console.log(`  ${label.padEnd(20)} active=${r.active}/${r.total}  → is_active=${r.is_active}`);
  }

  // 7. Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n===================================================');
  console.log(' Summary');
  console.log('===================================================');
  console.log(`  Areas probed    : ${records.length}`);
  console.log(`  Active          : ${active}`);
  console.log(`  Inactive        : ${inactive}`);
  console.log(`  Errored         : ${errored}`);
  console.log(`  Elapsed         : ${elapsed}s`);
  console.log(`  Finished        : ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  console.error(e.stack);
  process.exit(1);
});
