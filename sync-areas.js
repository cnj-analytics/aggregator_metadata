// sync-areas.js
//
// Deliveroo UAE Area Discovery & Sync
//
// Scans all UAE bounding boxes via the Deliveroo Location API,
// derives enrichment data (geohash, lat/lng, active status) from grid scan results,
// and upserts complete records to Supabase.
//
// The code owns ALL decisions. Supabase receives and stores.
//
// Architecture: the Location API grid scan is the single source of truth.
// - An area that appears in the scan is ACTIVE (Deliveroo serves it).
// - An area that was previously known but no longer appears is INACTIVE.
// - Geohash and lat/lng are computed from the centroid of grid hits.
// - No page scraping is needed â avoids PerimeterX bot detection and 429s.

// --- Config -----------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UAE_COUNTRY_ID = '27780a1f-e345-4ff8-939a-ef5d879186b1';

const TEST_MODE = process.env.TEST_MODE === 'true';
const TEST_REGION = process.env.TEST_REGION || 'Ajman'; // small emirate, fast scan

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// --- City Map ---------------------------------------------------------------
// city_id -> { name, slug } for all known UAE emirates.
// Includes Fujairah and UAQ as placeholders â IDs unknown until they activate.

const CITY_MAP = {
  40:   { name: 'Dubai',           slug: 'dubai' },
  148:  { name: 'Abu Dhabi',       slug: 'abu-dhabi' },
  586:  { name: 'Sharjah',         slug: 'sharjah' },
  1123: { name: 'Al Ain',          slug: 'al-ain' },
  2407: { name: 'Ajman',           slug: 'ajman' },
  2541: { name: 'Ras Al Khaimah',  slug: 'ras-al-khaimah' },
};

// Names and slugs for cities that don't exist yet â used when a new city_id appears
const POTENTIAL_CITIES = [
  { name: 'Fujairah',       slug: 'fujairah' },
  { name: 'Umm Al Quwain',  slug: 'umm-al-quwain' },
];

// --- Bounding Boxes ---------------------------------------------------------
// 0.008 deg spacing â 800-900m. All 9 emirates scanned every run.

const REGIONS = [
  { name: 'Dubai',            latMin: 24.82, latMax: 25.36, lngMin: 54.89, lngMax: 55.55 },
  { name: 'Abu Dhabi',        latMin: 24.35, latMax: 24.55, lngMin: 54.30, lngMax: 54.80 },
  { name: 'Abu Dhabi North',  latMin: 24.55, latMax: 24.70, lngMin: 54.55, lngMax: 54.75 },
  { name: 'Sharjah',          latMin: 25.28, latMax: 25.42, lngMin: 55.30, lngMax: 55.55 },
  { name: 'Al Ain',           latMin: 24.16, latMax: 24.30, lngMin: 55.68, lngMax: 55.82 },
  { name: 'Ajman',            latMin: 25.38, latMax: 25.44, lngMin: 55.42, lngMax: 55.52 },
  { name: 'Ras Al Khaimah',   latMin: 25.72, latMax: 25.84, lngMin: 55.92, lngMax: 56.02 },
  { name: 'Fujairah',         latMin: 25.10, latMax: 25.16, lngMin: 56.32, lngMax: 56.38 },
  { name: 'Umm Al Quwain',    latMin: 25.54, latMax: 25.58, lngMin: 55.55, lngMax: 55.60 },
];

const GRID_STEP = 0.008;
const MAX_CONCURRENT = 5;      // Location API has no rate limiting â 5 is polite
const BATCH_DELAY_MS = 100;    // Small pause between batches for good citizenship

const LOCATION_API = 'https://api.ae.deliveroo.com/orderapp/v1/location';
const AREA_PAGE_BASE = 'https://deliveroo.ae/en/restaurants';

// --- Utilities --------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildAreaUrl(citySlug, areaSlug) {
  return `${AREA_PAGE_BASE}/${citySlug}/${areaSlug}`;
}

// --- Geohash Encoding -------------------------------------------------------
// Pure implementation â no external dependencies required.
// Encodes (lat, lng) to a geohash string of the given precision (default 7).

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function encodeGeohash(lat, lng, precision = 7) {
  let latMin = -90, latMax = 90;
  let lngMin = -180, lngMax = 180;
  let hash = '';
  let bit = 0;
  let ch = 0;
  let isLng = true;

  while (hash.length < precision) {
    if (isLng) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        ch |= (1 << (4 - bit));
        lngMin = mid;
      } else {
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        ch |= (1 << (4 - bit));
        latMin = mid;
      } else {
        latMax = mid;
      }
    }

    isLng = !isLng;
    bit++;

    if (bit === 5) {
      hash += GEOHASH_BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }

  return hash;
}

// --- Location API Scanning --------------------------------------------------

function generateGridPoints(region) {
  const points = [];
  for (let lat = region.latMin; lat <= region.latMax; lat += GRID_STEP) {
    for (let lng = region.lngMin; lng <= region.lngMax; lng += GRID_STEP) {
      points.push({ lat: parseFloat(lat.toFixed(6)), lng: parseFloat(lng.toFixed(6)) });
    }
  }
  return points;
}

async function queryLocationAPI(lat, lng) {
  try {
    const resp = await fetch(`${LOCATION_API}?lat=${lat}&lng=${lng}`);
    if (!resp.ok) return null; // 404 = not in any delivery zone
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Scans all regions and collects every grid hit per neighborhood.
 * Returns a Map of neighborhood.id -> { id, name, slug, cityId, hits: [{lat, lng}] }
 * where `hits` contains every grid point that returned this neighborhood.
 */
async function scanAllRegions() {
  const neighborhoods = new Map(); // neighborhood.id -> data
  const regionsToScan = TEST_MODE
    ? REGIONS.filter(r => r.name === TEST_REGION)
    : REGIONS;

  if (TEST_MODE) {
    console.log(`TEST MODE: scanning only ${TEST_REGION}\n`);
  }

  let totalPoints = 0;
  let totalHits = 0;

  for (const region of regionsToScan) {
    const points = generateGridPoints(region);
    totalPoints += points.length;
    console.log(`Scanning ${region.name} â ${points.length} grid points`);

    let regionNewCount = 0;

    for (let i = 0; i < points.length; i += MAX_CONCURRENT) {
      const batch = points.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(
        batch.map(p => queryLocationAPI(p.lat, p.lng))
      );

      // Progress logging every 200 points
      if (i > 0 && i % 200 === 0) {
        console.log(`  Progress: ${i}/${points.length} (${((i / points.length) * 100).toFixed(0)}%)`);
      }

      // Polite delay between batches
      if (BATCH_DELAY_MS > 0) await sleep(BATCH_DELAY_MS);

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (!r || !r.neighborhood) continue;
        totalHits++;
        const id = r.neighborhood.id;

        if (!neighborhoods.has(id)) {
          neighborhoods.set(id, {
            id,
            name: r.neighborhood.name,
            slug: r.neighborhood.uname,
            cityId: r.zone.city_id,
            hits: [],
          });
          regionNewCount++;
        }

        // Record the grid point that found this neighborhood
        neighborhoods.get(id).hits.push({
          lat: batch[j].lat,
          lng: batch[j].lng,
        });
      }
    }

    console.log(`  â ${regionNewCount} unique neighborhoods found`);
  }

  console.log(`\nGrid scan complete: ${totalPoints} points queried, ${totalHits} hits, ${neighborhoods.size} unique neighborhoods\n`);
  return neighborhoods;
}

// --- Enrichment from Grid Data ----------------------------------------------

/**
 * Compute centroid (average lat/lng) and geohash from grid hits.
 * For areas with many hits, the centroid is a good approximation of the
 * area's center. For areas with few hits, it's still the best we have.
 */
function computeEnrichment(hits) {
  if (!hits || hits.length === 0) return { latitude: null, longitude: null, geohash: null };

  const sumLat = hits.reduce((s, h) => s + h.lat, 0);
  const sumLng = hits.reduce((s, h) => s + h.lng, 0);
  const latitude = parseFloat((sumLat / hits.length).toFixed(6));
  const longitude = parseFloat((sumLng / hits.length).toFixed(6));
  const geohash = encodeGeohash(latitude, longitude);

  return { latitude, longitude, geohash };
}

// --- New City Detection -----------------------------------------------------

function resolveNewCity(cityId, neighborhoodNames) {
  // Try matching against known potential cities
  for (const pc of POTENTIAL_CITIES) {
    const lower = pc.name.toLowerCase();
    if (neighborhoodNames.some(n => n.toLowerCase().includes(lower))) {
      CITY_MAP[cityId] = { name: pc.name, slug: pc.slug };
      console.log(`  Mapped new city_id ${cityId} â ${pc.name} (${pc.slug})`);
      return CITY_MAP[cityId];
    }
  }

  // Fallback: derive from first neighborhood name (often prefixed with city name)
  if (neighborhoodNames.length > 0) {
    const first = neighborhoodNames[0];
    const parts = first.split(' ');
    if (parts.length >= 2) {
      const name = parts[0];
      const slug = name.toLowerCase().replace(/\s+/g, '-');
      CITY_MAP[cityId] = { name, slug };
      console.log(`  Derived new city_id ${cityId} â ${name} (${slug}) from "${first}"`);
      return CITY_MAP[cityId];
    }
  }

  console.error(`  WARNING: Cannot resolve city for city_id=${cityId}. Areas in this city will be skipped.`);
  return null;
}

// --- Supabase Operations ----------------------------------------------------

async function supabase(path, method, body = null, extraHeaders = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(`Supabase ${method} ${path} â ${resp.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function upsertCities(cityIds) {
  const rows = [];
  for (const id of cityIds) {
    const city = CITY_MAP[id];
    if (!city) continue;
    rows.push({
      deliveroo_city_id: id,
      deliveroo_city_name: city.name,
      deliveroo_country_id: UAE_COUNTRY_ID,
    });
  }
  if (rows.length === 0) return;

  console.log(`Upserting ${rows.length} cities to Supabase...`);
  await supabase('/deliveroo_city?on_conflict=deliveroo_city_id', 'POST', rows, {
    'Prefer': 'resolution=merge-duplicates',
  });
}

async function upsertAreas(records) {
  const BATCH = 50;
  console.log(`Upserting ${records.length} area records to Supabase...`);

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(records.length / BATCH);

    try {
      await supabase('/deliveroo_area?on_conflict=deliveroo_area_id', 'POST', batch, {
        'Prefer': 'resolution=merge-duplicates',
      });
      console.log(`  Batch ${batchNum}/${totalBatches} â ${batch.length} rows`);
    } catch (e) {
      console.error(`  Batch ${batchNum} failed: ${e.message}`);
      // Fall back to individual upserts so one bad row doesn't block the rest
      for (const row of batch) {
        try {
          await supabase('/deliveroo_area?on_conflict=deliveroo_area_id', 'POST', [row], {
            'Prefer': 'resolution=merge-duplicates',
          });
        } catch (e2) {
          console.error(`  Failed: ${row.deliveroo_area_slug} â ${e2.message}`);
        }
      }
    }
  }
}

async function getExistingAreas() {
  const rows = await supabase(
    '/deliveroo_area?select=deliveroo_area_id,deliveroo_area_slug,deliveroo_area_is_active,deliveroo_city_id,deliveroo_area_geohash,deliveroo_area_latitude,deliveroo_area_longitude&limit=10000',
    'GET',
    null,
    { 'Accept': 'application/json' }
  );
  return rows || [];
}

async function markInactive(areaIds) {
  if (areaIds.length === 0) return;

  console.log(`Marking ${areaIds.length} areas as inactive...`);
  const BATCH = 100;
  for (let i = 0; i < areaIds.length; i += BATCH) {
    const ids = areaIds.slice(i, i + BATCH).join(',');
    await supabase(
      `/deliveroo_area?deliveroo_area_id=in.(${ids})`,
      'PATCH',
      { deliveroo_area_is_active: false }
    );
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  console.log('===================================================');
  console.log('  Deliveroo UAE â Area Discovery & Sync');
  console.log('===================================================');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // -- Step 1: Grid scan -----------------------------------------------------
  console.log('STEP 1: Location API grid scan\n');
  const neighborhoods = await scanAllRegions();

  if (neighborhoods.size === 0) {
    console.error('ABORT: Zero neighborhoods discovered. Location API may be unreachable.');
    process.exit(1);
  }

  // -- Step 2: Compute enrichment from grid data -----------------------------
  console.log('STEP 2: Compute enrichment (centroid + geohash)\n');
  for (const n of neighborhoods.values()) {
    const enrichment = computeEnrichment(n.hits);
    n.latitude = enrichment.latitude;
    n.longitude = enrichment.longitude;
    n.geohash = enrichment.geohash;
    console.log(`  ${n.name}: ${n.hits.length} hits â lat=${n.latitude}, lng=${n.longitude}, geohash=${n.geohash}`);
  }

  // -- Step 3: Resolve cities ------------------------------------------------
  console.log('\nSTEP 3: City resolution\n');
  const cityIds = new Set();
  for (const n of neighborhoods.values()) {
    cityIds.add(n.cityId);
  }

  const unknownIds = [...cityIds].filter(id => !CITY_MAP[id]);
  if (unknownIds.length > 0) {
    console.log(`New city IDs detected: ${unknownIds.join(', ')}`);
    for (const uid of unknownIds) {
      const names = [...neighborhoods.values()]
        .filter(n => n.cityId === uid)
        .map(n => n.name);
      resolveNewCity(uid, names);
    }
  } else {
    console.log('All city IDs known.');
  }

  await upsertCities([...cityIds]);

  // -- Step 4: Read existing table for comparison ----------------------------
  console.log('\nSTEP 4: Read existing table\n');
  const existingAreas = await getExistingAreas();
  const existingMap = new Map();
  for (const row of existingAreas) {
    existingMap.set(row.deliveroo_area_id, row);
  }
  console.log(`Existing table: ${existingAreas.length} rows (${existingAreas.filter(r => r.deliveroo_area_is_active).length} active)\n`);

  // -- Step 5: Build records -------------------------------------------------
  // Every area found in the grid scan is active â the Location API returned it.
  // For existing areas that already have enrichment data (geohash, lat/lng),
  // preserve the existing values unless the computed ones are better.
  console.log('STEP 5: Build area records\n');
  const records = [];

  for (const n of neighborhoods.values()) {
    const citySlug = CITY_MAP[n.cityId]?.slug;
    if (!citySlug) {
      console.log(`  SKIP: ${n.name} â city_id ${n.cityId} unresolved`);
      continue;
    }

    const existing = existingMap.get(n.id);

    // For geohash/lat/lng: prefer existing values if present (they may have
    // come from a more precise source), otherwise use the computed centroid.
    const geohash = existing?.deliveroo_area_geohash || n.geohash;
    const latitude = existing?.deliveroo_area_latitude || n.latitude;
    const longitude = existing?.deliveroo_area_longitude || n.longitude;

    records.push({
      deliveroo_area_id: n.id,
      deliveroo_area_name: n.name,
      deliveroo_area_slug: n.slug,
      deliveroo_city_id: n.cityId,
      deliveroo_area_geohash: geohash ?? null,
      deliveroo_area_latitude: latitude ?? null,
      deliveroo_area_longitude: longitude ?? null,
      deliveroo_area_url: buildAreaUrl(citySlug, n.slug),
      deliveroo_area_is_active: true,  // present in grid scan = active
    });
  }

  const newCount = records.filter(r => !existingMap.has(r.deliveroo_area_id)).length;
  console.log(`Built ${records.length} records (${newCount} new)`);

  // -- Step 6: Upsert all records --------------------------------------------
  console.log('\nSTEP 6: Upsert to Supabase\n');
  await upsertAreas(records);

  // -- Step 7: Mark inactive â areas in table but not in scan ----------------
  console.log('\nSTEP 7: Mark inactive areas\n');
  const discoveredIds = new Set(neighborhoods.keys());

  // In test mode, only deactivate areas within the scanned cities so that
  // scanning one emirate doesn't wipe out the rest of the country.
  const scannedCityIds = new Set([...neighborhoods.values()].map(n => n.cityId));

  const toDeactivate = existingAreas
    .filter(a => {
      if (!a.deliveroo_area_is_active) return false; // already inactive
      if (discoveredIds.has(a.deliveroo_area_id)) return false; // found in scan
      if (TEST_MODE && !scannedCityIds.has(a.deliveroo_city_id)) return false;
      return true;
    })
    .map(a => a.deliveroo_area_id);

  if (toDeactivate.length > 0) {
    await markInactive(toDeactivate);
    const slugs = toDeactivate.map(id => {
      const existing = existingMap.get(id);
      return existing?.deliveroo_area_slug || id;
    });
    console.log(`  Deactivated ${toDeactivate.length} area(s): ${slugs.join(', ')}`);
  } else {
    console.log('  No areas to deactivate.');
  }

  // -- Summary ---------------------------------------------------------------
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('\n===================================================');
  console.log('  Summary');
  console.log('===================================================');
  console.log(`  Discovered: ${neighborhoods.size} neighborhoods`);
  console.log(`  Active:     ${records.length}`);
  console.log(`  New areas:  ${newCount}`);
  console.log(`  Deactivated: ${toDeactivate.length}`);
  console.log(`  Runtime:    ${elapsed} minutes`);
  console.log(`  Finished:   ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  process.exit(1);
});
