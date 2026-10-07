// scrape-area-listings.js
//
// Talabat UAE — Area Listings Scraper (TRIAL)
//
// Hits Talabat's vendor-list endpoint for ONE area, pages through all vendors
// serially (1 req/sec — concurrency triggers 429), and upserts each vendor into
// `talabat_restaurant_queue` keyed on `bid`.
//
// Dedup: ON CONFLICT (bid) the row's `area_ids` array picks up the new area_id
// (DISTINCT) and `last_seen_at` + `raw_json` are refreshed. One row per unique
// branch, with a growing list of areas where it has been seen.
//
// Reads the area's lat/lng/name from the `talabat_area` table in Supabase.
//
// Dumps the full raw vendor payloads to `raw-{AREA_ID}-page{N}.json` and a
// combined `raw-{AREA_ID}-all.json` for inspection as a workflow artifact.
//
// Env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   AREA_ID                     the Talabat area_id to scrape (required)
//   OUT_DIR                     where to write raw dumps (default: ./out)
//   MAX_PAGES                   safety cap (default: 50)
//   PAGE_DELAY_MS               serial pacing (default: 1100)

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AREA_ID = process.env.AREA_ID ? parseInt(process.env.AREA_ID, 10) : null;
const OUT_DIR = process.env.OUT_DIR || './out';
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '50', 10);
const PAGE_DELAY_MS = parseInt(process.env.PAGE_DELAY_MS || '1100', 10);
const PAGE_SIZE = 1000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!AREA_ID) {
  console.error('Missing AREA_ID');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Supabase REST helpers --------------------------------------------------

async function supabase(path, method, body = null, extraHeaders = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
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

async function supabaseRpc(fn, body) {
  return supabase(`/rpc/${fn}`, 'POST', body);
}

// --- Talabat listing fetch --------------------------------------------------
// Headers per the verified mobile-API scraping brief. Do NOT add extra
// headers (Perseus, X-FP-API-KEY, Latitude, Longitude, Origin, Referer) —
// doing so triggers DEVICE_BLOCKED. The server validates on the specific
// Flutter-app header set below.

const TALABAT_HEADERS = {
  'User-Agent': 'talabat/8701 CFNetwork/3896.100.1.2.1 Darwin/27.0.0',
  'Accept': '*/*',
  'Accept-Language': 'en-US',
  'Accept-Encoding': 'gzip, deflate, br',
  'appbrand': '1',
  'x-country': 'ae',
  'x-app-version': '13.93.0',
  'x-device-version': '13.93.0',
  'x-device-source': '4',
  'x-device-framework': 'flutter',
  'x-marshmallow-version': 'mm3',
  'http2-enabled': 'true',
  'tokentypekey': 'jwt',
  'Content-Length': '0',
};

async function fetchListingPage(lat, lng, areaId, page) {
  const url =
    `https://api.talabat.com/vendor-list/v1/composite-list/${lat}/${lng}` +
    `?countrycode=4&areaid=${areaId}&vertical_id=0&isCustomerPro=false` +
    `&page=${page}&size=${PAGE_SIZE}`;

  const resp = await fetch(url, { method: 'GET', headers: TALABAT_HEADERS });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Talabat ${resp.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Talabat returned non-JSON (${text.length} chars): ${text.slice(0, 300)}`);
  }
}

// --- Vendor extraction ------------------------------------------------------
// Talabat's response structure varies; try the common paths and log the first-
// page shape for debugging.

function extractVendors(resp) {
  if (!resp) return [];
  const candidates = [
    resp.vendors,
    resp?.data?.vendors,
    resp?.result?.vendors,
    Array.isArray(resp?.data) ? resp.data : null,
    resp?.restaurants,
    resp?.data?.restaurants,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function pickFirst(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const k of p.split('.')) {
      if (cur == null) { ok = false; break; }
      cur = cur[k];
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return null;
}

// Talabat serves logos + hero banners from this Delivery Hero CDN. The raw
// payload holds just filenames in images.logo / images.heroBanner — we prefix
// to produce usable URLs. Verified Oct 7 against real talabat.com page.
const TALABAT_CDN_PREFIX = 'https://images.deliveryhero.io/image/talabat/restaurants/';

function cdnUrl(filename) {
  if (!filename || typeof filename !== 'string' || filename.trim() === '') return null;
  if (/^https?:\/\//i.test(filename)) return filename;
  return TALABAT_CDN_PREFIX + filename;
}

function flattenVendor(v, areaId) {
  const bid = pickFirst(v, ['bid', 'id', 'branch_id', 'branchId']);
  const chainId = pickFirst(v, [
    'tracking.shop_impressions_loaded.chainId',
    'tracking.chainId',
    'chain_id',
    'chainId',
  ]);
  const chainName = pickFirst(v, [
    'tracking.shop_impressions_loaded.chainName',
    'tracking.chainName',
    'chain_name',
    'chainName',
  ]);
  const name = pickFirst(v, ['na', 'name']);
  const branchName = pickFirst(v, ['bna', 'branch_name', 'branchName']);
  const latitude = pickFirst(v, ['latitude', 'lat', 'location.latitude']);
  const longitude = pickFirst(v, ['longitude', 'lng', 'lon', 'location.longitude']);
  const logoFile = pickFirst(v, ['images.logo', 'lg', 'logo']);
  const bannerFile = pickFirst(v, ['images.heroBanner', 'gtl', 'coverPhoto']);
  const slug = pickFirst(v, ['sl', 'slug', 'uname', 'uri']);

  const menuApiUrl =
    bid && latitude != null && longitude != null
      ? `https://api.talabat.com/menubff/v4/branches/${bid}/menu?branchId=${bid}&countryId=4&areaId=${areaId}&latitude=${latitude}&longitude=${longitude}`
      : null;

  const webUrl =
    bid && slug
      ? `https://www.talabat.com/uae/restaurant/${bid}/${slug}`
      : bid
      ? `https://www.talabat.com/uae/restaurant/${bid}`
      : null;

  return {
    bid,
    chain_id: chainId,
    chain_name: chainName,
    name,
    branch_name: branchName,
    latitude: latitude != null ? Number(latitude) : null,
    longitude: longitude != null ? Number(longitude) : null,
    image_url: cdnUrl(logoFile),
    banner_url: cdnUrl(bannerFile),
    menu_api_url: menuApiUrl,
    web_url: webUrl,
    raw_json: v,
  };
}

// --- Upsert with array-append dedup ----------------------------------------

async function upsertBatch(rows, areaId) {
  if (rows.length === 0) return 0;
  try {
    const payload = {
      p_area_id: areaId,
      p_rows: rows.map((r) => ({
        bid: r.bid,
        chain_id: r.chain_id,
        chain_name: r.chain_name,
        name: r.name,
        branch_name: r.branch_name,
        latitude: r.latitude,
        longitude: r.longitude,
        image_url: r.image_url,
        banner_url: r.banner_url,
        menu_api_url: r.menu_api_url,
        web_url: r.web_url,
        raw_json: r.raw_json,
      })),
    };
    await supabaseRpc('talabat_queue_upsert', payload);
    return rows.length;
  } catch (e) {
    console.error('RPC talabat_queue_upsert failed:', e.message);
    throw e;
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  console.log(`Talabat area-listings scraper — AREA_ID=${AREA_ID}`);

  const areaRows = await supabase(
    `/talabat_area?select=area_id,area_name,latitude,longitude,city_id&area_id=eq.${AREA_ID}&limit=1`,
    'GET',
    null,
    { Accept: 'application/json' },
  );
  if (!areaRows || areaRows.length === 0) {
    throw new Error(`area_id ${AREA_ID} not found in talabat_area`);
  }
  const area = areaRows[0];
  console.log(`Area: ${area.area_name} (city_id=${area.city_id}) @ ${area.latitude}, ${area.longitude}`);

  const lat = area.latitude;
  const lng = area.longitude;

  const allVendors = [];
  const stats = {
    pages_fetched: 0,
    vendors_total: 0,
    upserted_total: 0,
    unique_bids: new Set(),
    firstPageKeys: null,
    firstVendorKeys: null,
    responseStructureSample: null,
  };

  for (let page = 1; page <= MAX_PAGES; page++) {
    const t0 = Date.now();
    let resp;
    try {
      resp = await fetchListingPage(lat, lng, AREA_ID, page);
    } catch (e) {
      console.error(`Page ${page} fetch failed: ${e.message}`);
      await sleep(5000);
      try {
        resp = await fetchListingPage(lat, lng, AREA_ID, page);
      } catch (e2) {
        console.error(`Page ${page} retry failed: ${e2.message}`);
        break;
      }
    }

    stats.pages_fetched++;

    const rawFile = path.join(OUT_DIR, `raw-${AREA_ID}-page${page}.json`);
    fs.writeFileSync(rawFile, JSON.stringify(resp));

    if (page === 1) {
      stats.firstPageKeys = Object.keys(resp || {});
      stats.responseStructureSample = JSON.stringify(resp, null, 2).slice(0, 3000);
    }

    const vendors = extractVendors(resp);
    if (page === 1 && vendors.length > 0) {
      stats.firstVendorKeys = Object.keys(vendors[0]);
      console.log(`First vendor keys (${stats.firstVendorKeys.length}):`, stats.firstVendorKeys.slice(0, 40).join(', '));
      console.log('Sample vendor (truncated):', JSON.stringify(vendors[0]).slice(0, 1500));
    }

    stats.vendors_total += vendors.length;
    for (const v of vendors) {
      const flat = flattenVendor(v, AREA_ID);
      if (flat.bid) stats.unique_bids.add(flat.bid);
      allVendors.push(v);
    }

    const flatRows = vendors.map((v) => flattenVendor(v, AREA_ID)).filter((r) => r.bid);
    if (flatRows.length > 0) {
      const upserted = await upsertBatch(flatRows, AREA_ID);
      stats.upserted_total += upserted;
    }

    const elapsed = Date.now() - t0;
    console.log(
      `Page ${page}: ${vendors.length} vendors (${flatRows.length} with bid), ` +
        `cumulative=${stats.vendors_total} unique=${stats.unique_bids.size} (${elapsed}ms)`,
    );

    if (vendors.length === 0 || vendors.length < PAGE_SIZE) {
      console.log(`Terminating: page returned ${vendors.length} < ${PAGE_SIZE} vendors`);
      break;
    }

    await sleep(PAGE_DELAY_MS);
  }

  const allFile = path.join(OUT_DIR, `raw-${AREA_ID}-all.json`);
  fs.writeFileSync(allFile, JSON.stringify(allVendors));

  const statsOut = {
    area_id: AREA_ID,
    area_name: area.area_name,
    city_id: area.city_id,
    lat,
    lng,
    pages_fetched: stats.pages_fetched,
    vendors_total: stats.vendors_total,
    upserted_total: stats.upserted_total,
    unique_bids: stats.unique_bids.size,
    first_page_response_keys: stats.firstPageKeys,
    first_vendor_keys: stats.firstVendorKeys,
    first_page_sample: stats.responseStructureSample,
    completed_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, `stats-${AREA_ID}.json`), JSON.stringify(statsOut, null, 2));

  console.log('\n=== DONE ===');
  console.log(JSON.stringify({ ...statsOut, first_page_sample: '(see stats file)' }, null, 2));
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
