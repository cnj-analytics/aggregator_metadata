// talabat/uae/ranking-scrape.js
//
// Talabat UAE — Ranking worker (one GitHub Actions job per machine).
// Loops: check -> claim -> fetch all pages of composite-list -> parse ->
//        save_area_hour -> report -> sleep. Exits on 429/403, deadline, or
//        "no areas left".
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY         required
//   RUN_ID            bigint (from workflow input)
//   MACHINE_NO        integer (from workflow input)
//   GITHUB_RUN_ID     informational, passed back to Supabase
//   PAGE_SIZE         composite-list page size (default 1000)
//   PAGE_DELAY_MS     delay between page fetches within one area (default 1500)
//   WALL_LIMIT_SEC    hard stop (default 21000 = 5h50m, below GH's 6h cap)

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUN_ID        = process.env.RUN_ID;
const MACHINE_NO    = parseInt(process.env.MACHINE_NO || '0', 10);
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID || '';
const PAGE_SIZE     = parseInt(process.env.PAGE_SIZE || '1000', 10);
const PAGE_DELAY_MS = parseInt(process.env.PAGE_DELAY_MS || '1500', 10);
const WALL_LIMIT_SEC = parseInt(process.env.WALL_LIMIT_SEC || '21000', 10);

if (!SUPABASE_URL || !SUPABASE_KEY || !RUN_ID || !MACHINE_NO) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RUN_ID / MACHINE_NO');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Flutter-app headers used by composite-list. Content-Length: 0 is required.
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

const CDN_PREFIX = 'https://images.deliveryhero.io/image/talabat/restaurants/';

// --------------------------------------------------------------------------
// Supabase RPC helper
// --------------------------------------------------------------------------
async function rpc(fn, body) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`RPC ${fn} ${resp.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

// --------------------------------------------------------------------------
// Composite-list fetch (one page). Returns parsed JSON or error.
// --------------------------------------------------------------------------
function compositeListUrl({ lat, lng, areaId, page, size }) {
  return `https://api.talabat.com/vendor-list/v1/composite-list/${lat}/${lng}` +
         `?countrycode=4&areaid=${areaId}&vertical_id=0&isCustomerPro=false&page=${page}&size=${size}`;
}

async function fetchPage(area, page) {
  const t0 = Date.now();
  const url = compositeListUrl({
    lat: area.latitude,
    lng: area.longitude,
    areaId: area.area_id,
    page,
    size: PAGE_SIZE,
  });
  const resp = await fetch(url, { method: 'GET', headers: TALABAT_HEADERS });
  const text = await resp.text();
  return { status: resp.status, text, elapsed: Date.now() - t0, bytes: text.length };
}

// --------------------------------------------------------------------------
// Parse one vendor card into the 21-slot positional row.
//
// [0]  bid                  branch id (shopId / card.bid)
// [1]  rank                 1-based position in the composite list across pages
// [2]  op_status            open|closed|busy|preorder|unknown
// [3]  is_active            bool
// [4]  rating               numeric or null
// [5]  ratings_count_text   text ("1,000", "500+")
// [6]  is_talabat_pro       bool
// [7]  is_tstar             bool
// [8]  tstar_desc           text
// [9]  has_offer            bool (derived)
// [10] offer_text           text
// [11] is_fast_delivery     bool (fids contains 100000)
// [12] only_on_talabat      bool
// [13] is_sponsored         bool (spd.type == 'cpc')
// [14] sponsored_category   organic_placements | paid | unknown
// [15] ranking_model        tracking.shop_impressions_loaded.rankingModelServed
// [16] card_name            text (branch display name)
// [17] card_slug            text
// [18] card_image_url       text (full CDN URL)
// [19] minimum_order        numeric or null
// [20] delivery_provider    text (TGO, VENDOR, …)
// --------------------------------------------------------------------------
function toBool(v, def = false) { return v === true || v === 'true' ? true : v === false || v === 'false' ? false : def; }

function mapOpStatus(card) {
  const t = card?.tracking?.shop_impressions_loaded?.shopStatus;
  if (t) {
    const s = String(t).toLowerCase();
    if (['open','closed','busy','preorder'].includes(s)) return s;
  }
  // Fallback by stt code (observed: 0 = open)
  const stt = card?.stt;
  if (stt === 0) return 'open';
  if (stt === 1) return 'closed';
  if (stt === 2) return 'busy';
  if (stt === 3) return 'preorder';
  return 'unknown';
}

function mapSponsoredCategory(card) {
  const cat = card?.spd?.cat;
  if (!cat) return '';
  const c = String(cat).toLowerCase();
  if (['organic_placements','paid','unknown'].includes(c)) return c;
  return 'unknown';
}

function mapImageUrl(card) {
  const logo = card?.images?.logo || card?.lg || null;
  if (!logo) return '';
  if (/^https?:\/\//i.test(logo)) return logo;
  return CDN_PREFIX + logo;
}

function parseCard(card, rank) {
  const bid         = card?.bid ?? null;
  if (!bid) return null;
  const tracking    = card?.tracking?.shop_impressions_loaded || {};
  const offerText   = card?.otxt || '';
  const hasOffer    = (offerText && offerText.length > 0) || tracking.shopWithOffer === true;
  const isSponsored = card?.spd?.type === 'cpc';
  const fids        = Array.isArray(card?.fids) ? card.fids : [];
  const minOrder    = card?.mna ?? tracking.shopMinimumOrderValue ?? null;
  const delProv     = tracking.deliveryProvider ?? '';

  return [
    String(bid),
    rank,
    mapOpStatus(card),
    toBool(card?.ac, true),
    (card?.rat == null || card?.rat === '') ? '' : String(card.rat),
    card?.ratings_count ?? '',
    toBool(card?.is_tpro ?? card?.isTalabatPro, false),
    toBool(card?.is_tstar, false),
    card?.tstar_desc ?? '',
    hasOffer,
    offerText,
    fids.includes(100000),
    toBool(card?.only_on_talabat, false),
    isSponsored,
    mapSponsoredCategory(card),
    tracking.rankingModelServed ?? '',
    card?.bna ?? card?.na ?? '',
    card?.sl ?? '',
    mapImageUrl(card),
    (minOrder == null || minOrder === '') ? '' : String(minOrder),
    delProv,
  ];
}

// Scoop cuisine objects out so we can feed the registry
function collectCuisines(card, acc) {
  const list = Array.isArray(card?.cus) ? card.cus : [];
  for (const c of list) {
    if (!c?.na) continue;
    acc.set(c.na, { id: c.id ?? null, na: c.na, sl: c.sl ?? null });
  }
}

// --------------------------------------------------------------------------
// Process one area: fetch all pages, parse, save, report.
// --------------------------------------------------------------------------
async function processArea({ area, scrape_date, scrape_hour, dry_run }) {
  const t0 = Date.now();
  const rows = [];
  const cuisinesByName = new Map();
  let totalBytes = 0;
  let totalFetchMs = 0;
  let httpStatus = null;
  let rank = 0;

  // Talabat composite-list is 1-indexed. page=0 silently returns an empty page.
  for (let page = 1; page <= 50; page++) {   // safety: 50 pages * 1000 = 50k cards
    let fp;
    try {
      fp = await fetchPage(area, page);
    } catch (e) {
      return { status: 'failed', error: `fetch failed: ${e.message}`, http_status: null,
               cards: rank, ranking_rows: rows.length, pending_rows: 0,
               bytes: totalBytes, fetch_ms: totalFetchMs };
    }
    httpStatus = fp.status;
    totalBytes += fp.bytes;
    totalFetchMs += fp.elapsed;

    if (fp.status === 429) {
      return { status: 'rate_limited', http_status: 429, error: 'http_429',
               cards: rank, ranking_rows: rows.length, pending_rows: 0,
               bytes: totalBytes, fetch_ms: totalFetchMs };
    }
    if (fp.status === 403) {
      return { status: 'blocked', http_status: 403, error: 'http_403',
               cards: rank, ranking_rows: rows.length, pending_rows: 0,
               bytes: totalBytes, fetch_ms: totalFetchMs };
    }
    if (fp.status < 200 || fp.status >= 400) {
      return { status: 'failed', http_status: fp.status, error: `http_${fp.status}`,
               cards: rank, ranking_rows: rows.length, pending_rows: 0,
               bytes: totalBytes, fetch_ms: totalFetchMs };
    }

    let parsed;
    try { parsed = JSON.parse(fp.text); }
    catch (e) {
      return { status: 'failed', http_status: fp.status, error: `non-JSON: ${e.message}`,
               cards: rank, ranking_rows: rows.length, pending_rows: 0,
               bytes: totalBytes, fetch_ms: totalFetchMs };
    }

    // Vetting found Talabat shuffles the shape across versions; probe the
    // known paths in priority order (matches scrape-area-full-raw.js).
    const cards =
      (Array.isArray(parsed?.vendors)           && parsed.vendors.length           ? parsed.vendors           : null) ||
      (Array.isArray(parsed?.data?.vendors)     && parsed.data.vendors.length      ? parsed.data.vendors      : null) ||
      (Array.isArray(parsed?.result?.vendors)   && parsed.result.vendors.length    ? parsed.result.vendors    : null) ||
      (Array.isArray(parsed?.restaurants)       && parsed.restaurants.length       ? parsed.restaurants       : null) ||
      (Array.isArray(parsed?.data?.restaurants) && parsed.data.restaurants.length  ? parsed.data.restaurants  : null) ||
      [];
    const hasMore = parsed?.has_more === true || parsed?.result?.has_more === true || parsed?.data?.has_more === true;

    if (!Array.isArray(cards) || cards.length === 0) {
      if (page === 1) {
        // Area has no vendors at all
        return { status: 'not_found', http_status: fp.status, error: null,
                 cards: 0, ranking_rows: 0, pending_rows: 0,
                 bytes: totalBytes, fetch_ms: totalFetchMs };
      }
      break; // normal end of pagination
    }

    for (const c of cards) {
      rank += 1;
      const row = parseCard(c, rank);
      if (row) rows.push(row);
      collectCuisines(c, cuisinesByName);
    }

    if (!hasMore && cards.length < PAGE_SIZE) break;
    await sleep(PAGE_DELAY_MS);
  }

  // --- Partition rows into known vs pending (unknown branches) ------------
  // The scraper doesn't check Supabase per-row; it passes everything in
  // p_rows and nothing in p_pending by default. But to feed the registration
  // queue we need to send unknowns through p_pending. Simplest: ship all rows
  // under p_rows, and ALSO ship rows that look brand-new (we don't know yet).
  //
  // Supabase save_area_hour already handles the known/unknown split in
  // p_pending; for p_rows it assumes known. We play it safe by sending every
  // card as pending so the RPC's "exists in talabat_branch?" check splits
  // them correctly. Known ones go into ranking_analysis, unknowns into pending
  // + registration queue.
  //
  // Downside: slightly more work per RPC call (every row goes through the
  // existence check twice — once for the known/pending split, once for the
  // image-update loop). For ~500-1000 cards per area that's trivial.

  const result = {
    status: 'ok',
    http_status: httpStatus,
    cards: rank,
    ranking_rows: 0,     // filled after save_area_hour
    pending_rows: 0,
    bytes: totalBytes,
    fetch_ms: totalFetchMs,
    error: null,
  };

  if (dry_run) {
    result.ranking_rows = rows.length;
    return result;
  }

  const cuisines = Array.from(cuisinesByName.values());
  let saved;
  try {
    saved = await rpc('talabat_ranking_save_area_hour', {
      p_area_id:  area.area_id,
      p_date:     scrape_date,
      p_hour:     scrape_hour,
      p_rows:     [],              // we pass everything through pending; see note above
      p_pending:  rows,
      p_cuisines: cuisines,
    });
  } catch (e) {
    return { status: 'failed', http_status: httpStatus, error: `save_area_hour: ${e.message}`,
             cards: rank, ranking_rows: 0, pending_rows: 0,
             bytes: totalBytes, fetch_ms: totalFetchMs };
  }

  result.ranking_rows = (saved?.pending_promoted ?? 0) + (saved?.inserted ?? 0);
  result.pending_rows = saved?.pending_parked ?? 0;
  console.log(
    `  area=${area.area_id} ${area.area_name}: cards=${rank} rows=${result.ranking_rows} ` +
    `pending=${result.pending_rows} cuisines=${saved?.cuisines_added ?? 0} ` +
    `info=${saved?.info_updated ?? 0} elapsed=${Math.round((Date.now()-t0)/1000)}s`
  );
  return result;
}

// --------------------------------------------------------------------------
// Main loop
// --------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  const deadline = t0 + WALL_LIMIT_SEC * 1000;

  console.log(`Talabat UAE ranking worker — run=${RUN_ID} machine=${MACHINE_NO}`);
  const start = await rpc('talabat_ranking_machine_start', {
    p_run_id: parseInt(RUN_ID, 10),
    p_machine_no: MACHINE_NO,
    p_github_run_id: GITHUB_RUN_ID,
  });
  if (start?.stop) {
    console.log(`machine_start says stop: ${start.reason}`);
    return;
  }
  const scrape_date = start.scrape_date;
  const scrape_hour = start.scrape_hour.length === 5 ? start.scrape_hour + ':00' : start.scrape_hour;
  const dry_run     = start.dry_run === true;
  console.log(`started: date=${scrape_date} hour=${scrape_hour} dry_run=${dry_run}`);

  let areasDone = 0;
  let areasFailed = 0;

  while (Date.now() < deadline) {
    // heartbeat
    let check;
    try { check = await rpc('talabat_ranking_check', { p_run_id: parseInt(RUN_ID, 10), p_machine_no: MACHINE_NO }); }
    catch (e) { console.error('check failed:', e.message); break; }
    if (!check?.go) {
      console.log(`check says stop: ${check?.reason || 'unknown'}`);
      break;
    }

    // claim
    let claim;
    try { claim = await rpc('talabat_ranking_claim', { p_run_id: parseInt(RUN_ID, 10), p_machine_no: MACHINE_NO }); }
    catch (e) { console.error('claim failed:', e.message); break; }
    if (claim?.done) {
      console.log(`no claim: ${claim.reason}`);
      break;
    }

    const area = claim.area;
    if (claim.wait_ms > 0) {
      console.log(`  pacing: waiting ${claim.wait_ms} ms for slot`);
      await sleep(claim.wait_ms);
    }
    if (claim.batch_break) {
      console.log(`  planned break kicked in; already paced`);
    }

    // process + report
    const outcome = await processArea({ area, scrape_date, scrape_hour, dry_run });
    try {
      const rep = await rpc('talabat_ranking_report', {
        p_run_id: parseInt(RUN_ID, 10),
        p_machine_no: MACHINE_NO,
        p_area_id: area.area_id,
        p_result: outcome,
      });
      if (rep?.action === 'stop_job') {
        console.log(`report returned stop_job: ${rep.reason || 'rate limit/block'}`);
        break;
      }
    } catch (e) {
      console.error(`report failed for area ${area.area_id}: ${e.message}`);
    }

    if (outcome.status === 'ok' || outcome.status === 'not_found') areasDone++;
    else areasFailed++;

    // pace between areas (gap_seconds set by claim)
    const gap = parseFloat(claim.gap_seconds || '3') * 1000;
    await sleep(gap);
  }

  try {
    await rpc('talabat_ranking_machine_end', {
      p_run_id: parseInt(RUN_ID, 10),
      p_machine_no: MACHINE_NO,
      p_reason: `finished: ok=${areasDone} fail=${areasFailed}`,
    });
  } catch (e) {
    console.error('machine_end failed:', e.message);
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`DONE — areas ok=${areasDone} fail=${areasFailed} elapsed=${mins} min`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
