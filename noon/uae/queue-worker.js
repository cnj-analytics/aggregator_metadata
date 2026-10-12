#!/usr/bin/env node
// noon/uae/queue-worker.js
//
// Orchestrated worker: receives run_id + machine_no from Supabase via
// workflow_dispatch. Checks in with Supabase to get batch_id + settings,
// claims batches from noon_work_queue, processes each item, writes results
// back incrementally. On IP block, reports to Supabase which retires this
// machine and dispatches a replacement.
//
// Zone items:    locate(lat,lng) → record the food zone code.
// Area items:    locate(lat,lng) → fetch first listing page → record zone, count,
//                fingerprint, resolved address.
// Listing items: locate(lat,lng) → walk EVERY page via chained searchToken until
//                the list is exhausted, then upsert the restaurants into
//                noon_restaurant_list_queue. A restaurant already in the queue
//                only gains this area in its noon_area_ids.
//
// Throttling is handled by ROTATING THE TOKEN, not the machine. Evidence from
// the first full sweep: every replacement runner had a brand-new IP and still
// hit 429 after ~100-150 requests, so the budget follows the guest session, not
// the address. Swapping machines to escape it burns runners for nothing.
//
// On 403 or 429:  mint a fresh token and retry the same item.
//   fresh token 403s too → the IP really is blocked → report, retire, replace.
//   fresh token 429s too → throttling is not token-scoped here → report, retire,
//                          replace.
// A 429 also permanently slows this machine's call rate, since the server has
// said we are going too fast either way.
//
// An item is NEVER marked 'error' because of throttling. On stand-down the
// in-flight item is released back to 'pending' with everything else still
// claimed, so the queue always completes.
//
// Every single request is logged line-by-line.
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   RUN_ID               Supabase run id                required
//   MACHINE_NO           Machine number in the run      required

'use strict';

const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const RUN_ID = process.env.RUN_ID;
const MACHINE_NO = process.env.MACHINE_NO;
if (!RUN_ID || !MACHINE_NO) {
  console.error('Missing RUN_ID or MACHINE_NO');
  process.exit(1);
}

const UA = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const BUILD = '22098';
const SET_LOCATION_URL = 'https://api-app.noon.com/_vs/st/mp-identity-api-geo/serviceable-geo-info/set-location-by-lat-lng';
const WHOAMI_FOOD_URL = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami?experience=food&select_nearby=1';
const SEARCH_URL = 'https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/search';
const DETAIL_URL =
  'https://api-app-fd.noon.com/_svc/mp-food-api-mpnoon/consumer/restaurant/outlet/details/guest/partial';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Delay between page requests. main() sets it from Supabase settings and the
// 429 rule raises it, so the paginating walk below picks the change up mid-run.
let pageDelayMs = 200;
const PAGE_LIMIT = 60;          // Noon's own page size
const PAGE_SAFETY_CAP = 500;    // runaway guard only; exhaustion is the real stop

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
      if (!resp.ok) throw new Error(`Supabase ${opts.method || 'GET'} ${path} -> ${resp.status}: ${text.slice(0, 500)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}

// ── Supabase orchestration RPCs ─────────────────────────────────────────────

async function workerCheckin(ip) {
  return supabase('/rpc/noon_worker_checkin', {
    method: 'POST',
    body: { p_run_id: Number(RUN_ID), p_machine_no: Number(MACHINE_NO), p_ip: ip },
  });
}

async function workerHeartbeat(itemsDone, itemsError) {
  return supabase('/rpc/noon_worker_heartbeat', {
    method: 'POST',
    body: { p_run_id: Number(RUN_ID), p_machine_no: Number(MACHINE_NO), p_items_done: itemsDone, p_items_error: itemsError },
  });
}

async function workerReportBlock(itemsDone, itemsError) {
  return supabase('/rpc/noon_worker_report_block', {
    method: 'POST',
    body: { p_run_id: Number(RUN_ID), p_machine_no: Number(MACHINE_NO), p_items_done: itemsDone, p_items_error: itemsError },
  });
}

async function workerReportRateLimit(itemsDone, itemsError) {
  return supabase('/rpc/noon_worker_report_rate_limit', {
    method: 'POST',
    body: { p_run_id: Number(RUN_ID), p_machine_no: Number(MACHINE_NO), p_items_done: itemsDone, p_items_error: itemsError },
  });
}

async function workerFinished(itemsDone, itemsError) {
  return supabase('/rpc/noon_worker_finished', {
    method: 'POST',
    body: { p_run_id: Number(RUN_ID), p_machine_no: Number(MACHINE_NO), p_items_done: itemsDone, p_items_error: itemsError },
  });
}

// ── Queue RPCs (existing) ───────────────────────────────────────────────────

async function claimWork(batchId, workerId, claimSize) {
  return supabase('/rpc/noon_claim_work', {
    method: 'POST',
    body: { p_batch_id: batchId, p_worker_id: workerId, p_batch_size: claimSize },
  });
}

async function completeWork(id, status, result = null, error = null) {
  return supabase('/rpc/noon_complete_work', {
    method: 'POST',
    body: { p_id: id, p_status: status, p_result: result, p_error: error },
  });
}

async function releaseWork(workerId, batchId) {
  return supabase('/rpc/noon_release_work', {
    method: 'POST',
    body: { p_worker_id: workerId, p_batch_id: batchId },
  });
}

// Postgres does the card → row mapping, so there is one source of truth for it.
async function upsertQueue(noonAreaId, cards) {
  return supabase('/rpc/noon_queue_upsert_batch', {
    method: 'POST',
    body: { p_noon_area_id: noonAreaId, p_cards: cards },
  });
}

async function queueStatus(batchId) {
  return supabase('/rpc/noon_queue_status', {
    method: 'POST',
    body: { p_batch_id: batchId },
  });
}

// ── Noon auth + locate ────────────────────────────────────────────────────

// MINT_SOURCE picks where the guest token is issued.
//   'worker'   (default) - minted here, on this runner's own IP. A token
//              issued to one address and presented from another is a
//              mismatch no real device produces, and Supabase has a single
//              static egress IP that degraded badly under load (778 mints in
//              a day took it to a 66% failure rate and abandoned 9 areas).
//   'supabase' - the old path, kept for diagnostics only.
const MINT_SOURCE = (process.env.MINT_SOURCE || 'worker').toLowerCase();
const WHOAMI_URL = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami';

function decodeJwt(jwt) {
  try {
    const seg = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(Buffer.from(seg + '='.repeat((4 - (seg.length % 4)) % 4), 'base64').toString('utf8'));
    return { exp: p.exp ? new Date(p.exp * 1000).toISOString() : null, kid: p.kid || null };
  } catch { return { exp: null, kid: null }; }
}

// The 3-step chain Noon's app performs. nguestv2 is issued by step 1; steps 2
// and 3 resolve the location and return the zone headers the food API wants
// echoed back.
async function mintSessionLocal(lat, lng) {
  const deviceId = crypto.randomUUID();
  const visitorId = crypto.randomUUID();
  const jar = {};
  const base = () => ({
    'User-Agent': UA, 'x-platform': 'ios', 'x-build': BUILD, 'x-mp': 'noon',
    'x-content': 'mobile', Accept: 'application/json',
    'x-device-id': deviceId, 'x-visitor-id': visitorId,
  });

  const r1 = await fetch(WHOAMI_URL, {
    headers: { ...base(), 'x-experience': 'ecom', 'x-whoami-request-id': crypto.randomUUID() },
  });
  if (r1.status === 403) throw Object.assign(new Error('mint whoami 403'), { forbidden: true });
  if (r1.status !== 200) throw new Error(`mint whoami ecom HTTP ${r1.status}`);
  mergeSetCookies(jar, r1);

  const r2 = await fetch(SET_LOCATION_URL, {
    method: 'POST',
    headers: { ...base(), 'x-experience': 'ecom', 'x-locale': 'en-ae',
               'x-device-lat': String(lat), 'x-device-lng': String(lng),
               'Content-Type': 'application/json', Cookie: cookieString(jar) },
    body: JSON.stringify({ location: { lat, lng }, lang: 'en' }),
  });
  if (r2.status === 403) throw Object.assign(new Error('mint set-location 403'), { forbidden: true });
  if (r2.status !== 200) throw new Error(`mint set-location HTTP ${r2.status}`);
  const setloc = await r2.json().catch(() => ({}));
  mergeSetCookies(jar, r2);

  const r3 = await fetch(WHOAMI_FOOD_URL, {
    headers: { ...base(), 'x-experience': 'ecom', 'x-locale': 'en-ae',
               'x-device-lat': String(lat), 'x-device-lng': String(lng),
               'x-whoami-request-id': crypto.randomUUID(), Cookie: cookieString(jar) },
  });
  if (r3.status === 403) throw Object.assign(new Error('mint whoami food 403'), { forbidden: true });
  if (r3.status !== 200) throw new Error(`mint whoami food HTTP ${r3.status}`);
  const who = await r3.json().catch(() => ({}));
  mergeSetCookies(jar, r3);

  if (!jar.nguestv2) throw new Error('mint produced no nguestv2');
  const { exp, kid } = decodeJwt(jar.nguestv2);
  const zones = who && who.headers && typeof who.headers === 'object' ? who.headers : {};

  return {
    ok: true,
    device_id: deviceId, visitor_id: visitorId,
    cookies: jar, cookie_string: cookieString(jar),
    zone_codes: zones, food_zonecode: zones['x-food-zonecode'] || null,
    resolved_area: setloc.area || null,
    nguestv2_exp: exp, nguestv2_kid: kid,
    mintedAt: Date.now(),
  };
}

async function mintSession(lat = 25.078058170938117, lng = 55.15337817083452) {
  if (MINT_SOURCE === 'supabase') {
    const s = await supabase('/rpc/noon_mint_session', { method: 'POST', body: { p_lat: lat, p_lng: lng } });
    if (!s || s.ok !== true) throw new Error(`noon_mint_session ok=false: ${s && s.error}`);
    return { ...s, mintedAt: Date.now() };
  }
  return mintSessionLocal(lat, lng);
}

const TOKEN_LIFETIME_MS = 300000;   // Noon's nguestv2 lives 5 minutes

class NoonWorker {
  constructor(id) { this.id = id; this.session = null; this.tokenNumber = 0; }

  // Milliseconds of usable life left on the current token, by whichever runs
  // out first: the JWT's own exp, or 5 minutes from when we minted it.
  remainingMs() {
    if (!this.session) return 0;
    const byExp = this.session.nguestv2_exp
      ? Date.parse(this.session.nguestv2_exp) - Date.now()
      : Infinity;
    const byAge = this.session.mintedAt + TOKEN_LIFETIME_MS - Date.now();
    return Math.max(0, Math.min(byExp, byAge));
  }

  // Guarantee at least `needMs` of token life before starting a unit of work.
  // A token minted seconds ago is reused, so this never double-mints straight
  // after a rotation.
  async ensureFresh(needMs) {
    if (this.remainingMs() >= needMs) return this.session;
    return this.remint();
  }

  async ensure(lat, lng) {
    const exp = this.session && this.session.nguestv2_exp ? Date.parse(this.session.nguestv2_exp) : 0;
    if (!this.session || Date.now() > Math.min(exp - 60000, this.session.mintedAt + 240000)) {
      this.session = (lat != null && lng != null) ? await mintSession(lat, lng) : await mintSession();
      this.tokenNumber++;
      console.log(`[machine ${MACHINE_NO}] minted token #${this.tokenNumber} via ${MINT_SOURCE} | device_id=${this.session.device_id} | zone=${this.session.food_zonecode || '-'}`);
    }
    return this.session;
  }
  async remint(lat, lng) {
    this.session = null;
    return this.ensure(lat, lng);
  }
}

function baseHeaders(session, lat, lng) {
  return {
    'User-Agent': UA,
    'x-platform': 'ios',
    'x-build': BUILD,
    'x-mp': 'noon',
    'x-content': 'mobile',
    'x-locale': 'en-ae',
    'x-device-id': session.device_id,
    'x-visitor-id': session.visitor_id,
    'x-device-lat': String(lat),
    'x-device-lng': String(lng),
    Accept: 'application/json',
  };
}

function mergeSetCookies(jar, resp) {
  const list = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const c of list) {
    const m = /^([^=]+)=([^;]+)/.exec(c);
    if (m) jar[m[1]] = m[2];
  }
}
const cookieString = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function locate(worker, lat, lng) {
  const session = await worker.ensure();
  const jar = { ...(session.cookies || {}) };
  const h = { ...baseHeaders(session, lat, lng), 'x-experience': 'ecom' };

  const r1 = await fetch(SET_LOCATION_URL, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json', Cookie: cookieString(jar) },
    body: JSON.stringify({ location: { lat, lng }, lang: 'en' }),
  });
  if (r1.status === 429) throw Object.assign(new Error('set-location 429'), { rateLimited: true });
  if (r1.status === 403) throw Object.assign(new Error('set-location 403'), { forbidden: true });
  if (!r1.ok) throw new Error(`set-location HTTP ${r1.status}`);
  const setloc = await r1.json().catch(() => ({}));
  mergeSetCookies(jar, r1);

  const r2 = await fetch(WHOAMI_FOOD_URL, {
    headers: { ...h, 'x-whoami-request-id': crypto.randomUUID(), Cookie: cookieString(jar) },
  });
  if (r2.status === 429) throw Object.assign(new Error('whoami 429'), { rateLimited: true });
  if (r2.status === 403) throw Object.assign(new Error('whoami 403'), { forbidden: true });
  if (!r2.ok) throw new Error(`whoami food HTTP ${r2.status}`);
  const who = await r2.json();
  mergeSetCookies(jar, r2);

  const zoneHeaders = who && who.headers && typeof who.headers === 'object' ? who.headers : {};
  return {
    session, lat, lng,
    foodZone: zoneHeaders['x-food-zonecode'] || null,
    zoneHeaders,
    cookie: cookieString(jar),
    resolvedAddress: setloc.area || null,
    geoCityId: Number.isInteger(setloc.cityId) ? setloc.cityId : null,
  };
}

async function listingPage(loc, searchToken) {
  const { session, lat, lng } = loc;
  const headers = {
    ...baseHeaders(session, lat, lng),
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
  // /search ignores `page`; the response's searchToken is the real cursor and
  // must be chained in, or every page re-serves the first 60 outlets.
  if (searchToken) body.searchToken = searchToken;

  const resp = await fetch(SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (resp.status === 429) throw Object.assign(new Error('search 429'), { rateLimited: true });
  if (resp.status === 403) throw Object.assign(new Error('search 403'), { forbidden: true });
  if (resp.status === 404) return { outlets: [], token: null };
  if (!resp.ok) throw new Error(`search HTTP ${resp.status}`);
  const json = await resp.json();
  const outlets = [];
  (function walk(x, depth) {
    if (depth > 8 || !x) return;
    if (Array.isArray(x)) { for (const v of x) walk(v, depth + 1); return; }
    if (typeof x === 'object') {
      if (typeof x.outletCode === 'string' && x.outletCode) { outlets.push(x); return; }
      for (const k of Object.keys(x)) walk(x[k], depth + 1);
    }
  })(json.results || [], 0);
  return { outlets, token: json.searchToken || null };
}

const firstListingPage = async (loc) => (await listingPage(loc, null)).outlets;

// ── Process one item ────────────────────────────────────────────────────────

// ── Restaurant page (outlet detail) ─────────────────────────────────────────
//
// One call per branch. Measured on this endpoint (four controlled runs):
// it is a token bucket on the IP — roughly 110 burst, refilling about one
// every 4 seconds. Rotating the token does NOT refill it (a fresh token is
// 429'd immediately once empty), so PACE is the only lever and the queue is
// run at delay_ms = 4000. The result is extracted straight into
// noon_branch_information by noon_detail_record; raw payloads are not kept.
async function processDetailItem(worker, item) {
  const outlet = item.noon_outlet_code;
  if (!outlet) throw new Error('detail item has no noon_outlet_code');

  const session = await worker.ensure(item.latitude, item.longitude);
  const lat = item.latitude;
  const lng = item.longitude;

  const headers = {
    ...baseHeaders(session, lat, lng),
    'x-mp-country': 'ae',
    'x-experience': 'food',
    'x-lat': String(Math.round(lat * 1e7)),
    'x-lng': String(Math.round(lng * 1e7)),
    'x-whoami-request-id': crypto.randomUUID(),
    Cookie: cookieString({ ...(session.cookies || {}) }),
    'Content-Type': 'application/json',
  };
  const zones = session.zone_codes && typeof session.zone_codes === 'object' ? session.zone_codes : {};
  for (const [k, v] of Object.entries(zones)) {
    if (v !== null && typeof v !== 'object' && !k.toLowerCase().includes('ab-test')) headers[k] = String(v);
  }

  const started = Date.now();
  const resp = await fetch(DETAIL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      outletCode: outlet,
      lat: Math.round(lat * 1e7),
      lng: Math.round(lng * 1e7),
    }),
  });
  const elapsed = Date.now() - started;

  if (resp.status === 429) throw Object.assign(new Error('detail 429'), { rateLimited: true });
  if (resp.status === 403) throw Object.assign(new Error('detail 403'), { forbidden: true });
  if (resp.status === 404) return { outlet, http: 404, skipped: 'not found' };
  if (!resp.ok) throw new Error(`detail HTTP ${resp.status}`);

  const payload = await resp.json();
  const rec = await supabase('/rpc/noon_detail_record', {
    method: 'POST',
    body: { p_outlet: outlet, p_http: 200, p_payload: payload, p_elapsed_ms: elapsed },
  });

  const d = (payload && payload.data) || {};
  const menu = d.menu || {};
  return {
    outlet,
    http: 200,
    name: d.name || null,
    oms: d.externalOmsCode || null,
    has_address: !!d.address,
    menu_items: Array.isArray(menu.items) ? menu.items.length : null,
    elapsed_ms: elapsed,
    recorded: rec && rec.ok === true,
  };
}

async function processZoneItem(worker, item) {
  const loc = await locate(worker, item.latitude, item.longitude);
  return { zone: loc.foodZone, lat: item.latitude, lng: item.longitude };
}

async function processAreaItem(worker, item) {
  const loc = await locate(worker, item.latitude, item.longitude);
  const zone = loc.foodZone || null;
  const outlets = zone ? await firstListingPage(loc) : [];
  const fingerprint = outlets.length
    ? crypto.createHash('md5').update(outlets.map((o) => `${o.outletCode}:${o.distance ?? ''}`).join('|')).digest('hex')
    : null;
  return {
    zone,
    count: outlets.length,
    fingerprint,
    resolved_address: loc.resolvedAddress,
    geo_city_id: loc.geoCityId,
  };
}

async function processListingItem(worker, item) {
  const areaId = item.noon_area_id;
  if (!areaId) throw new Error('listing item has no noon_area_id');

  // ONE TOKEN PER AREA. Measured: an area takes ~125s median, 211s at p90,
  // 262s worst, against a 300s token. Minting at the start of the area means
  // the whole page walk runs on one fresh token instead of straddling an
  // expiry partway through. A token minted moments ago (e.g. by a 429
  // rotation) still has its life left and is reused rather than replaced.
  await worker.ensureFresh(280000);

  const loc = await locate(worker, item.latitude, item.longitude);
  if (!loc.foodZone) {
    return { zone: null, pages: 0, unique: 0, skipped: 'no food zone at this point' };
  }

  const seen = new Set();
  const cards = [];
  let token = null;
  let page = 0;
  let stopReason = null;

  while (page < PAGE_SAFETY_CAP) {
    page++;
    const r = await listingPage(loc, token);

    const fresh = r.outlets.filter((o) => !seen.has(o.outletCode));
    for (const o of fresh) { seen.add(o.outletCode); cards.push(o); }

    if (r.outlets.length === 0) { stopReason = `empty page at ${page}`; break; }
    if (fresh.length === 0)     { stopReason = `no new outlets at page ${page}`; break; }
    if (!r.token)               { stopReason = `no searchToken at page ${page}`; break; }

    token = r.token;              // advance the cursor
    await sleep(pageDelayMs);
  }
  if (!stopReason) stopReason = `RUNAWAY: hit PAGE_SAFETY_CAP=${PAGE_SAFETY_CAP}`;

  let inserted = 0, merged = 0, queueTotal = null;
  for (let i = 0; i < cards.length; i += 500) {
    const res = await upsertQueue(areaId, cards.slice(i, i + 500));
    if (res) {
      inserted += res.inserted || 0;
      merged   += res.merged   || 0;
      queueTotal = res.queue_total ?? queueTotal;
    }
  }

  return {
    zone: loc.foodZone,
    pages: page,
    unique: seen.size,
    inserted,
    merged,
    queue_total: queueTotal,
    stop_reason: stopReason,
    resolved_address: loc.resolvedAddress,
  };
}

// ── Main loop ───────────────────────────────────────────────────────────────

(async () => {
  if (typeof fetch !== 'function') throw new Error('Node 18+ required');

  console.log(`[machine ${MACHINE_NO}] starting | run=${RUN_ID}`);

  // Get our IP
  const ip = await fetch('https://api.ipify.org').then((r) => r.text()).catch(() => 'unknown');
  console.log(`[machine ${MACHINE_NO}] runner IP: ${ip}`);

  // Check in with Supabase — get batch_id, delay_ms, claim_size
  const checkin = await workerCheckin(ip);
  console.log(`[machine ${MACHINE_NO}] checkin: ${JSON.stringify(checkin)}`);

  if (checkin.action === 'stop_job') {
    console.log(`[machine ${MACHINE_NO}] told to stop: ${checkin.reason}`);
    process.exit(0);
  }

  const BATCH_ID = checkin.batch_id;
  const DELAY_MS = checkin.delay_ms || 200;
  const CLAIM_SIZE = checkin.claim_size || 50;
  const WORKER_ID = `run${RUN_ID}-m${MACHINE_NO}`;
  const RATE_LIMIT_PAUSE_MS = 30000;
  const RATE_LIMIT_SLOWDOWN = 2;      // multiply the delay each time we are throttled
  const RATE_LIMIT_MAX_DELAY = 6000;  // ms, ceiling for the slowed rate
  const MAX_TOKEN_ROTATIONS = 1;      // fresh tokens to try per item before standing down

  console.log(`[machine ${MACHINE_NO}] batch=${BATCH_ID} | claim_size=${CLAIM_SIZE} | delay=${DELAY_MS}ms`);

  const worker = new NoonWorker(WORKER_ID);
  let totalProcessed = 0;
  let totalErrors = 0;
  let ipBlocked = false;
  let standDown = false;     // fresh token still throttled: retire and hand over
  let delayMs = DELAY_MS;    // raised on 429, never lowered again
  pageDelayMs = DELAY_MS;    // the paginating walk reads this too
  let heartbeatCounter = 0;
  let throttleHits = 0;      // 429s cleared by rotating the token (detail mode)

  // Outer loop: claim batches until the queue drains, the IP is blocked, or a
  // 429 tells us to stand down.
  while (!ipBlocked && !standDown) {
    const batch = await claimWork(BATCH_ID, WORKER_ID, CLAIM_SIZE);
    if (!batch || batch.length === 0) {
      console.log(`[machine ${MACHINE_NO}] no more items to claim — queue drained for this machine`);
      break;
    }
    console.log(`[machine ${MACHINE_NO}] claimed ${batch.length} items (ids ${batch[0].id}..${batch[batch.length - 1].id})`);

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const label = item.mode === 'area' ? item.area_name
        : item.mode === 'detail' ? item.noon_outlet_code
        : `${item.latitude},${item.longitude}`;

      let result = null;
      let lastErr = null;
      let success = false;

      // Token rotations spent on THIS item. One rotation is allowed: if the
      // fresh token is throttled or blocked straight away, the problem is not
      // the token and the machine stands down.
      let rotations = 0;

      for (let attempt = 1; attempt <= 4 && !success && !ipBlocked && !standDown; attempt++) {
        try {
          if (item.mode === 'zone') {
            result = await processZoneItem(worker, item);
          } else if (item.mode === 'listing') {
            result = await processListingItem(worker, item);
          } else if (item.mode === 'detail') {
            result = await processDetailItem(worker, item);
          } else {
            result = await processAreaItem(worker, item);
          }
          success = true;
          if (rotations > 0) {
            console.log(`[machine ${MACHINE_NO}] fresh token worked — continuing on item ${item.id}`);
          }
        } catch (e) {
          lastErr = e;
          const throttled = !!e.rateLimited;
          const blocked = !!e.forbidden;

          if (throttled || blocked) {
            const kind = blocked ? '403' : '429';

            if (rotations >= MAX_TOKEN_ROTATIONS) {
              // Already tried a fresh token on this item and still refused.
              if (blocked) {
                console.log(`[machine ${MACHINE_NO}] FRESH TOKEN ALSO 403 — IP IS BLOCKED`);
                ipBlocked = true;
              } else {
                console.log(`[machine ${MACHINE_NO}] FRESH TOKEN ALSO 429 — throttling is not token-scoped, standing down`);
                standDown = true;
              }
              break;
            }

            rotations++;
            if (throttled && item.mode === 'detail') {
              // Measured on the restaurant-detail endpoint: the quota sits
              // on the TOKEN, not the IP. A fresh token is accepted at once
              // (17/17 in run 7), so pausing 30s and permanently halving the
              // rate buys nothing and cost us 14s/item instead of 2s. Rotate
              // and carry straight on at the configured pace. If the fresh
              // token is ALSO refused, MAX_TOKEN_ROTATIONS still trips and
              // the machine retires for a replacement with a new IP.
              throttleHits++;
              console.log(`[machine ${MACHINE_NO}] 429 on item ${item.id} (${label}) — token spent (#${throttleHits}), rotating and continuing at ${delayMs}ms/call`);
            } else if (throttled) {
              // Listing/area/zone walks: there a fresh token was refused
              // 83/83 times, so the quota is on the IP and backing off is
              // the right move. Behaviour unchanged.
              delayMs = Math.min(delayMs * RATE_LIMIT_SLOWDOWN, RATE_LIMIT_MAX_DELAY);
              pageDelayMs = delayMs;
              console.log(`[machine ${MACHINE_NO}] 429 on item ${item.id} (${label}) — slowing to ${delayMs}ms/call, pausing ${RATE_LIMIT_PAUSE_MS / 1000}s, rotating token`);
              await sleep(RATE_LIMIT_PAUSE_MS);
            } else {
              console.log(`[machine ${MACHINE_NO}] 403 on item ${item.id} (${label}) — token burned, rotating`);
            }

            try {
              await worker.remint();
            } catch (mintErr) {
              console.log(`[machine ${MACHINE_NO}] mint failed after ${kind}: ${mintErr.message}`);
              await sleep(5000);
            }
            continue;   // retry the same item on the new token
          }

          // Anything else: genuine error, back off and retry.
          await sleep(2000 * attempt);
        }
      }

      if (ipBlocked || standDown) {
        // The in-flight item is still 'claimed', so this hands it back to
        // 'pending' along with everything else. Nothing is lost to throttling.
        const released = await releaseWork(WORKER_ID, BATCH_ID);
        console.log(`[machine ${MACHINE_NO}] standing down (${ipBlocked ? 'IP blocked' : 'rate limited'}) — released ${released} claimed items back to pending, including the one in progress`);

        const rep = ipBlocked
          ? await workerReportBlock(totalProcessed, totalErrors)
          : await workerReportRateLimit(totalProcessed, totalErrors);
        console.log(`[machine ${MACHINE_NO}] report response: ${JSON.stringify(rep)}`);

        if (rep.replaced) {
          console.log(`[machine ${MACHINE_NO}] replacement machine ${rep.replacement_machine} dispatched`);
        } else {
          console.log(`[machine ${MACHINE_NO}] no replacement dispatched (cap reached or no work left)`);
        }
        break;
      }

      if (success) {
        await completeWork(item.id, 'done', result);
        totalProcessed++;
        if (item.mode === 'zone') {
          console.log(`[machine ${MACHINE_NO}] ${totalProcessed} DONE item=${item.id} | zone=${result.zone || '(none)'} | ${item.latitude},${item.longitude}`);
        } else if (item.mode === 'listing') {
          console.log(`[machine ${MACHINE_NO}] ${totalProcessed} DONE item=${item.id} | ${label} | ${result.unique} restaurants over ${result.pages} pages | +${result.inserted} new, ${result.merged} merged | queue=${result.queue_total ?? '?'} | ${result.stop_reason}`);
        } else if (item.mode === 'detail') {
          console.log(`[machine ${MACHINE_NO}] ${totalProcessed} DONE item=${item.id} | ${label} | "${result.name || '?'}" | oms=${result.oms || '-'} | addr=${result.has_address ? 'y' : 'n'} | items=${result.menu_items ?? '-'} | ${result.elapsed_ms}ms`);
        } else {
          console.log(`[machine ${MACHINE_NO}] ${totalProcessed} DONE item=${item.id} | ${label} | zone=${result.zone || '(none)'} | ${result.count} restaurants`);
        }
      } else {
        const errMsg = lastErr ? lastErr.message : 'unknown error';
        await completeWork(item.id, 'error', null, errMsg.slice(0, 500));
        totalErrors++;
        console.log(`[machine ${MACHINE_NO}] ${totalProcessed + totalErrors} ERROR item=${item.id} | ${label} | ${errMsg}`);
      }

      // Heartbeat every 25 items
      heartbeatCounter++;
      if (heartbeatCounter >= 25) {
        heartbeatCounter = 0;
        try {
          const hb = await workerHeartbeat(totalProcessed, totalErrors);
          if (hb.action === 'stop_job') {
            console.log(`[machine ${MACHINE_NO}] heartbeat says stop: ${hb.reason}`);
            await releaseWork(WORKER_ID, BATCH_ID);
            break;
          }
        } catch (hbErr) {
          console.log(`[machine ${MACHINE_NO}] heartbeat error (continuing): ${hbErr.message}`);
        }
      }

      await sleep(delayMs);
    }
  }

  // Clean exit only: a 429 retirement already reported itself above.
  if (!ipBlocked && !standDown) {
    console.log(`[machine ${MACHINE_NO}] reporting finished to Supabase...`);
    const fin = await workerFinished(totalProcessed, totalErrors);
    console.log(`[machine ${MACHINE_NO}] finished response: ${JSON.stringify(fin)}`);
  }

  // Print summary.
  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`  run: ${RUN_ID}`);
  console.log(`  machine: ${MACHINE_NO}`);
  console.log(`  runner IP: ${ip}`);
  console.log(`  processed: ${totalProcessed}`);
  console.log(`  errors: ${totalErrors}`);
  console.log(`  tokens used: ${worker.tokenNumber}`);
  console.log(`  IP blocked: ${ipBlocked}`);
  console.log(`  stood down (rate limited): ${standDown}${standDown ? ` (final delay ${delayMs}ms)` : ''}`);
  console.log(`  429s cleared by token rotation: ${throttleHits}`);

  try {
    const status = await queueStatus(BATCH_ID);
    console.log(`  queue status: ${JSON.stringify(status)}`);
  } catch (e) {
    console.log(`  queue status: error — ${e.message}`);
  }

  if (ipBlocked || standDown) {
    process.exitCode = 2; // Non-zero but not 1, so the workflow summary step still runs
  }
})().catch((e) => {
  console.error('[machine] FATAL:', e);
  // On fatal error, try to release claimed work and report block before dying.
  const WORKER_ID = `run${RUN_ID}-m${MACHINE_NO}`;
  (async () => {
    try {
      // Try to get batch_id from the run
      const run = await supabase(`/rest/v1/noon_run?run_id=eq.${RUN_ID}&select=batch_id`, {
        headers: { Prefer: 'return=representation' },
      });
      if (run && run[0]) {
        const n = await releaseWork(WORKER_ID, run[0].batch_id);
        console.log(`[machine] released ${n} items on fatal error`);
      }
    } catch (_) {}
    try {
      await workerFinished(0, 0);
    } catch (_) {}
  })().finally(() => process.exit(1));
});
