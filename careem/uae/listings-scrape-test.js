// careem/uae/listings-scrape-test.js
//
// Careem UAE — TEST listings harvest for ONE area.
//
// Called once per GitHub Actions matrix worker. Each worker:
//   1. Pulls the live guest token from Supabase (careem_token_latest() RPC).
//   2. Loops sp_page=1..N against the food-discovery-all-restaurants-v2
//      component endpoint, with 1500 ms between pages (serial, per worker).
//      Stops when the page returns zero restaurant cards OR the page's card
//      count is less than PAGE_SIZE (natural end of pagination).
//   3. Dedupes cards within the area (sponsored copies etc.) by
//      careem_merchant_id.
//   4. Calls careem_test_upsert_batch(p_area_id, p_rows) which inserts new
//      restaurants and merges careem_area_ids on conflict. One RPC call per
//      area, at the end.
//
// The table careem_restaurant_list_test is throwaway — we're harvesting raw
// cards here so we can design the final careem_brand / careem_branch /
// careem_branch_information / careem_branch_delivery_area schemas from
// evidence. One row per restaurant, careem_area_ids accumulates every area
// the restaurant was seen in across all workers / runs.
//
// Env:
//   SUPABASE_URL                 — required
//   SUPABASE_SERVICE_ROLE_KEY    — required (service_role bypasses RLS)
//   AREA_ID                      — required: careem_area.careem_area_id to probe
//   LAT, LNG                     — required: lat/lng for the Careem lat/lng headers
//   AREA_NAME                    — optional, for log labels
//   MACHINE_NO                   — optional, for log labels
//   CAREEM_BATCH_DELAY_MS        — optional, default 1500 (ms between pages)
//   CAREEM_PROBE_RETRIES         — optional, default 4 (per-page attempts)
//   CAREEM_RATE_LIMIT_PAUSE_MS   — optional, default 30000 (global sleep after 429)
//   CAREEM_MAX_PAGES             — optional, default 150 (safety cap)
//
// Exit code:
//   0 — area probed cleanly, upsert succeeded.
//   1 — token expired, upsert failed, or any page errored out after retries.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const AREA_ID    = process.env.AREA_ID ? Number(process.env.AREA_ID) : null;
const LAT        = process.env.LAT;
const LNG        = process.env.LNG;
const AREA_NAME  = process.env.AREA_NAME || `area_id=${AREA_ID}`;
const MACHINE_NO = process.env.MACHINE_NO || '?';

if (!AREA_ID || !LAT || !LNG) {
  // Workers without an assigned area exit cleanly as a no-op. The matrix
  // dispatches 5 machines regardless; when the operator only lists N<5
  // areas, machines N+1..5 land here and finish successfully.
  console.log(`machine ${MACHINE_NO}: no AREA_ID / LAT / LNG supplied — nothing to do, exiting cleanly.`);
  process.exit(0);
}

const BATCH_DELAY_MS       = Number(process.env.CAREEM_BATCH_DELAY_MS       || 1500);
const PROBE_RETRIES        = Number(process.env.CAREEM_PROBE_RETRIES        || 4);
const RATE_LIMIT_PAUSE_MS  = Number(process.env.CAREEM_RATE_LIMIT_PAUSE_MS  || 30000);
const MAX_PAGES            = Number(process.env.CAREEM_MAX_PAGES            || 150);

// ── Device profile — mirrors careem/uae/test-fetch.js + sync-areas.js ────
const DEVICE = {
  app_version: '26.39.0',
  os: 'iOS/27.0.1',
  appengine_api_version: '2026-09-17',
  device_id: 'D0O8gpXoJdQ2L5lC',
};

const LISTINGS_URL_BASE =
  'https://appengine.careemapis.com/v1/page/food-discovery-home/component/v/1/food-discovery-all-restaurants-v2';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sessionId() {
  return 'TEST-M' + MACHINE_NO + '-' + Math.random().toString(36).slice(2, 10).toUpperCase();
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
    jti:          row.jwt_jti,
    expires_at:   row.expires_at,
    mins_left:    minsLeft,
  };
}

// ── Careem fetch + parse ───────────────────────────────────────────────
function careemHeaders(token, user_id, sessId) {
  return {
    Host: 'appengine.careemapis.com',
    SESSION_ID: sessId,
    'X-Careem-Beta': 'false',
    'User-Agent': 'ICMA/' + DEVICE.app_version,
    'X-Careem-Agent': 'ICMA',
    'X-Careem-Session-Id': sessId,
    Agent: 'ICMA',
    'Time-Zone': 'Asia/Dubai',
    lng: String(LNG),
    lat: String(LAT),
    'x-careem-userid': String(user_id || ''),
    Version: DEVICE.app_version,
    'X-Careem-Version': DEVICE.app_version,
    'x-careem-user-location': `${LAT},${LNG}`,
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

function pageUrl(page) {
  return `${LISTINGS_URL_BASE}?sp_page=${page}&sp_offset=0&sp_category=food_disc_all_restaurants`;
}

// Walk a Careem component-tree response and collect every object that looks
// like a restaurant card. A card has (name|title) AND an id field.
function collectCards(node, out, seen, depth) {
  out = out || [];
  seen = seen || new Set();
  depth = depth || 0;
  if (!node || depth > 20) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectCards(n, out, seen, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;

  const name = node.title || node.name || node.brand_name || node.merchant_name;
  const id = node.merchant_id || node.outlet_id || node.restaurant_id || node.id || node.brand_id;
  if (name && id && typeof name === 'string') {
    const key = String(id);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(node);
    }
  }
  for (const k in node) collectCards(node[k], out, seen, depth + 1);
  return out;
}

// Flatten one Careem card to the shape careem_test_upsert_batch expects.
// Full card preserved as raw_card for later schema design.
function cardToRow(card) {
  const merchant_id = card.merchant_id || card.outlet_id || card.restaurant_id || card.id || null;
  const brand_id = card.brand_id || card.brandId || (card.brand && (card.brand.id || card.brand.brand_id)) || null;
  const brand_name = card.brand_name || card.brandName || (card.brand && (card.brand.name || card.brand.brand_name)) || null;
  const name = card.title || card.name || card.merchant_name || null;
  const latitude = card.latitude != null ? card.latitude
    : (card.lat != null ? card.lat
    : (card.location && (card.location.latitude != null ? card.location.latitude : card.location.lat)));
  const longitude = card.longitude != null ? card.longitude
    : (card.lng != null ? card.lng
    : (card.lon != null ? card.lon
    : (card.location && (card.location.longitude != null ? card.location.longitude
      : (card.location.lng != null ? card.location.lng : card.location.lon)))));
  const image_url = card.image_url || card.imageUrl || card.image
    || (card.images && (card.images.logo || card.images.cover || card.images.main))
    || (card.logo && (card.logo.url || card.logo)) || null;
  const restaurant_page_url =
    (card.target && (card.target.url || card.target.href || card.target.path || card.target.deeplink))
    || (card.action && (card.action.url || card.action.href || card.action.path || card.action.deeplink))
    || card.deeplink || card.href || card.url || card.path || null;
  const cuisines = card.cuisines || card.tags || card.categories || null;

  return {
    careem_merchant_id:   merchant_id != null ? String(merchant_id) : null,
    careem_brand_id:      brand_id    != null ? String(brand_id)    : '',
    careem_brand_name:    brand_name  || null,
    careem_name:          name        || null,
    latitude:             latitude  != null ? String(latitude)  : '',
    longitude:            longitude != null ? String(longitude) : '',
    image_url:            typeof image_url === 'string' ? image_url : null,
    restaurant_page_url:  typeof restaurant_page_url === 'string' ? restaurant_page_url : null,
    cuisines:             cuisines != null ? cuisines : null,
    raw_card:             card,
  };
}

// Fetch one page. 2xx-empty is "no more pages". 429 triggers a global pause.
async function fetchOnce(token, sub, page) {
  const sessId = sessionId();
  const headers = careemHeaders(token, sub, sessId);
  const t0 = Date.now();
  try {
    const resp = await fetch(pageUrl(page), { headers, redirect: 'follow' });
    const text = await resp.text();
    const ms = Date.now() - t0;
    if (resp.status >= 200 && resp.status < 300) {
      if (resp.status === 204 || !text || text.trim().length === 0) {
        return { ok: true, status: resp.status, cards: [], ms, bytes: 0 };
      }
      try {
        const json = JSON.parse(text);
        const cards = collectCards(json);
        return { ok: true, status: resp.status, cards, json, ms, bytes: text.length };
      } catch (e) {
        return { ok: false, status: resp.status, error: 'JSON parse: ' + e.message, ms };
      }
    }
    return {
      ok: false,
      status: resp.status,
      error: `HTTP ${resp.status}: ${text.slice(0, 200)}`,
      ms,
    };
  } catch (e) {
    return { ok: false, status: 0, error: 'network: ' + e.message, ms: Date.now() - t0 };
  }
}

async function fetchPage(token, sub, page) {
  let last = null;
  for (let attempt = 1; attempt <= PROBE_RETRIES; attempt++) {
    const r = await fetchOnce(token, sub, page);
    if (r.ok) return Object.assign({}, r, { attempts: attempt });
    last = r;
    if (attempt === PROBE_RETRIES) break;
    if (r.status === 429) {
      console.warn(`  [429] page=${page} rate-limited — pausing ${RATE_LIMIT_PAUSE_MS}ms`);
      await sleep(RATE_LIMIT_PAUSE_MS);
    } else {
      const backoff = [2000, 5000, 10000, 20000][attempt - 1] || 20000;
      console.warn(`  [${r.status || 'net'}] page=${page} attempt ${attempt}/${PROBE_RETRIES} — sleep ${backoff}ms`);
      await sleep(backoff);
    }
  }
  return { ok: false, status: last ? last.status : 0, error: last ? last.error : 'unknown', attempts: PROBE_RETRIES };
}
// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log('===============================================================');
  console.log(' Careem UAE — listings test harvest');
  console.log('===============================================================');
  console.log(` machine_no=${MACHINE_NO}  area_id=${AREA_ID}  area=${AREA_NAME}`);
  console.log(` lat=${LAT}  lng=${LNG}`);
  console.log(` pacing: delay=${BATCH_DELAY_MS}ms  retries=${PROBE_RETRIES}  rate_pause=${RATE_LIMIT_PAUSE_MS}ms  max_pages=${MAX_PAGES}`);

  console.log('\nSTEP 1: Pull token from Supabase');
  const tok = await getToken();
  const sub = decodeJwtSub(tok.access_token);
  console.log(`  jti=${(tok.jti || '').slice(0, 8)} sub=${sub || '?'} mins_left=${tok.mins_left}`);

  console.log(`\nSTEP 2: Paginate area ${AREA_ID}`);
  const rowsByMerchant = new Map();
  let page = 0;
  let totalBytes = 0;
  let cardsSeen = 0;
  let stopReason = null;
  while (page < MAX_PAGES) {
    page++;
    const r = await fetchPage(tok.access_token, sub, page);
    if (!r.ok) {
      console.error(`  FATAL on page ${page}: ${r.error}`);
      process.exit(1);
    }
    const n = r.cards.length;
    cardsSeen += n;
    totalBytes += r.bytes || 0;
    console.log(`  page ${page}: status=${r.status} cards=${n} bytes=${r.bytes || 0} ms=${r.ms}`);
    if (n === 0) { stopReason = `empty page at ${page}`; break; }
    for (const card of r.cards) {
      const row = cardToRow(card);
      if (!row.careem_merchant_id) continue;
      if (!rowsByMerchant.has(row.careem_merchant_id)) {
        rowsByMerchant.set(row.careem_merchant_id, row);
      }
    }
    if (page < MAX_PAGES) await sleep(BATCH_DELAY_MS);
  }
  if (!stopReason && page >= MAX_PAGES) stopReason = `hit MAX_PAGES=${MAX_PAGES}`;
  console.log(`  stopped: ${stopReason}`);
  console.log(`  totals: pages=${page} cards_seen=${cardsSeen} unique_merchants=${rowsByMerchant.size} bytes=${totalBytes}`);

  console.log(`\nSTEP 3: Upsert ${rowsByMerchant.size} restaurants into careem_restaurant_list_test`);
  const rows = Array.from(rowsByMerchant.values());
  if (rows.length === 0) {
    console.log('  no rows to upsert — area produced zero merchants');
  } else {
    const res = await supabase('/rpc/careem_test_upsert_batch', {
      method: 'POST',
      body: { p_area_id: AREA_ID, p_rows: rows },
    });
    const rr = Array.isArray(res) ? res[0] : res;
    console.log(`  rpc result: inserted=${rr && rr.inserted} merged=${rr && rr.merged} total=${rr && rr.total}`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n===============================================================');
  console.log(` DONE  machine=${MACHINE_NO}  area_id=${AREA_ID}  elapsed=${elapsed}s`);
  console.log('===============================================================');
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  console.error(e.stack);
  process.exit(1);
});
