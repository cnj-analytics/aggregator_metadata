// enrich-area.js
//
// Failsafe enrichment for a single Deliveroo area.
// Triggered by Supabase when a record lands with missing data (null geohash).
//
// Input: AREA_ID environment variable
// Action: Fetches the area's page, extracts geohash/lat/lng/active status, updates Supabase.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AREA_ID = process.env.AREA_ID;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!AREA_ID) {
  console.error('Missing AREA_ID');
  process.exit(1);
}

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Supabase ---------------------------------------------------------

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

// --- Page Fetch -------------------------------------------------------

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
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`  429 rate limited -- retrying in ${delay / 1000}s`);
        await sleep(delay);
        continue;
      }

      return resp;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`  Fetch error (${e.message}) -- retrying in ${delay / 1000}s`);
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

    // restaurantCount.results = number of restaurants currently available.
    // Active areas have restaurants (count > 0). Inactive areas = 0.
    const hasRestaurants = (restaurantCount?.results || 0) > 0;

    return {
      geohash: location?.geohash || null,
      latitude: location?.lat || null,
      longitude: location?.lon || null,
      hasRestaurants,
      restaurantCount: restaurantCount?.results || 0,
    };
  } catch (e) {
    console.log(`  __NEXT_DATA__ parse error: ${e.message}`);
    return null;
  }
}

// --- Main -------------------------------------------------------------

async function main() {
  console.log(`Enriching area ID: ${AREA_ID}\n`);

  // 1. Get the area record from Supabase
  const rows = await supabase(
    `/deliveroo_area?deliveroo_area_id=eq.${AREA_ID}&select=*`,
    'GET',
    null,
    { 'Accept': 'application/json' }
  );

  if (!rows || rows.length === 0) {
    console.error(`Area ID ${AREA_ID} not found in Supabase.`);
    process.exit(1);
  }

  const area = rows[0];
  console.log(`Area: ${area.deliveroo_area_name} (${area.deliveroo_area_slug})`);
  console.log(`URL: ${area.deliveroo_area_url}`);
  console.log(`Current state: geohash=${area.deliveroo_area_geohash}, is_active=${area.deliveroo_area_is_active}\n`);

  // 2. Fetch the area page
  const resp = await fetchWithRetry(area.deliveroo_area_url);

  if (!resp) {
    console.error('Page fetch failed after all retries. No changes made.');
    process.exit(1);
  }

  if (!resp.ok) {
    console.log(`Page returned ${resp.status} -- marking as inactive.`);
    await supabase(
      `/deliveroo_area?deliveroo_area_id=eq.${AREA_ID}`,
      'PATCH',
      { deliveroo_area_is_active: false }
    );
    console.log('Done -- area marked inactive.');
    return;
  }

  const html = await resp.text();

  // 3. Extract data
  const pageData = extractPageData(html);

  if (!pageData) {
    console.log('No __NEXT_DATA__ found -- marking as inactive.');
    await supabase(
      `/deliveroo_area?deliveroo_area_id=eq.${AREA_ID}`,
      'PATCH',
      { deliveroo_area_is_active: false }
    );
    console.log('Done -- area marked inactive.');
    return;
  }

  // 4. Update the record
  // Active = restaurantCount > 0 (area has restaurants available).
  // NOTE: This failsafe trigger fires on INSERT when geohash is null,
  // meaning the main sync couldn't fetch the page. If this failsafe also
  // runs during off-hours, restaurantCount may be 0 for active areas.
  // In that case, we still update geohash/lat/lng and set is_active based
  // on what we see -- the next weekly sync will correct it at 8am UAE.
  const isActive = pageData.hasRestaurants;

  const update = {
    deliveroo_area_is_active: isActive,
  };

  if (pageData.geohash) update.deliveroo_area_geohash = pageData.geohash;
  if (pageData.latitude) update.deliveroo_area_latitude = pageData.latitude;
  if (pageData.longitude) update.deliveroo_area_longitude = pageData.longitude;

  await supabase(
    `/deliveroo_area?deliveroo_area_id=eq.${AREA_ID}`,
    'PATCH',
    update
  );

  console.log(`Done -- updated:`);
  console.log(`  is_active: ${isActive} (restaurantCount=${pageData.restaurantCount})`);
  console.log(`  geohash: ${pageData.geohash || '(unchanged)'}`);
  console.log(`  latitude: ${pageData.latitude || '(unchanged)'}`);
  console.log(`  longitude: ${pageData.longitude || '(unchanged)'}`);
}

main().catch(e => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
