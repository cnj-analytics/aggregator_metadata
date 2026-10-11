#!/usr/bin/env node
// noon/uae/queue-finalize.js
//
// Reads completed ('done') items from noon_work_queue for a batch, aggregates
// them into the noon_city / noon_hub / noon_zone / noon_area tables, and calls
// noon_refresh_active() to roll active status up.
//
// This is the last step in the orchestrated workflow, run after all workers
// have finished (or been IP-blocked and released their remaining work).
//
// Zone items:
//   Parse zone codes, compute representative points and bounding boxes,
//   upsert noon_city, noon_hub, noon_zone — same logic as sync-areas.js.
//
// Area items:
//   Upsert noon_area with zone link, restaurant count, fingerprint, etc.
//   Ensure FK zone rows exist (zones discovered during area probing may not
//   have been in the grid scan).
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   NOON_BATCH_ID                              required
//   NOON_MIN_RESTAURANTS                       (default 1)
//   NOON_MAX_ERROR_RATE                        (default 0.05, zones only)

'use strict';

const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const BATCH_ID = process.env.NOON_BATCH_ID;
if (!BATCH_ID) { console.error('Missing NOON_BATCH_ID'); process.exit(1); }

const MIN_RESTAURANTS = Number(process.env.NOON_MIN_RESTAURANTS || '1');
const MAX_ERROR_RATE = Number(process.env.NOON_MAX_ERROR_RATE || '0.05');

const UAE_COUNTRY_ID = '27780a1f-e345-4ff8-939a-ef5d879186b1';

const ZONE_RE = /^FOOD-AE-([A-Z]+)-HUB(\d+)-(.+)$/;
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

// ── Utilities ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseZone(code) {
  const m = ZONE_RE.exec(code || '');
  if (!m) return null;
  const [, city, hub, key] = m;
  return { code, city, hubNumber: Number(hub), hubId: `${city}-HUB${Number(hub)}`, key, name: zoneName(key) };
}

function zoneName(key) {
  return key.toLowerCase().split('_').filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
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

// ── Finalize: zones ─────────────────────────────────────────────────────────

async function finalizeZones(items) {
  const total = items.length;
  const errors = items.filter((i) => i.status === 'error').length;
  const done = items.filter((i) => i.status === 'done');

  console.log(`[finalize] zones: ${total} total, ${done.length} done, ${errors} errors`);

  // Check error rate (only among items that were attempted = done + error).
  const attempted = done.length + errors;
  if (attempted > 0) {
    const errorRate = errors / attempted;
    if (errorRate > MAX_ERROR_RATE) {
      throw new Error(`zone error rate ${(errorRate * 100).toFixed(1)}% > ${MAX_ERROR_RATE * 100}% — nothing written`);
    }
  }

  // Group hits by zone code.
  const zones = new Map();
  const unparsed = new Map();
  for (const item of done) {
    const r = item.result;
    if (!r || !r.zone) continue;
    const z = parseZone(r.zone);
    if (!z) { unparsed.set(r.zone, (unparsed.get(r.zone) || 0) + 1); continue; }
    if (!zones.has(z.code)) zones.set(z.code, { ...z, hits: [] });
    zones.get(z.code).hits.push([r.lat || item.latitude, r.lng || item.longitude]);
  }

  if (unparsed.size) console.log(`[finalize] WARNING unrecognised zone codes: ${JSON.stringify(Object.fromEntries(unparsed))}`);
  if (zones.size === 0) {
    console.log('[finalize] no valid zones found — nothing to write');
    return;
  }

  const now = new Date().toISOString();
  const cityRows = new Map(), hubRows = new Map(), zoneRows = [];

  for (const z of zones.values()) {
    if (!CITY_INFO[z.city]) console.log(`[finalize] WARNING new city code ${z.city} — add it to CITY_INFO`);
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

  console.log(`[finalize] upserted ${cityRows.size} cities, ${hubRows.size} hubs, ${zoneRows.length} zones`);
  const byCity = {};
  for (const z of zoneRows) byCity[z.noon_city_code] = (byCity[z.noon_city_code] || 0) + 1;
  console.log(`[finalize] zones per city: ${JSON.stringify(byCity)}`);
}

// ── Finalize: areas ─────────────────────────────────────────────────────────

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
  console.log(`[finalize] ensured ${zones.length} zone(s) not in the table: ${zones.map((z) => z.noon_zone_code).join(', ')}`);
}

async function finalizeAreas(items) {
  const done = items.filter((i) => i.status === 'done');
  const errors = items.filter((i) => i.status === 'error');
  console.log(`[finalize] areas: ${items.length} total, ${done.length} done, ${errors.length} errors`);

  const knownZones = new Set((await selectAll('noon_zone', 'noon_zone_code')).map((z) => z.noon_zone_code));

  // Ensure FK zone rows exist for all zones seen in results.
  const zonesSeen = new Set();
  for (const item of done) {
    const r = item.result;
    if (r && r.zone) zonesSeen.add(r.zone);
  }
  await ensureZoneRows(zonesSeen, knownZones);

  // Build area rows from completed items.
  const okRows = [];
  const errRows = [];
  let active = 0;

  for (const item of done) {
    const r = item.result;
    const z = r && r.zone ? parseZone(r.zone) : null;
    const isActive = (r && r.count >= MIN_RESTAURANTS);
    if (isActive) active++;

    okRows.push({
      source_key: item.source_key,
      area_source: item.area_source,
      talabat_area_id: item.talabat_area_id,
      area_name: item.area_name,
      area_name_ar: item.area_name_ar,
      area_slug: item.area_slug,
      latitude: item.latitude,
      longitude: item.longitude,
      geohash: encodeGeohash(item.latitude, item.longitude),
      noon_zone_code: z ? z.code : null,
      noon_hub_id: z ? z.hubId : null,
      noon_city_code: z ? z.city : null,
      noon_geo_city_id: r ? r.geo_city_id : null,
      noon_resolved_address: r ? r.resolved_address : null,
      is_active: isActive,
      restaurant_count_page1: r ? r.count : null,
      listing_fingerprint: r ? r.fingerprint : null,
      last_probed_at: new Date().toISOString(),
      probe_error: null,
    });
  }

  // Error items: only update probe_error (leave is_active unchanged).
  for (const item of errors) {
    errRows.push({
      source_key: item.source_key,
      area_source: item.area_source,
      talabat_area_id: item.talabat_area_id,
      area_name: item.area_name,
      area_name_ar: item.area_name_ar,
      area_slug: item.area_slug,
      latitude: item.latitude,
      longitude: item.longitude,
      geohash: encodeGeohash(item.latitude, item.longitude),
      last_probed_at: new Date().toISOString(),
      probe_error: (item.error || 'unknown error').slice(0, 500),
    });
  }

  if (okRows.length) await upsert('noon_area', 'source_key', okRows);
  if (errRows.length) await upsert('noon_area', 'source_key', errRows);

  console.log(`[finalize] upserted ${okRows.length} area results (${active} active) + ${errRows.length} error markers`);

  // Roll up active status.
  const summary = await supabase('/rpc/noon_refresh_active', { method: 'POST', body: {} });
  console.log(`[finalize] roll-up: ${JSON.stringify(summary)}`);

  // Fingerprint analysis.
  const dupes = await supabase('/noon_area?select=listing_fingerprint&listing_fingerprint=not.is.null');
  const fp = new Map();
  for (const r of dupes) fp.set(r.listing_fingerprint, (fp.get(r.listing_fingerprint) || 0) + 1);
  console.log(`[finalize] ${dupes.length} active areas map to ${fp.size} distinct first-page listings`);

  return errors.length;
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  if (typeof fetch !== 'function') throw new Error('Node 18+ required');

  console.log(`[finalize] batch_id=${BATCH_ID}`);

  // Get queue status.
  const status = await supabase('/rpc/noon_queue_status', { method: 'POST', body: { p_batch_id: BATCH_ID } });
  console.log(`[finalize] queue status: ${JSON.stringify(status)}`);

  if (status.pending > 0 || status.claimed > 0) {
    console.log(`[finalize] WARNING: ${status.pending} pending + ${status.claimed} claimed items remain — some work was not completed`);
  }

  // Read all items for this batch.
  const allItems = await selectAll('noon_work_queue',
    'id,batch_id,mode,latitude,longitude,source_key,area_source,talabat_area_id,area_name,area_name_ar,area_slug,status,result,error',
    `&batch_id=eq.${encodeURIComponent(BATCH_ID)}`);

  const zoneItems = allItems.filter((i) => i.mode === 'zone');
  const areaItems = allItems.filter((i) => i.mode === 'area');

  let failed = 0;
  if (zoneItems.length > 0) await finalizeZones(zoneItems);
  if (areaItems.length > 0) failed = await finalizeAreas(areaItems);

  console.log(`[finalize] done`);

  if (failed > 0) {
    console.error(`[finalize] ${failed} area probe(s) failed — re-run with only_errored=true`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('[finalize] FATAL:', e);
  process.exit(1);
});
