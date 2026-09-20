// sync-areas.js
//
// Deliveroo UAE Area Discovery & Sync
//
// Scans all UAE bounding boxes via the Deliveroo Location API,
// fetches each area's page for enrichment data (geohash, lat/lng, active status),
// and upserts complete records to Supabase.
//
// The code owns ALL decisions. Supabase receives and stores.

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
// Includes Fujairah and UAQ as placeholders -- IDs unknown until they activate.

const CITY_MAP = {
  40:   { name: 'Dubai',           slug: 'dubai' },
  148:  { name: 'Abu Dhabi',       slug: 'abu-dhabi' },
  586:  { name: 'Sharjah',         slug: 'sharjah' },
  1123: { name: 'Al Ain',          slug: 'al-ain' },
  2407: { name: 'Ajman',           slug: 'ajman' },
  2541: { name: 'Ras Al Khaimah',  slug: 'ras-al-khaimah' },
};

// Names and slugs for cities that don't exist yet -- used when a new city_id appears
const POTENTIAL_CITIES = [
  { name: 'Fujairah',       slug: 'fujairah' },
  { name: 'Umm Al Quwain',  slug: 'umm-al-quwain' },
];

// --- Bounding Boxes ---------------------------------------------------------
// 0.008 deg spacing -- 800-900m. All 9 emirates scanned every run.

const REGIONS = [
  { name: 'Dubai',           latMin: 24.82, latMax: 25.36, lngMin: 54.89, lngMax: 55.55 },
  { name: 'Abu Dhabi',       latMin: 24.35, latMax: 24.55, lngMin: 54.30, lngMax: 54.80 },
  { name: 'Abu Dhabi North', latMin: 24.55, latMax: 24.70, lngMin: 54.55, lngMax: 54.75 },
  { name: 'Sharjah',         latMin: 25.28, latMax: 25.42, lngMin: 55.30, lngMax: 55.55 },
  { name: 'Al Ain',          latMin: 24.16, latMax: 24.30, lngMin: 55.68, lngMax: 55.82 },
  { name: 'Ajman',           latMin: 25.38, latMax: 25.44, lngMin: 55.42, lngMax: 55.52 },
  { name: 'Ras Al Khaimah',  latMin: 25.72, latMax: 25.84, lngMin: 55.92, lngMax: 56.02 },
  { name: 'Fujairah',        latMin: 25.10, latMax: 25.16, lngMin: 56.32, lngMax: 56.38 },
  { name: 'Umm Al Quwain',   latMin: 25.54, latMax: 25.58, lngMin: 55.55, lngMax: 55.60 },
];

const GRID_STEP = 0.008;
const MAX_CONCURRENT = 1;
const PAGE_FETCH_DELAY_MS = TEST_MODE ? 2000 : 5000;   // more polite in full runs
const MAX_RETRIES = TEST_MODE ? 3 : 5;                 // full run: try harder
const INITIAL_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 60000;                       // cap backoff at 60s
const BATCH_PAUSE_EVERY = TEST_MODE ? 25 : 15;         // full run: smaller batches
const BATCH_PAUSE_MS = TEST_MODE ? 10000 : 30000;      // full run: 30s between batches

const LOCATION_API = 'https://api.ae.deliveroo.com/orderapp/v1/location';
const AREA_PAGE_BASE = 'https://deliveroo.ae/en/restaurants';
const URL_PARAMS = '?collection=restaurants&collection=all-restaurants';

// --- Utilities --------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildAreaUrl(citySlug, areaSlug) {
  return `${AREA_PAGE_BASE}/${citySlug}/${areaSlug}${URL_PARAMS}`;
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
    console.log(`Scanning ${region.name} -- ${points.length} grid points`);

    let regionNewCount = 0;

    for (let i = 0; i < points.length; i += MAX_CONCURRENT) {
      const batch = points.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(
        batch.map(p => queryLocationAPI(p.lat, p.lng))
      );

      for (const r of results) {
        if (!r || !r.neighborhood) continue;
        totalHits++;
        const id = r.neighborhood.id;
        if (!neighborhoods.has(id)) {
          neighborhoods.set(id, {
            id,
            name: r.neighborhood.name,
            slug: r.neighborhood.uname,
            zoneId: r.zone.id,
            cityId: r.zone.city_id,
            apiLat: r.coordinates.lat,
            apiLng: r.coordinates.lng,
          });
          regionNewCount++;
        }
      }
    }

    console.log(`  -> ${regionNewCount} unique neighborhoods found`);
  }

  console.log(`\nGrid scan complete: ${totalPoints} points queried, ${totalHits} hits, ${neighborhoods.size} unique neighborhoods\n`);
  return neighborhoods;
}

// --- Area Page Fetching & Enrichment ----------------------------------------

async function fetchWithRetry(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AreaSync/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });

      if (resp.status === 429) {
        const delay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
        console.log(`    429 rate limited -- retrying in ${delay / 1000}s`);
        await sleep(delay);
        continue;
      }

      return resp;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
        console.log(`    Fetch error (${e.message}) -- retrying in ${delay / 1000}s`);
        await sleep(delay);
      }
    }
  }
  return null;
}

function extractPageData(html) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s
  );
  if (!match) return null;

  try {
    const data = JSON.parse(match[1]);
    const meta = data?.props?.initialState?.home?.feed?.meta;
    const location = meta?.location;
    const restaurantCount = meta?.restaurantCount;

    // restaurantCount.results reflects the number of restaurants listed in this
    // area. Active areas have restaurants registered; inactive areas (concourses,
    // beaches, placeholder zones) always have 0.
    const hasRestaurants = (restaurantCount?.results || 0) > 0;

    return {
      geohash: location?.geohash || null,
      latitude: location?.lat || null,
      longitude: location?.lon || null,
      hasRestaurants,
      restaurantCount: restaurantCount?.results || 0,
    };
  } catch (e) {
    console.log(`    __NEXT_DATA__ parse error: ${e.message}`);
    return null;
  }
}

/**
 * Fetch an area's page to determine:
 * - is_active -- based on restaurantCount > 0 from __NEXT_DATA__.
 *   Active areas have restaurants registered; inactive areas (concourses,
 *   beaches, placeholder zones) always have restaurantCount = 0.
 * - geohash, latitude, longitude (from __NEXT_DATA__)
 *
 * Returns { isActive, geohash, latitude, longitude, restaurantCount, fetchFailed }
 */
async function enrichArea(citySlug, areaSlug) {
  const url = buildAreaUrl(citySlug, areaSlug);

  try {
    const resp = await fetchWithRetry(url);

    // Page fetch completely failed after retries
    if (!resp) {
      return { isActive: null, geohash: null, latitude: null, longitude: null, fetchFailed: true };
    }

    // 404 or other error status -- inactive
    if (!resp.ok) {
      return { isActive: false, geohash: null, latitude: null, longitude: null, fetchFailed: false };
    }

    const html = await resp.text();
    const pageData = extractPageData(html);

    // No __NEXT_DATA__ or can't parse -- inactive
    if (!pageData) {
      return { isActive: false, geohash: null, latitude: null, longitude: null, fetchFailed: false };
    }

    // Active = restaurantCount > 0 (area has restaurants registered to it).
    // Inactive areas (airport concourses, beaches, etc.) always have 0.
    const isActive = pageData.hasRestaurants;

    return {
      isActive,
      geohash: pageData.geohash,
      latitude: pageData.latitude,
      longitude: pageData.longitude,
      restaurantCount: pageData.restaurantCount,
      fetchFailed: false,
    };
  } catch (e) {
    console.log(`    Enrichment error for ${areaSlug}: ${e.message}`);
    return { isActive: null, geohash: null, latitude: null, longitude: null, fetchFailed: true };
  }
}

// --- New City Detection -----------------------------------------------------

function resolveNewCity(cityId, neighborhoodNames) {
  // Try matching against known potential cities
  for (const pc of POTENTIAL_CITIES) {
    const lower = pc.name.toLowerCase();
    if (neighborhoodNames.some(n => n.toLowerCase().includes(lower))) {
      CITY_MAP[cityId] = { name: pc.name, slug: pc.slug };
      console.log(`  Mapped new city_id ${cityId} -> ${pc.name} (${pc.slug})`);
      return CITY_MAP[cityId];
    }
  }

  // Fallback: derive from first neighborhood name (often prefixed with city name)
  if (neighborhoodNames.length > 0) {
    // E.g., "Fujairah Downtown" -> city name "Fujairah"
    const first = neighborhoodNames[0];
    const parts = first.split(' ');
    if (parts.length >= 2) {
      const name = parts[0];
      const slug = name.toLowerCase().replace(/\s+/g, '-');
      CITY_MAP[cityId] = { name, slug };
      console.log(`  Derived new city_id ${cityId} -> ${name} (${slug}) from "${first}"`);
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
    throw new Error(`Supabase ${method} ${path} -> ${resp.status}: ${text}`);
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
      console.log(`  Batch ${batchNum}/${totalBatches} -> ${batch.length} rows`);
    } catch (e) {
      console.error(`  Batch ${batchNum} failed: ${e.message}`);
      // Fall back to individual upserts so one bad row doesn't block the rest
      for (const row of batch) {
        try {
          await supabase('/deliveroo_area?on_conflict=deliveroo_area_id', 'POST', [row], {
            'Prefer': 'resolution=merge-duplicates',
          });
        } catch (e2) {
          console.error(`    Failed: ${row.deliveroo_area_slug} -> ${e2.message}`);
        }
      }
    }
  }
}

async function getExistingAreas() {
  // Include city_id so Step 6 can scope deactivation by city in test mode
  const rows = await supabase(
    '/deliveroo_area?select=deliveroo_area_id,deliveroo_area_is_active,deliveroo_city_id&limit=10000',
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
  console.log('  Deliveroo UAE -- Area Discovery & Sync');
  console.log('===================================================');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // -- Step 1: Grid scan -----------------------------------------------------
  console.log('STEP 1: Location API grid scan\n');
  const neighborhoods = await scanAllRegions();

  if (neighborhoods.size === 0) {
    console.error('ABORT: Zero neighborhoods discovered. Location API may be unreachable.');
    process.exit(1);
  }

  // -- Step 2: Resolve cities ------------------------------------------------
  console.log('STEP 2: City resolution\n');
  const cityIds = new Set();
  for (const n of neighborhoods.values()) {
    cityIds.add(n.cityId);
  }

  // Detect unknown city IDs
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

  // Upsert cities before areas (FK constraint)
  await upsertCities([...cityIds]);

  // -- Step 3: Read existing table for comparison ----------------------------
  console.log('\nSTEP 3: Read existing table\n');
  const existingAreas = await getExistingAreas();
  const existingMap = new Map();
  for (const row of existingAreas) {
    existingMap.set(row.deliveroo_area_id, row.deliveroo_area_is_active);
  }
  console.log(`Existing table: ${existingAreas.length} rows (${existingAreas.filter(r => r.deliveroo_area_is_active).length} active)\n`);

  // -- Step 4: Enrich each neighborhood via page fetch -----------------------
  console.log('STEP 4: Enrich neighborhoods via page fetch\n');
  const records = [];
  const failedSlugs = [];
  let enrichedCount = 0;
  let consecutiveFails = 0;        // adaptive pacing: track consecutive fetch failures
  let currentDelay = PAGE_FETCH_DELAY_MS;

  for (const n of neighborhoods.values()) {
    const citySlug = CITY_MAP[n.cityId]?.slug;
    if (!citySlug) {
      console.log(`  SKIP: ${n.name} -- city_id ${n.cityId} unresolved`);
      continue;
    }

    enrichedCount++;

    // Progress log and batch pause
    if (enrichedCount % BATCH_PAUSE_EVERY === 0) {
      console.log(`  Progress: ${enrichedCount}/${neighborhoods.size} -- pausing ${BATCH_PAUSE_MS / 1000}s`);
      await sleep(BATCH_PAUSE_MS);
    }

    const enriched = await enrichArea(citySlug, n.slug);

    // Determine is_active
    let isActive;
    if (enriched.fetchFailed) {
      // Page fetch failed -- preserve previous status if it exists, else default true
      // (Location API returned this area, so Deliveroo's backend knows about it)
      const prev = existingMap.get(n.id);
      isActive = prev !== undefined ? prev : true;
      failedSlugs.push(n.slug);
      console.log(`    FETCH FAILED: ${n.slug} -- keeping is_active=${isActive}`);

      // Adaptive pacing: back off when getting consecutive failures (likely 429s)
      consecutiveFails++;
      if (consecutiveFails >= 3) {
        currentDelay = Math.min(currentDelay * 2, 60000); // double delay, cap at 60s
        console.log(`    Adaptive pacing: ${consecutiveFails} consecutive failures, delay now ${currentDelay / 1000}s`);
      }
    } else {
      isActive = enriched.isActive;
      if (!isActive) {
        console.log(`    INACTIVE: ${n.slug} (restaurantCount=${enriched.restaurantCount})`);
      }
      // Reset adaptive pacing on success
      if (consecutiveFails > 0) {
        consecutiveFails = 0;
        currentDelay = PAGE_FETCH_DELAY_MS;
      }
    }

    // Use ?? (nullish coalescing) for null safety -- ensures every record has
    // identical keys, which PostgREST requires for batch upserts (PGRST102).
    records.push({
      deliveroo_area_id: n.id,
      deliveroo_area_name: n.name,
      deliveroo_area_slug: n.slug,
      deliveroo_city_id: n.cityId,
      deliveroo_area_geohash: enriched.geohash ?? null,
      deliveroo_area_latitude: enriched.latitude ?? n.apiLat ?? null,
      deliveroo_area_longitude: enriched.longitude ?? n.apiLng ?? null,
      deliveroo_area_url: buildAreaUrl(citySlug, n.slug),
      deliveroo_area_is_active: isActive,
    });

    await sleep(currentDelay);
  }

  // -- Step 5: Upsert all records --------------------------------------------
  console.log('\nSTEP 5: Upsert to Supabase\n');
  await upsertAreas(records);

  // -- Step 6: Mark inactive -- areas in table but not in scan ---------------
  console.log('\nSTEP 6: Mark inactive areas\n');
  const discoveredIds = new Set(neighborhoods.keys());

  // In test mode, only deactivate areas within the scanned cities so that
  // scanning one emirate doesn't wipe out the rest of the country.
  const scannedCityIds = new Set([...neighborhoods.values()].map(n => n.cityId));

  const toDeactivate = existingAreas
    .filter(a => {
      if (!a.deliveroo_area_is_active) return false;       // already inactive
      if (discoveredIds.has(a.deliveroo_area_id)) return false; // found in scan
      // In test mode, skip areas outside the scanned cities
      if (TEST_MODE && !scannedCityIds.has(a.deliveroo_city_id)) return false;
      return true;
    })
    .map(a => a.deliveroo_area_id);

  if (toDeactivate.length > 0) {
    await markInactive(toDeactivate);
    console.log(`  Deactivated ${toDeactivate.length} area(s): ${toDeactivate.join(', ')}`);
  } else {
    console.log('  No areas to deactivate.');
  }

  // -- Summary ---------------------------------------------------------------
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const activeCount = records.filter(r => r.deliveroo_area_is_active).length;
  const inactiveCount = records.filter(r => !r.deliveroo_area_is_active).length;
  const newCount = records.filter(r => !existingMap.has(r.deliveroo_area_id)).length;

  console.log('\n===================================================');
  console.log('  Summary');
  console.log('===================================================');
  console.log(`  Discovered:     ${neighborhoods.size} neighborhoods`);
  console.log(`  Active:         ${activeCount}`);
  console.log(`  Inactive:       ${inactiveCount}`);
  console.log(`  New areas:      ${newCount}`);
  console.log(`  Deactivated:    ${toDeactivate.length}`);
  console.log(`  Failed fetches: ${failedSlugs.length}`);
  if (failedSlugs.length > 0) {
    console.log(`    -> ${failedSlugs.join(', ')}`);
  }
  console.log(`  Runtime:        ${elapsed} minutes`);
  console.log(`  Finished:       ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  process.exit(1);
});
