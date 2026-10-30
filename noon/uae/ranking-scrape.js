#!/usr/bin/env node
// noon/uae/ranking-scrape.js
//
// Hourly ranking worker. Dispatched by GitHub Actions via workflow_dispatch,
// each runner is one "machine" in a Supabase ranking run. Claims up to TWO
// areas from the noon_ranking_run_area queue, walks the full /search listing
// for each area recording every outlet's ranking position, then saves the
// data via noon_ranking_save_area_hour.
//
// Noon-specific rules (NOT Careem's — Noon has stricter per-IP throttling):
// * Max 2 areas per machine. Then exit (fresh IP = fresh machine).
// * If area 1 >= 50 pages, don't claim area 2. The IP budget is near spent.
// * One token per area. Minted at area start, never re-minted mid-walk.
// * 429 / 403 anywhere stops the machine IMMEDIATELY. Any completed area is
// already committed; the in-flight area is reported blocked and returned
// to the queue by the orchestrator for a replacement machine to retry.
// * Non-restaurant outlets (all cuisines in noon_cuisines where is_food=false)
// are dropped at parse time so they never pollute the registration queue.
//
// Auth: Noon's 3-step guest token minted locally on this runner's IP.
// 1. GET whoami (ecom) -> nguestv2 cookie
// 2. POST set-location -> resolve lat/lng to zone
// 3. GET whoami (food) -> zone headers for the food API
//
// Pagination: /search ignores `page`; chaining `searchToken` is the cursor.
// Each page returns up to 60 outlets. Walk until empty / no new outlets /
// no token / max_pages.
//
// Env vars (required):
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// RUN_ID Supabase ranking run id
// MACHINE_NO machine number in the run
// Env vars (set by workflow):
// GITHUB_RUN_ID GitHub Actions run id
// WALL_LIMIT_SEC wall-clock safety cap (default 4500 = 75 min)

'use strict';

const crypto = require('node:crypto');

// -- Env --------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const RUN_ID  = Number(process.env.RUN_ID);
const MACHINE = Number(process.env.MACHINE_NO);
const GH_RUN_ID = process.env.GITHUB_RUN_ID || '';
if (!RUN_ID || !MACHINE) {
  console.error('Missing or invalid RUN_ID / MACHINE_NO');
  process.exit(1);
}
const WALL_LIMIT_MS = (Number(process.env.WALL_LIMIT_SEC) || 4500) * 1000;
const START_TIME = Date.now();

// -- Audit log (403 pattern analysis). Never blocks or stops a scrape. ------

let NOON_REQ = 0;      // Noon requests made from this machine's IP
let RUNNER_IP = null;   // public IP of this GitHub runner
// HTTP/2 (Node's built-in fetch negotiates h2 by default)
const _nativeFetch = globalThis.fetch;
globalThis.fetch = (u, o) => {
  if (String(u).includes('noon.com')) NOON_REQ++;
  return _nativeFetch(u, o);
};
const rawFetch = _nativeFetch;  // used by audit() and ipify
const AREA_CTX = { page: 0 };

function failStep(msg) {
  const m = String(msg || '');
  if (m.startsWith('mint whoami-food')) return 'mint_whoami_food';
  if (m.startsWith('mint whoami'))      return 'mint_whoami';
  if (m.startsWith('mint set-location')) return 'mint_set_location';
  if (m.startsWith('locate set-loc'))   return 'locate_set_location';
  if (m.startsWith('locate whoami'))    return 'locate_whoami';
  if (m.startsWith('search'))           return 'search';
  return 'other';
}

async function audit(row) {
  try {
    const r = await rawFetch(`${SUPABASE_URL}/rest/v1/noon_scrape_audit`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        run_id: RUN_ID, machine_no: MACHINE, github_run_id: GH_RUN_ID,
        runner_ip: RUNNER_IP,
        machine_started_at: new Date(START_TIME).toISOString(),
        machine_age_s: Math.round((Date.now() - START_TIME) / 1000),
        areas_cap: MAX_AREAS_PER_RUN,
        ...row,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) console.log(`[m${MACHINE}] audit log HTTP ${r.status}`);
  } catch (e) {
    console.log(`[m${MACHINE}] audit log failed: ${e.message}`);
  }
}

// -- Constants --------------------------------------------------------------

const UA    = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const BUILD = '22098';

const WHOAMI_URL       = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami';
const SET_LOCATION_URL = 'https://api-app.noon.com/_vs/st/mp-identity-api-geo/serviceable-geo-info/set-location-by-lat-lng';
const WHOAMI_FOOD_URL  = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami?experience=food&select_nearby=1';
const SEARCH_URL       = 'https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/search';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_LIMIT        = 60;
const PAGE_SAFETY_CAP   = 500;
const MAX_AREAS_PER_RUN = 2;
const EARLY_EXIT_PAGES  = 50;

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

async function mintToken(lat, lng) {
  const deviceId  = crypto.randomUUID();
  const visitorId = crypto.randomUUID();
  const jar = {};
  const base = () => ({
    'User-Agent': UA, 'x-platform': 'ios', 'x-build': BUILD,
    'x-mp': 'noon', 'x-content': 'mobile', Accept: 'application/json',
    'x-device-id': deviceId, 'x-visitor-id': visitorId,
  });

  const r1 = await fetch(WHOAMI_URL, {
    headers: { ...base(), 'x-experience': 'ecom',
      'x-whoami-request-id': crypto.randomUUID() },
  });
  if (r1.status === 403) throw Object.assign(new Error('mint whoami 403'), { forbidden: true });
  if (!r1.ok) throw new Error(`mint whoami HTTP ${r1.status}`);
  mergeSetCookies(jar, r1);

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

function isRestaurant(outlet, nonFoodCuisines) {
  const raw = outlet.cuisines || outlet.cuisineNames || [];
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) return true;          // no cuisine info -> keep it
  // Restaurant if at least one cuisine is food
  return list.some((c) => {
    const key = String(c).trim().toLowerCase();
    return key && !nonFoodCuisines.has(key);
  });
}

// -- CDN URL helpers --------------------------------------------------------

const CDN_PREFIX = 'https://f.nooncdn.com/s/app/com/noon/';

function cdnUrl(p) {
  if (!p || typeof p !== 'string') return null;
  if (p.startsWith('http')) return p;
  return CDN_PREFIX + p.replace(/^\/+/, '');
}

// -- Rating status ----------------------------------------------------------

function deriveRatingStatus(score, count) {
  if (score == null || count == null || count === 0) return 'new';
  if (count < 25) return 'few';
  return 'enough';
}

// -- Promo classification ---------------------------------------------------
// Returns { scope, cap, percent }.
//   scope   : 'delivery' | 'order' | 'bogo' | 'item' | 'other' | null
//   cap     : number (AED) | null
//   percent : number (0–100) | null

function classifyPromo(text) {
  if (!text) return { scope: null, cap: null, percent: null };
  const t = String(text);

  // — Free delivery --------------------------------------------------------
  if (/free\s+deliver/i.test(t)) {
    return { scope: 'delivery', cap: null, percent: 100 };
  }

  // — Delivery discount with flat AED off ----------------------------------
  const delFlat = t.match(/(?:save|get)\s+(?:AED\s*)?(\d+(?:\.\d+)?)\s+(?:on\s+)?deliver/i);
  if (delFlat) {
    return { scope: 'delivery', cap: Number(delFlat[1]), percent: null };
  }

  // — Delivery % off -------------------------------------------------------
  const delPct = t.match(/(\d+)%\s+(?:off\s+)?(?:on\s+)?deliver/i);
  if (delPct) {
    return { scope: 'delivery', cap: null, percent: Number(delPct[1]) };
  }

  // — Reduced / low delivery fee -------------------------------------------
  if (/(?:reduced|low|less)\s+deliver/i.test(t)) {
    return { scope: 'delivery', cap: null, percent: null };
  }

  // — BOGO -----------------------------------------------------------------
  if (/b[uo][gy]\s*\d\s*get\s*\d/i.test(t) || /\bbogo\b/i.test(t) ||
      /buy\s*one\s*get\s*one/i.test(t)) {
    return { scope: 'bogo', cap: null, percent: null };
  }

  // — Order % off with cap: "20% off up to AED 15" ------------------------
  const pctCap = t.match(/(\d+)%\s*off.*?(?:up\s*to|max|capped?\s*at)\s*(?:AED\s*)?(\d+(?:\.\d+)?)/i);
  if (pctCap) {
    return { scope: 'order', cap: Number(pctCap[2]), percent: Number(pctCap[1]) };
  }

  // — Order % off no cap: "30% off" ---------------------------------------
  const pctOnly = t.match(/(\d+)%\s*off/i);
  if (pctOnly) {
    return { scope: 'order', cap: null, percent: Number(pctOnly[1]) };
  }

  // — Flat AED off order: "AED 10 off" ------------------------------------
  const flatOff = t.match(/(?:AED\s*)?(\d+(?:\.\d+)?)\s+off/i);
  if (flatOff) {
    return { scope: 'order', cap: Number(flatOff[1]), percent: null };
  }

  // — Item-level promo (e.g. "Up to 50% off on selected items") -----------
  const itemPct = t.match(/up\s+to\s+(\d+)%\s*(?:off)?\s*(?:on\s+)?(?:selected|menu|item)/i);
  if (itemPct) {
    return { scope: 'item', cap: null, percent: Number(itemPct[1]) };
  }

  // — Fallback: bare percentage anywhere ----------------------------------
  const anyPct = t.match(/(\d+)%/);
  if (anyPct) {
    return { scope: 'other', cap: null, percent: Number(anyPct[1]) };
  }

  return { scope: 'other', cap: null, percent: null };
}

// -- Parse outlet cards -> row arrays (37 fields each) ----------------------

function parseCards(outlets, nonFoodCuisines, startRank) {
  const rows = [];
  let rank = startRank;

  for (const o of outlets) {
    rank++;

    // Drop non-restaurant outlets
    if (!isRestaurant(o, nonFoodCuisines)) continue;

    const code = o.outletCode || null;
    if (!code) continue;

    // Operating status
    const opStatus = o.operatingStatusCode || o.operatingStatus || null;
    const opType   = o.operatingType || null;

    // Rating
    const rObj     = (o.rating && typeof o.rating === 'object') ? o.rating : {};
    const score    = rObj.score ?? (typeof o.rating === 'number' ? o.rating : null);
    const rCount   = rObj.count ?? o.ratingCount ?? null;
    const rStatus  = deriveRatingStatus(score, rCount);
    const rDispCnt = rObj.displayCount ?? rObj.display_count ?? rCount;
    const rTitle   = cleanText(rObj.title ?? rObj.ratingTitle ?? null);

    // Promo
    const promoRaw = o.promo || o.promotion || null;
    const promoText = cleanText(
      typeof promoRaw === 'string' ? promoRaw
        : promoRaw && typeof promoRaw === 'object'
          ? (promoRaw.text || promoRaw.title || promoRaw.label || null)
          : null
    );
    const hasPromo = !!promoText;
    const classified = classifyPromo(promoText);

    // Widget / personalisation
    const widgetGroup    = o.widgetGroup ?? o.widget_group ?? null;
    const isPersonalized = !!(o.isPersonalized ?? o.is_personalized ?? false);

    // Tags
    const miniTag     = cleanText(o.miniTag ?? o.mini_tag ?? null);
    const extendedTag = cleanText(o.extendedTag ?? o.extended_tag ?? null);

    // Delivery
    const del = (o.delivery && typeof o.delivery === 'object') ? o.delivery : {};
    const isFreeDeliv   = !!(del.isFree ?? del.is_free ?? false);
    const isNonFreeDel  = !!(del.isNonFreeDelivery ?? del.is_non_free_delivery ?? false);
    const isNearAndQuick = !!(o.isNearAndQuick ?? o.is_near_and_quick ?? false);
    const delFee     = del.fee ?? del.deliveryFee ?? null;
    const delOrigFee = del.originalFee ?? del.original_fee ?? null;
    const delMinOrder = del.minOrder ?? del.min_order ?? null;
    const delTime    = cleanText(del.time ?? del.deliveryTime ?? del.eta ?? null);

    // Identity / display
    const name     = cleanText(o.name ?? o.outletName ?? null);
    const linkUrl  = o.linkUrl ?? o.link_url ?? o.slug ?? null;
    const bannerUrl = cdnUrl(o.bannerUrl ?? o.banner_url ?? o.bannerImage ?? null);
    const logoUrl   = cdnUrl(o.logoUrl ?? o.logo_url ?? o.logoImage ?? null);

    // Cuisines (joined string)
    const cuisineArr = o.cuisines || o.cuisineNames || [];
    const cuisines = (Array.isArray(cuisineArr) ? cuisineArr : [cuisineArr])
      .map((c) => cleanText(String(c)))
      .filter(Boolean)
      .join(', ') || null;

    const restaurantCode = o.restaurantCode ?? o.restaurant_code ?? null;
    const price    = o.price ?? o.priceRange ?? o.price_range ?? null;
    const distance = o.distance ?? null;

    // VIP
    const isVip = !!(o.isVip ?? o.is_vip ?? false);
    const vipMsg = cleanText(
      typeof o.vipMessage === 'string' ? o.vipMessage
        : (o.vipMessage && typeof o.vipMessage === 'object')
          ? (o.vipMessage.text || o.vipMessage.title || null)
          : (o.vip_message ?? null)
    );

    // 37 fields per row
    rows.push([
      code,                   //  0  outletCode
      rank,                   //  1  rank
      opStatus,               //  2  operatingStatusCode
      opType,                 //  3  operatingType
      score,                  //  4  rating (score)
      rCount,                 //  5  ratingCount
      rStatus,                //  6  ratingStatus
      hasPromo,               //  7  hasPromo
      promoText,              //  8  promoText
      classified.scope,       //  9  classified.scope
      classified.cap,         // 10  classified.cap
      widgetGroup,            // 11  widgetGroup
      isPersonalized,         // 12  isPersonalized
      false,                  // 13  sponsored (deprecated)
      null,                   // 14  ad_slot (deprecated)
      rDispCnt,               // 15  ratingDisplayCnt
      miniTag,                // 16  miniTag
      extendedTag,            // 17  extendedTag
      isFreeDeliv,            // 18  isFreeDeliv
      isNonFreeDel,           // 19  isNonFreeDel
      isNearAndQuick,         // 20  isNearAndQuick
      name,                   // 21  name
      linkUrl,                // 22  linkUrl
      bannerUrl,              // 23  bannerUrl
      cuisines,               // 24  cuisines
      restaurantCode,         // 25  restaurantCode
      price,                  // 26  price
      distance,               // 27  distance
      rTitle,                 // 28  ratingTitle
      delFee,                 // 29  delivery.fee
      delOrigFee,             // 30  delivery.originalFee
      delMinOrder,            // 31  delivery.minOrder
      delTime,                // 32  delivery.time
      classified.percent,     // 33  classified.percent
      logoUrl,                // 34  logoUrl
      isVip,                  // 35  isVip
      vipMsg,                 // 36  vipMsg
    ]);
  }

  return rows;
}

// -- Process one area -------------------------------------------------------

async function processArea(area, nonFoodCuisines) {
  const { lat, lng, page_delay_ms: pageDelayMs = 1500 } = area;
  AREA_CTX.page = 0;

  // One token per area, minted fresh
  await mintToken(lat, lng);

  // Set location for food experience
  const loc = await locate(lat, lng);

  const allRows   = [];
  const seenCodes = new Set();
  let searchToken = null;
  let totalOutlets = 0;
  let page = 0;
  let emptyStreak = 0;

  while (page < PAGE_SAFETY_CAP) {
    // Wall-clock guard
    if (Date.now() - START_TIME > WALL_LIMIT_MS) {
      console.log(`[m${MACHINE}] wall limit reached at page ${page}`);
      break;
    }

    page++;
    AREA_CTX.page = page;

    if (page > 1 && pageDelayMs > 0) await sleep(pageDelayMs);

    const result = await fetchPage(loc, searchToken);
    const { outlets, token } = result;

    // Empty page
    if (!outlets.length) {
      emptyStreak++;
      if (emptyStreak >= 2) break;          // two consecutive empties -> done
      searchToken = token;
      continue;
    }
    emptyStreak = 0;

    // Deduplicate within this area walk
    const fresh = outlets.filter((o) => {
      const c = o.outletCode;
      if (!c || seenCodes.has(c)) return false;
      seenCodes.add(c);
      return true;
    });

    if (fresh.length === 0) {
      console.log(`[m${MACHINE}] page ${page}: all dupes -> done`);
      break;
    }

    totalOutlets += fresh.length;
    const rows = parseCards(fresh, nonFoodCuisines, allRows.length);
    allRows.push(...rows);

    console.log(
      `[m${MACHINE}] page ${page}: ${fresh.length} new, ` +
      `${rows.length} restaurants (${allRows.length} total)`
    );

    if (!token) break;                      // no next-page cursor
    searchToken = token;
  }

  return { rows: allRows, pages: page, outlets: totalOutlets };
}

// -- Main -------------------------------------------------------------------

(async () => {
  const summary = {
    machine: MACHINE, run_id: RUN_ID,
    areas_attempted: 0, areas_completed: 0,
    areas_blocked: 0, areas_errored: 0,
    total_rows: 0, total_pages: 0,
  };

  try {
    // ---- machine_start ----------------------------------------------------
    await audit({ event: 'machine_start' });
    console.log(
      `[m${MACHINE}] machine_start | run=${RUN_ID} ` +
      `gh_run=${GH_RUN_ID} wall=${WALL_LIMIT_MS / 1000}s`
    );

    // ---- non-food cuisines ------------------------------------------------
    const nfRows = await rpc('noon_ranking_non_food_cuisines', {});
    const nonFoodCuisines = new Set(
      (nfRows || [])
        .map((r) => String(r.cuisine || r.name || '').trim().toLowerCase())
        .filter(Boolean)
    );
    console.log(`[m${MACHINE}] non-food cuisines loaded: ${nonFoodCuisines.size}`);

    // ---- runner IP --------------------------------------------------------
    try {
      const ipResp = await rawFetch('https://api.ipify.org?format=json', {
        signal: AbortSignal.timeout(8000),
      });
      const ipData = await ipResp.json();
      RUNNER_IP = ipData.ip || null;
    } catch (e) {
      console.log(`[m${MACHINE}] ipify failed: ${e.message}`);
    }
    console.log(`[m${MACHINE}] runner IP: ${RUNNER_IP || 'unknown'}`);

    // ---- area claim loop --------------------------------------------------
    let earlyExit = false;

    for (let areaIdx = 0; areaIdx < MAX_AREAS_PER_RUN; areaIdx++) {
      if (earlyExit) break;

      // Wall-clock check before claiming
      if (Date.now() - START_TIME > WALL_LIMIT_MS) {
        console.log(`[m${MACHINE}] wall limit before area claim`);
        break;
      }

      // Claim next area from the queue
      let area;
      try {
        area = await rpc('noon_ranking_claim_area', {
          p_run_id: RUN_ID,
          p_machine_no: MACHINE,
        });
      } catch (e) {
        console.log(`[m${MACHINE}] claim failed: ${e.message}`);
        break;
      }

      if (!area || (Array.isArray(area) && area.length === 0)) {
        console.log(`[m${MACHINE}] no more areas to claim`);
        break;
      }
      if (Array.isArray(area)) area = area[0];

      const areaId   = area.area_id ?? area.id;
      const areaName = area.area_name ?? area.name ?? `area-${areaId}`;
      summary.areas_attempted++;

      console.log(
        `\n[m${MACHINE}] === area ${areaIdx + 1}/${MAX_AREAS_PER_RUN}: ` +
        `${areaName} (id=${areaId}, lat=${area.lat}, lng=${area.lng}) ===`
      );

      let result;
      try {
        result = await processArea(area, nonFoodCuisines);

        // ---- area success -------------------------------------------------
        summary.areas_completed++;
        summary.total_rows  += result.rows.length;
        summary.total_pages += result.pages;

        console.log(
          `[m${MACHINE}] area ${areaName}: done | ` +
          `${result.rows.length} rows, ${result.pages} pages, ` +
          `${result.outlets} raw outlets`
        );

        // Audit: area done
        await audit({
          event: 'area_done',
          area_id: areaId,
          area_name: areaName,
          pages: result.pages,
          outlets_raw: result.outlets,
          outlets_kept: result.rows.length,
          noon_reqs: NOON_REQ,
        });

        // Save rows via RPC
        if (result.rows.length > 0) {
          try {
            await rpc('noon_ranking_save_area_hour', {
              p_run_id:     RUN_ID,
              p_area_id:    areaId,
              p_machine_no: MACHINE,
              p_pages:      result.pages,
              p_rows:       result.rows,
            });
            console.log(`[m${MACHINE}] saved ${result.rows.length} rows for ${areaName}`);
          } catch (e) {
            console.error(`[m${MACHINE}] save failed for ${areaName}: ${e.message}`);
          }
        }

        // Report area status
        try {
          await rpc('noon_ranking_report', {
            p_run_id:     RUN_ID,
            p_area_id:    areaId,
            p_machine_no: MACHINE,
            p_status:     'done',
            p_pages:      result.pages,
            p_rows:       result.rows.length,
          });
        } catch (e) {
          console.log(`[m${MACHINE}] report(done) failed: ${e.message}`);
        }

        // ---- early exit check ---------------------------------------------
        if (result.pages >= EARLY_EXIT_PAGES) {
          console.log(
            `[m${MACHINE}] area used ${result.pages} pages ` +
            `(>= ${EARLY_EXIT_PAGES}), skipping further areas ` +
            `to preserve IP budget`
          );
          earlyExit = true;
        }
      } catch (e) {
        // ---- area blocked (403 / 429) -------------------------------------
        if (e.forbidden || e.rateLimited) {
          summary.areas_blocked++;
          const reason = e.forbidden ? '403' : '429';
          console.error(
            `[m${MACHINE}] BLOCKED (${reason}) on area ${areaName} ` +
            `at page ${AREA_CTX.page}: ${e.message}`
          );

          await audit({
            event: 'area_blocked',
            area_id: areaId,
            area_name: areaName,
            block_reason: reason,
            block_step: failStep(e.message),
            page_at_block: AREA_CTX.page,
            noon_reqs: NOON_REQ,
          });

          try {
            await rpc('noon_ranking_report', {
              p_run_id:       RUN_ID,
              p_area_id:      areaId,
              p_machine_no:   MACHINE,
              p_status:       'blocked',
              p_pages:        AREA_CTX.page,
              p_rows:         0,
              p_block_reason: reason,
            });
          } catch (re) {
            console.log(`[m${MACHINE}] report(blocked) failed: ${re.message}`);
          }

          // 403/429 anywhere -> stop machine immediately
          break;
        }

        // ---- area error (non-block) ---------------------------------------
        summary.areas_errored++;
        console.error(
          `[m${MACHINE}] ERROR on area ${areaName}: ${e.message}`
        );

        await audit({
          event: 'area_error',
          area_id: areaId,
          area_name: areaName,
          error_msg: String(e.message).slice(0, 500),
          error_step: failStep(e.message),
          page_at_error: AREA_CTX.page,
          noon_reqs: NOON_REQ,
        });

        try {
          await rpc('noon_ranking_report', {
            p_run_id:     RUN_ID,
            p_area_id:    areaId,
            p_machine_no: MACHINE,
            p_status:     'error',
            p_pages:      AREA_CTX.page,
            p_rows:       0,
            p_error:      String(e.message).slice(0, 500),
          });
        } catch (re) {
          console.log(`[m${MACHINE}] report(error) failed: ${re.message}`);
        }
      }
    }

    // ---- machine_end ------------------------------------------------------
    await audit({
      event: 'machine_end',
      areas_attempted: summary.areas_attempted,
      areas_completed: summary.areas_completed,
      areas_blocked:   summary.areas_blocked,
      areas_errored:   summary.areas_errored,
      total_rows:      summary.total_rows,
      total_pages:     summary.total_pages,
      noon_reqs:       NOON_REQ,
    });
  } catch (fatal) {
    console.error(`[m${MACHINE}] FATAL: ${fatal.message}`);
    await audit({
      event: 'machine_fatal',
      error_msg: String(fatal.message).slice(0, 500),
      noon_reqs: NOON_REQ,
    }).catch(() => {});
    process.exitCode = 1;
  }

  // ---- summary ------------------------------------------------------------
  const elapsed = ((Date.now() - START_TIME) / 1000).toFixed(1);
  console.log(
    `\n[m${MACHINE}] SUMMARY | run=${RUN_ID} | ` +
    `${summary.areas_completed} done, ${summary.areas_blocked} blocked, ` +
    `${summary.areas_errored} errors | ` +
    `${summary.total_rows} rows, ${summary.total_pages} pages | ` +
    `${NOON_REQ} noon reqs | ${elapsed}s elapsed`
  );
})();
