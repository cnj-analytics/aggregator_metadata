// careem/uae/test-fetch.js
//
// End-to-end test of the Careem token pipeline:
//   1. Pull the latest guest token from Supabase (careem_token_latest() RPC)
//   2. Call Careem's food-discovery-home endpoint for one area (Dubai Marina / JBR)
//   3. Walk the response, pick up to 10 restaurant/brand IDs
//   4. Fetch each restaurant's detail/menu endpoint
//   5. Save everything to ./out/ and print a summary
//
// The test is deliberately conservative: it mirrors the exact header set the
// live iOS Careem app sends (captured by Proxyman in careem_token_test_config.json),
// so Careem can't tell it apart from a real app session.
//
// Run locally (needs Node 20):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node careem/uae/test-fetch.js
//
// In CI: the careem-uae-test-fetch workflow sets the env vars from repo secrets.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const fs = require('fs/promises');
const path = require('path');

// ── Device + location profile ──────────────────────────────────────────
// Mirrors the Careem iOS app that captured the token on this project.
// Changing these breaks nothing immediately but drifts us further from
// "real-looking traffic", so keep them in sync with your capture device.
const AREA = {
  name: process.env.CAREEM_AREA_NAME || 'Dubai Marina / JBR',
  lat: process.env.CAREEM_LAT || '25.078033653862',
  lng: process.env.CAREEM_LNG || '55.153380854808',
};
const DEVICE = {
  app_version: '26.39.0',
  os: 'iOS/27.0.1',
  appengine_api_version: '2026-09-17',
  device_id: 'D0O8gpXoJdQ2L5lC',   // Nick's spare iPhone — matches the token's device fingerprint
  session_id: 'TEST-' + Math.random().toString(36).slice(2, 10).toUpperCase() + '-NODE',
};

const OUT_DIR = path.join(__dirname, 'out', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const MAX_RESTAURANTS = Number(process.env.CAREEM_MAX_RESTAURANTS || 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Supabase helpers ───────────────────────────────────────────────────

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
    throw new Error('Token expired at ' + row.expires_at + ' — ' + Math.abs(minsLeft) + ' min ago');
  }
  return {
    access_token: row.access_token,
    jti: row.jwt_jti,
    expires_at: row.expires_at,
    captured_at: row.captured_at,
    mins_left: minsLeft,
  };
}

// ── Careem request helper ──────────────────────────────────────────────
// Builds the exact header set the live iOS app sends. Pass in the user_id
// extracted from the token (sub claim) so x-careem-userid matches.

function careemHeaders(token, user_id) {
  return {
    'Host': 'appengine.careemapis.com',
    'SESSION_ID': DEVICE.session_id,
    'X-Careem-Beta': 'false',
    'User-Agent': 'ICMA/' + DEVICE.app_version,
    'X-Careem-Agent': 'ICMA',
    'X-Careem-Session-Id': DEVICE.session_id,
    'Agent': 'ICMA',
    'Time-Zone': 'Asia/Dubai',
    'lng': AREA.lng,
    'lat': AREA.lat,
    'x-careem-userid': String(user_id || ''),
    'Version': DEVICE.app_version,
    'X-Careem-Version': DEVICE.app_version,
    'x-careem-user-location': `${AREA.lat},${AREA.lng}`,
    'x-careem-appengine-api-version': DEVICE.appengine_api_version,
    'X-Careem-Operating-System': DEVICE.os,
    'Authorization': 'Bearer ' + token,
    'x-careem-permissions': 'location:granted',
    'Accept-Language': 'en',
    'x-careem-device-id': DEVICE.device_id,
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
  };
}

async function careemGet(url, headers, label) {
  const t0 = Date.now();
  const resp = await fetch(url, { headers, redirect: 'follow' });
  const text = await resp.text();
  const ms = Date.now() - t0;
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  const rl_remaining = resp.headers.get('ratelimit-remaining');
  const rl_limit = resp.headers.get('x-ratelimit-limit-minute');
  console.log(`  [${resp.status}] ${label} (${ms}ms, ${text.length} bytes, ratelimit=${rl_remaining}/${rl_limit})`);
  return { status: resp.status, ms, bytes: text.length, text, json, headers: Object.fromEntries(resp.headers) };
}

// ── Response walking ──────────────────────────────────────────────────
// Careem's food-discovery response is a nested "components" tree. Different
// screens use different layouts, so instead of hard-coding paths we walk the
// whole tree and pick anything that looks like a restaurant/brand reference
// AND carries an action/target with a URL we can hit next.

function walkForRestaurants(node, out = [], depth = 0) {
  if (!node || depth > 20) return out;
  if (Array.isArray(node)) {
    for (const n of node) walkForRestaurants(n, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;

  // Heuristic: a restaurant/brand card typically has a name/title AND an id/brand_id,
  // plus an action/target with a URL template. Capture whichever shape it comes in.
  const name = node.title || node.name || node.brand_name || node.merchant_name;
  const id = node.id || node.brand_id || node.merchant_id || node.outlet_id || node.restaurant_id;
  const target_url =
    (node.target && (node.target.url || node.target.href || node.target.path)) ||
    (node.action && (node.action.url || node.action.href || node.action.path || node.action.deeplink)) ||
    node.href || node.url || node.path || null;
  if (name && id && typeof name === 'string' && (typeof id === 'number' || typeof id === 'string')) {
    out.push({ name, id: String(id), target_url: target_url || null, kind: node.card_type || node.type || null });
  }
  for (const k in node) walkForRestaurants(node[k], out, depth + 1);
  return out;
}

function decodeJwtSub(token) {
  try {
    const payload = token.split('.')[1];
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/') + '===';
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json).sub;
  } catch (_) { return null; }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log('Output dir:', OUT_DIR);

  // 1. Token
  console.log('\n== 1. Pulling token from Supabase ==');
  const tok = await getToken();
  const sub = decodeJwtSub(tok.access_token);
  console.log(`  jti=${(tok.jti || '').slice(0, 8)}  sub=${sub || '?'}  mins_left=${tok.mins_left}  captured=${tok.captured_at}`);

  // 2. Area listing
  console.log(`\n== 2. Fetching area listing (${AREA.name}) ==`);
  const headers = careemHeaders(tok.access_token, sub);
  const listingUrl = `https://appengine.careemapis.com/v1/page/food-discovery-home?timeZone=Asia%2FDubai&isFoodBlueprintEnabled=true`;
  const listing = await careemGet(listingUrl, headers, 'food-discovery-home');

  await fs.writeFile(path.join(OUT_DIR, '01-area-listing.json'), listing.text);
  await fs.writeFile(path.join(OUT_DIR, '01-area-listing.response-headers.json'), JSON.stringify(listing.headers, null, 2));

  if (listing.status !== 200) {
    console.error(`  listing failed with ${listing.status} — bailing. First 500 chars of body:`);
    console.error('  ' + listing.text.slice(0, 500));
    process.exit(2);
  }
  if (!listing.json) {
    console.error('  listing returned non-JSON body — bailing.');
    process.exit(2);
  }

  // 3. Find restaurants in the response
  const found = walkForRestaurants(listing.json);
  // Dedupe by id and prefer entries that have a target_url
  const byId = new Map();
  for (const r of found) {
    const prev = byId.get(r.id);
    if (!prev || (!prev.target_url && r.target_url)) byId.set(r.id, r);
  }
  const unique = [...byId.values()];
  console.log(`  found ${found.length} candidate rows → ${unique.length} unique restaurant-ish entries`);
  await fs.writeFile(path.join(OUT_DIR, '02-restaurants-discovered.json'), JSON.stringify(unique, null, 2));

  const picked = unique.slice(0, MAX_RESTAURANTS);
  console.log(`  picking first ${picked.length} for detail fetch`);

  // 4. Per-restaurant fetch
  console.log(`\n== 3. Fetching ${picked.length} restaurant pages ==`);
  const results = [];
  for (let i = 0; i < picked.length; i++) {
    const r = picked[i];
    const num = String(i + 1).padStart(2, '0');

    let detailUrl = null;
    if (r.target_url) {
      // Resolve relative URLs against appengine host
      try {
        detailUrl = new URL(r.target_url, 'https://appengine.careemapis.com').href;
      } catch (_) {}
    }
    // Fallback: construct a food-menu URL from the id
    if (!detailUrl) {
      detailUrl = `https://appengine.careemapis.com/v1/page/food-menu?brandId=${encodeURIComponent(r.id)}`;
    }

    const label = `[${num}] ${r.name.slice(0, 40)} (id=${r.id})`;
    try {
      const resp = await careemGet(detailUrl, headers, label);
      await fs.writeFile(
        path.join(OUT_DIR, `03-restaurant-${num}-${r.id}.json`),
        resp.text,
      );
      results.push({ num, id: r.id, name: r.name, url: detailUrl, status: resp.status, bytes: resp.bytes, ms: resp.ms });
    } catch (e) {
      console.log(`  [ERR] ${label}: ${e.message}`);
      results.push({ num, id: r.id, name: r.name, url: detailUrl, error: e.message });
    }

    // Gentle pacing so we don't trip rate limiting on the test.
    await sleep(300);
  }

  // 5. Summary
  const summary = {
    area: AREA,
    token: { jti: tok.jti, sub, mins_left: tok.mins_left, expires_at: tok.expires_at },
    listing: { status: listing.status, bytes: listing.bytes, ms: listing.ms },
    restaurants_discovered: unique.length,
    restaurants_fetched: results.length,
    results,
    out_dir: OUT_DIR,
  };
  await fs.writeFile(path.join(OUT_DIR, '00-summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n== Summary ==');
  console.log(JSON.stringify({
    listing_status: listing.status,
    listing_bytes: listing.bytes,
    discovered: unique.length,
    fetched_ok: results.filter(r => r.status && r.status >= 200 && r.status < 300).length,
    fetched_err: results.filter(r => r.error || (r.status && r.status >= 400)).length,
  }, null, 2));
  console.log('\nFull output in:', OUT_DIR);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
