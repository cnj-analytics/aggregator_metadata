#!/usr/bin/env node
// noon/uae/listings-fields-probe.js
//
// Noon Food UAE — PHASE 2 STEP 1: field-discovery probe for the area listing.
//
// Goal: answer "what data is actually available per area listing?" before we
// design noon_restaurant_list_queue. For each probed area this script:
//
//   1. Mints a guest session via Supabase  noon_mint_session(lat,lng).
//   2. locate(lat,lng): set-location-by-lat-lng + whoami?experience=food,
//      collecting cookies and the 10 zone-code headers.
//   3. Paginates POST /mp-food-api-catalog/api/search with CHAINED searchToken
//      (the `page` field is ignored by the API — the token is the real cursor).
//      It paginates until the LIST IS GENUINELY EXHAUSTED: an empty page, a page
//      with no outlet we have not already seen, or no searchToken returned.
//      There is no page limit. PAGE_SAFETY_CAP exists only as a runaway guard
//      against an API that pages forever; if it is ever hit, that is a bug to
//      investigate, not a normal stop, and the run says so loudly.
//   4. Writes EVERY card untouched into noon_restaurant_list_probe, and one row
//      per page request into noon_restaurant_list_probe_page.
//
// It deliberately stores nothing derived and links nothing by FK. The whole
// point is to look at the raw payload first; schema decisions come after.
//
// Resilience is copied from queue-worker.js, which survived a 16.5k-item run:
//   token 403       → mint a fresh session and retry the same page
//   fresh token 403 → IP is blocked, stop and exit non-zero
//   HTTP 429        → pause 30 s and retry
//
// Pace: this is not a rush job. Default is one page per second with a 30 s
// pause on 429, and the whole run stops cleanly before WALL_LIMIT_SEC so it
// always lands inside a 3-hour budget rather than being killed mid-area.
//
// Env vars:
//   SUPABASE_URL                required
//   SUPABASE_SERVICE_ROLE_KEY   required
//   PROBE_BATCH                 optional, default probe-<timestamp>
//   AREA_IDS                    optional, comma-separated noon_area_id list.
//                               If unset, picks AREA_SAMPLE areas spread across
//                               cities and listing sizes (see pickSampleAreas).
//   AREA_SAMPLE                 optional, default 5 (ignored when AREA_IDS set)
//   PAGE_SAFETY_CAP             optional, default 500. Runaway guard only.
//   DELAY_MS                    optional, default 1000 between page requests
//   AREA_DELAY_MS               optional, default 3000 between areas
//   RATE_LIMIT_PAUSE_MS         optional, default 30000
//   WALL_LIMIT_SEC              optional, default 10200 (2h50m). Stops between
//                               areas once exceeded, leaving a clean batch.
//
// Usage:
//   node noon/uae/listings-fields-probe.js
//   AREA_IDS=12,87,310 node noon/uae/listings-fields-probe.js

'use strict';

const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const PROBE_BATCH = process.env.PROBE_BATCH || `probe-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;
const AREA_IDS = (process.env.AREA_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const AREA_SAMPLE = Number(process.env.AREA_SAMPLE || 5);
const PAGE_SAFETY_CAP = Number(process.env.PAGE_SAFETY_CAP || 500);
const DELAY_MS = Number(process.env.DELAY_MS || 1000);
const AREA_DELAY_MS = Number(process.env.AREA_DELAY_MS || 3000);
const RATE_LIMIT_PAUSE_MS = Number(process.env.RATE_LIMIT_PAUSE_MS || 30000);
const WALL_LIMIT_SEC = Number(process.env.WALL_LIMIT_SEC || 10200);
const STARTED_AT = Date.now();
const secondsElapsed = () => Math.round((Date.now() - STARTED_AT) / 1000);
const PAGE_LIMIT = 60; // Noon's own per-page size

const UA = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const BUILD = '22098';
const SET_LOCATION_URL = 'https://api-app.noon.com/_vs/st/mp-identity-api-geo/serviceable-geo-info/set-location-by-lat-lng';
const WHOAMI_FOOD_URL = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami?experience=food&select_nearby=1';
const SEARCH_URL = 'https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/search';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Supabase REST ───────────────────────────────────────────────────────────

async function supabase(path, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(SUPABASE_URL + '/rest/v1' + path, {
        method: opts.method || 'GET',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          ...(opts.headers || {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`Supabase ${opts.method || 'GET'} ${path} -> ${resp.status}: ${text.slice(0, 400)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}

const insertRows = (table, rows) =>
  supabase(`/${table}`, { method: 'POST', body: rows, headers: { Prefer: 'return=minimal' } });

// ── Area selection ──────────────────────────────────────────────────────────

async function loadAreas() {
  if (AREA_IDS.length) {
    const list = AREA_IDS.join(',');
    const rows = await supabase(
      `/noon_area?noon_area_id=in.(${list})&select=noon_area_id,area_name,latitude,longitude,noon_zone_code,noon_city_code,restaurant_count_page1,area_source`
    );
    console.log(`[probe] explicit AREA_IDS: requested ${AREA_IDS.length}, found ${rows.length}`);
    return rows;
  }
  const all = await supabase(
    '/noon_area?is_active=eq.true&select=noon_area_id,area_name,latitude,longitude,noon_zone_code,noon_city_code,restaurant_count_page1,area_source&order=noon_area_id'
  );
  return pickSampleAreas(all, AREA_SAMPLE);
}

// Spread the sample so field variation has a chance to show up:
// one area per distinct city code, preferring a dense area in the biggest
// cities, and always including one noon_zone fill-in point and one sparse area.
function pickSampleAreas(areas, n) {
  const picked = new Map();
  const take = (a, why) => {
    if (a && !picked.has(a.noon_area_id)) {
      picked.set(a.noon_area_id, { ...a, _why: why });
    }
  };

  const byCount = [...areas].sort(
    (a, b) => (b.restaurant_count_page1 || 0) - (a.restaurant_count_page1 || 0)
  );
  take(byCount[0], 'densest overall');

  const zoneSourced = areas.filter((a) => a.area_source === 'noon_zone');
  take(zoneSourced[Math.floor(zoneSourced.length / 2)], 'noon_zone fill-in point');

  const sparse = [...areas]
    .filter((a) => (a.restaurant_count_page1 || 0) > 0 && (a.restaurant_count_page1 || 0) < PAGE_LIMIT)
    .sort((a, b) => (a.restaurant_count_page1 || 0) - (b.restaurant_count_page1 || 0));
  take(sparse[0], 'sparsest non-empty');

  // Fill the rest with the densest area of each city we have not covered yet.
  const seenCities = new Set([...picked.values()].map((a) => a.noon_city_code));
  for (const a of byCount) {
    if (picked.size >= n) break;
    if (seenCities.has(a.noon_city_code)) continue;
    seenCities.add(a.noon_city_code);
    take(a, `densest in ${a.noon_city_code}`);
  }
  // Still short? top up by density.
  for (const a of byCount) {
    if (picked.size >= n) break;
    take(a, 'top-up by density');
  }

  const out = [...picked.values()].slice(0, n);
  console.log(`[probe] sampled ${out.length} of ${areas.length} active areas:`);
  for (const a of out) {
    console.log(`         #${a.noon_area_id}  ${a.area_name}  (${a.noon_city_code}, page1=${a.restaurant_count_page1}) — ${a._why}`);
  }
  return out;
}

// ── Noon session + locate (same flow as queue-worker.js) ────────────────────

async function mintSession(lat, lng) {
  const s = await supabase('/rpc/noon_mint_session', { method: 'POST', body: { p_lat: lat, p_lng: lng } });
  if (!s || s.ok !== true) throw new Error(`noon_mint_session ok=false: ${s && s.error}`);
  return { ...s, mintedAt: Date.now() };
}

class Session {
  constructor() { this.s = null; this.n = 0; }
  async ensure(lat, lng) {
    const exp = this.s && this.s.nguestv2_exp ? Date.parse(this.s.nguestv2_exp) : 0;
    const stale = !this.s || Date.now() > Math.min(exp - 60000, this.s.mintedAt + 240000);
    if (stale) {
      this.s = await mintSession(lat, lng);
      this.n++;
      console.log(`[probe] minted token #${this.n} (device ${this.s.device_id.slice(0, 8)}…)`);
    }
    return this.s;
  }
  async remint(lat, lng) { this.s = null; return this.ensure(lat, lng); }
}

const baseHeaders = (s, lat, lng) => ({
  'User-Agent': UA,
  'x-platform': 'ios',
  'x-build': BUILD,
  'x-mp': 'noon',
  'x-content': 'mobile',
  'x-locale': 'en-ae',
  'x-device-id': s.device_id,
  'x-visitor-id': s.visitor_id,
  'x-device-lat': String(lat),
  'x-device-lng': String(lng),
  Accept: 'application/json',
});

function mergeSetCookies(jar, resp) {
  const list = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const c of list) {
    const m = /^([^=]+)=([^;]+)/.exec(c);
    if (m) jar[m[1]] = m[2];
  }
}
const cookieString = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

const flag = (e, kind) => Object.assign(e, { [kind]: true });

async function locate(session, lat, lng) {
  const s = await session.ensure(lat, lng);
  const jar = { ...(s.cookies || {}) };
  const h = { ...baseHeaders(s, lat, lng), 'x-experience': 'ecom' };

  const r1 = await fetch(SET_LOCATION_URL, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json', Cookie: cookieString(jar) },
    body: JSON.stringify({ location: { lat, lng }, lang: 'en' }),
  });
  if (r1.status === 429) throw flag(new Error('set-location 429'), 'rateLimited');
  if (r1.status === 403) throw flag(new Error('set-location 403'), 'forbidden');
  if (!r1.ok) throw new Error(`set-location HTTP ${r1.status}`);
  const setloc = await r1.json().catch(() => ({}));
  mergeSetCookies(jar, r1);

  const r2 = await fetch(WHOAMI_FOOD_URL, {
    headers: { ...h, 'x-whoami-request-id': crypto.randomUUID(), Cookie: cookieString(jar) },
  });
  if (r2.status === 429) throw flag(new Error('whoami 429'), 'rateLimited');
  if (r2.status === 403) throw flag(new Error('whoami 403'), 'forbidden');
  if (!r2.ok) throw new Error(`whoami food HTTP ${r2.status}`);
  const who = await r2.json();
  mergeSetCookies(jar, r2);

  const zoneHeaders = who && who.headers && typeof who.headers === 'object' ? who.headers : {};
  return {
    session: s,
    lat,
    lng,
    foodZone: zoneHeaders['x-food-zonecode'] || null,
    zoneHeaders,
    cookie: cookieString(jar),
    resolvedAddress: setloc.area || null,
  };
}

// ── One /search page ────────────────────────────────────────────────────────

async function fetchPage(loc, searchToken) {
  const { session: s, lat, lng } = loc;
  const headers = {
    ...baseHeaders(s, lat, lng),
    'x-mp-country': 'ae',
    'x-experience': 'food',
    'x-lat': String(Math.round(lat * 1e7)),
    'x-lng': String(Math.round(lng * 1e7)),
    'x-border-enabled': 'true',
    'x-rocket-enabled': 'true',
    'x-whoami-request-id': crypto.randomUUID(),
    Cookie: loc.cookie,
    'Content-Type': 'application/json',
  };
  for (const [k, v] of Object.entries(loc.zoneHeaders)) {
    if (v !== null && typeof v !== 'object' && !k.toLowerCase().includes('ab-test')) headers[k] = String(v);
  }

  const body = {
    queryEntity: null, q: null, f: {}, contexts: [], withContent: true,
    excludeOutletCodes: [], limit: PAGE_LIMIT, page: 1,
    sort: { by: 'popularity', dir: 'desc' },
    type: 'outlet', qType: 'search_query', getFallback: true,
  };
  if (searchToken) body.searchToken = searchToken;

  const t0 = Date.now();
  const resp = await fetch(SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await resp.text();
  const ms = Date.now() - t0;

  if (resp.status === 429) throw flag(new Error('search 429'), 'rateLimited');
  if (resp.status === 403) throw flag(new Error('search 403'), 'forbidden');
  if (resp.status === 404) return { status: 404, cards: [], token: null, bytes: text.length, ms, envelopeKeys: [] };
  if (!resp.ok) throw new Error(`search HTTP ${resp.status}: ${text.slice(0, 200)}`);

  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('search JSON parse: ' + e.message); }

  return {
    status: resp.status,
    cards: walkForOutlets(json.results || []),
    token: json.searchToken || null,
    bytes: text.length,
    ms,
    envelopeKeys: Object.keys(json),
  };
}

// results[] is a nested tree; collect every object carrying an outletCode.
function walkForOutlets(node, depth = 0, out = []) {
  if (depth > 8 || !node) return out;
  if (Array.isArray(node)) {
    for (const v of node) walkForOutlets(v, depth + 1, out);
    return out;
  }
  if (typeof node === 'object') {
    if (typeof node.outletCode === 'string' && node.outletCode) { out.push(node); return out; }
    for (const k of Object.keys(node)) walkForOutlets(node[k], depth + 1, out);
  }
  return out;
}

// ── One area: paginate to exhaustion, store everything ──────────────────────

async function probeArea(session, area) {
  const lat = area.latitude;
  const lng = area.longitude;
  const t0 = Date.now();

  let loc = await locate(session, lat, lng);
  if (!loc.foodZone) {
    console.log(`[probe] #${area.noon_area_id} ${area.area_name}: no food zone at this point — skipping`);
    return { areaId: area.noon_area_id, pages: 0, cards: 0, unique: 0, skipped: 'no food zone' };
  }

  const seen = new Set();
  let token = null;
  let page = 0;
  let cardsTotal = 0;
  let bytesTotal = 0;
  let stopReason = null;

  while (page < PAGE_SAFETY_CAP) {
    page++;
    const sentToken = token;

    let r = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3 && !r; attempt++) {
      try {
        r = await fetchPage(loc, sentToken);
      } catch (e) {
        lastErr = e;
        if (e.rateLimited) {
          console.log(`[probe]   429 on page ${page} — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s`);
          await sleep(RATE_LIMIT_PAUSE_MS);
          continue;
        }
        if (e.forbidden) {
          console.log(`[probe]   403 on page ${page} — reminting token`);
          await session.remint(lat, lng);
          try {
            loc = await locate(session, lat, lng);
          } catch (e2) {
            if (e2.forbidden) throw flag(new Error('IP BLOCKED: fresh token also 403'), 'ipBlocked');
            lastErr = e2;
          }
          continue;
        }
        await sleep(1500 * attempt);
      }
    }

    if (!r) {
      const msg = lastErr ? lastErr.message : 'unknown error';
      if (lastErr && lastErr.ipBlocked) throw lastErr;
      await insertRows('noon_restaurant_list_probe_page', [{
        probe_batch: PROBE_BATCH, noon_area_id: area.noon_area_id, area_name: area.area_name,
        noon_zone_code: loc.foodZone, latitude: lat, longitude: lng,
        page_no: page, sent_search_token: sentToken, got_search_token: null,
        http_status: null, cards_on_page: 0, new_outlets: 0,
        response_bytes: null, elapsed_ms: null, envelope_keys: null,
        error: msg.slice(0, 500),
      }]);
      stopReason = `page ${page} failed: ${msg}`;
      break;
    }

    const fresh = r.cards.filter((c) => !seen.has(c.outletCode));
    for (const c of fresh) seen.add(c.outletCode);
    cardsTotal += r.cards.length;
    bytesTotal += r.bytes;

    await insertRows('noon_restaurant_list_probe_page', [{
      probe_batch: PROBE_BATCH, noon_area_id: area.noon_area_id, area_name: area.area_name,
      noon_zone_code: loc.foodZone, latitude: lat, longitude: lng,
      page_no: page, sent_search_token: sentToken, got_search_token: r.token,
      http_status: r.status, cards_on_page: r.cards.length, new_outlets: fresh.length,
      response_bytes: r.bytes, elapsed_ms: r.ms,
      envelope_keys: JSON.stringify(r.envelopeKeys), error: null,
    }]);

    // Store every card from this page, including repeats across pages — we want
    // to see whether the API ever re-serves the same outlet with a different card.
    if (r.cards.length) {
      const rows = r.cards.map((card, i) => ({
        probe_batch: PROBE_BATCH,
        noon_area_id: area.noon_area_id,
        area_name: area.area_name,
        noon_zone_code: loc.foodZone,
        page_no: page,
        card_index: i,
        rank_in_area: (page - 1) * PAGE_LIMIT + i + 1,
        outlet_code: card.outletCode || null,
        raw_card: card,
        card_bytes: JSON.stringify(card).length,
      }));
      for (let i = 0; i < rows.length; i += 100) {
        await insertRows('noon_restaurant_list_probe', rows.slice(i, i + 100));
      }
    }

    console.log(`[probe]   page ${String(page).padStart(2)}  cards=${String(r.cards.length).padStart(2)}  new=${String(fresh.length).padStart(2)}  unique=${seen.size}  ${r.bytes}B  ${r.ms}ms  token=${r.token ? 'yes' : 'NONE'}`);

    if (r.cards.length === 0) { stopReason = `empty page at ${page}`; break; }
    if (fresh.length === 0) { stopReason = `no new outlets at page ${page}`; break; }
    if (!r.token) { stopReason = `no searchToken returned at page ${page}`; break; }

    await sleep(DELAY_MS);
  }
  if (!stopReason) {
    stopReason = `RUNAWAY: hit PAGE_SAFETY_CAP=${PAGE_SAFETY_CAP} without exhausting the list`;
    console.log(`[probe]   !! ${stopReason} — investigate before trusting this area`);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[probe] #${area.noon_area_id} ${area.area_name}: ${seen.size} unique outlets over ${page} pages in ${elapsed}s — stop: ${stopReason}`);
  return { areaId: area.noon_area_id, areaName: area.area_name, pages: page, cards: cardsTotal, unique: seen.size, bytes: bytesTotal, elapsed, stopReason };
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  if (typeof fetch !== 'function') throw new Error('Node 18+ required');

  console.log('===============================================================');
  console.log(' Noon UAE — listings field-discovery probe');
  console.log(`   batch:       ${PROBE_BATCH}`);
  console.log(`   pagination:  until exhausted (safety cap ${PAGE_SAFETY_CAP} pages)`);
  console.log(`   delay:       ${DELAY_MS}ms between pages, ${AREA_DELAY_MS}ms between areas`);
  console.log(`   wall budget: ${WALL_LIMIT_SEC}s`);
  console.log('===============================================================');

  const ip = await fetch('https://api.ipify.org').then((r) => r.text()).catch(() => 'unknown');
  console.log(`[probe] runner IP: ${ip}`);

  const areas = await loadAreas();
  if (!areas.length) { console.error('No areas to probe'); process.exit(1); }

  const session = new Session();
  const results = [];
  let ipBlocked = false;
  let wallStopped = false;

  for (const area of areas) {
    if (secondsElapsed() > WALL_LIMIT_SEC) {
      console.log('');
      console.log(`[probe] wall limit reached (${secondsElapsed()}s > ${WALL_LIMIT_SEC}s) — stopping between areas.`);
      console.log(`[probe] ${areas.length - results.length} areas not probed. Re-run with AREA_IDS to finish them.`);
      wallStopped = true;
      break;
    }
    console.log('');
    console.log(`[probe] ── area #${area.noon_area_id} ${area.area_name} (${area.latitude}, ${area.longitude})`);
    try {
      results.push(await probeArea(session, area));
    } catch (e) {
      if (e.ipBlocked) {
        console.error(`[probe] ${e.message} — stopping early`);
        ipBlocked = true;
        break;
      }
      console.error(`[probe] area #${area.noon_area_id} failed: ${e.message}`);
      results.push({ areaId: area.noon_area_id, areaName: area.area_name, error: e.message });
    }
    await sleep(AREA_DELAY_MS);
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`  batch:        ${PROBE_BATCH}`);
  console.log(`  runner IP:    ${ip}`);
  console.log(`  areas probed: ${results.length} of ${areas.length}`);
  console.log(`  tokens used:  ${session.n}`);
  console.log(`  elapsed:      ${secondsElapsed()}s of ${WALL_LIMIT_SEC}s budget`);
  console.log(`  IP blocked:   ${ipBlocked}`);
  console.log(`  wall stopped: ${wallStopped}`);
  for (const r of results) {
    if (r.error) console.log(`  #${r.areaId} ${r.areaName}: ERROR ${r.error}`);
    else if (r.skipped) console.log(`  #${r.areaId} ${r.areaName}: skipped (${r.skipped})`);
    else console.log(`  #${r.areaId} ${r.areaName}: ${r.unique} unique / ${r.cards} cards / ${r.pages} pages / ${r.elapsed}s / ${r.stopReason}`);
  }
  console.log('');
  console.log('Next: inspect the field inventory —');
  console.log('  select * from public.noon_restaurant_list_probe_fields;');
  console.log('  select * from public.noon_restaurant_list_probe_areas;');
  console.log('  select * from public.noon_restaurant_list_probe_overlap limit 50;');

  if (ipBlocked) process.exitCode = 2;
})().catch((e) => {
  console.error('[probe] FATAL:', e);
  process.exit(1);
});
