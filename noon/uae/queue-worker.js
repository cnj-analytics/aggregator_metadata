#!/usr/bin/env node
// noon/uae/queue-worker.js
//
// Orchestrated worker: claims batches from noon_work_queue, processes each item,
// writes results back incrementally. Designed to run as a GitHub Actions matrix
// job — each runner has its own IP.
//
// Zone items:   locate(lat,lng) → record the food zone code.
// Area items:   locate(lat,lng) → fetch first listing page → record zone, count,
//               fingerprint, resolved address.
//
// On token 403:  mint a fresh token and retry.
// On IP block (fresh token also 403s): release all remaining claimed items back
//   to 'pending' and exit cleanly. Another machine picks them up.
// On HTTP 429:   pause 30s and retry.
//
// Every single request is logged line-by-line.
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   NOON_BATCH_ID        which batch to work on          required
//   WORKER_ID            unique id for this worker       required
//   NOON_CLAIM_SIZE      items to claim per batch        (default 50)
//   DELAY_MS             delay between requests          (default 200)
//   NOON_RATE_LIMIT_PAUSE_MS  global pause after 429    (default 30000)

'use strict';

const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const BATCH_ID = process.env.NOON_BATCH_ID;
if (!BATCH_ID) { console.error('Missing NOON_BATCH_ID'); process.exit(1); }

const WORKER_ID = process.env.WORKER_ID || '0';
const CLAIM_SIZE = Number(process.env.NOON_CLAIM_SIZE || '50');
const DELAY_MS = Number(process.env.DELAY_MS || '200');
const RATE_LIMIT_PAUSE_MS = Number(process.env.NOON_RATE_LIMIT_PAUSE_MS || '30000');

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
      if (!resp.ok) throw new Error(`Supabase ${opts.method || 'GET'} ${path} -> ${resp.status}: ${text.slice(0, 500)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}

async function claimWork() {
  return supabase('/rpc/noon_claim_work', {
    method: 'POST',
    body: { p_batch_id: BATCH_ID, p_worker_id: WORKER_ID, p_batch_size: CLAIM_SIZE },
  });
}

async function completeWork(id, status, result = null, error = null) {
  return supabase('/rpc/noon_complete_work', {
    method: 'POST',
    body: { p_id: id, p_status: status, p_result: result, p_error: error },
  });
}

async function releaseWork() {
  return supabase('/rpc/noon_release_work', {
    method: 'POST',
    body: { p_worker_id: WORKER_ID, p_batch_id: BATCH_ID },
  });
}

async function queueStatus() {
  return supabase('/rpc/noon_queue_status', {
    method: 'POST',
    body: { p_batch_id: BATCH_ID },
  });
}

// ── Noon auth + locate ────────────────────────────────────────────────────

async function mintSession(lat = 25.078058170938117, lng = 55.15337817083452) {
  const s = await supabase('/rpc/noon_mint_session', { method: 'POST', body: { p_lat: lat, p_lng: lng } });
  if (!s || s.ok !== true) throw new Error(`noon_mint_session ok=false: ${s && s.error}`);
  return { ...s, mintedAt: Date.now() };
}

class NoonWorker {
  constructor(id) { this.id = id; this.session = null; this.tokenNumber = 0; }
  async ensure() {
    const exp = this.session && this.session.nguestv2_exp ? Date.parse(this.session.nguestv2_exp) : 0;
    if (!this.session || Date.now() > Math.min(exp - 60000, this.session.mintedAt + 240000)) {
      this.session = await mintSession();
      this.tokenNumber++;
      console.log(`[worker ${WORKER_ID}] minted token #${this.tokenNumber} | device_id=${this.session.device_id} | visitor_id=${this.session.visitor_id}`);
    }
    return this.session;
  }
  // Force a new token (after 403).
  async remint() {
    this.session = null;
    return this.ensure();
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

// locate: set-location + whoami-food. Returns zone info or throws.
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

// First listing page (same as sync-areas.js).
async function firstListingPage(loc) {
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
    excludeOutletCodes: [], limit: 60, page: 1,
    sort: { by: 'popularity', dir: 'desc' },
    type: 'outlet', qType: 'search_query', getFallback: true,
  };
  const resp = await fetch(SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (resp.status === 429) throw Object.assign(new Error('search 429'), { rateLimited: true });
  if (resp.status === 403) throw Object.assign(new Error('search 403'), { forbidden: true });
  if (resp.status === 404) return []; // "unserviceable area"
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
  return outlets;
}

// ── Process one item ────────────────────────────────────────────────────────

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

// ── Main loop ───────────────────────────────────────────────────────────────

(async () => {
  if (typeof fetch !== 'function') throw new Error('Node 18+ required');

  console.log(`[worker ${WORKER_ID}] starting | batch=${BATCH_ID} | claim_size=${CLAIM_SIZE} | delay=${DELAY_MS}ms`);

  const ip = await fetch('https://api.ipify.org').then((r) => r.text()).catch(() => 'unknown');
  console.log(`[worker ${WORKER_ID}] runner IP: ${ip}`);

  const worker = new NoonWorker(WORKER_ID);
  let totalProcessed = 0;
  let totalErrors = 0;
  let ipBlocked = false;

  // Outer loop: keep claiming batches until the queue is drained or IP is blocked.
  while (!ipBlocked) {
    const batch = await claimWork();
    if (!batch || batch.length === 0) {
      console.log(`[worker ${WORKER_ID}] no more items to claim — queue drained for this worker`);
      break;
    }
    console.log(`[worker ${WORKER_ID}] claimed ${batch.length} items (ids ${batch[0].id}..${batch[batch.length - 1].id})`);

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const label = item.mode === 'area' ? item.area_name : `${item.latitude},${item.longitude}`;

      let result = null;
      let lastErr = null;
      let success = false;

      // Up to 3 attempts per item (handles transient errors + one token remint).
      for (let attempt = 1; attempt <= 3 && !success && !ipBlocked; attempt++) {
        try {
          if (item.mode === 'zone') {
            result = await processZoneItem(worker, item);
          } else {
            result = await processAreaItem(worker, item);
          }
          success = true;
        } catch (e) {
          lastErr = e;

          if (e.rateLimited) {
            console.log(`[worker ${WORKER_ID}] 429 on item ${item.id} (${label}) — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s`);
            await sleep(RATE_LIMIT_PAUSE_MS);
            continue; // retry same item
          }

          if (e.forbidden) {
            console.log(`[worker ${WORKER_ID}] 403 on item ${item.id} (${label}) — token may be burned, reminting...`);
            await worker.remint();

            // Test the new token on the same item.
            try {
              if (item.mode === 'zone') {
                result = await processZoneItem(worker, item);
              } else {
                result = await processAreaItem(worker, item);
              }
              success = true;
              console.log(`[worker ${WORKER_ID}] remint worked — continuing`);
            } catch (retryErr) {
              if (retryErr.forbidden) {
                console.log(`[worker ${WORKER_ID}] FRESH TOKEN ALSO 403 — IP IS BLOCKED`);
                ipBlocked = true;
                break;
              }
              if (retryErr.rateLimited) {
                console.log(`[worker ${WORKER_ID}] 429 after remint — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s`);
                await sleep(RATE_LIMIT_PAUSE_MS);
                // will retry in outer attempt loop
              } else {
                lastErr = retryErr;
                await sleep(2000 * attempt);
              }
            }
            continue;
          }

          // Other errors: wait and retry.
          await sleep(2000 * attempt);
        }
      }

      if (ipBlocked) {
        // Release ALL remaining claimed items (this one + rest of batch).
        const released = await releaseWork();
        console.log(`[worker ${WORKER_ID}] released ${released} claimed items back to pending`);
        console.log(`[worker ${WORKER_ID}] IP blocked — exiting. Another machine will pick up the remaining work.`);
        break;
      }

      if (success) {
        await completeWork(item.id, 'done', result);
        totalProcessed++;
        if (item.mode === 'zone') {
          console.log(`[worker ${WORKER_ID}] ${totalProcessed} DONE item=${item.id} | zone=${result.zone || '(none)'} | ${item.latitude},${item.longitude}`);
        } else {
          console.log(`[worker ${WORKER_ID}] ${totalProcessed} DONE item=${item.id} | ${label} | zone=${result.zone || '(none)'} | ${result.count} restaurants`);
        }
      } else {
        const errMsg = lastErr ? lastErr.message : 'unknown error';
        await completeWork(item.id, 'error', null, errMsg.slice(0, 500));
        totalErrors++;
        console.log(`[worker ${WORKER_ID}] ${totalProcessed + totalErrors} ERROR item=${item.id} | ${label} | ${errMsg}`);
      }

      await sleep(DELAY_MS);
    }
  }

  // Print summary.
  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`  worker: ${WORKER_ID}`);
  console.log(`  batch: ${BATCH_ID}`);
  console.log(`  runner IP: ${ip}`);
  console.log(`  processed: ${totalProcessed}`);
  console.log(`  errors: ${totalErrors}`);
  console.log(`  tokens used: ${worker.tokenNumber}`);
  console.log(`  IP blocked: ${ipBlocked}`);

  const status = await queueStatus();
  console.log(`  queue status: ${JSON.stringify(status)}`);

  if (ipBlocked) {
    console.log(`  remaining work released to pending for other workers`);
  }
})().catch((e) => {
  console.error('[worker] FATAL:', e);
  // On fatal error, try to release claimed work before dying.
  releaseWork()
    .then((n) => console.log(`[worker] released ${n} items on fatal error`))
    .catch(() => {})
    .finally(() => process.exit(1));
});
