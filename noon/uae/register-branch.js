// register-branch.js
//
// Noon UAE — register new restaurants (one job of JOB_COUNT).
//
// Started by Supabase (trigger on noon_restaurant_list_queue INSERT via
// noon_dispatch_registration) whenever the ranking scrape discovers outlet
// codes that are not in noon_branch. Each job:
//   1. claims the oldest waiting outlet (noon_registration_claim) — atomic,
//      no two jobs get the same one;
//   2. mints its own 3-step guest token on this runner's IP (same chain as
//      ranking-scrape.js);
//   3. fetches /outlet/details/guest/partial with the outlet's area lat/lng;
//   4. builds the record (partner / brand / branch / information + delivery
//      areas) from the detail payload, falling back to raw_card where fields
//      are not present on the detail;
//   5. calls noon_register_branch, which in one transaction creates/updates
//      the partner, brand, branch, information and delivery-area edges,
//      promotes parked ranking rows from noon_ranking_pending into
//      noon_ranking_analysis, and marks the queue row 'registered';
//   6. on any problem calls noon_registration_fail (up to 3 attempts,
//      then failed_permanent);
//   7. repeats until the queue is empty or the time budget is spent.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JOB_INDEX, JOB_COUNT,
//      CLAIM_SIZE (default 1), TIME_BUDGET_MIN (default 40), SUMMARY_FILE,
//      DELAY_MS (default 4000 — detail endpoint refill ~1 per 4s per IP),
//      CALL_BUDGET (default 100 — safety cap per machine)

'use strict';

const fs      = require('fs');
const crypto  = require('node:crypto');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JOB_INDEX     = parseInt(process.env.JOB_INDEX || '0', 10);
const JOB_COUNT     = parseInt(process.env.JOB_COUNT || '1', 10);
const CLAIM_SIZE    = parseInt(process.env.CLAIM_SIZE || '1', 10);
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || '40', 10) * 60_000;
const SUMMARY_FILE  = process.env.SUMMARY_FILE || 'summary.json';
const DELAY_MS      = parseInt(process.env.DELAY_MS || '4000', 10);
const CALL_BUDGET   = parseInt(process.env.CALL_BUDGET || '100', 10);
const START_STAGGER_MS = 2000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const UA    = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const BUILD = '22098';
const WHOAMI_URL       = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami';
const SET_LOCATION_URL = 'https://api-app.noon.com/_vs/st/mp-identity-api-geo/serviceable-geo-info/set-location-by-lat-lng';
const WHOAMI_FOOD_URL  = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami?experience=food&select_nearby=1';
const DETAIL_URL       = 'https://api-app-fd.noon.com/_svc/mp-food-api-mpnoon/consumer/restaurant/outlet/details/guest/partial';

const TOKEN_LIFE_MS = 300_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log   = (...a) => console.log(`[j${JOB_INDEX}]`, ...a);

// -- Supabase RPC -----------------------------------------------------------
async function rpc(name, body) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }).catch(e => ({ ok: false, status: 0, text: async () => e.message }));
    const text = await resp.text();
    if (resp.ok) return text ? JSON.parse(text) : null;
    if ((resp.status >= 500 || resp.status === 0) && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new Error(`rpc ${name} -> ${resp.status}: ${text.slice(0, 400)}`);
  }
}

// -- Cookie / mint ----------------------------------------------------------
function mergeSetCookies(jar, resp) {
  const list = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const c of list) {
    const m = /^([^=]+)=([^;]+)/.exec(c);
    if (m) jar[m[1]] = m[2];
  }
}
const cookieStr = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

let session = null, tokenCount = 0;

async function mintSession(lat, lng) {
  const deviceId  = crypto.randomUUID();
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
  tokenCount++;
  session = { deviceId, visitorId, jar, zones, mintedAt: Date.now() };
  log(`token #${tokenCount} | zone=${zones['x-food-zonecode'] || '-'}`);
  return session;
}

function tokenRemainingMs() {
  if (!session) return 0;
  return Math.max(0, session.mintedAt + TOKEN_LIFE_MS - Date.now());
}

async function ensureSession(lat, lng, needMs = 60_000) {
  if (session && tokenRemainingMs() >= needMs) return session;
  return mintSession(lat, lng);
}

// -- Detail fetch -----------------------------------------------------------
function detailHeaders(lat, lng) {
  const h = {
    'User-Agent': UA, 'x-platform': 'ios', 'x-build': BUILD, 'x-mp': 'noon',
    'x-content': 'mobile', 'x-locale': 'en-ae', Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-device-id': session.deviceId, 'x-visitor-id': session.visitorId,
    'x-mp-country': 'ae', 'x-experience': 'food',
    'x-device-lat': String(lat), 'x-device-lng': String(lng),
    'x-lat': String(Math.round(lat * 1e7)),
    'x-lng': String(Math.round(lng * 1e7)),
    'x-whoami-request-id': crypto.randomUUID(),
    Cookie: cookieStr(session.jar),
  };
  for (const [k, v] of Object.entries(session.zones || {})) {
    if (v != null && typeof v !== 'object' && !k.toLowerCase().includes('ab-test')) h[k] = String(v);
  }
  return h;
}

async function fetchDetail(outletCode, lat, lng) {
  const resp = await fetch(DETAIL_URL, {
    method: 'POST', headers: detailHeaders(lat, lng),
    body: JSON.stringify({
      outletCode,
      lat: Math.round(lat * 1e7),
      lng: Math.round(lng * 1e7),
    }),
  });
  if (resp.status === 429) throw Object.assign(new Error('detail 429'), { rateLimited: true });
  if (resp.status === 403) throw Object.assign(new Error('detail 403'), { forbidden: true });
  if (!resp.ok) throw new Error(`detail HTTP ${resp.status}`);
  return resp.json();
}

// -- Build record from detail payload + queue row ---------------------------
function pickString(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}
function pickNumber(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && isFinite(v)) return v;
    const n = Number(v);
    if (!isNaN(n) && v != null && v !== '') return n;
  }
  return null;
}

/**
 * Translate Noon's detail payload + the queue's raw_card into the record
 * noon_register_branch expects. Any field present in the detail trumps the
 * same field in the card (detail is authoritative).
 */
function buildRecord(claim, detail) {
  const d = (detail && detail.data) ? detail.data : (detail || {});
  const card = claim.raw_card || {};

  // The detail payload has either flat fields or a nested restaurant object
  const r = d.restaurant || d.outlet || d;

  const outletCode = claim.noon_outlet_code;
  const brandId    = pickString(r.brandCode, r.brand && r.brand.code, r.brandId, card.brandCode);
  const brandName  = pickString(r.brandName, r.brand && r.brand.name, card.brandName);
  const partnerId  = pickString(r.partnerCode, r.partner && r.partner.code, r.partnerId);

  const lat = pickNumber(r.location && r.location.lat, r.lat, claim.area_lat);
  const lng = pickNumber(r.location && r.location.lng, r.lng, claim.area_lng);

  return {
    outlet_code:     outletCode,
    partner_id:      partnerId,
    brand_id:        brandId,
    brand_name:      brandName,
    brand_logo_url:  pickString(r.brandLogoUrl, r.brand && r.brand.logoUrl, card.brandLogoUrl),
    brand_image_url: pickString(r.brandImageUrl, r.brand && r.brand.imageUrl, card.brandImageUrl),

    name:            pickString(r.name, card.name, claim.name),
    restaurant_url:  pickString(r.pageUrl, r.url, card.pageUrl, claim.restaurant_url),
    logo_url:        pickString(r.logoUrl, r.imageUrl, card.imageUrl, card.logoUrl, claim.logo_url),
    menu_code:       pickString(r.menuCode, card.menuCode),

    address:         pickString(r.address, r.location && r.location.address, r.contact && r.contact.address),
    area_name:       pickString(r.areaName, r.location && r.location.areaName, r.area && r.area.name),
    latitude:        lat != null ? String(lat) : null,
    longitude:       lng != null ? String(lng) : null,
    zone_code:       pickString(r.zoneCode, r.zone && r.zone.code),
    city_code:       pickString(r.cityCode, r.city && r.city.code),

    price_tier:      pickString(r.priceTier, card.priceTier),
    oms_code:        pickString(r.omsCode, r.oms && r.oms.code),
    logistics_code:  pickString(r.logisticsCode, r.logistics && r.logistics.code),
    delivery_type:   pickString(r.deliveryType, r.delivery && r.delivery.type),
    self_pickup_enabled: !!(r.selfPickupEnabled || (r.selfPickup && r.selfPickup.enabled)),

    first_seen_area_id: claim.first_seen_area_id,
  };
}

// -- Main loop --------------------------------------------------------------
(async () => {
  if (typeof fetch !== 'function') { console.error('Node 18+ required'); process.exit(1); }
  const started = Date.now();
  const results = [];
  let calls = 0;

  // Live knobs from noon_registration_settings (Supabase). Env is the fallback.
  let callBudget = CALL_BUDGET;
  let delayMs    = DELAY_MS;
  try {
    const cb = await rpc('noon_registration_setting', { p_key: 'call_budget' });
    const dm = await rpc('noon_registration_setting', { p_key: 'delay_ms' });
    if (Number.isFinite(cb)) callBudget = cb;
    if (Number.isFinite(dm)) delayMs    = dm;
  } catch (_) { /* keep env fallback */ }

  if (JOB_INDEX > 0) await sleep(JOB_INDEX * START_STAGGER_MS);
  log(`Register job ${JOB_INDEX + 1}/${JOB_COUNT} | delay=${delayMs}ms | budget=${callBudget} calls (settings win over env)`);

  try {
    while (Date.now() - started < TIME_BUDGET_MS && calls < callBudget) {
      // p_limit is a fallback; the RPC reads claim_size from noon_registration_settings.
      const batch = await rpc('noon_registration_claim', { p_limit: CLAIM_SIZE });
      if (!batch || !batch.length) { log('queue empty – done'); break; }

      for (const q of batch) {
        if (calls >= callBudget) break;

        const t0 = Date.now();
        const res = {
          job: JOB_INDEX,
          outlet_code: q.noon_outlet_code,
          name: q.name,
          attempt: q.registration_attempts,
          status: null,
          detail: null,
          ms: 0,
        };
        try {
          const lat = Number(q.area_lat), lng = Number(q.area_lng);
          if (!isFinite(lat) || !isFinite(lng)) throw new Error('no area lat/lng in queue row');

          await ensureSession(lat, lng, 60_000);
          const payload = await fetchDetail(q.noon_outlet_code, lat, lng);
          calls++;

          const rec = buildRecord(q, payload);
          const out = await rpc('noon_register_branch', { p: rec });
          res.status = (out && out.skipped) ? 'skipped' : 'registered';
          res.detail = { ...out, name: rec.name };
        } catch (e) {
          res.status = 'failed';
          res.detail = e.message.slice(0, 300);
          try {
            res.queue_status = await rpc('noon_registration_fail', {
              p_outlet_code: q.noon_outlet_code, p_error: res.detail,
            });
          } catch (e2) { res.queue_status = `fail_rpc_error: ${e2.message.slice(0, 100)}`; }

          // Hard stop on IP-class failures: fresh runner needed
          if (e.rateLimited || e.forbidden) {
            res.ms = Date.now() - t0;
            results.push(res);
            log(`${res.status.padEnd(10)} ${(q.name || '').slice(0, 40).padEnd(40)} ${res.detail}`);
            log(`IP-class failure (${e.rateLimited ? '429' : '403'}) — stopping this job`);
            throw e;
          }
        }
        res.ms = Date.now() - t0;
        results.push(res);
        log(`${res.status.padEnd(10)} ${(q.name || '').slice(0, 40).padEnd(40)} ` +
          (res.status === 'registered'
            ? `areas+${res.detail.delivery_areas_added} rankings->${res.detail.rankings_moved} brand_new=${res.detail.brand_created}`
            : res.status === 'skipped'
              ? `reason=${res.detail.reason}`
              : `${res.detail} (queue: ${res.queue_status})`));
        await sleep(delayMs);
      }
    }
  } catch (e) {
    log(`stopping early: ${e.message}`);
  }

  log(`done | ${results.length} outlets processed | ${calls}/${callBudget} calls | ${tokenCount} tokens | ${Math.round((Date.now() - started) / 1000)}s`);
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(results, null, 1));
})().catch(e => {
  console.error('FATAL:', e.message || e);
  try { fs.writeFileSync(SUMMARY_FILE, JSON.stringify([{ job: JOB_INDEX, status: 'fatal', detail: String(e.message || e) }])); } catch (_) {}
  process.exit(1);
});
