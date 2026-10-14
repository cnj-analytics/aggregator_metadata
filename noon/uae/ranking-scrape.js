#!/usr/bin/env node
// noon/uae/ranking-scrape.js
//
// Hourly ranking worker.  Dispatched by GitHub Actions via workflow_dispatch,
// each runner is one "machine" in a Supabase ranking run.  Claims up to TWO
// areas from the noon_ranking_run_area queue, walks the full /search listing
// for each area recording every outlet's ranking position, then saves the
// data via noon_ranking_save_area_hour.
//
// Noon-specific rules (NOT Careem's — Noon has stricter per-IP throttling):
//   * Max 2 areas per machine. Then exit (fresh IP = fresh machine).
//   * If area 1 >= 50 pages, don't claim area 2. The IP budget is near spent.
//   * One token per area. Minted at area start, never re-minted mid-walk.
//   * 429 / 403 anywhere stops the machine IMMEDIATELY. Any completed area is
//     already committed; the in-flight area is reported blocked and returned
//     to the queue by the orchestrator for a replacement machine to retry.
//   * Non-restaurant outlets (all cuisines in noon_cuisines where is_food=false)
//     are dropped at parse time so they never pollute the registration queue.
//
// Auth: Noon's 3-step guest token minted locally on this runner's IP.
//   1. GET  whoami (ecom)    -> nguestv2 cookie
//   2. POST set-location     -> resolve lat/lng to zone
//   3. GET  whoami (food)    -> zone headers for the food API
//
// Pagination: /search ignores `page`; chaining `searchToken` is the cursor.
// Each page returns up to 60 outlets. Walk until empty / no new outlets /
// no token / max_pages.
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

// -- Env --------------------------------------------------------------------

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

// -- Constants --------------------------------------------------------------

const UA    = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const BUILD = '22098';

const WHOAMI_URL       = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami';
const SET_LOCATION_URL = 'https://api-app.noon.com/_vs/st/mp-identity-api-geo/serviceable-geo-info/set-location-by-lat-lng';
const WHOAMI_FOOD_URL  = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami?experience=food&select_nearby=1';
const SEARCH_URL       = 'https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/search';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_LIMIT        = 60;    // Noon's own page size
const PAGE_SAFETY_CAP   = 500;   // runaway guard
const MAX_AREAS_PER_RUN = 2;     // Noon rule: hard cap, fresh IP for more
const EARLY_EXIT_PAGES  = 50;    // if area 1 >= this, don't claim area 2

// U+E001 is Noon's custom dirham glyph -> normalise to "AED"
const DIRHAM_RE = //g;
const cleanText = (s) => (typeof s === 'string' ? s.replace(DIRHAM_RE, 'AED').trim() || null : null);

// -- Supabase RPC helper ----------------------------------------------------

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
      console.log(`[m${MACHINE}] rpc(${name}) attempt ${attempt} failed: ${e.message} - retrying`);
      await sleep(2_000 * attempt);
    }
  }
}

// -- Cookie helpers ---------------------------------------------------------

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

// -- Token (one per area, no re-mint mid-walk) ------------------------------

let session     = null;
let tokenNumber = 0;

/**
 * 3-step Noon guest auth. One token lives ~300s. Called once per area at
 * area start. Never called mid-walk — token exhaustion inside an area is
 * accepted (unlikely at 60 pages * 500ms = 30s per area).
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

  // Step 1 - whoami (ecom)
  const r1 = await fetch(WHOAMI_URL, {
    headers: { ...base(), 'x-experience': 'ecom',
      'x-whoami-request-id': crypto.randomUUID() },
  });
  if (r1.status === 403) throw Object.assign(new Error('mint whoami 403'), { forbidden: true });
  if (!r1.ok) throw new Error(`mint whoami HTTP ${r1.status}`);
  mergeSetCookies(jar, r1);

  // Step 2 - set-location
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

  // Step 3 - whoami (food)
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
  session = { deviceId, visitorId, jar, zones, mintedAt: Date.now() };
  console.log(`[m${MACHINE}] token #${tokenNumber} | zone=${zones['x-food-zonecode'] || '-'}`);
  return session;
}

// -- Noon API calls ---------------------------------------------------------

function hdrs(lat, lng) {
  return {
    'User-Agent': UA, 'x-platform': 'ios', 'x-build': BUILD,
    'x-mp': 'noon', 'x-content': 'mobile', 'x-locale': 'en-ae',
    'x-device-id': session.deviceId, 'x-visitor-id': session.visitorId,
    'x-device-lat': String(lat), 'x-device-lng': String(lng),
    Accept: 'application/json',
  };
}

async function locate(lat, lng) {
  const jar = { ...(session.jar || {}) };
  const h = { ...hdrs(lat, lng), 'x-experience': 'ecom' };

  const r1 = await fetch(SET_LOCATION_URL, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json', Cookie: cookieStr(jar) },
    body: JSON.stringify({ location: { lat, lng }, lang: 'en' }),
  });
  if (r1.status === 429) throw Object.assign(new Error('locate set-loc 429'), { rateLimited: true });
  if (r1.status === 403) throw Object.assign(new Error('locate set-loc 403'), { forbidden: true });
  if (!r1.ok) throw new Error(`locate set-loc HTTP ${r1.status}`);
  mergeSetCookies(jar, r1);

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

// -- Non-restaurant filter --------------------------------------------------

/**
 * Returns true if the outlet is a restaurant (at least one cuisine marked
 * is_food=true in noon_cuisines). Drops the outlet if ALL cuisines are
 * non-food (Flowers, Pharmacy, Butcher Shop, etc).
 */
function isRestaurant(outlet, nonFoodSet) {
  const cuisines = Array.isArray(outlet.cuisines) ? outlet.cuisines : [];
  if (cuisines.length === 0) return true;        // unknown -> keep (register will decide)
  for (const c of cuisines) if (!nonFoodSet.has(c)) return true;
  return false;
}

// -- New-schema helpers (Noon changed /search response shape on 2026-10-14) --

const CDN_PREFIX = 'https://f.nooncdn.com/food_production/';
const cdnUrl = (key) =>
  (typeof key === 'string' && key.trim()) ? CDN_PREFIX + key.trim() + '?width=720&format=webp' : null;

// Rating state is now carried in rating.title: null -> not_rated, "New" -> new,
// anything else (e.g., "4.4 (500+)") -> rated.
function deriveRatingStatus(title) {
  if (title == null || String(title).trim() === '') return 'not_rated';
  if (/^new$/i.test(String(title).trim())) return 'new';
  return 'rated';
}

/**
 * Classify a promo text string into the noon_promo_scope enum values and
 * extract numeric percent and cap when present. Any one of the three card tag
 * fields (tag / extendedTag / miniTag) can match. extendedTag often carries
 * the richest form (with "up to X" caps or "select items" scope).
 *
 * Returns { scope, percent, cap }. All nullable.
 *
 * Pattern catalogue (from 2026-10-14 live sample of 12,565 cards):
 *   - "30% off", "50% OFF"                 -> percent_off
 *   - "30% off up to  20"                  -> percent_off_capped (cap=20)
 *   - "Flat 50% off"                       -> flat_percent_off
 *   - "64% off select items"               -> percent_off_select_items
 *   - "50% off full menu"                  -> percent_off_full_menu
 *   - "30% OFF Bestsellers"                -> percent_off_bestsellers
 *   - "50% off above  1"                   -> percent_off_above_min (threshold=1)
 *   - "Offers"                             -> offers_generic
 *   - "Free Delivery"                      -> free_delivery
 */
function classifyPromo(tag, extendedTag, miniTag) {
  // Prefer extendedTag because it has the richest text ("up to", "select items")
  const texts = [extendedTag, tag, miniTag].filter(
    (t) => typeof t === 'string' && t.trim()
  );
  if (texts.length === 0) return { scope: null, percent: null, cap: null };

  const joined = texts.join(' | ');
  const low = joined.toLowerCase();

  // free_delivery FIRST (only promos the restaurant pays matter — but
  // Noon still uses the tag text as our signal, so we read it here)
  if (/\bfree\s*delivery\b/i.test(joined)) {
    return { scope: 'free_delivery', percent: null, cap: null };
  }

  // percent capture: first NN% in any text
  const percentMatch = joined.match(/(\d{1,3})\s*%/);
  const percent = percentMatch ? Math.min(100, parseInt(percentMatch[1], 10)) : null;

  // cap capture: "up to <num>" (dirham amount, no AED prefix in Noon text)
  const capMatch = joined.match(/up\s*to\s*[^0-9]*([\d.]+)/i);
  const cap = capMatch ? parseFloat(capMatch[1]) : null;

  // Classify scope by phrase
  if (/bestseller/i.test(joined))     return { scope: 'percent_off_bestsellers', percent, cap };
  if (/select\s*items?/i.test(joined)) return { scope: 'percent_off_select_items', percent, cap };
  if (/full\s*menu/i.test(joined))     return { scope: 'percent_off_full_menu', percent, cap };
  if (/\babove\b/i.test(joined)) {
    // "50% off above  1" -> percent_off_above_min, cap carries the threshold
    const aboveMatch = joined.match(/above\s*[^0-9]*([\d.]+)/i);
    const threshold = aboveMatch ? parseFloat(aboveMatch[1]) : null;
    return { scope: 'percent_off_above_min', percent, cap: threshold };
  }
  if (/\bflat\b/i.test(joined))        return { scope: 'flat_percent_off', percent, cap: null };
  if (/up\s*to/i.test(joined))         return { scope: 'percent_off_capped', percent, cap };
  if (percent != null)                 return { scope: 'percent_off', percent, cap: null };
  if (/^\s*offers?\s*$/i.test(joined)) return { scope: 'offers_generic', percent: null, cap: null };

  return { scope: 'offers_generic', percent: null, cap: null };
}

// -- Card -> ranking row ----------------------------------------------------

function parseCards(outlets, nonFoodSet) {
  const seen = new Set();
  const rows = [];
  let dropped = 0;

  for (let i = 0; i < outlets.length; i++) {
    const o = outlets[i];
    const code = o.outletCode;
    if (!code || seen.has(code)) continue;
    if (!isRestaurant(o, nonFoodSet)) { dropped++; continue; }
    seen.add(code);

    const rank = rows.length + 1;

    // Rating: new schema uses rating.score + rating.title + rating.titleCode.
    const rt = o.rating || {};
    const rating           = rt.score != null ? rt.score : null;
    const ratingCount      = rt.count != null ? rt.count : null;
    const ratingTitle      = rt.title || null;
    const ratingDisplayCnt = rt.displayCount || null;
    const ratingStatus     = deriveRatingStatus(ratingTitle);

    // Promo tags are now top-level, not nested under o.promo.
    const tag         = typeof o.tag === 'string' ? o.tag : null;
    const miniTag     = typeof o.miniTag === 'string' ? o.miniTag : null;
    const extendedTag = typeof o.extendedTag === 'string' ? o.extendedTag : null;
    const hasPromo    = !!(tag || miniTag || extendedTag);
    const promoText   = cleanText(tag) || cleanText(extendedTag) || cleanText(miniTag);

    const classified   = classifyPromo(tag, extendedTag, miniTag);
    // Free-delivery flag reads ONLY from the promo text (restaurant-paid signal).
    const isFreeDeliv  = classified.scope === 'free_delivery';
    const isNonFreeDel = hasPromo && !isFreeDeliv;

    // Images: new schema returns raw CDN keys in media.*; build full URLs.
    const d           = o.delivery || {};
    const bannerKey   = (o.media && typeof o.media.heroImage === 'string') ? o.media.heroImage : null;
    const logoKey     = (o.media && typeof o.media.logoImage === 'string') ? o.media.logoImage : null;
    const bannerUrl   = cdnUrl(bannerKey);
    const logoUrl     = cdnUrl(logoKey);

    rows.push([
      code,                                // [0]  noon_branch_id
      rank,                                // [1]  noon_listing_rank
      o.operatingStatusCode || null,       // [2]  noon_operating_status (RENAMED)
      o.operatingType       || null,       // [3]  noon_operating_type
      rating,                              // [4]  noon_rating (rating.score)
      ratingCount,                         // [5]  noon_rating_count
      ratingStatus,                        // [6]  noon_rating_status (derived)
      hasPromo,                            // [7]  noon_has_promo
      promoText,                           // [8]  noon_promo_text
      classified.scope,                    // [9]  noon_promo_scope (classified)
      classified.cap,                      // [10] noon_promo_cap (extracted)
      o.widgetGroup || null,               // [11] noon_widget_group
      !!(o.isPersonalized),                // [12] noon_is_personalized
      false,                               // [13] noon_is_sponsored  (DEPRECATED: Noon dropped this signal)
      null,                                // [14] noon_ad_slot        (DEPRECATED: Noon dropped this signal)
      ratingDisplayCnt,                    // [15] noon_rating_display_count
      cleanText(miniTag),                  // [16] noon_promo_mini_tag
      cleanText(extendedTag),              // [17] noon_promo_extended_tag
      isFreeDeliv,                         // [18] noon_promo_is_free_delivery
      isNonFreeDel,                        // [19] noon_promo_is_non_free_delivery
      !!(o.isNearAndQuick),                // [20] noon_is_near_and_quick
      o.name || null,                      // [21] noon_card_name
      o.linkUrl || null,                   // [22] noon_card_url (RENAMED: pageUrl -> linkUrl)
      bannerUrl,                           // [23] noon_card_banner_url (full CDN URL, used as branch banner)
      Array.isArray(o.cuisines) ? o.cuisines : [], // [24] cuisines (for queue)
      o.restaurantCode || null,            // [25] noon_restaurant_code (NEW: brand code at scrape time)
      typeof o.price === 'string' ? o.price : null, // [26] noon_card_price_tier ($, $$, $$$)
      typeof o.distance === 'number' ? o.distance : null, // [27] noon_card_distance_m
      ratingTitle,                         // [28] noon_card_rating_title
      typeof d.fee === 'number' ? d.fee : null,          // [29] delivery_fee
      typeof d.originalFee === 'number' ? d.originalFee : null, // [30] delivery_original_fee
      typeof d.minOrder === 'number' ? d.minOrder : null, // [31] delivery_min_order
      typeof d.time === 'string' ? d.time : null,         // [32] delivery_time
      classified.percent,                  // [33] noon_promo_percent (extracted)
      logoUrl,                             // [34] brand logo URL (full CDN)
      typeof o.isVip === 'boolean' ? o.isVip : null, // [35] noon_is_vip (ranking row; null when missing)
      o.vipMsg || null,                    // [36] noon_vip_msg (ranking row; null when blank)
    ]);
  }
  return { rows, dropped };
}

// -- Process one area -------------------------------------------------------

async function processArea(areaId, lat, lng, pageDelayMs, maxPages, nonFoodSet) {
  const t0 = Date.now();

  // One token per area, minted now. Not re-minted mid-walk.
  await mintToken(lat, lng);

  // Locate: set-location + whoami-food
  const loc = await locate(lat, lng);

  const allOutlets = [];
  const seen = new Set();
  let searchToken = null;
  let page = 0;
  let stopReason = null;
  const cap = maxPages || PAGE_SAFETY_CAP;

  while (page < cap) {
    page++;
    const pt0 = Date.now();
    const r = await fetchPage(loc, searchToken);
    const pageMs = Date.now() - pt0;

    const fresh = r.outlets.filter((o) => !seen.has(o.outletCode));
    for (const o of fresh) { seen.add(o.outletCode); allOutlets.push(o); }

    console.log(
      `[m${MACHINE}] ${areaId} p${page}: ${r.outlets.length} outlets ` +
      `(${fresh.length} new, ${allOutlets.length} total) ${pageMs}ms` +
      `${r.token ? '' : ' no-token'}`
    );

    if (r.outlets.length === 0) { stopReason = `empty@${page}`;    break; }
    if (fresh.length === 0)     { stopReason = `no-new@${page}`;   break; }
    if (!r.token)               { stopReason = `no-token@${page}`; break; }

    searchToken = r.token;
    if (page < cap) await sleep(pageDelayMs);
  }
  if (!stopReason) stopReason = `max-pages(${cap})`;

  const parsed  = parseCards(allOutlets, nonFoodSet);
  const elapsed = Date.now() - t0;
  const requests = page + 2; // search pages + locate (set-location + whoami-food)

  return {
    pages: page,
    cards: allOutlets.length,
    rows: parsed.rows,
    dropped: parsed.dropped,
    elapsed,
    requests,
    stopReason,
  };
}

// -- Main -------------------------------------------------------------------

(async () => {
  if (typeof fetch !== 'function') {
    console.error('Node 18+ required (native fetch)');
    process.exit(1);
  }

  console.log(`[m${MACHINE}] starting | run=${RUN_ID} | gh=${GH_RUN_ID} | wall=${WALL_LIMIT_MS / 1000}s`);

  // -- machine_start -------------------------------------------------------
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
  let totalAreas = 0, totalRows = 0, totalRequests = 0, totalDropped = 0;

  console.log(`[m${MACHINE}] date=${scrapeDate} hour=${scrapeHour} dry=${dryRun}`);

  // -- Fetch non-food cuisines once at startup -----------------------------
  const nonFoodList = await rpc('noon_get_non_food_cuisines', {});
  const nonFoodSet  = new Set(Array.isArray(nonFoodList) ? nonFoodList : []);
  console.log(`[m${MACHINE}] non-food cuisines (${nonFoodSet.size}): ${[...nonFoodSet].join(', ')}`);

  // -- claim -> process -> report loop (max 2 areas) -----------------------
  let exitReason = 'areas_complete';

  for (let areaIdx = 0; areaIdx < MAX_AREAS_PER_RUN; areaIdx++) {
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

    if (!claim || claim.noon_area_id == null) {
      if (claim && claim.wait_ms > 0) {
        console.log(`[m${MACHINE}] wait ${claim.wait_ms}ms (pacing)`);
        await sleep(claim.wait_ms);
        areaIdx--; // doesn't count — try claim again
        continue;
      }
      console.log(`[m${MACHINE}] no more areas`);
      exitReason = 'no_more_areas';
      break;
    }

    const areaId   = claim.noon_area_id;
    const areaName = claim.area_name || String(areaId);
    const lat      = claim.lat;
    const lng      = claim.lng;
    const pageDel  = claim.page_delay_ms || 500;
    const maxPg    = claim.max_pages     || PAGE_SAFETY_CAP;

    console.log(`[m${MACHINE}] claimed ${areaId} (${areaName}) [area ${areaIdx + 1}/${MAX_AREAS_PER_RUN}] | delay=${pageDel}ms max=${maxPg}`);

    if (claim.gap_seconds > 0) {
      console.log(`[m${MACHINE}] gap ${claim.gap_seconds}s`);
      await sleep(claim.gap_seconds * 1000);
    }

    // -- process area ------------------------------------------------------
    let result;
    try {
      result = await processArea(areaId, lat, lng, pageDel, maxPg, nonFoodSet);
      totalRequests += result.requests;
      totalDropped  += result.dropped;

      // Save ranking data
      let savedAnalysis = 0, savedPending = 0;
      if (!dryRun && result.rows.length > 0) {
        const sv = await rpc('noon_ranking_save_area_hour', {
          p_area_id: areaId, p_date: scrapeDate, p_hour: scrapeHour,
          p_rows: result.rows,
        });
        savedAnalysis = (sv && sv.inserted != null) ? sv.inserted : result.rows.length;
        savedPending  = (sv && sv.pending  != null) ? sv.pending  : 0;
        console.log(`[m${MACHINE}] saved ${areaId}: analysis=${savedAnalysis} pending=${savedPending} dropped=${result.dropped}`);
      }

      // Report OK
      const rep = await rpc('noon_ranking_report', {
        p_run_id: RUN_ID, p_machine_no: MACHINE, p_area_id: areaId,
        p_result: {
          status:        'ok',
          pages_scraped: result.pages,
          cards:         result.cards,
          ranking_rows:  savedAnalysis,
          pending_rows:  savedPending,
          dropped:       result.dropped,
          bytes:         0,
          fetch_ms:      result.elapsed,
        },
      });

      totalAreas++;
      totalRows += result.rows.length;
      console.log(
        `[m${MACHINE}] ${areaId} ok: ${result.cards} cards, ${result.rows.length} rows (${result.dropped} dropped), ` +
        `${result.pages}p, ${result.elapsed}ms | ${result.stopReason} | -> ${rep.action}`,
      );

      if (rep.action === 'stop_job') {
        console.log(`[m${MACHINE}] stop: ${rep.reason}`);
        exitReason = 'stop_job';
        break;
      }

      // Noon rule: if first area went long, don't risk the IP on a second
      if (areaIdx === 0 && result.pages >= EARLY_EXIT_PAGES) {
        console.log(`[m${MACHINE}] area 1 was ${result.pages}p (>= ${EARLY_EXIT_PAGES}), skipping area 2 to spare IP`);
        exitReason = 'first_area_long';
        break;
      }

      if (rep.gap_seconds > 0) await sleep(rep.gap_seconds * 1000);

    } catch (e) {
      // 429 / 403: stop machine immediately. Any completed area is already
      // committed. In-flight area reported blocked -> back to queue for a
      // replacement machine on a fresh IP.
      if (e.rateLimited || e.forbidden) {
        const kind = e.forbidden ? 'blocked' : 'rate_limited';
        console.log(`[m${MACHINE}] ${kind} on ${areaId}: ${e.message} - stopping machine immediately`);

        const rep = await rpc('noon_ranking_report', {
          p_run_id: RUN_ID, p_machine_no: MACHINE, p_area_id: areaId,
          p_result: { status: kind },
        });
        console.log(`[m${MACHINE}] reported ${kind}: action=${rep.action} reason=${rep.reason || '-'}`);

        exitReason = kind;
        break; // Noon rule: 429/403 ALWAYS stops the machine
      }

      // Non-throttle error -> report and stop (one error exhausts the budget too)
      console.log(`[m${MACHINE}] error on ${areaId}: ${e.message}`);
      await rpc('noon_ranking_report', {
        p_run_id: RUN_ID, p_machine_no: MACHINE, p_area_id: areaId,
        p_result: { status: 'error', error: e.message.slice(0, 500) },
      });
      exitReason = 'error';
      break;
    }
  }

  // -- machine_end ---------------------------------------------------------
  const end = await rpc('noon_ranking_machine_end', {
    p_run_id: RUN_ID, p_machine_no: MACHINE, p_reason: exitReason,
  });

  const elapsed = Math.round((Date.now() - START_TIME) / 1000);
  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`  run:       ${RUN_ID}`);
  console.log(`  machine:   ${MACHINE}`);
  console.log(`  areas:     ${totalAreas}`);
  console.log(`  rows:      ${totalRows}`);
  console.log(`  dropped:   ${totalDropped} (non-restaurant)`);
  console.log(`  requests:  ${totalRequests}`);
  console.log(`  tokens:    ${tokenNumber}`);
  console.log(`  elapsed:   ${elapsed}s`);
  console.log(`  exit:      ${exitReason}`);
  console.log(`  finished:  ${JSON.stringify(end)}`);

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
