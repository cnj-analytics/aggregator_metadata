#!/usr/bin/env node
// noon/uae/ranking-scrape.js
//
// Hourly ranking worker.  Dispatched by GitHub Actions via workflow_dispatch,
// each runner is one "machine" in a Supabase ranking run.  Claims areas from
// the noon_ranking_run_area queue, walks the full /search listing for each
// area recording every outlet's ranking position, then saves the data via
// noon_ranking_save_area_hour.
//
// Auth: Noon's 3-step guest token minted locally on this runner's IP.
//   1. GET  whoami (ecom)    â nguestv2 cookie
//   2. POST set-location     â resolve lat/lng to zone
//   3. GET  whoami (food)    â zone headers for the food API
// Token lives ~300 s; one fresh token per area (ensureFresh 280 s headroom).
//
// Pagination: /search ignores `page`; chaining `searchToken` is the cursor.
// Each page returns up to 60 outlets.  Walk until empty / no new outlets /
// no token / max_pages.
//
// 429/403: on the listing endpoint, throttling is IP-based (a fresh token is
// still refused).  One rotation is attempted; if the fresh token also fails,
// report as rate_limited/blocked and let the orchestrator dispatch a
// replacement machine pinned to this area.
//
// Env vars (required):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RUN_ID                       Supabase ranking run id
//   MACHINE_NO                   machine number in the run
// Env vars (set by workflow):
//   GITHUB_RUN_ID                GitHub Actions run id
//   WALL_LIMIT_SEC               wall-clock safety cap (default 4500 = 75 min)

'use strict';

const crypto = require('node:crypto');

// ââ Env âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const RUN_ID    = Number(process.env.RUN_ID);
const MACHINE   = Number(process.env.MACHINE_NO);
const GH_RUN_ID = process.env.GITHUB_RUN_ID || '';
if (!RUN_ID || !MACHINE) {
  console.error('Missing or invalid RUN_ID / MACHINE_NO');
  process.exit(1);
}
const WALL_LIMIT_MS = (Number(process.env.WALL_LIMIT_SEC) || 4500) * 1000;
const START_TIME    = Date.now();

// ââ Constants âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const UA    = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const BUILD = '22098';

const WHOAMI_URL       = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami';
const SET_LOCATION_URL = 'https://api-app.noon.com/_vs/st/mp-identity-api-geo/serviceable-geo-info/set-location-by-lat-lng';
const WHOAMI_FOOD_URL  = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami?experience=food&select_nearby=1';
const SEARCH_URL       = 'https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/search';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_LIMIT      = 60;   // Noon's own page size
const PAGE_SAFETY_CAP = 500;  // runaway guard
const TOKEN_LIFE_MS   = 300_000;

// U+E001 is Noon's custom dirham glyph â normalise to "AED"
const DIRHAM_RE = /î/g;
const cleanText = (s) => (typeof s === 'string' ? s.replace(DIRHAM_RE, 'AED').trim() || null : null);

// ââ Supabase RPC helper âââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function rpc(name, params) {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`rpc(${name}) ${resp.status}: ${text.slice(0, 500)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`[m${MACHINE}] rpc(${name}) attempt ${attempt} failed: ${e.message} â retrying`);
      await sleep(2_000 * attempt);
    }
  }
}

// ââ Cookie helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function mergeSetCookies(jar, resp) {
  const list = typeof resp.headers.getSetCookie === 'function'
    ? resp.headers.getSetCookie() : [];
  for (const c of list) {
    const m = /^([^=]+)=([^;]+)/.exec(c);
    if (m) jar[m[1]] = m[2];
  }
}
const cookieStr = (jar) =>
  Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

function decodeJwtExp(jwt) {
  try {
    const seg = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(
      Buffer.from(seg + '='.repeat((4 - (seg.length % 4)) % 4), 'base64').toString('utf8'),
    );
    return p.exp ? p.exp * 1000 : null; // ms epoch
  } catch { return null; }
}

// ââ Token management ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

let session     = null;
let tokenNumber = 0;

function tokenRemainingMs() {
  if (!session) return 0;
  const byExp = session.expMs ? session.expMs - Date.now() : Infinity;
  const byAge = session.mintedAt + TOKEN_LIFE_MS - Date.now();
  return Math.max(0, Math.min(byExp, byAge));
}

/**
 * 3-step Noon guest auth.
 *   1. GET  whoami (ecom)    â nguestv2 cookie set
 *   2. POST set-location     â resolve lat/lng
 *   3. GET  whoami (food)    â zone headers for the food API
 */
async function mintToken(lat, lng) {
  const deviceId  = crypto.randomUUID();
  const visitorId = crypto.randomUUID();
  const jar = {};
  const base = () => ({
    'User-Agent': UA, 'x-platform': 'ios', 'x-build': BUILD,
    'x-mp': 'noon', 'x-content': 'mobile', Accept: 'application/json',
    'x-device-id': deviceId, 'x-visitor-id': visitorId,
  });

  // Step 1 â whoami (ecom)
  const r1 = await fetch(WHOAMI_URL, {
    headers: { ...base(), 'x-experience': 'ecom',
      'x-whoami-request-id': crypto.randomUUID() },
  });
  if (r1.status === 403) throw Object.assign(new Error('mint whoami 403'), { forbidden: true });
  if (!r1.ok) throw new Error(`mint whoami HTTP ${r1.status}`);
  mergeSetCookies(jar, r1);

  // Step 2 â set-location
  const r2 = await fetch(SET_LOCATION_URL, {
    method: 'POST',
    headers: { ...base(), 'x-experience': 'ecom', 'x-locale': 'en-ae',
      'x-device-lat': String(lat), 'x-device-lng': String(lng),
      'Content-Type': 'application/json', Cookie: cookieStr(jar) },
    body: JSON.stringify({ location: { lat, lng }, lang: 'en' }),
  });
  if (r2.status === 403) throw Object.assign(new Error('mint set-location 403'), { forbidden: true });
  if (!r2.ok) throw new Error(`mint set-location HTTP ${r2.status}`);
  mergeSetCookies(jar, r2);

  // Step 3 â whoami (food)
  const r3 = await fetch(WHOAMI_FOOD_URL, {
    headers: { ...base(), 'x-experience': 'ecom', 'x-locale': 'en-ae',
      'x-device-lat': String(lat), 'x-device-lng': String(lng),
      'x-whoami-request-id': crypto.randomUUID(), Cookie: cookieStr(jar) },
  });
  if (r3.status === 403) throw Object.assign(new Error('mint whoami-food 403'), { forbidden: true });
  if (!r3.ok) throw new Error(`mint whoami-food HTTP ${r3.status}`);
  const who = await r3.json().catch(() => ({}));
  mergeSetCookies(jar, r3);

  if (!jar.nguestv2) throw new Error('mint produced no nguestv2');

  const zones = who && who.headers && typeof who.headers === 'object' ? who.headers : {};
  tokenNumber++;
  session = {
    deviceId, visitorId, jar,
    zones,
    expMs: decodeJwtExp(jar.nguestv2),
    mintedAt: Date.now(),
  };
  console.log(`[m${MACHINE}] token #${tokenNumber} | zone=${zones['x-food-zonecode'] || '-'}`);
  return session;
}

/** Guarantee >= needMs of token life, minting if necessary. */
async function ensureFresh(lat, lng, needMs) {
  if (needMs === undefined) needMs = 280_000;
  if (tokenRemainingMs() >= needMs) return session;
  return mintToken(lat, lng);
}

/** Force-rotate to a new token (e.g. after 429). */
async function remint(lat, lng) {
  session = null;
  return mintToken(lat, lng);
}

// ââ Noon API calls ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function hdrs(lat, lng) {
  return {
    'User-Agent': UA, 'x-platform': 'ios', 'x-build': BUILD,
    'x-mp': 'noon', 'x-content': 'mobile', 'x-locale': 'en-ae',
    'x-device-id': session.deviceId, 'x-visitor-id': session.visitorId,
    'x-device-lat': String(lat), 'x-device-lng': String(lng),
    Accept: 'application/json',
  };
}

/**
 * Locate: set-location + whoami-food.
 * Returns zone headers + cookie string for subsequent search calls.
 */
async function locate(lat, lng) {
  const jar = { ...(session.jar || {}) };
  const h = { ...hdrs(lat, lng), 'x-experience': 'ecom' };

  // set-location
  const r1 = await fetch(SET_LOCATION_URL, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json', Cookie: cookieStr(jar) },
    body: JSON.stringify({ location: { lat, lng }, lang: 'en' }),
  });
  if (r1.status === 429) throw Object.assign(new Error('locate set-loc 429'), { rateLimited: true });
  if (r1.status === 403) throw Object.assign(new Error('locate set-loc 403'), { forbidden: true });
  if (!r1.ok) throw new Error(`locate set-loc HTTP ${r1.status}`);
  mergeSetCookies(jar, r1);

  // whoami food
  const r2 = await fetch(WHOAMI_FOOD_URL, {
    headers: { ...h, 'x-whoami-request-id': crypto.randomUUID(), Cookie: cookieStr(jar) },
  });
  if (r2.status === 429) throw Object.assign(new Error('locate whoami 429'), { rateLimited: true });
  if (r2.status === 403) throw Object.assign(new Error('locate whoami 403'), { forbidden: true });
  if (!r2.ok) throw new Error(`locate whoami HTTP ${r2.status}`);
  const who = await r2.json().catch(() => ({}));
  mergeSetCookies(jar, r2);

  const zh = who && who.headers && typeof who.headers === 'object' ? who.headers : {};
  return { lat, lng, zh, cookie: cookieStr(jar) };
}

/**
 * Fetch one listing page.  Returns { outlets[], token }.
 * `token` is the searchToken for the next page (null = last page).
 */
async function fetchPage(loc, searchToken) {
  const { lat, lng } = loc;
  const headers = {
    ...hdrs(lat, lng),
    'x-mp-country': 'ae', 'x-experience': 'food',
    'x-lat': String(Math.round(lat * 1e7)),
    'x-lng': String(Math.round(lng * 1e7)),
    'x-border-enabled': 'true', 'x-rocket-enabled': 'true',
    'x-whoami-request-id': crypto.randomUUID(),
    Cookie: loc.cookie, 'Content-Type': 'application/json',
  };
  // Echo the zone headers the food API wants back
  for (const [k, v] of Object.entries(loc.zh)) {
    if (v != null && typeof v !== 'object' && !k.toLowerCase().includes('ab-test'))
      headers[k] = String(v);
  }

  const body = {
    queryEntity: null, q: null, f: {}, contexts: [], withContent: true,
    excludeOutletCodes: [], limit: PAGE_LIMIT, page: 1,
    sort: { by: 'popularity', dir: 'desc' },
    type: 'outlet', qType: 'search_query', getFallback: true,
  };
  if (searchToken) body.searchToken = searchToken;

  const resp = await fetch(SEARCH_URL, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  if (resp.status === 429) throw Object.assign(new Error('search 429'), { rateLimited: true });
  if (resp.status === 403) throw Object.assign(new Error('search 403'), { forbidden: true });
  if (resp.status === 404) return { outlets: [], token: null };
  if (!resp.ok) throw new Error(`search HTTP ${resp.status}`);

  const json = await resp.json();

  // Walk the nested response to collect all outlet cards
  const outlets = [];
  (function walk(x, d) {
    if (d > 8 || !x) return;
    if (Array.isArray(x)) { for (const v of x) walk(v, d + 1); return; }
    if (typeof x === 'object') {
      if (typeof x.outletCode === 'string' && x.outletCode) { outlets.push(x); return; }
      for (const k of Object.keys(x)) walk(x[k], d + 1);
    }
  })(json.results || [], 0);

  return { outlets, token: json.searchToken || null };
}

// ââ Card -> ranking row âââââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Convert an ordered list of raw outlet cards into ranking row arrays
 * matching noon_ranking_save_area_hour's p_rows format (24 elements each).
 *
 * Indices:
 *   [0]  branch_id           [12] is_personalized
 *   [1]  rank                [13] is_sponsored
 *   [2]  operating_status    [14] ad_slot
 *   [3]  operating_type      [15] rating_display_count
 *   [4]  rating              [16] promo_mini_tag
 *   [5]  rating_count        [17] promo_extended_tag
 *   [6]  rating_status       [18] promo_is_free_delivery
 *   [7]  has_promo           [19] promo_is_non_free_delivery
 *   [8]  promo_text          [20] is_near_and_quick
 *   [9]  promo_scope         [21] card_name
 *   [10] promo_cap           [22] card_url
 *   [11] widget_group        [23] card_image_url
 *
 * Deduplicates by outletCode â keeps first appearance (= highest rank).
 */
function parseCards(outlets) {
  const seen = new Set();
  const rows = [];

  for (let i = 0; i < outlets.length; i++) {
    const o = outlets[i];
    const code = o.outletCode;
    if (!code || seen.has(code)) continue;
    seen.add(code);

    const rank = rows.length + 1; // 1-based deduplicated position

    // Rating
    const rt = o.rating || {};
    const rating           = rt.value != null ? rt.value : null;
    const ratingCount      = rt.count != null ? rt.count : null;
    const ratingStatus     = rt.status || null;
    const ratingDisplayCnt = rt.displayCount || null;

    // Promo
    const p           = o.promo || {};
    const tag         = typeof p.tag === 'string' ? p.tag : null;
    const miniTag     = typeof p.miniTag === 'string' ? p.miniTag : null;
    const extendedTag = typeof p.extendedTag === 'string' ? p.extendedTag : null;
    const hasPromo    = !!(tag || miniTag || extendedTag);
    const promoText   = cleanText(tag) || cleanText(extendedTag) || cleanText(miniTag);

    // Free delivery: if ANY tag/miniTag/extendedTag mentions "free delivery"
    const allTags      = [tag, miniTag, extendedTag].filter(Boolean).join(' ').toLowerCase();
    const isFreeDeliv  = allTags.includes('free delivery');
    const isNonFreeDel = hasPromo && !isFreeDeliv;

    rows.push([
      code,                                // [0]  noon_branch_id
      rank,                                // [1]  noon_rank
      o.operatingStatus || null,           // [2]  noon_operating_status
      o.operatingType   || null,           // [3]  noon_operating_type
      rating,                              // [4]  noon_rating
      ratingCount,                         // [5]  noon_rating_count
      ratingStatus,                        // [6]  noon_rating_status
      hasPromo,                            // [7]  noon_has_promo
      promoText,                           // [8]  noon_promo_text
      p.scope || null,                     // [9]  noon_promo_scope
      p.cap != null ? p.cap : (p.maxDiscount != null ? p.maxDiscount : null),
                                           // [10] noon_promo_cap
      o.widgetGroup || null,               // [11] noon_widget_group
      !!(o.isPersonalized),                // [12] noon_is_personalized
      !!(o.isSponsored),                   // [13] noon_is_sponsored
      o.adSlot != null ? o.adSlot : null,  // [14] noon_ad_slot
      ratingDisplayCnt,                    // [15] noon_rating_display_count
      cleanText(miniTag),                  // [16] noon_promo_mini_tag
      cleanText(extendedTag),              // [17] noon_promo_extended_tag
      isFreeDeliv,                         // [18] noon_promo_is_free_delivery
      isNonFreeDel,                        // [19] noon_promo_is_non_free_delivery
      !!(o.isNearAndQuick),                // [20] noon_is_near_and_quick
      o.name || null,                      // [21] noon_card_name
      o.pageUrl || null,                   // [22] noon_card_url
      o.imageUrl || o.logoUrl || null,     // [23] noon_card_image_url
    ]);
  }
  return rows;
}

// ââ Process one area ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function processArea(areaId, lat, lng, pageDelayMs, maxPages) {
  const t0 = Date.now();

  // Fresh token for this area (280 s headroom against 300 s token life)
  await ensureFresh(lat, lng);

  // Locate: set-location + whoami-food (2 API requests)
  const loc = await locate(lat, lng);

  // Walk all pages via searchToken chaining
  const allOutlets = [];
  const seen = new Set();
  let searchToken = null;
  let page = 0;
  let stopReason = null;
  const cap = maxPages || PAGE_SAFETY_CAP;

  while (page < cap) {
    page++;
    const r = await fetchPage(loc, searchToken);

    const fresh = r.outlets.filter((o) => !seen.has(o.outletCode));
    for (const o of fresh) { seen.add(o.outletCode); allOutlets.push(o); }

    if (r.outlets.length === 0) { stopReason = `empty@${page}`;    break; }
    if (fresh.length === 0)     { stopReason = `no-new@${page}`;   break; }
    if (!r.token)               { stopReason = `no-token@${page}`; break; }

    searchToken = r.token; // chain the cursor
    if (page < cap) await sleep(pageDelayMs);
  }
  if (!stopReason) stopReason = `max-pages(${cap})`;

  const rows    = parseCards(allOutlets);
  const elapsed = Date.now() - t0;
  // requests = pages (search) + 2 (set-location + whoami-food from locate)
  const requests = page + 2;

  return { pages: page, cards: allOutlets.length, rows, elapsed, requests, stopReason };
}

// ââ Main ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

(async () => {
  if (typeof fetch !== 'function') {
    console.error('Node 18+ required (native fetch)');
    process.exit(1);
  }

  console.log(`[m${MACHINE}] starting | run=${RUN_ID} | gh=${GH_RUN_ID} | wall=${WALL_LIMIT_MS / 1000}s`);

  // ââ machine_start âââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const start = await rpc('noon_ranking_machine_start', {
    p_run_id: RUN_ID, p_machine_no: MACHINE, p_github_run_id: GH_RUN_ID,
  });
  console.log(`[m${MACHINE}] start -> ${JSON.stringify(start)}`);

  if (start.stop) {
    console.log(`[m${MACHINE}] told to stop at check-in`);
    process.exit(0);
  }

  const scrapeDate = start.scrape_date;
  const scrapeHour = start.scrape_hour;
  const dryRun     = !!start.dry_run;
  let totalAreas = 0, totalRows = 0, totalRequests = 0;

  console.log(`[m${MACHINE}] date=${scrapeDate} hour=${scrapeHour} dry=${dryRun}`);

  // ââ claim -> process -> report loop âââââââââââââââââââââââââââââââââââ
  let exitReason = 'no_more_areas';

  while (true) {
    // Wall-clock safety check
    if (Date.now() - START_TIME > WALL_LIMIT_MS) {
      console.log(`[m${MACHINE}] wall limit reached (${WALL_LIMIT_MS / 1000}s)`);
      exitReason = 'wall_limit';
      break;
    }

    // Claim next area
    const claim = await rpc('noon_ranking_claim', {
      p_run_id: RUN_ID, p_machine_no: MACHINE,
    });

    // No area available
    if (!claim || claim.noon_area_id == null) {
      if (claim && claim.wait_ms > 0) {
        console.log(`[m${MACHINE}] wait ${claim.wait_ms}ms (pacing)`);
        await sleep(claim.wait_ms);
        continue;
      }
      console.log(`[m${MACHINE}] no more areas`);
      break;
    }

    const areaId   = claim.noon_area_id;
    const areaName = claim.area_name || String(areaId);
    const lat      = claim.lat;
    const lng      = claim.lng;
    const pageDel  = claim.page_delay_ms || 2000;
    const maxPg    = claim.max_pages     || PAGE_SAFETY_CAP;

    console.log(`[m${MACHINE}] claimed ${areaId} (${areaName}) | delay=${pageDel}ms max=${maxPg}`);

    // Pacing gap before starting this area
    if (claim.gap_seconds > 0) {
      console.log(`[m${MACHINE}] gap ${claim.gap_seconds}s`);
      await sleep(claim.gap_seconds * 1000);
    }

    // ââ process area ââââââââââââââââââââââââââââââââââââââââââââââââ
    let result;
    try {
      result = await processArea(areaId, lat, lng, pageDel, maxPg);
      totalRequests += result.requests;

      // Save ranking data via noon_ranking_save_area_hour
      let savedAnalysis = 0, savedPending = 0;
      if (!dryRun && result.rows.length > 0) {
        const sv = await rpc('noon_ranking_save_area_hour', {
          p_area_id: areaId, p_date: scrapeDate, p_hour: scrapeHour,
          p_rows: result.rows,
        });
        savedAnalysis = (sv && sv.analysis_rows != null) ? sv.analysis_rows : result.rows.length;
        savedPending  = (sv && sv.pending_rows  != null) ? sv.pending_rows  : 0;
        console.log(`[m${MACHINE}] saved ${areaId}: analysis=${savedAnalysis} pending=${savedPending}`);
      }

      // Report OK
      const rep = await rpc('noon_ranking_report', {
        p_run_id: RUN_ID, p_machine_no: MACHINE, p_area_id: areaId,
        p_result: {
          status:       'ok',
          pages_scraped: result.pages,
          cards:         result.cards,
          ranking_rows:  savedAnalysis,
          pending_rows:  savedPending,
          bytes:         0,
          fetch_ms:      result.elapsed,
        },
      });

      totalAreas++;
      totalRows += result.rows.length;
      console.log(
        `[m${MACHINE}] ${areaId} ok: ${result.cards} cards, ${result.rows.length} rows, ` +
        `${result.pages}p, ${result.elapsed}ms | ${result.stopReason} | -> ${rep.action}`,
      );

      if (rep.action === 'stop_job') {
        console.log(`[m${MACHINE}] stop: ${rep.reason}`);
        exitReason = 'stop_job';
        break;
      }
      if (rep.gap_seconds > 0) await sleep(rep.gap_seconds * 1000);

    } catch (e) {
      // ââ throttle / block ââââââââââââââââââââââââââââââââââââââââââ
      if (e.rateLimited || e.forbidden) {
        const kind = e.forbidden ? 'blocked' : 'rate_limited';
        console.log(`[m${MACHINE}] ${kind} on ${areaId}: ${e.message} â rotating token`);

        // One rotation attempt (unlikely to help for listing, but
        // follows the established safety pattern)
        try { await remint(lat, lng); } catch (me) {
          console.log(`[m${MACHINE}] remint failed: ${me.message}`);
        }

        const rep = await rpc('noon_ranking_report', {
          p_run_id: RUN_ID, p_machine_no: MACHINE, p_area_id: areaId,
          p_result: { status: kind },
        });
        console.log(`[m${MACHINE}] reported ${kind}: action=${rep.action} reason=${rep.reason || '-'}`);

        if (rep.action === 'stop_job') {
          exitReason = kind;
          break;
        }
        // If report says continue (area retried, replacement dispatched),
        // this machine keeps going with remaining areas
        if (rep.gap_seconds > 0) await sleep(rep.gap_seconds * 1000);

      } else {
        // ââ non-throttle error ââââââââââââââââââââââââââââââââââââââ
        console.log(`[m${MACHINE}] error on ${areaId}: ${e.message}`);
        const rep = await rpc('noon_ranking_report', {
          p_run_id: RUN_ID, p_machine_no: MACHINE, p_area_id: areaId,
          p_result: { status: 'error', error: e.message.slice(0, 500) },
        });
        if (rep.action === 'stop_job') {
          exitReason = 'stop_job';
          break;
        }
      }
    }
  }

  // ââ machine_end âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const end = await rpc('noon_ranking_machine_end', {
    p_run_id: RUN_ID, p_machine_no: MACHINE, p_reason: exitReason,
  });

  const elapsed = Math.round((Date.now() - START_TIME) / 1000);
  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`  run:      ${RUN_ID}`);
  console.log(`  machine:  ${MACHINE}`);
  console.log(`  areas:    ${totalAreas}`);
  console.log(`  rows:     ${totalRows}`);
  console.log(`  requests: ${totalRequests}`);
  console.log(`  tokens:   ${tokenNumber}`);
  console.log(`  elapsed:  ${elapsed}s`);
  console.log(`  exit:     ${exitReason}`);
  console.log(`  finished: ${JSON.stringify(end)}`);

})().catch(async (e) => {
  console.error(`[m${MACHINE}] FATAL: ${e.message}`);
  console.error(e.stack);
  try {
    await rpc('noon_ranking_machine_end', {
      p_run_id: RUN_ID, p_machine_no: MACHINE,
      p_reason: `fatal: ${e.message.slice(0, 200)}`,
    });
  } catch (_) {}
  process.exit(1);
});
