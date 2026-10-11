#!/usr/bin/env node
// noon/uae/queue-worker.js
//
// Orchestrated worker: receives run_id + machine_no from Supabase via
// workflow_dispatch. Checks in with Supabase to get batch_id + settings,
// claims batches from noon_work_queue, processes each item, writes results
// back incrementally. On IP block, reports to Supabase which retires this
// machine and dispatches a replacement.
//
// Zone items:   locate(lat,lng) → record the food zone code.
// Area items:   locate(lat,lng) → fetch first listing page → record zone, count,
//               fingerprint, resolved address.
//
// On token 403:  mint a fresh token and retry.
// On IP block (fresh token also 403s): report to Supabase → exit.
// On HTTP 429:   pause 30s and retry.
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

async function queueStatus(batchId) {
  return supabase('/rpc/noon_queue_status', {
    method: 'POST',
    body: { p_batch_id: batchId },
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
      console.log(`[machine ${MACHINE_NO}] minted token #${this.tokenNumber} | device_id=${this.session.device_id} | visitor_id=${this.session.visitor_id}`);
    }
    return this.session;
  }
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
  if (resp.status === 404) return [];
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

  console.log(`[machine ${MACHINE_NO}] batch=${BATCH_ID} | claim_size=${CLAIM_SIZE} | delay=${DELAY_MS}ms`);

  const worker = new NoonWorker(WORKER_ID);
  let totalProcessed = 0;
  let totalErrors = 0;
  let ipBlocked = false;
  let heartbeatCounter = 0;

  // Outer loop: keep claiming batches until the queue is drained or IP is blocked.
  while (!ipBlocked) {
    const batch = await claimWork(BATCH_ID, WORKER_ID, CLAIM_SIZE);
    if (!batch || batch.length === 0) {
      console.log(`[machine ${MACHINE_NO}] no more items to claim — queue drained for this machine`);
      break;
    }
    console.log(`[machine ${MACHINE_NO}] claimed ${batch.length} items (ids ${batch[0].id}..${batch[batch.length - 1].id})`);

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
            console.log(`[machine ${MACHINE_NO}] 429 on item ${item.id} (${label}) — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s`);
            await sleep(RATE_LIMIT_PAUSE_MS);
            continue;
          }

          if (e.forbidden) {
            console.log(`[machine ${MACHINE_NO}] 403 on item ${item.id} (${label}) — token may be burned, reminting...`);
            await worker.remint();

            // Test the new token on the same item.
            try {
              if (item.mode === 'zone') {
                result = await processZoneItem(worker, item);
              } else {
                result = await processAreaItem(worker, item);
              }
              success = true;
              console.log(`[machine ${MACHINE_NO}] remint worked — continuing`);
            } catch (retryErr) {
              if (retryErr.forbidden) {
                console.log(`[machine ${MACHINE_NO}] FRESH TOKEN ALSO 403 — IP IS BLOCKED`);
                ipBlocked = true;
                break;
              }
              if (retryErr.rateLimited) {
                console.log(`[machine ${MACHINE_NO}] 429 after remint — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s`);
                await sleep(RATE_LIMIT_PAUSE_MS);
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
        // Release remaining claimed items back to pending
        const released = await releaseWork(WORKER_ID, BATCH_ID);
        console.log(`[machine ${MACHINE_NO}] released ${released} claimed items back to pending`);

        // Report IP block to Supabase — it will dispatch a replacement
        console.log(`[machine ${MACHINE_NO}] reporting IP block to Supabase...`);
        const rep = await workerReportBlock(totalProcessed, totalErrors);
        console.log(`[machine ${MACHINE_NO}] report_block response: ${JSON.stringify(rep)}`);

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

      await sleep(DELAY_MS);
    }
  }

  // If we exited cleanly (not IP blocked), tell Supabase we're done
  if (!ipBlocked) {
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

  try {
    const status = await queueStatus(BATCH_ID);
    console.log(`  queue status: ${JSON.stringify(status)}`);
  } catch (e) {
    console.log(`  queue status: error — ${e.message}`);
  }

  if (ipBlocked) {
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
