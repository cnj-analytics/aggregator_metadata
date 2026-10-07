// scrape-restaurant-details-test.js
//
// Talabat UAE — Per-restaurant detail scraper (TEST MODE).
//
// Hits api.talabat.com/menubff/v4/branches/{bid}/menu for every bid in
// talabat_restaurant_queue whose chain_name or name matches a brand filter,
// extracts the restaurant-level block (NOT the menu items), and upserts into
// talabat_restaurant_detail_test. The full raw restaurant/offers/config
// blocks are also stored as jsonb for later inspection.
//
// Serial, 1.5s between calls — menu endpoint has no documented rate limit
// but we're being polite. 234 branches ≈ 6 min.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   BRAND_PATTERN   SQL ILIKE pattern alternation (default:
//                   starbucks|ldc kitchen|sugargram|sushi do|box it)
//                   Each clause is wrapped as '%<clause>%' and OR'd across
//                   both chain_name and name.
//   CALL_DELAY_MS   pacing between restaurant fetches (default 1500)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BRAND_PATTERN =
  process.env.BRAND_PATTERN ||
  'starbucks|ldc kitchen|sugargram|sushi do|box it';
const CALL_DELAY_MS = parseInt(process.env.CALL_DELAY_MS || '1500', 10);
const UPSERT_FLUSH = 25; // flush upserts in chunks of 25

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Supabase helpers -------------------------------------------------------

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

// --- Talabat menu endpoint --------------------------------------------------
// Note tokentypekey='guest' for the menu endpoint (listings uses 'jwt').

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
  'tokentypekey': 'guest',
};

async function fetchMenu(menuApiUrl) {
  const t0 = Date.now();
  const resp = await fetch(menuApiUrl, { method: 'GET', headers: TALABAT_HEADERS });
  const text = await resp.text();
  const elapsed = Date.now() - t0;
  return { status: resp.status, text, elapsed };
}

const TALABAT_CDN_PREFIX = 'https://images.deliveryhero.io/image/talabat/restaurants/';
function cdnUrl(filename) {
  if (!filename || typeof filename !== 'string' || filename.trim() === '') return null;
  if (/^https?:\/\//i.test(filename)) return filename;
  return TALABAT_CDN_PREFIX + filename;
}

// Coerce to integer, or null. Talabat sometimes returns things like
// "10-20 mins" in fields the schema expects as ints (e.g. dtim), which
// otherwise 400s the whole batch at the RPC.
function toInt(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function toNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toBool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return null;
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

// Pull the restaurant block from a menu API response. Observed shape:
//   { config, menu, offers, vendor: { result: { restaurant: {...}, menu: {...} } } }
function extractRestaurant(parsed) {
  const vendor = parsed?.vendor || parsed;
  const result = vendor?.result || vendor;
  return result?.restaurant || null;
}

function extractMenu(parsed) {
  const vendor = parsed?.vendor || parsed;
  const result = vendor?.result || vendor;
  return result?.menu || parsed?.menu || null;
}

function countMenu(menu) {
  if (!menu) return { sections: 0, items: 0 };
  const sections = menu.menuSection || menu.sections || menu.categories || [];
  const items = sections.reduce(
    (n, s) => n + ((s.items || s.menuItems || []).length),
    0,
  );
  return { sections: sections.length, items };
}

// --- Row builder ------------------------------------------------------------

function buildRow(bid, menuApiUrl, result) {
  // result.{http_status, text, elapsed, parsed, error}
  const base = {
    bid,
    http_status: result.http_status,
    fetch_duration_ms: result.elapsed,
    response_bytes: result.text ? result.text.length : null,
    last_error: result.error || null,
  };
  if (!result.parsed || result.http_status >= 400) {
    return base;
  }
  const r = extractRestaurant(result.parsed) || {};
  const menu = extractMenu(result.parsed);
  const { sections, items } = countMenu(menu);
  const offers = result.parsed?.offers || result.parsed?.vendor?.result?.offers || [];
  const config = result.parsed?.config || result.parsed?.vendor?.result?.config || null;

  // Talabat's `dtim` is often a text range like "10-20 mins", so stash the
  // raw string on delivery_time_text if we didn't get a numeric minutes.
  const dtimRaw = r.dtim;
  const dtimInt = toInt(dtimRaw);
  const dtxt = r.dtxt || r.delivery_text || (typeof dtimRaw === 'string' ? dtimRaw : null);

  return {
    ...base,
    chain_id: toInt(r.id || r.chainId || r.chain_id),
    name: r.na || r.name || null,
    branch_name: r.bna || r.branch_name || null,
    brand_legal_name: r.brandLegalName || null,
    latitude: toNum(r.lat || r.latitude),
    longitude: toNum(r.lon || r.longitude || r.lng),
    address: r.addr || r.address || null,
    area_name: r.an || r.area_name || null,
    rating: toNum(r.rat || r.rating),
    ratings_count_text: r.trt == null ? null : String(r.trt),
    unified_rating_count: r.unified_rating?.count == null ? null : String(r.unified_rating.count),
    delivery_charge: toNum(r.dch),
    service_fees: toNum(r.serviceFees),
    service_fees_cap_min: toNum(r.serviceFeesCapMin),
    service_fees_cap_max: toNum(r.serviceFeesCapMax),
    service_fees_type: r.serviceFeesType == null ? null : String(r.serviceFeesType),
    service_fees_setup_val: toNum(r.serviceFeesSetupValue),
    minimum_order: toNum(r.mna),
    cuisines: Array.isArray(r.cus) ? r.cus : null,
    logo_url: cdnUrl(r.lg || r.images?.logo || r.logoUrl),
    banner_url: cdnUrl(r.gtl || r.images?.heroBanner || r.coverPhoto),
    slug: r.sl || r.slug || null,
    status_description: r.status_description || null,
    status_int: toInt(r.stt),
    is_talabat_pro: toBool(r.isTalabatPro != null ? r.isTalabatPro : r.is_tpro),
    delivery_time_minutes: dtimInt,
    delivery_time_text: dtxt,
    time_estimation: r.time_estimation == null ? null : (typeof r.time_estimation === 'string' ? r.time_estimation : String(r.time_estimation)),
    vertical_type: r.verticalType == null ? null : String(r.verticalType),
    menu_sections_count: sections,
    menu_items_total: items,
    offers_count: Array.isArray(offers) ? offers.length : null,
    raw_restaurant: r,
    raw_offers: offers,
    raw_config: config,
  };
}

// --- Upsert batcher ---------------------------------------------------------

async function flush(rows) {
  if (rows.length === 0) return;
  await supabaseRpc('talabat_restaurant_detail_test_upsert', { p_rows: rows });
}

// --- Main -------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log('Talabat UAE — restaurant detail test scraper');
  console.log(`BRAND_PATTERN=${BRAND_PATTERN}`);
  console.log(`CALL_DELAY_MS=${CALL_DELAY_MS}`);
  console.log('');

  // 1. Build the SQL filter from the pattern alternation
  const clauses = BRAND_PATTERN.split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => `chain_name.ilike.*${p}*,name.ilike.*${p}*`)
    .join(',');
  // PostgREST uses `or=(a.ilike.X,b.ilike.Y,...)`
  const orFilter = `or=(${clauses})`;

  const url =
    `/talabat_restaurant_queue?select=bid,chain_name,name,menu_api_url&limit=5000&${orFilter}`;
  const targets = await supabase(url, 'GET', null, { Accept: 'application/json' });
  console.log(`Loaded ${targets.length} target branches.`);
  if (targets.length === 0) {
    console.log('Nothing to scrape.');
    return;
  }

  // Group counts per matched brand (sanity log)
  const brandCounts = {};
  for (const t of targets) {
    const label = (t.chain_name || t.name || '').toLowerCase();
    let brand = 'other';
    for (const p of BRAND_PATTERN.split('|').map((s) => s.trim().toLowerCase())) {
      if (p && label.includes(p)) { brand = p; break; }
    }
    brandCounts[brand] = (brandCounts[brand] || 0) + 1;
  }
  console.log('Per-brand branch counts:');
  for (const [k, v] of Object.entries(brandCounts)) console.log(`  ${k}: ${v}`);
  console.log('');

  // 2. Loop serially
  const pending = [];
  let okCount = 0;
  let failCount = 0;
  const failures = [];

  for (let i = 0; i < targets.length; i++) {
    const { bid, menu_api_url, name, chain_name } = targets[i];
    if (!menu_api_url) {
      console.error(`[${i + 1}/${targets.length}] bid=${bid}: no menu_api_url, skipping`);
      failCount++;
      failures.push({ bid, reason: 'no menu_api_url' });
      continue;
    }
    let result = { http_status: null, text: null, elapsed: null, parsed: null, error: null };
    try {
      const r = await fetchMenu(menu_api_url);
      result.http_status = r.status;
      result.elapsed = r.elapsed;
      result.text = r.text;
      if (r.status >= 200 && r.status < 400) {
        try {
          result.parsed = JSON.parse(r.text);
        } catch (e) {
          result.error = 'non-JSON response: ' + e.message;
        }
      } else {
        result.error = `HTTP ${r.status}: ${r.text.slice(0, 200)}`;
      }
    } catch (e) {
      result.error = e.message;
    }

    const row = buildRow(bid, menu_api_url, result);
    pending.push(row);

    if (result.parsed && !result.error) {
      okCount++;
      console.log(
        `[${i + 1}/${targets.length}] bid=${bid} ${name || chain_name}: ` +
          `${result.http_status} ${(result.text.length / 1024).toFixed(1)}KB ${result.elapsed}ms ` +
          `brand_legal_name=${row.brand_legal_name || '-'} rat=${row.rating || '-'}`,
      );
    } else {
      failCount++;
      failures.push({ bid, reason: result.error || `status ${result.http_status}` });
      console.error(`[${i + 1}/${targets.length}] bid=${bid} FAIL: ${result.error}`);
    }

    // Flush in chunks
    if (pending.length >= UPSERT_FLUSH) {
      try {
        await flush(pending);
      } catch (e) {
        console.error(`  upsert flush failed: ${e.message}`);
      }
      pending.length = 0;
    }

    if (i < targets.length - 1) await sleep(CALL_DELAY_MS);
  }

  // Final flush
  if (pending.length > 0) {
    try {
      await flush(pending);
    } catch (e) {
      console.error(`  final upsert flush failed: ${e.message}`);
    }
  }

  const totalMin = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log('');
  console.log('=== DONE ===');
  console.log(`Target branches:   ${targets.length}`);
  console.log(`Successful fetches: ${okCount}`);
  console.log(`Failed fetches:    ${failCount}`);
  console.log(`Elapsed:           ${totalMin} min`);
  if (failures.length > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of failures.slice(0, 20)) {
      console.log(`  bid=${f.bid}  ${f.reason.slice(0, 120)}`);
    }
    if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
