// sync-areas.js
//
// Deliveroo UAE — Area Discovery & Sync
//
// Scans UAE bounding boxes via the Deliveroo Location API to discover every
// active delivery area (neighborhood), then resolves city names and upserts
// complete records to Supabase.
//
// Data flow:
//   1. Grid scan — query the Location API at ~800m spacing across all emirates.
//      Each hit returns a neighborhood (id, name, slug) and its city_id.
//   2. Enrichment — compute centroid lat/lng and geohash from grid hits.
//   3. City resolution — the Location API returns city_id but no city name.
//      For new or unresolved cities, the code resolves names via:
//        a. Nominatim reverse geocode (coordinates -> city name guess)
//        b. Deliveroo area page __NEXT_DATA__ (authoritative city name + slug)
//        c. Placeholder "City {id}" as last resort (re-attempted on future runs)
//   4. Upsert — write all discovered areas and cities to Supabase.
//   5. Deactivation — mark areas previously known but absent from the scan
//      as inactive.
//
// Data ownership:
//   deliveroo_country — maintained by us (the only table we define).
//   deliveroo_city    — discovered from Deliveroo. City IDs come from the
//                       Location API; names come from Deliveroo page scraping
//                       or Nominatim reverse geocoding.
//   deliveroo_area    — discovered from Deliveroo. Neighborhood IDs, names,
//                       slugs, and city assignment all come from the Location
//                       API response.
//
// Self-sustaining: this code rebuilds everything from scratch if all area and
// city data is wiped. It depends only on the Location API and the UAE bounding
// boxes defined below — not on existing Supabase data to operate.

// --- Config -----------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UAE_COUNTRY_ID = '27780a1f-e345-4ff8-939a-ef5d879186b1';

const TEST_MODE = process.env.TEST_MODE === 'true';
const TEST_REGION = process.env.TEST_REGION || 'Ajman';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// --- Bounding Boxes ---------------------------------------------------------
// Geographic scan zones — 0.008 deg spacing (~800-900m).
// These define WHERE to scan, not which city a point belongs to.
// City assignment comes from the Deliveroo API response (zone.city_id).

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
const MAX_CONCURRENT = 5;
const BATCH_DELAY_MS = 100;

const LOCATION_API = 'https://api.ae.deliveroo.com/orderapp/v1/location';
const AREA_PAGE_BASE = 'https://deliveroo.ae/en/restaurants';
const NOMINATIM_API = 'https://nominatim.openstreetmap.org/reverse';

// --- Utilities --------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-');
}

function buildAreaUrl(citySlug, areaSlug) {
  return `${AREA_PAGE_BASE}/${citySlug}/${areaSlug}`;
}

// Full restaurant listing for the area (every restaurant card, in ranked order).
// This is the URL stored in deliveroo_area.deliveroo_area_url and used by the
// ranking scraper. buildAreaUrl (no query) is still used for city resolution.
const AREA_LISTING_QUERY = '?collection=restaurants&collection=all-restaurants';

function buildAreaListingUrl(citySlug, areaSlug) {
  return `${buildAreaUrl(citySlug, areaSlug)}${AREA_LISTING_QUERY}`;
}

// --- Geohash Encoding -------------------------------------------------------
// Pure implementation — no external dependencies required.
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

// --- City Name Resolution ---------------------------------------------------
// The Location API returns zone.city_id but no city name. These functions
// resolve the name for new or previously unresolved cities.
//
// Resolution cascade:
//   1. Nominatim reverse geocode — free, no API key. Returns the OSM city
//      name for a coordinate pair. Used as an initial guess.
//   2. Deliveroo area page — the guessed city slug + a known area slug form
//      a URL. The page's __NEXT_DATA__ contains the authoritative cityName
//      and cityUname (slug) as Deliveroo defines them.
//   3. If the Deliveroo page fails (wrong guess, bot detection, etc.), the
//      Nominatim name is used directly — close enough for URL construction.
//   4. If Nominatim also fails, a placeholder "City {id}" is stored so no
//      area is ever skipped. Placeholders are re-attempted on future runs.

/**
 * Reverse geocode coordinates to a city name via Nominatim (OpenStreetMap).
 * Returns the city/town name string, or null on failure.
 *
 * Nominatim usage policy: max 1 request/second with a descriptive User-Agent.
 * Not a concern here — this is only called for rare new-city events.
 */
async function reverseGeocode(lat, lng) {
  try {
    const url = `${NOMINATIM_API}?lat=${lat}&lon=${lng}&format=json&zoom=10`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'DeliverooAreaSync/1.0 (github.com/cnj-analytics)' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.address?.city || data.address?.town || data.address?.village || null;
  } catch {
    return null;
  }
}

/**
 * Parse city info from a Deliveroo area page's raw HTML.
 * Extracts the __NEXT_DATA__ JSON and reads the location metadata at:
 *   props.initialState.home.feed.meta.location
 *
 * Returns { cityName, cityUname } or null if the data is absent or malformed.
 */
function parseCityFromHtml(html) {
  const marker = '<script id="__NEXT_DATA__" type="application/json">';
  const start = html.indexOf(marker);
  if (start === -1) return null;

  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  if (jsonEnd === -1) return null;

  try {
    const nextData = JSON.parse(html.slice(jsonStart, jsonEnd));
    const location = nextData?.props?.initialState?.home?.feed?.meta?.location;
    if (location?.cityName && location?.cityUname) {
      return { cityName: location.cityName, cityUname: location.cityUname };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch a Deliveroo area page and extract city info from __NEXT_DATA__.
 * URL format: deliveroo.ae/en/restaurants/{citySlug}/{areaSlug}
 *
 * Returns { cityName, cityUname } or null if the page doesn't resolve
 * (wrong city slug, area not found, bot detection, etc.).
 */
async function fetchDeliverooCityInfo(citySlug, areaSlug) {
  try {
    const url = buildAreaUrl(citySlug, areaSlug);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'DeliverooAreaSync/1.0 (github.com/cnj-analytics)' },
      redirect: 'follow',
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    return parseCityFromHtml(html);
  } catch {
    return null;
  }
}

/**
 * Resolve the city name for a newly discovered city_id.
 *
 * Takes a representative neighborhood (the one with the most grid hits for
 * this city_id) and uses its coordinates and slug to drive the cascade:
 *   1. Nominatim reverse geocode -> city name guess
 *   2. Guess slug + area slug -> fetch Deliveroo page -> parse __NEXT_DATA__
 *   3. Fall back to the Nominatim name if the page doesn't resolve
 *
 * Returns { name, slug } or null if resolution fails entirely.
 */
async function resolveCityName(representative) {
  const { latitude, longitude, slug: areaSlug } = representative;

  // Nominatim reverse geocode for an initial city name guess
  console.log(`    Nominatim: lat=${latitude}, lng=${longitude}`);
  const nominatimCity = await reverseGeocode(latitude, longitude);

  if (!nominatimCity) {
    console.log('    Nominatim returned no result');
    return null;
  }
  console.log(`    Nominatim result: "${nominatimCity}"`);

  // Use the guess to construct a Deliveroo area page URL and fetch it
  const guessedSlug = slugify(nominatimCity);
  console.log(`    Fetching Deliveroo page: ${buildAreaUrl(guessedSlug, areaSlug)}`);
  const deliverooInfo = await fetchDeliverooCityInfo(guessedSlug, areaSlug);

  if (deliverooInfo) {
    // Deliveroo confirmed the city — use its authoritative name and slug
    console.log(`    Confirmed by Deliveroo: "${deliverooInfo.cityName}" (slug: ${deliverooInfo.cityUname})`);
    return { name: deliverooInfo.cityName, slug: deliverooInfo.cityUname };
  }

  // Deliveroo page didn't resolve — use the Nominatim name directly
  console.log(`    Deliveroo page unavailable — using Nominatim name: "${nominatimCity}"`);
  return { name: nominatimCity, slug: guessedSlug };
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
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Scan all regions and collect every grid hit per neighborhood.
 * Returns a Map: neighborhood.id -> { id, name, slug, cityId, hits: [{lat, lng}] }
 */
async function scanAllRegions() {
  const neighborhoods = new Map();
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
    console.log(`Scanning ${region.name} — ${points.length} grid points`);

    let regionNewCount = 0;

    for (let i = 0; i < points.length; i += MAX_CONCURRENT) {
      const batch = points.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(
        batch.map(p => queryLocationAPI(p.lat, p.lng))
      );

      if (i > 0 && i % 200 === 0) {
        console.log(`  Progress: ${i}/${points.length} (${((i / points.length) * 100).toFixed(0)}%)`);
      }

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

        neighborhoods.get(id).hits.push({
          lat: batch[j].lat,
          lng: batch[j].lng,
        });
      }
    }

    console.log(`  Found ${regionNewCount} unique neighborhoods`);
  }

  console.log(`\nGrid scan complete: ${totalPoints} points queried, ${totalHits} hits, ${neighborhoods.size} unique neighborhoods\n`);
  return neighborhoods;
}

// --- Enrichment from Grid Data ----------------------------------------------

/**
 * Compute centroid (average lat/lng) and geohash from grid hits.
 * For areas with many hits, the centroid closely approximates the area center.
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

async function getExistingCities() {
  const rows = await supabase(
    `/deliveroo_city?select=deliveroo_city_id,deliveroo_city_name&deliveroo_country_id=eq.${UAE_COUNTRY_ID}&limit=1000`,
    'GET',
    null,
    { 'Accept': 'application/json' }
  );
  return rows || [];
}

async function upsertCities(cityRows) {
  if (cityRows.length === 0) return;
  console.log(`Upserting ${cityRows.length} cities to Supabase...`);
  await supabase('/deliveroo_city?on_conflict=deliveroo_city_id', 'POST', cityRows, {
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
      console.log(`  Batch ${batchNum}/${totalBatches}: ${batch.length} rows`);
    } catch (e) {
      console.error(`  Batch ${batchNum} failed: ${e.message}`);
      for (const row of batch) {
        try {
          await supabase('/deliveroo_area?on_conflict=deliveroo_area_id', 'POST', [row], {
            'Prefer': 'resolution=merge-duplicates',
          });
        } catch (e2) {
          console.error(`  Failed: ${row.deliveroo_area_slug} -> ${e2.message}`);
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
  console.log('  Deliveroo UAE — Area Discovery & Sync');
  console.log('===================================================');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // -- Step 1: Grid scan -----------------------------------------------------
  // Query the Location API across all bounding boxes. Each hit tells us a
  // neighborhood ID, name, slug, and city_id. We record every grid point that
  // returned each neighborhood so we can compute its centroid later.
  console.log('STEP 1: Location API grid scan\n');
  const neighborhoods = await scanAllRegions();

  if (neighborhoods.size === 0) {
    console.error('ABORT: Zero neighborhoods discovered. Location API may be unreachable.');
    process.exit(1);
  }

  // -- Step 2: Compute enrichment from grid data -----------------------------
  // Average all grid hits for each neighborhood to find its centroid, then
  // encode that as a geohash. Areas with many hits get a precise centroid;
  // areas at the edge of the grid with few hits still get the best estimate.
  console.log('STEP 2: Compute enrichment (centroid + geohash)\n');
  for (const n of neighborhoods.values()) {
    const enrichment = computeEnrichment(n.hits);
    n.latitude = enrichment.latitude;
    n.longitude = enrichment.longitude;
    n.geohash = enrichment.geohash;
    console.log(`  ${n.name}: ${n.hits.length} hits -> lat=${n.latitude}, lng=${n.longitude}, geohash=${n.geohash}`);
  }

  // -- Step 3: City resolution ------------------------------------------------
  // The Location API returns zone.city_id for every neighborhood but no city
  // name. For cities already resolved in a previous run, we reuse the known
  // name. For new cities — or cities still carrying a placeholder name from a
  // failed earlier attempt — we actively resolve via Nominatim reverse
  // geocoding and Deliveroo page scraping.
  console.log('\nSTEP 3: City resolution\n');

  const cityMap = new Map(); // city_id -> { name, slug }

  // 3a — Collect every city_id the scan found
  const discoveredCityIds = new Set();
  for (const n of neighborhoods.values()) {
    discoveredCityIds.add(n.cityId);
  }
  console.log(`Discovered ${discoveredCityIds.size} distinct city IDs: ${[...discoveredCityIds].join(', ')}`);

  // 3b — Load existing city names from Supabase
  const existingCities = await getExistingCities();
  const existingCityMap = new Map();
  for (const row of existingCities) {
    existingCityMap.set(row.deliveroo_city_id, row.deliveroo_city_name);
  }

  // 3c — Resolve each discovered city_id
  const cityUpsertRows = [];
  let knownCount = 0;
  let resolvedCount = 0;
  let placeholderCount = 0;

  for (const cityId of discoveredCityIds) {
    const existingName = existingCityMap.get(cityId) || null;
    const isPlaceholder = !existingName || /^City \d+$/.test(existingName);

    if (!isPlaceholder) {
      // Known city with a resolved name — reuse it
      const slug = slugify(existingName);
      cityMap.set(cityId, { name: existingName, slug });
      cityUpsertRows.push({
        deliveroo_city_id: cityId,
        deliveroo_city_name: existingName,
        deliveroo_country_id: UAE_COUNTRY_ID,
      });
      knownCount++;
      console.log(`  city_id=${cityId} -> "${existingName}" (known)`);
      continue;
    }

    // New city or placeholder — attempt active resolution
    const label = existingName ? `placeholder "${existingName}"` : 'new';
    console.log(`  city_id=${cityId} -> ${label}, resolving...`);

    // Pick the representative neighborhood: most grid hits = best coordinates
    const candidates = [...neighborhoods.values()].filter(n => n.cityId === cityId);
    candidates.sort((a, b) => b.hits.length - a.hits.length);
    const representative = candidates[0];

    const resolved = await resolveCityName(representative);

    let cityName, citySlug;
    if (resolved) {
      cityName = resolved.name;
      citySlug = resolved.slug;
      resolvedCount++;
      console.log(`    Resolved: "${cityName}" (slug: ${citySlug})`);
    } else {
      cityName = `City ${cityId}`;
      citySlug = slugify(cityName);
      placeholderCount++;
      console.log(`    Using placeholder: "${cityName}" (will retry on next run)`);
    }

    cityMap.set(cityId, { name: cityName, slug: citySlug });
    cityUpsertRows.push({
      deliveroo_city_id: cityId,
      deliveroo_city_name: cityName,
      deliveroo_country_id: UAE_COUNTRY_ID,
    });
  }

  console.log(`\nCity resolution: ${knownCount} known, ${resolvedCount} newly resolved, ${placeholderCount} placeholders`);
  await upsertCities(cityUpsertRows);

  // -- Step 4: Read existing table for comparison ----------------------------
  console.log('\nSTEP 4: Read existing area table\n');
  const existingAreas = await getExistingAreas();
  const existingMap = new Map();
  for (const row of existingAreas) {
    existingMap.set(row.deliveroo_area_id, row);
  }
  console.log(`Existing table: ${existingAreas.length} rows (${existingAreas.filter(r => r.deliveroo_area_is_active).length} active)\n`);

  // -- Step 5: Build area records ---------------------------------------------
  // Every area found in the grid scan is active — the Location API returned it.
  // For existing areas that already have enrichment data (geohash, lat/lng),
  // preserve the existing values unless the area is new.
  console.log('STEP 5: Build area records\n');
  const records = [];

  for (const n of neighborhoods.values()) {
    const city = cityMap.get(n.cityId);
    const existing = existingMap.get(n.id);

    // Prefer existing enrichment values if present — they may have come from
    // a more precise source or a denser scan.
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
      deliveroo_area_url: buildAreaListingUrl(city.slug, n.slug),
      deliveroo_area_is_active: true,
    });
  }

  const newAreaCount = records.filter(r => !existingMap.has(r.deliveroo_area_id)).length;
  console.log(`Built ${records.length} records (${newAreaCount} new)`);

  // -- Step 6: Upsert all records --------------------------------------------
  console.log('\nSTEP 6: Upsert to Supabase\n');
  await upsertAreas(records);

  // -- Step 7: Mark inactive — areas in table but absent from scan -----------
  console.log('\nSTEP 7: Mark inactive areas\n');
  const discoveredIds = new Set(neighborhoods.keys());
  let deactivatedCount = 0;

  if (TEST_MODE) {
    // In test mode we scan only one region, so we cannot determine which areas
    // across the whole country are truly inactive. Skip deactivation to avoid
    // false-positives from overlapping bounding boxes.
    const wouldDeactivate = existingAreas.filter(a =>
      a.deliveroo_area_is_active && !discoveredIds.has(a.deliveroo_area_id)
    ).length;
    console.log(`  TEST MODE: skipping deactivation (${wouldDeactivate} areas not seen in partial scan)`);
  } else {
    // Full scan: every region was covered, so any active area absent from the
    // scan is genuinely no longer served by Deliveroo.
    const toDeactivate = existingAreas
      .filter(a => a.deliveroo_area_is_active && !discoveredIds.has(a.deliveroo_area_id))
      .map(a => a.deliveroo_area_id);

    if (toDeactivate.length > 0) {
      await markInactive(toDeactivate);
      deactivatedCount = toDeactivate.length;
      const slugs = toDeactivate.map(id => existingMap.get(id)?.deliveroo_area_slug || id);
      console.log(`  Deactivated ${toDeactivate.length} area(s): ${slugs.join(', ')}`);
    } else {
      console.log('  No areas to deactivate');
    }
  }

  // -- Summary ---------------------------------------------------------------
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('\n===================================================');
  console.log('  Summary');
  console.log('===================================================');
  console.log(`  Discovered:  ${neighborhoods.size} neighborhoods`);
  console.log(`  Active:      ${records.length}`);
  console.log(`  New areas:   ${newAreaCount}`);
  console.log(`  Deactivated: ${deactivatedCount}`);
  console.log(`  Cities:      ${knownCount} known, ${resolvedCount} resolved, ${placeholderCount} placeholders`);
  console.log(`  Runtime:     ${elapsed} minutes`);
  console.log(`  Finished:    ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  process.exit(1);
});
