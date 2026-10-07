// scrape-all-areas.js
//
// Talabat UAE — Full UAE sweep orchestrator.
//
// Reads every row of `talabat_area` (ordered by area_id) and runs the same
// vendor-list fetch + upsert logic as scrape-area-listings.js, one area at a
// time, serially. The dedup RPC `talabat_queue_upsert` appends the current
// area_id to each matched vendor's `area_ids` array (DISTINCT), so a chain
// seen in 20 areas will end up as ONE row in talabat_restaurant_queue with
// area_ids of length 20.
//
// Pacing (per the brief + §15 of app-reverse-engineering-findings.md):
//   - 1.1s between pages inside an area (concurrency triggers 429)
//   - 2.0s between areas as a safety buffer
//
// Resumability:
//   START_FROM env var skips areas with area_id < START_FROM. If a run dies
//   mid-sweep, note the last successful area_id in the log and restart with
//   START_FROM=<that + 1>. Re-running areas is harmless (ON CONFLICT path),
//   just slower.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   START_FROM          skip areas below this area_id (default 0)
//   LIMIT_AREAS         stop after N areas processed (default: all)
//   PAGE_DELAY_MS       intra-area page pacing (default 1100)
//   AREA_DELAY_MS       between-area pacing (default 2000)
//   MAX_PAGES_PER_AREA  safety cap (default 50)

const START_FROM = parseInt(process.env.START_FROM || '0', 10);
const LIMIT_AREAS = process.env.LIMIT_AREAS ? parseInt(process.env.LIMIT_AREAS, 10) : null;
const PAGE_DELAY_MS = parseInt(process.env.PAGE_DELAY_MS || '1100', 10);
const AREA_DELAY_MS = parseInt(process.env.AREA_DELAY_MS || '2000', 10);
const MAX_PAGES_PER_AREA = parseInt(process.env.MAX_PAGES_PER_AREA || '50', 10);
const PAGE_SIZE = 1000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

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
    throw new Error(`Supabase ${method} ${path} -> ${resp.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function supabaseRpc(fn, body) {
  return supabase(`/rpc/${fn}`, 'POST', body);
}

// --- Talabat listing fetch --------------------------------------------------

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
    throw new Error(`Talabat ${resp.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// --- Vendor extraction ------------------------------------------------------

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
  for (const c of candidates) if (Array.isArray(c)) return c;
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

async function upsertBatch(rows, areaId) {
  if (rows.length === 0) return 0;
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
}

// --- Scrape one area --------------------------------------------------------

async function scrapeArea(area) {
  const { area_id: areaId, latitude: lat, longitude: lng } = area;
  let vendors_total = 0;
  let upserted_total = 0;
  let pages_fetched = 0;

  for (let page = 1; page <= MAX_PAGES_PER_AREA; page++) {
    let resp;
    try {
      resp = await fetchListingPage(lat, lng, areaId, page);
    } catch (e) {
      console.error(`    page ${page} failed: ${e.message} — retrying in 5s`);
      await sleep(5000);
      try {
        resp = await fetchListingPage(lat, lng, areaId, page);
      } catch (e2) {
        console.error(`    page ${page} retry failed: ${e2.message} — giving up on this area`);
        break;
      }
    }
    pages_fetched++;

    const vendors = extractVendors(resp);
    vendors_total += vendors.length;

    const flatRows = vendors.map((v) => flattenVendor(v, areaId)).filter((r) => r.bid);
    if (flatRows.length > 0) {
      try {
        upserted_total += await upsertBatch(flatRows, areaId);
      } catch (e) {
        console.error(`    upsert failed for page ${page}: ${e.message}`);
      }
    }

    if (vendors.length === 0 || vendors.length < PAGE_SIZE) break;
    await sleep(PAGE_DELAY_MS);
  }

  return { pages_fetched, vendors_total, upserted_total };
}

// --- Main orchestrator ------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log('Talabat UAE — full-sweep orchestrator');
  console.log(`START_FROM=${START_FROM}  LIMIT_AREAS=${LIMIT_AREAS ?? 'all'}`);
  console.log(`PAGE_DELAY_MS=${PAGE_DELAY_MS}  AREA_DELAY_MS=${AREA_DELAY_MS}`);
  console.log('');

  const areas = await supabase(
    `/talabat_area?select=area_id,area_name,latitude,longitude,city_id&order=area_id.asc&limit=1000`,
    'GET',
    null,
    { Accept: 'application/json' },
  );
  console.log(`Loaded ${areas.length} areas from talabat_area.`);

  const toProcess = areas
    .filter((a) => a.area_id >= START_FROM)
    .slice(0, LIMIT_AREAS ?? areas.length);
  console.log(`Will process ${toProcess.length} areas (first=${toProcess[0]?.area_id} last=${toProcess[toProcess.length - 1]?.area_id})`);
  console.log('');

  let totals = { pages_fetched: 0, vendors_total: 0, upserted_total: 0 };

  for (let i = 0; i < toProcess.length; i++) {
    const area = toProcess[i];
    const t1 = Date.now();

    try {
      const r = await scrapeArea(area);
      totals.pages_fetched += r.pages_fetched;
      totals.vendors_total += r.vendors_total;
      totals.upserted_total += r.upserted_total;
      const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
      const totalMin = ((Date.now() - t0) / 1000 / 60).toFixed(1);
      console.log(
        `[${i + 1}/${toProcess.length}] area_id=${area.area_id} (${area.area_name}): ` +
          `${r.pages_fetched}p ${r.vendors_total}v upserted=${r.upserted_total} ${elapsed}s | ` +
          `totals: ${totals.vendors_total}v ${totalMin}min elapsed`,
      );
    } catch (e) {
      console.error(`[${i + 1}/${toProcess.length}] area_id=${area.area_id} FATAL: ${e.message}`);
    }

    if (i < toProcess.length - 1) await sleep(AREA_DELAY_MS);
  }

  const totalMin = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log('');
  console.log('=== SWEEP COMPLETE ===');
  console.log(`Areas processed: ${toProcess.length}`);
  console.log(`Pages fetched:   ${totals.pages_fetched}`);
  console.log(`Vendors seen:    ${totals.vendors_total}`);
  console.log(`Upserts:         ${totals.upserted_total}`);
  console.log(`Elapsed:         ${totalMin} min`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
