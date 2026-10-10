#!/usr/bin/env node
/**
 * noon/uae/test-fetch.js
 *
 * End-to-end test for Noon Food (UAE) scraping via the Supabase-native guest
 * session.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ THIS FIRST if you are an AI picking up this script:
 *   - `noon/README.md`                         — full operational guide
 *   - project doc `claude/noon-keeta-findings.md` — the complete reverse-engineering log
 *
 * Also read before changing anything about the auth flow or endpoints.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * What this script does:
 *   1. Calls Supabase RPC `noon_mint_session(lat, lng)` to get a fresh guest
 *      session (cookies, zone codes, device IDs). Noon's auth is complex —
 *      the SQL function hides all of it. Do NOT reproduce the 3-call activation
 *      flow here; use the RPC.
 *   2. Uses the session to call POST /mp-food-api-catalog/api/search with
 *      chained searchToken pagination. Each page returns 60 unique outlets
 *      with ZERO overlap because the server dedupes by restaurantCode via the
 *      token's internal `outlet_group_codes` list.
 *   3. Picks 10 outlets from the aggregated list and fetches full menu detail
 *      via POST /mp-food-api-mpnoon/consumer/restaurant/outlet/details/guest/partial.
 *   4. Writes all raw responses to ./noon-uae-test-output/ for inspection.
 *
 * Env vars required:
 *   SUPABASE_URL                  (e.g. https://zxsglrnjlmghplecndue.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY     (secret — in GitHub Actions, from org secrets)
 *
 * Optional env vars (sensible defaults for Dubai Marina):
 *   NOON_LAT    (default 25.078058170938117)
 *   NOON_LNG    (default 55.15337817083452)
 *   NOON_PAGES  (default 3   — how many pages of listings to paginate through)
 *   NOON_MENUS  (default 10  — how many outlet menus to fetch after listing)
 */

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const LAT = parseFloat(process.env.NOON_LAT || '25.078058170938117');  // Dubai Marina / JLT
const LNG = parseFloat(process.env.NOON_LNG || '55.15337817083452');
const PAGES = parseInt(process.env.NOON_PAGES || '3', 10);
const MENUS = parseInt(process.env.NOON_MENUS || '10', 10);

const OUT_DIR = path.resolve(process.cwd(), 'noon-uae-test-output');

// Fixed User-Agent — matches the real Noon iOS app build captured in Proxyman.
// If Noon ships a new build and starts rejecting this one, bump these two.
const UA = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const BUILD = '22098';

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[noon] starting test fetch`);
  console.log(`[noon]   location: lat=${LAT} lng=${LNG}`);
  console.log(`[noon]   pages=${PAGES}, menu samples=${MENUS}`);
  console.log(`[noon]   output: ${OUT_DIR}`);

  await fs.mkdir(OUT_DIR, { recursive: true });

  // Step 1: mint a fresh session via Supabase RPC.
  //   The RPC runs 3 HTTP calls to Noon internally (whoami → set-location →
  //   whoami?experience=food) and returns everything a scraper needs.
  //   See noon/README.md "Noon guest auth flow" for the mechanism.
  const session = await mintSession(LAT, LNG);
  await writeJson('01-session.json', session);
  console.log(`[noon] session minted:`);
  console.log(`[noon]   resolved_area:  ${session.resolved_area}`);
  console.log(`[noon]   food_zonecode:  ${session.food_zonecode}`);
  console.log(`[noon]   nguestv2 exp:   ${session.nguestv2_exp} (5-min JWT)`);
  console.log(`[noon]   cookies:        ${Object.keys(session.cookies).join(', ')}`);

  // Step 2: paginate /search with chained searchToken.
  //   Each page returns 60 unique outlets. Token grows ~1150 chars/page.
  const outlets = await paginateSearch(session, PAGES);
  console.log(`[noon] listing enumeration complete: ${outlets.length} unique outlets across ${PAGES} pages`);

  // Save a flat CSV of the outlets we found (convenient for Nick to inspect).
  const outletCsv = ['outletCode,name,cuisines,price,rating,distance_m,linkUrl']
    .concat(outlets.map(o => csvRow([
      o.outletCode, o.name,
      (o.cuisines || []).join('|'),
      o.price || '',
      o.rating?.ratingScore || '',
      o.distance || '',
      o.linkUrl || '',
    ])))
    .join('\n');
  await fs.writeFile(path.join(OUT_DIR, '02-outlets.csv'), outletCsv);
  await writeJson('02-outlets.json', outlets);

  // Step 3: fetch menu detail for first N outlets.
  //   Each menu is ~100-150 KB JSON with full item list, prices, modifiers,
  //   images, etc. See noon/README.md and findings log for all fields.
  const sampleOutlets = outlets.slice(0, MENUS);
  console.log(`[noon] fetching ${sampleOutlets.length} menus...`);
  let menuOk = 0;
  for (const outlet of sampleOutlets) {
    try {
      const detail = await fetchOutletDetail(session, outlet.outletCode);
      await writeJson(`03-menu-${outlet.outletCode}.json`, detail);
      const data = detail.data || {};
      const itemCount = countItems(data);
      console.log(`[noon]   ✓ ${outlet.outletCode}  ${data.name || outlet.name}  (${itemCount} items)`);
      menuOk += 1;
    } catch (e) {
      console.log(`[noon]   ✗ ${outlet.outletCode}  FAILED: ${e.message}`);
    }
  }

  // Final summary — written both to stdout and to a summary.json file.
  const summary = {
    lat: LAT, lng: LNG,
    resolved_area: session.resolved_area,
    food_zonecode: session.food_zonecode,
    pages_fetched: PAGES,
    outlets_total: outlets.length,
    menus_attempted: sampleOutlets.length,
    menus_ok: menuOk,
    sample_outlets: outlets.slice(0, 5).map(o => ({ code: o.outletCode, name: o.name })),
    completed_at: new Date().toISOString(),
  };
  await writeJson('00-summary.json', summary);
  console.log(`\n[noon] done. Summary:`);
  console.log(JSON.stringify(summary, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: mint a session via Supabase RPC
// ─────────────────────────────────────────────────────────────────────────────
async function mintSession(lat, lng) {
  // PostgREST exposes SECURITY DEFINER functions at /rest/v1/rpc/<name>.
  // The function is granted to service_role only (not anon/authenticated).
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/noon_mint_session`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_lat: lat, p_lng: lng }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`mintSession: HTTP ${resp.status}: ${body.slice(0, 400)}`);
  }
  const session = await resp.json();
  if (!session || session.ok !== true) {
    throw new Error(`mintSession: ok=false, error=${session?.error || '?'}`);
  }
  return session;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: /search pagination via chained searchToken
// ─────────────────────────────────────────────────────────────────────────────
async function paginateSearch(session, maxPages) {
  const seen = new Set();         // dedupe by outletCode across pages
  const allOutlets = [];
  let searchToken = null;         // null on first call; thereafter from response

  for (let page = 1; page <= maxPages; page++) {
    const body = {
      queryEntity: null,
      q: null,
      f: {},
      contexts: [],
      withContent: true,
      excludeOutletCodes: [],
      limit: 60,
      page: 1,                    // Note: /search ignores `page` — real pagination is `searchToken`
      sort: { by: 'popularity', dir: 'desc' },
      type: 'outlet',
      qType: 'search_query',
      getFallback: true,
    };
    if (searchToken) body.searchToken = searchToken;

    const resp = await noonFetch(
      session,
      'POST',
      'https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/search',
      body,
    );
    if (!resp.ok) throw new Error(`search page ${page}: HTTP ${resp.status}`);
    const json = await resp.json();

    // Walk the nested `results` tree to collect every record with an outletCode.
    const found = walkForOutlets(json.results || []);
    const newOutlets = found.filter(o => !seen.has(o.outletCode));
    for (const o of newOutlets) {
      seen.add(o.outletCode);
      allOutlets.push(o);
    }
    console.log(`[noon]   page ${page}: ${found.length} found, ${newOutlets.length} new, running total ${allOutlets.length}`);

    // Server-signalled end of catalog: last page returns < 60.
    if (found.length < 60) {
      console.log(`[noon]   page ${page} returned < 60 outlets — end of catalog`);
      break;
    }

    // Chain: use the response's searchToken as the next request's input.
    searchToken = json.searchToken || null;
    if (!searchToken) {
      console.log(`[noon]   no searchToken returned — stopping`);
      break;
    }
  }
  return allOutlets;
}

// Walk arbitrary nested dicts/lists; yield any object that has an outletCode.
// The /search response structure is {results: [{modules: [{hits: [...]}]}, ...]}
// — but Noon tweaks this; the walk approach is robust to layout changes.
function walkForOutlets(x, depth = 0, out = []) {
  if (depth > 8) return out;
  if (Array.isArray(x)) {
    for (const v of x) walkForOutlets(v, depth + 1, out);
  } else if (x && typeof x === 'object') {
    if (typeof x.outletCode === 'string' && x.outletCode) {
      out.push(x);
      return out;
    }
    for (const k of Object.keys(x)) walkForOutlets(x[k], depth + 1, out);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: fetch outlet (menu) detail
// ─────────────────────────────────────────────────────────────────────────────
async function fetchOutletDetail(session, outletCode) {
  // Note: addressLat/addressLng go in body as INTEGERS (lat/lng × 1e7),
  // NOT as the floats we use elsewhere. Noon is picky about this.
  const body = {
    outletCode,
    addressLat: session.lat_int,
    addressLng: session.lng_int,
    deliveryType: 'default',
    context: { experience: null },
  };
  const resp = await noonFetch(
    session,
    'POST',
    'https://api-app-fd.noon.com/_svc/mp-food-api-mpnoon/consumer/restaurant/outlet/details/guest/partial',
    body,
  );
  if (!resp.ok) throw new Error(`detail ${outletCode}: HTTP ${resp.status}`);
  return await resp.json();
}

// Count item-like records in a menu — anything with price + name/title.
// Used only for logging; not business-critical.
function countItems(x, depth = 0) {
  if (depth > 10) return 0;
  if (Array.isArray(x)) return x.reduce((n, v) => n + countItems(v, depth + 1), 0);
  if (x && typeof x === 'object') {
    if ('price' in x && ('name' in x || 'title' in x)) return 1;
    return Object.values(x).reduce((n, v) => n + countItems(v, depth + 1), 0);
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// The one function that knows how to build a Noon request from a session
// ─────────────────────────────────────────────────────────────────────────────
async function noonFetch(session, method, url, bodyObj) {
  // Build the full header set once, from the session + the fixed app identity.
  // Any mp-food-api-* call needs ALL of these headers to be accepted. Missing
  // any of the zone codes (especially x-food-zonecode) → 404 "unserviceable area".
  const headers = {
    'User-Agent':             UA,
    'x-platform':             'ios',
    'x-build':                BUILD,
    'x-mp':                   'noon',
    'x-mp-country':           'ae',
    'x-experience':           'food',
    'x-content':              'mobile',
    'x-locale':               'en-ae',
    'x-device-id':            session.device_id,
    'x-visitor-id':           session.visitor_id,
    'x-device-lat':           String(session.lat),
    'x-device-lng':           String(session.lng),
    'x-lat':                  String(session.lat_int),
    'x-lng':                  String(session.lng_int),
    'x-border-enabled':       'true',
    'x-rocket-enabled':       'true',
    'x-whoami-request-id':    crypto.randomUUID(),  // per-call unique
    'Cookie':                 session.cookie_string,
    'Accept':                 'application/json, text/plain, */*',
    'Accept-Language':        'en-US,en;q=0.9',
  };
  // Fold in all zone-code headers from session.zone_codes.
  // Noon returns up to 10 zonecodes + a few flags in whoami?experience=food's
  // response body under `headers`. We echo them back on every food call.
  for (const [k, v] of Object.entries(session.zone_codes || {})) {
    if (typeof v !== 'object' && v !== null && !String(k).toLowerCase().includes('ab-test')) {
      headers[k] = String(v);
    }
  }

  const init = { method, headers };
  if (bodyObj !== undefined && bodyObj !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(bodyObj);
  }
  return await fetch(url, init);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[noon] FATAL: env var ${name} is not set`);
    process.exit(1);
  }
  return v;
}

async function writeJson(filename, obj) {
  await fs.writeFile(path.join(OUT_DIR, filename), JSON.stringify(obj, null, 2));
}

function csvRow(fields) {
  return fields.map(f => {
    const s = f == null ? '' : String(f);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }).join(',');
}

// Node 18+ has fetch globally. Fail fast on older versions.
if (typeof fetch !== 'function') {
  console.error('[noon] FATAL: this script needs Node 18+ (global fetch)');
  process.exit(1);
}

main().catch(err => {
  console.error('[noon] FATAL:', err);
  process.exit(1);
});