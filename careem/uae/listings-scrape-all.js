// careem/uae/listings-scrape-all.js
//
// Careem UAE — full listings harvest across every active careem_area.
//
// Scaled version of listings-scrape-test.js. Where the test script took a
// single AREA_ID and probed just that area, this script:
//   1. Reads every careem_area row with is_active=true from Supabase.
//   2. Round-robins the areas across N machines (default 5): machine M
//      claims area at index i iff (i % NUM_MACHINES) == (MACHINE_NO - 1).
//      Round-robin interleaves Dubai/AD/Sharjah/… so each machine gets a
//      geographic mix (so no machine is stuck on only big Dubai areas).
//   3. Loops through its assigned areas serially. For each area it
//      paginates sp_page=1..N (stop on empty), dedupes by careem_merchant_id
//      within the area, and calls the SAME upsert RPC used by the test
//      script (careem_test_upsert_batch), which merges careem_area_ids on
//      conflict.
//   4. Exits 0 if every assigned area was probed cleanly; non-zero if any
//      area ultimately failed after retries. A re-run with the same
//      MACHINE_NO will idempotently re-process any areas that failed
//      (because the only change on failure is "no upsert happens", not a
//      spoiled row — area probes are independent).
//
// Clean-run guarantees inherited from sync-areas.js and
// listings-scrape-test.js:
//   * Serial within a machine: 1500 ms between page requests
//   * Per-page retries with exponential backoff
//   * On HTTP 429, global pause for 30 s before the next request
//   * Failed probes never clobber a prior successful upsert (the merge
//     function only touches careem_area_ids on conflict)
//
// Env:
//   SUPABASE_URL                 — required
//   SUPABASE_SERVICE_ROLE_KEY    — required
//   MACHINE_NO                   — required, 1..NUM_MACHINES
//   NUM_MACHINES                 — optional, default 5
//   CAREEM_BATCH_DELAY_MS        — optional, default 1500
//   CAREEM_PROBE_RETRIES         — optional, default 4
//   CAREEM_RATE_LIMIT_PAUSE_MS   — optional, default 30000
//   CAREEM_MAX_PAGES             — optional, default 150
//   CAREEM_AREA_LIMIT            — optional, cap on areas per machine
//                                  (for smoke testing — default: no cap)
//   WALL_LIMIT_SEC               — optional, hard stop after this many
//                                  seconds (default 20400 = 5h40m, below
//                                  GitHub's 6h job cap).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const MACHINE_NO    = parseInt(process.env.MACHINE_NO || '0', 10);
const NUM_MACHINES  = parseInt(process.env.NUM_MACHINES || '5', 10);
if (!MACHINE_NO || MACHINE_NO < 1 || MACHINE_NO > NUM_MACHINES) {
  console.error(`MACHINE_NO must be in 1..${NUM_MACHINES} (got "${process.env.MACHINE_NO}")`);
  process.exit(1);
}

const BATCH_DELAY_MS       = Number(process.env.CAREEM_BATCH_DELAY_MS       || 1500);
const PROBE_RETRIES        = Number(process.env.CAREEM_PROBE_RETRIES        || 4);
const RATE_LIMIT_PAUSE_MS  = Number(process.env.CAREEM_RATE_LIMIT_PAUSE_MS  || 30000);
const MAX_PAGES            = Number(process.env.CAREEM_MAX_PAGES            || 150);
const AREA_LIMIT           = Number(process.env.CAREEM_AREA_LIMIT           || 0);  // 0 = no cap
const WALL_LIMIT_SEC       = Number(process.env.WALL_LIMIT_SEC              || 20400);

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
  return 'ALL-M' + MACHINE_NO + '-' + Math.random().toString(36).slice(2, 10).toUpperCase();
}
function decodeJwtSub(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/') + '===';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).sub;
  } catch { return null; }
}

// ── Supabase REST ──────────────────────────────────────────────────────
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

async function getActiveAreas() {
  // Pull every active careem_area so each machine can slice the same list.
  // Order by careem_area_id so the slicing is deterministic across machines.
  const rows = await supabase(
    '/careem_area?select=careem_area_id,area_name,latitude,longitude,careem_city_id' +
    '&is_active=eq.true&latitude=not.is.null&longitude=not.is.null' +
    '&order=careem_area_id.asc&limit=1000',
    { headers: { Accept: 'application/json' } }
  );
  return rows || [];
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

function pageUrl(page) {
  return `${LISTINGS_URL_BASE}?sp_page=${page}&sp_offset=0&sp_category=food_disc_all_restaurants`;
}

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

function cardToRow(card) {
  const merchant_id = card.merchant_id || card.outlet_id || card.restaurant_id || card.id || null;
  const brand_id = card.brand_id || card.brandId || (card.brand && (card.brand.id || card.brand.brand_id)) || null;
  const brand_name = card.brand_name || card.brandName || (card.brand && (card.brand.name || card.brand.brand_name)) || null;
  const name = card.title || card.name || card.merchant_name || null;
  return {
    careem_merchant_id:   merchant_id != null ? String(merchant_id) : null,
    careem_brand_id:      brand_id    != null ? String(brand_id)    : '',
    careem_brand_name:    brand_name  || null,
    careem_name:          name        || null,
    latitude:             '',   // listing endpoint doesn't expose coords
    longitude:            '',   // listing endpoint doesn't expose coords
    image_url:            null, // not on listing — comes from restaurant page
    restaurant_page_url:  null, // not on listing — merchant_id IS the key
    cuisines:             null, // not on listing — comes from restaurant page
    raw_card:             card,
  };
}

async function fetchOnce(token, sub, page, area) {
  const sessId = sessionId();
  const headers = careemHeaders(token, sub, area.latitude, area.longitude, sessId);
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
        return { ok: true, status: resp.status, cards, ms, bytes: text.length };
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

async function fetchPage(token, sub, page, area) {
  let last = null;
  for (let attempt = 1; attempt <= PROBE_RETRIES; attempt++) {
    const r = await fetchOnce(token, sub, page, area);
    if (r.ok) return Object.assign({}, r, { attempts: attempt });
    last = r;
    if (attempt === PROBE_RETRIES) break;
    if (r.status === 429) {
      console.warn(`    [429] area=${area.careem_area_id} page=${page} rate-limited — pausing ${RATE_LIMIT_PAUSE_MS}ms`);
      await sleep(RATE_LIMIT_PAUSE_MS);
    } else {
      const backoff = [2000, 5000, 10000, 20000][attempt - 1] || 20000;
      console.warn(`    [${r.status || 'net'}] area=${area.careem_area_id} page=${page} attempt ${attempt}/${PROBE_RETRIES} — sleep ${backoff}ms`);
      await sleep(backoff);
    }
  }
  return { ok: false, status: last ? last.status : 0, error: last ? last.error : 'unknown', attempts: PROBE_RETRIES };
}

// ── Per-area work: paginate + dedup + upsert ───────────────────────────
async function processArea(area, token, sub) {
  const t0 = Date.now();
  const rowsByMerchant = new Map();
  let page = 0;
  let totalBytes = 0;
  let cardsSeen = 0;
  let stopReason = null;
  while (page < MAX_PAGES) {
    page++;
    const r = await fetchPage(token, sub, page, area);
    if (!r.ok) {
      return {
        ok: false,
        area_id: area.careem_area_id,
        pages_done: page - 1,
        error: r.error,
      };
    }
    const n = r.cards.length;
    cardsSeen += n;
    totalBytes += r.bytes || 0;
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

  const rows = Array.from(rowsByMerchant.values());
  let rpcRes = null;
  if (rows.length > 0) {
    try {
      rpcRes = await supabase('/rpc/careem_test_upsert_batch', {
        method: 'POST',
        body: { p_area_id: area.careem_area_id, p_rows: rows },
      });
    } catch (e) {
      return {
        ok: false,
        area_id: area.careem_area_id,
        pages_done: page,
        cards_seen: cardsSeen,
        unique: rows.length,
        error: 'rpc: ' + e.message,
      };
    }
  }
  const rr = Array.isArray(rpcRes) ? rpcRes[0] : rpcRes;
  return {
    ok: true,
    area_id: area.careem_area_id,
    area_name: area.area_name,
    pages_done: page,
    cards_seen: cardsSeen,
    unique: rows.length,
    bytes: totalBytes,
    elapsed_sec: Math.round((Date.now() - t0) / 1000),
    stop_reason: stopReason,
    rpc_inserted: rr && rr.inserted,
    rpc_merged:   rr && rr.merged,
  };
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  const deadline = startTime + WALL_LIMIT_SEC * 1000;

  console.log('===============================================================');
  console.log(` Careem UAE — full listings harvest  machine ${MACHINE_NO}/${NUM_MACHINES}`);
  console.log('===============================================================');
  console.log(` pacing: delay=${BATCH_DELAY_MS}ms  retries=${PROBE_RETRIES}  rate_pause=${RATE_LIMIT_PAUSE_MS}ms  max_pages=${MAX_PAGES}`);

  console.log('\nSTEP 1: Pull token');
  const tok = await getToken();
  const sub = decodeJwtSub(tok.access_token);
  console.log(`  jti=${(tok.jti || '').slice(0, 8)} sub=${sub} mins_left=${tok.mins_left}`);

  console.log('\nSTEP 2: Load active careem_area list and slice by machine');
  const allAreas = await getActiveAreas();
  const assigned = allAreas.filter((_, i) => (i % NUM_MACHINES) === (MACHINE_NO - 1));
  const slice = AREA_LIMIT > 0 ? assigned.slice(0, AREA_LIMIT) : assigned;
  console.log(`  total active=${allAreas.length}  assigned_to_me=${assigned.length}` +
              (AREA_LIMIT > 0 ? `  cap=${AREA_LIMIT}  will_process=${slice.length}` : ''));

  if (slice.length === 0) {
    console.log('No areas assigned to this machine — exiting cleanly.');
    return;
  }

  // ── STEP 3: process assigned areas serially ──
  console.log(`\nSTEP 3: Process ${slice.length} areas serially`);
  const results = [];
  let areasOk = 0, areasFail = 0;
  let totalCards = 0, totalUnique = 0, totalBytes = 0;
  for (let i = 0; i < slice.length; i++) {
    if (Date.now() > deadline) {
      console.warn(`  wall-time limit reached (${WALL_LIMIT_SEC}s). Stopping at area ${i}/${slice.length}.`);
      break;
    }
    const area = slice[i];
    console.log(`\n  [${i + 1}/${slice.length}] area_id=${area.careem_area_id}  ${area.area_name}  (${area.latitude},${area.longitude})`);
    const r = await processArea(area, tok.access_token, sub);
    results.push(r);
    if (r.ok) {
      areasOk++;
      totalCards  += r.cards_seen || 0;
      totalUnique += r.unique     || 0;
      totalBytes  += r.bytes      || 0;
      console.log(`    OK   pages=${r.pages_done}  cards=${r.cards_seen}  unique=${r.unique}  bytes=${r.bytes}  elapsed=${r.elapsed_sec}s  stop=${r.stop_reason}  rpc_inserted=${r.rpc_inserted}  rpc_merged=${r.rpc_merged}`);
    } else {
      areasFail++;
      console.error(`    FAIL pages_done=${r.pages_done}  error=${r.error}`);
    }
  }

  // ── SUMMARY ──
  const elapsed = ((Date.now() - startTime) / 60).toFixed(1);
  console.log('\n===============================================================');
  console.log(` DONE  machine ${MACHINE_NO}/${NUM_MACHINES}`);
  console.log('===============================================================');
  console.log(`  areas assigned     : ${slice.length}`);
  console.log(`  areas succeeded    : ${areasOk}`);
  console.log(`  areas failed       : ${areasFail}`);
  console.log(`  total cards seen   : ${totalCards}`);
  console.log(`  total unique rows  : ${totalUnique}`);
  console.log(`  total bytes        : ${totalBytes}`);
  console.log(`  elapsed            : ${elapsed} min`);

  if (areasFail > 0) {
    console.log('\nFailed areas (re-run this machine_no to pick them up):');
    for (const r of results.filter(x => !x.ok)) {
      console.log(`  area_id=${r.area_id}  pages_done=${r.pages_done}  error=${(r.error || '').slice(0, 160)}`);
    }
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  console.error(e.stack);
  process.exit(1);
});
