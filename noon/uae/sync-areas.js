#!/usr/bin/env node
// noon/uae/sync-areas.js
//
// Noon Food (UAE) — City / Hub / Zone discovery and Area active-status sync.
//
// READ FIRST: noon/readme.md (auth flow, headers, "How Noon geography works").
//
// Noon's geography, as observed (2026-10-11):
//   * Native hierarchy lives in the food zone code returned by
//     whoami?experience=food, e.g. FOOD-AE-DXB-HUB4-DUBAI_MARINA
//       country AE / city DXB / hub 4 / zone DUBAI_MARINA.
//   * Noon has NO native area level (no IDs, names or URLs). The restaurant
//     list depends on the exact coordinates (snapped internally to hidden
//     points), not on the zone. The zone header only gates serviceability.
//   * Noon also returns a zone for sea / desert points, so a zone existing
//     does not mean restaurants are listed there.
//
// So this script has two modes (NOON_MODE):
//
//   zones  Grid-scan the UAE. For every point: set location -> read the food
//          zone code. Parse city/hub/zone and upsert noon_city, noon_hub,
//          noon_zone (representative point, bbox, hit count, last_seen_at).
//          Two passes: a coarse pass over the whole UAE bounding box (catches
//          outlying towns) and a dense pass over the populated regions.
//
//   areas  For every Talabat UAE area centroid (talabat_area), plus one
//          fill-in point for each Noon zone that has no Talabat area in it:
//          set location -> read zone -> fetch the FIRST page of listings.
//          Upsert noon_area: zone/hub/city links, is_active (>= MIN restaurants
//          listed), first-page count and a fingerprint of the first page.
//          Then call noon_refresh_active() to roll active up
//          area -> zone -> hub -> city.
//
//   all    zones, then areas.
//
// Safety rules (same spirit as careem/uae/sync-areas.js):
//   * Zone scan aborts WITHOUT writing if too many points fail.
//   * A failed area probe never demotes a previously active area: is_active is
//     left untouched and probe_error is set. The job exits 1 so it shows red;
//     re-run with NOON_ONLY_ERRORED=true to retry just those rows.
//   * Listing calls are serial with a delay; HTTP 429 pauses globally.
//
// Auth: sessions come from Supabase RPC noon_mint_session(lat, lng)
// (5-minute JWT). Each worker re-mints every ~4 minutes. To query another
// point the session is re-located (set-location + whoami?experience=food)
// using the minted cookies — the same steps 2-3 the RPC performs.
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   NOON_MODE                 zones | areas | all            (default all)
//   NOON_COARSE_STEP          deg, whole-UAE pass            (default 0.05)
//   NOON_DENSE_STEP           deg, populated regions pass    (default 0.01)
//   NOON_ZONE_CONCURRENCY     parallel location lookups      (default 4)
//   NOON_ZONE_DELAY_MS        delay per lookup per worker    (default 100)
//   NOON_MAX_ERROR_RATE       abort zone scan above this     (default 0.05)
//   NOON_AREA_DELAY_MS        delay between area probes      (default 1500)
//   NOON_PROBE_RETRIES        attempts per area probe        (default 4)
//   NOON_RATE_LIMIT_PAUSE_MS  global pause after HTTP 429    (default 30000)
//   NOON_MIN_RESTAURANTS      restaurants for active         (default 1)
//   NOON_ONLY_ERRORED         'true' = re-probe only errored / never-probed areas
//   TEST_CITY_ID              Talabat city_id: probe only that city's areas
//                             (areas mode; skips zone fill-ins)

'use strict';

const crypto = require('node:crypto');

// ── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const UAE_COUNTRY_ID = '27780a1f-e345-4ff8-939a-ef5d879186b1'; // aggregator_country

const MODE = (process.env.NOON_MODE || 'all').toLowerCase();
const COARSE_STEP = num('NOON_COARSE_STEP', 0.05);
const DENSE_STEP = num('NOON_DENSE_STEP', 0.01);
const ZONE_CONCURRENCY = num('NOON_ZONE_CONCURRENCY', 4);
const ZONE_DELAY_MS = num('NOON_ZONE_DELAY_MS', 100);
const MAX_ERROR_RATE = num('NOON_MAX_ERROR_RATE', 0.05);
const AREA_DELAY_MS = num('NOON_AREA_DELAY_MS', 1500);
const PROBE_RETRIES = num('NOON_PROBE_RETRIES', 4);
const RATE_LIMIT_PAUSE_MS = num('NOON_RATE_LIMIT_PAUSE_MS', 30000);
const MIN_RESTAURANTS = num('NOON_MIN_RESTAURANTS', 1);
const ONLY_ERRORED = process.env.NOON_ONLY_ERRORED === 'true';
const TEST_CITY_ID = process.env.TEST_CITY_ID ? Number(process.env.TEST_CITY_ID) : null;

// Same app identity as noon/uae/test-fetch.js and noon_mint_session().
const UA = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const BUILD = '22098';

const SET_LOCATION_URL = 'https://api-app.noon.com/_vs/st/mp-identity-api-geo/serviceable-geo-info/set-location-by-lat-lng';
const WHOAMI_FOOD_URL = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami?experience=food&select_nearby=1';
const SEARCH_URL = 'https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/search';

// Zone code format: FOOD-AE-<CITY>-HUB<n>-<ZONE_KEY>
const ZONE_RE = /^FOOD-AE-([A-Z]+)-HUB(\d+)-(.+)$/;

// Noon only gives city codes. Readable names + the matching Talabat city
// (talabat_city.city_id) where Talabat has that city. Unknown codes are still
// stored, with a null name, and logged so this map can be extended.
const CITY_INFO = {
  DXB: { name: 'Dubai',          talabat: 35 },
  AUH: { name: 'Abu Dhabi',      talabat: 43 },
  SHJ: { name: 'Sharjah',        talabat: 44 },
  RAK: { name: 'Ras Al Khaimah', talabat: 48 },
  AAN: { name: 'Al Ain',         talabat: 49 },
  QAJ: { name: 'Ajman',          talabat: 50 },
  FUJ: { name: 'Fujairah',       talabat: 96 },
  UAQ: { name: 'Umm Al Quwain',  talabat: 125 },
  DIB: { name: 'Dibba',          talabat: null },
  MDZ: { name: 'Madinat Zayed',  talabat: null },
  RUW: { name: 'Ruwais',         talabat: null },
  ADH: { name: 'Al Dhaid',       talabat: null },
};

// Coarse pass: whole UAE bounding box (points outside UAE simply return no zone).
const UAE_BOX = { name: 'UAE (coarse)', latMin: 22.6, latMax: 26.1, lngMin: 51.5, lngMax: 56.4 };

// Dense pass: populated regions (same boxes as deliveroo/uae/sync-areas.js,
// widened where the coarse Noon scan showed zones beyond them).
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

// ── Small utilities ─────────────────────────────────────────────────────────

function num(name, dflt) {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : Number(v);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d = 6) => Number(x.toFixed(d));

function zoneName(key) {
  return key.toLowerCase().split('_').filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function parseZone(code) {
  const m = ZONE_RE.exec(code || '');
  if (!m) return null;
  const [, city, hub, key] = m;
  return { code, city, hubNumber: Number(hub), hubId: `${city}-HUB${Number(hub)}`, key, name: zoneName(key) };
}

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
function encodeGeohash(lat, lng, precision = 7) {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = '', bit = 0, ch = 0, isLng = true;
  while (hash.length < precision) {
    if (isLng) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { ch |= 1 << (4 - bit); lngMin = mid; } else lngMax = mid;
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch |= 1 << (4 - bit); latMin = mid; } else latMax = mid;
    }
    isLng = !isLng;
    if (++bit === 5) { hash += GEOHASH_BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}

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

async function upsert(table, onConflict, rows, batchSize = 200) {
  for (let i = 0; i < rows.length; i += batchSize) {
    await supabase(`/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      body: rows.slice(i, i + batchSize),
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
  }
}

// ── Noon session + location ─────────────────────────────────────────────────

class RateLimited extends Error {}

async function mintSession(lat = 25.078058170938117, lng = 55.15337817083452) {
  const s = await supabase('/rpc/noon_mint_session', { method: 'POST', body: { p_lat: lat, p_lng: lng } });
  if (!s || s.ok !== true) throw new Error(`noon_mint_session ok=false: ${s && s.error}`);
  return { ...s, mintedAt: Date.now() };
}

// One worker = one Noon guest session, re-minted before the 5-minute JWT lapses.
class NoonWorker {
  constructor(id) { this.id = id; this.session = null; }
  async ensure() {
    const exp = this.session && this.session.nguestv2_exp ? Date.parse(this.session.nguestv2_exp) : 0;
    if (!this.session || Date.now() > Math.min(exp - 60000, this.session.mintedAt + 240000)) {
      this.session = await mintSession();
    }
    return this.session;
  }
}

function baseHeaders(session, lat, lng) {
  return {
    'User-Agent': UA,
    'x-platform': 'ios',
    'x-build': BUILD,
    'x-mp': 'noon',
    'x-content': 'mobile',
    'x-locale': 'en-ae',
    'x-device-id': session.device_id,
    'x-visitor-id': session.visitor_id,
    'x-device-lat': String(lat),
    'x-device-lng': String(lng),
    Accept: 'application/json',
  };
}

function mergeSetCookies(jar, resp) {
  const list = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const c of list) {
    const m = /^([^=]+)=([^;]+)/.exec(c);
    if (m) jar[m[1]] = m[2];
  }
}
const cookieString = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

// Re-locate a minted session to (lat, lng): set-location, then whoami?experience=food.
// Returns the zone headers + cookies to use for food calls at that point.
async function locate(worker, lat, lng) {
  const session = await worker.ensure();
  const jar = { ...(session.cookies || {}) };
  const h = { ...baseHeaders(session, lat, lng), 'x-experience': 'ecom' };

  const r1 = await fetch(SET_LOCATION_URL, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json', Cookie: cookieString(jar) },
    body: JSON.stringify({ location: { lat, lng }, lang: 'en' }),
  });
  if (r1.status === 429) throw new RateLimited('set-location 429');
  if (!r1.ok) throw new Error(`set-location HTTP ${r1.status}`);
  const setloc = await r1.json().catch(() => ({}));
  mergeSetCookies(jar, r1);

  const r2 = await fetch(WHOAMI_FOOD_URL, {
    headers: { ...h, 'x-whoami-request-id': crypto.randomUUID(), Cookie: cookieString(jar) },
  });
  if (r2.status === 429) throw new RateLimited('whoami 429');
  if (!r2.ok) throw new Error(`whoami food HTTP ${r2.status}`);
  const who = await r2.json();
  mergeSetCookies(jar, r2);

  const zoneHeaders = who && who.headers && typeof who.headers === 'object' ? who.headers : {};
  return {
    session, lat, lng,
    foodZone: zoneHeaders['x-food-zonecode'] || null,
    zoneHeaders,
    cookie: cookieString(jar),
    resolvedAddress: setloc.area || null,
    geoCityId: Number.isInteger(setloc.cityId) ? setloc.cityId : null,
  };
}

// First page of the outlet listing at a located point (same request as test-fetch.js).
async function firstListingPage(loc) {
  const { session, lat, lng } = loc;
  const headers = {
    ...baseHeaders(session, lat, lng),
    'x-mp-country': 'ae',
    'x-experience': 'food',
    'x-lat': String(Math.round(lat * 1e7)),
    'x-lng': String(Math.round(lng * 1e7)),
    'x-border-enabled': 'true',
    'x-rocket-enabled': 'true',
    'x-whoami-request-id': crypto.randomUUID(),
    Cookie: loc.cookie,
    'Content-Type': 'application/json',
  };
  for (const [k, v] of Object.entries(loc.zoneHeaders)) {
    if (v !== null && typeof v !== 'object' && !k.toLowerCase().includes('ab-test')) headers[k] = String(v);
  }
  const body = {
    queryEntity: null, q: null, f: {}, contexts: [], withContent: true,
    excludeOutletCodes: [], limit: 60, page: 1,
    sort: { by: 'popularity', dir: 'desc' },
    type: 'outlet', qType: 'search_query', getFallback: true,
  };
  const resp = await fetch(SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (resp.status === 429) throw new RateLimited('search 429');
  // Noon answers 404 "unserviceable area" where it does not deliver: a clean "no restaurants".
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`search HTTP ${resp.status}`);
  const json = await resp.json();
  const outlets = [];
  (function walk(x, depth) {
    if (depth > 8 || !x) return;
    if (Array.isArray(x)) { for (const v of x) walk(v, depth + 1); return; }
    if (typeof x === 'object') {
      if (typeof x.outletCode === 'string' && x.outletCode) { outlets.push(x); return; }
      for (const k of Object.keys(x)) walk(x[k], depth + 1);
    }
  })(json.results || [], 0);
  return outlets;
}

// ── Mode: zones ─────────────────────────────────────────────────────────────

async function scanPoints(points, label) {
  const results = [];
  let next = 0, errors = 0, done = 0;
  let pauseUntil = 0;
  const started = Date.now();

  async function run(worker) {
    while (next < points.length) {
      const [lat, lng] = points[next++];
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        if (Date.now() < pauseUntil) await sleep(pauseUntil - Date.now());
        try {
          const loc = await locate(worker, lat, lng);
          results.push({ lat, lng, zone: loc.foodZone });
          ok = true;
        } catch (e) {
          if (e instanceof RateLimited) {
            pauseUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
            console.log(`[zones] 429 — pausing all workers ${RATE_LIMIT_PAUSE_MS / 1000}s`);
          } else {
            await sleep(1000 * attempt);
            if (attempt === 3) console.log(`[zones]   point ${lat},${lng} failed: ${e.message}`);
          }
        }
      }
      if (!ok) errors++;
      if (++done % 500 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        console.log(`[zones]   ${label}: ${done}/${points.length} points (${rate.toFixed(1)}/s, ${errors} failed)`);
      }
      await sleep(ZONE_DELAY_MS);
    }
  }

  const workers = Array.from({ length: ZONE_CONCURRENCY }, (_, i) => new NoonWorker(i));
  await Promise.all(workers.map(run));
  console.log(`[zones] ${label}: ${points.length} points, ${errors} failed, ${results.filter((r) => r.zone).length} with a food zone`);
  return { results, errors };
}

async function syncZones() {
  console.log(`[zones] coarse step ${COARSE_STEP}°, dense step ${DENSE_STEP}°, concurrency ${ZONE_CONCURRENCY}`);
  const seen = new Set();
  const points = [];
  const add = (p) => { const k = p.join(','); if (!seen.has(k)) { seen.add(k); points.push(p); } };
  gridPoints(UAE_BOX, COARSE_STEP).forEach(add);
  const coarseCount = points.length;
  for (const r of DENSE_REGIONS) gridPoints(r, DENSE_STEP).forEach(add);
  console.log(`[zones] ${points.length} grid points (${coarseCount} coarse + ${points.length - coarseCount} dense)`);

  const { results, errors } = await scanPoints(points, 'grid');
  const errorRate = errors / points.length;
  if (errorRate > MAX_ERROR_RATE) {
    throw new Error(`zone scan error rate ${(errorRate * 100).toFixed(1)}% > ${MAX_ERROR_RATE * 100}% — nothing written`);
  }

  // Group hits by zone code.
  const zones = new Map();
  const unparsed = new Map();
  for (const r of results) {
    if (!r.zone) continue;
    const z = parseZone(r.zone);
    if (!z) { unparsed.set(r.zone, (unparsed.get(r.zone) || 0) + 1); continue; }
    if (!zones.has(z.code)) zones.set(z.code, { ...z, hits: [] });
    zones.get(z.code).hits.push([r.lat, r.lng]);
  }
  if (unparsed.size) console.log(`[zones] WARNING unrecognised zone codes (not stored): ${JSON.stringify(Object.fromEntries(unparsed))}`);
  if (zones.size === 0) throw new Error('zone scan found no zones — nothing written');

  const now = new Date().toISOString();
  const cityRows = new Map(), hubRows = new Map(), zoneRows = [];
  for (const z of zones.values()) {
    if (!CITY_INFO[z.city]) console.log(`[zones] WARNING new city code ${z.city} — add it to CITY_INFO`);
    cityRows.set(z.city, {
      noon_city_code: z.city,
      noon_city_name: CITY_INFO[z.city] ? CITY_INFO[z.city].name : null,
      country_id: UAE_COUNTRY_ID,
      talabat_city_id: CITY_INFO[z.city] ? CITY_INFO[z.city].talabat : null,
      last_seen_at: now,
    });
    hubRows.set(z.hubId, { noon_hub_id: z.hubId, noon_city_code: z.city, hub_number: z.hubNumber, last_seen_at: now });

    const lats = z.hits.map((h) => h[0]), lngs = z.hits.map((h) => h[1]);
    const cLat = lats.reduce((a, b) => a + b, 0) / lats.length;
    const cLng = lngs.reduce((a, b) => a + b, 0) / lngs.length;
    // Representative point = an actual grid hit (guaranteed inside the zone), nearest the centre.
    let rep = z.hits[0], best = Infinity;
    for (const h of z.hits) {
      const d = (h[0] - cLat) ** 2 + (h[1] - cLng) ** 2;
      if (d < best) { best = d; rep = h; }
    }
    zoneRows.push({
      noon_zone_code: z.code,
      noon_hub_id: z.hubId,
      noon_city_code: z.city,
      zone_key: z.key,
      zone_name: z.name,
      latitude: rep[0],
      longitude: rep[1],
      geohash: encodeGeohash(rep[0], rep[1]),
      grid_hit_count: z.hits.length,
      min_latitude: Math.min(...lats),
      max_latitude: Math.max(...lats),
      min_longitude: Math.min(...lngs),
      max_longitude: Math.max(...lngs),
      last_seen_at: now,
    });
  }

  await upsert('noon_city', 'noon_city_code', [...cityRows.values()]);
  await upsert('noon_hub', 'noon_hub_id', [...hubRows.values()]);
  await upsert('noon_zone', 'noon_zone_code', zoneRows);

  console.log(`[zones] upserted ${cityRows.size} cities, ${hubRows.size} hubs, ${zoneRows.length} zones`);
  const byCity = {};
  for (const z of zoneRows) byCity[z.noon_city_code] = (byCity[z.noon_city_code] || 0) + 1;
  console.log(`[zones] zones per city: ${JSON.stringify(byCity)}`);

  const stale = await supabase(`/noon_zone?select=noon_zone_code,last_seen_at&last_seen_at=lt.${encodeURIComponent(now)}`);
  if (stale.length) console.log(`[zones] ${stale.length} zone(s) in the table were NOT seen in this scan (kept, last_seen_at unchanged): ${stale.map((z) => z.noon_zone_code).join(', ')}`);
}

// ── Mode: areas ─────────────────────────────────────────────────────────────

// Make sure a zone seen during area probing exists (FK), even if the last zone
// scan missed it (small zones can fall between grid points).
async function ensureZoneRows(zoneCodes, knownZones) {
  const missing = [...zoneCodes].filter((c) => !knownZones.has(c));
  if (!missing.length) return;
  const now = new Date().toISOString();
  const cities = new Map(), hubs = new Map(), zones = [];
  for (const code of missing) {
    const z = parseZone(code);
    if (!z) continue;
    cities.set(z.city, {
      noon_city_code: z.city,
      noon_city_name: CITY_INFO[z.city] ? CITY_INFO[z.city].name : null,
      country_id: UAE_COUNTRY_ID,
      talabat_city_id: CITY_INFO[z.city] ? CITY_INFO[z.city].talabat : null,
      last_seen_at: now,
    });
    hubs.set(z.hubId, { noon_hub_id: z.hubId, noon_city_code: z.city, hub_number: z.hubNumber, last_seen_at: now });
    zones.push({ noon_zone_code: z.code, noon_hub_id: z.hubId, noon_city_code: z.city, zone_key: z.key, zone_name: z.name, last_seen_at: now });
  }
  await upsert('noon_city', 'noon_city_code', [...cities.values()]);
  await upsert('noon_hub', 'noon_hub_id', [...hubs.values()]);
  await upsert('noon_zone', 'noon_zone_code', zones);
  for (const z of zones) knownZones.add(z.noon_zone_code);
  console.log(`[areas] added ${zones.length} zone(s) not found by the last zone scan: ${zones.map((z) => z.noon_zone_code).join(', ')}`);
}

async function probeArea(worker, area, state) {
  let lastErr = null;
  for (let attempt = 1; attempt <= PROBE_RETRIES; attempt++) {
    if (Date.now() < state.pauseUntil) await sleep(state.pauseUntil - Date.now());
    try {
      const loc = await locate(worker, area.latitude, area.longitude);
      const zone = loc.foodZone && parseZone(loc.foodZone) ? loc.foodZone : null;
      const outlets = zone ? await firstListingPage(loc) : [];
      const fingerprint = outlets.length
        ? crypto.createHash('md5').update(outlets.map((o) => `${o.outletCode}:${o.distance ?? ''}`).join('|')).digest('hex')
        : null;
      return { ok: true, zone, loc, count: outlets.length, fingerprint };
    } catch (e) {
      lastErr = e;
      if (e instanceof RateLimited) {
        state.pauseUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
        console.log(`[areas] 429 — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s`);
      } else {
        await sleep(2000 * attempt);
      }
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'unknown error' };
}

async function probeAreaList(areas, knownZones, label) {
  const worker = new NoonWorker('areas');
  const state = { pauseUntil: 0 };
  const okRows = [], errRows = [];
  let active = 0, failed = 0;

  const flush = async () => {
    const zonesSeen = new Set(okRows.map((r) => r.noon_zone_code).filter(Boolean));
    await ensureZoneRows(zonesSeen, knownZones);
    if (okRows.length) await upsert('noon_area', 'source_key', okRows.splice(0));
    if (errRows.length) await upsert('noon_area', 'source_key', errRows.splice(0));
  };

  for (let i = 0; i < areas.length; i++) {
    const a = areas[i];
    const res = await probeArea(worker, a, state);
    const base = {
      source_key: a.source_key,
      area_source: a.area_source,
      talabat_area_id: a.talabat_area_id,
      area_name: a.area_name,
      area_name_ar: a.area_name_ar,
      area_slug: a.area_slug,
      latitude: a.latitude,
      longitude: a.longitude,
      geohash: encodeGeohash(a.latitude, a.longitude),
      last_probed_at: new Date().toISOString(),
    };
    if (res.ok) {
      const z = res.zone ? parseZone(res.zone) : null;
      const isActive = res.count >= MIN_RESTAURANTS;
      if (isActive) active++;
      okRows.push({
        ...base,
        noon_zone_code: z ? z.code : null,
        noon_hub_id: z ? z.hubId : null,
        noon_city_code: z ? z.city : null,
        noon_geo_city_id: res.loc.geoCityId,
        noon_resolved_address: res.loc.resolvedAddress,
        is_active: isActive,
        restaurant_count_page1: res.count,
        listing_fingerprint: res.fingerprint,
        probe_error: null,
      });
      console.log(`[areas] ${String(i + 1).padStart(4)}/${areas.length} ${isActive ? '✓' : '·'} ${a.area_name.padEnd(40).slice(0, 40)} ${z ? z.code : '(no zone)'}  ${res.count} on page 1`);
    } else {
      failed++;
      // Leave is_active / zone / counts untouched: only record the error.
      errRows.push({ ...base, probe_error: res.error.slice(0, 500) });
      console.log(`[areas] ${String(i + 1).padStart(4)}/${areas.length} ✗ ${a.area_name}  ERROR: ${res.error}`);
    }
    if (okRows.length + errRows.length >= 25) await flush();
    await sleep(AREA_DELAY_MS);
  }
  await flush();
  console.log(`[areas] ${label}: ${areas.length} probed, ${active} active, ${failed} failed`);
  return { failed };
}

async function syncAreas() {
  const knownZones = new Set((await selectAll('noon_zone', 'noon_zone_code')).map((z) => z.noon_zone_code));
  if (!knownZones.size) console.log('[areas] WARNING noon_zone is empty — run mode=zones first (zones will be added as found, but there will be no fill-in points)');

  let areas;
  if (ONLY_ERRORED) {
    const rows = await selectAll('noon_area',
      'source_key,area_source,talabat_area_id,area_name,area_name_ar,area_slug,latitude,longitude',
      '&or=(probe_error.not.is.null,last_probed_at.is.null)');
    areas = rows;
    console.log(`[areas] re-probing ${areas.length} errored / never-probed area(s)`);
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
    console.log(`[areas] probing ${areas.length} Talabat area(s)${TEST_CITY_ID ? ` (Talabat city_id=${TEST_CITY_ID})` : ''}`);
  }

  let { failed } = await probeAreaList(areas, knownZones, ONLY_ERRORED ? 'errored areas' : 'talabat areas');

  // Fill-ins: one point per Noon zone that no Talabat area falls in.
  if (!ONLY_ERRORED && !TEST_CITY_ID) {
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
    console.log(`[areas] ${fills.length} Noon zone(s) have no Talabat area — probing a fill-in point for each`);
    if (fills.length) failed += (await probeAreaList(fills, knownZones, 'zone fill-ins')).failed;
  }

  const summary = await supabase('/rpc/noon_refresh_active', { method: 'POST', body: {} });
  console.log(`[areas] roll-up: ${JSON.stringify(summary)}`);

  const dupes = await supabase('/noon_area?select=listing_fingerprint&listing_fingerprint=not.is.null');
  const fp = new Map();
  for (const r of dupes) fp.set(r.listing_fingerprint, (fp.get(r.listing_fingerprint) || 0) + 1);
  console.log(`[areas] ${dupes.length} active areas map to ${fp.size} distinct first-page listings`);

  return failed;
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  if (typeof fetch !== 'function') throw new Error('Node 18+ required');
  if (!['zones', 'areas', 'all'].includes(MODE)) throw new Error(`NOON_MODE must be zones|areas|all, got ${MODE}`);
  console.log(`[noon] sync-areas mode=${MODE}`);
  let failed = 0;
  if (MODE === 'zones' || MODE === 'all') await syncZones();
  if (MODE === 'areas' || MODE === 'all') failed = await syncAreas();
  if (failed > 0) {
    console.error(`[noon] ${failed} area probe(s) failed — re-run with only_errored=true`);
    process.exit(1);
  }
  console.log('[noon] done');
})().catch((e) => {
  console.error('[noon] FATAL:', e);
  process.exit(1);
});
