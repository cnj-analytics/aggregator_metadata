#!/usr/bin/env node
'use strict';

// noon/uae/detail-sample.js
//
// Field-discovery scrape of the Noon restaurant PAGE (outlet detail) for the
// ~100 sampled branches in noon_restaurant_detail_sample, to enumerate what
// the page exposes before the real branch/brand tables are designed.
//
// TOKENS ARE MINTED HERE, ON THE RUNNER. Supabase is used only for the queue
// and the writes. Reasons:
//   * Supabase has ONE static egress IP (15.134.11.117) and it cannot be
//     rotated. Minting 778 times in a day pushed it to a 66% failure rate
//     (DNS/SSL timeouts from the http extension) and that is what abandoned
//     9 areas at the end of the listing run.
//   * A token minted by one IP and presented from another is a mismatch a
//     real device would never produce. Minting where we scrape removes it.
//   * It costs almost nothing: the mint chain's set-location + whoami-food
//     are the same two calls the old locate() already made per area, so the
//     runner spends ~2 calls per unit of work either way, plus one
//     whoami-ecom per session.
//
// Budget: the food endpoints allow ~130 calls per runner IP (measured: a 33%
// delay change moved machine lifetime 19% and total calls 0.3%). This run is
// 1 whoami-ecom + 2 locate + 100 details ~= 103 calls. One machine, one token.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DELAY_MS     = Number(process.env.DELAY_MS || 1000);
const LIMIT        = Number(process.env.SAMPLE_LIMIT || 200);
const CALL_BUDGET  = Number(process.env.CALL_BUDGET || 120);

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const UA    = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const BUILD = '22098';
const WHOAMI_URL      = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami';
const WHOAMI_FOOD_URL = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami?experience=food&select_nearby=1';
const SET_LOCATION_URL =
  'https://api-app.noon.com/_vs/st/mp-identity-api-geo/serviceable-geo-info/set-location-by-lat-lng';
const DETAIL_URL =
  'https://api-app-fd.noon.com/_svc/mp-food-api-mpnoon/consumer/restaurant/outlet/details/guest/partial';

const TOKEN_LIFETIME_MS = 300000;   // nguestv2 carries a fixed 300s exp
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Supabase: queue reads and result writes only ───────────────────────────
async function supabase(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${path} HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ── cookie jar ─────────────────────────────────────────────────────────────
function mergeSetCookies(jar, resp) {
  const list = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const c of list) {
    const m = /^([^=]+)=([^;]+)/.exec(c);
    if (m) jar[m[1]] = m[2];
  }
}
const cookieString = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

function decodeJwtExp(jwt) {
  try {
    const seg = String(jwt).split('.')[1];
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
    return {
      exp: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      kid: payload.kid || null,
    };
  } catch {
    return { exp: null, kid: null };
  }
}

class MintError extends Error {
  constructor(msg, status) { super(msg); this.mintFailed = true; this.status = status || 0; }
}

// A guest session, minted entirely from this runner's IP.
// Replicates the 3-step chain Noon's app performs:
//   whoami(ecom) -> set-location-by-lat-lng -> whoami(experience=food)
async function mintSession(lat, lng) {
  const deviceId  = crypto.randomUUID();
  const visitorId = crypto.randomUUID();
  const jar = {};

  const base = () => ({
    'User-Agent': UA,
    'x-platform': 'ios',
    'x-build': BUILD,
    'x-mp': 'noon',
    'x-content': 'mobile',
    Accept: 'application/json',
    'x-device-id': deviceId,
    'x-visitor-id': visitorId,
  });

  // 1. whoami (ecom) — establishes the guest identity and first cookies
  const r1 = await fetch(WHOAMI_URL, {
    headers: { ...base(), 'x-experience': 'ecom', 'x-whoami-request-id': crypto.randomUUID() },
  });
  if (r1.status !== 200) throw new MintError(`whoami ecom HTTP ${r1.status}`, r1.status);
  mergeSetCookies(jar, r1);

  // 2. set location — resolves the point to a serviceable area
  const r2 = await fetch(SET_LOCATION_URL, {
    method: 'POST',
    headers: {
      ...base(),
      'x-experience': 'ecom',
      'x-locale': 'en-ae',
      'x-device-lat': String(lat),
      'x-device-lng': String(lng),
      'Content-Type': 'application/json',
      Cookie: cookieString(jar),
    },
    body: JSON.stringify({ location: { lat, lng }, lang: 'en' }),
  });
  if (r2.status !== 200) throw new MintError(`set-location HTTP ${r2.status}`, r2.status);
  const setloc = await r2.json().catch(() => ({}));
  mergeSetCookies(jar, r2);

  // 3. whoami (food) — returns the zone headers the food API expects back
  const r3 = await fetch(WHOAMI_FOOD_URL, {
    headers: {
      ...base(),
      'x-experience': 'ecom',
      'x-locale': 'en-ae',
      'x-device-lat': String(lat),
      'x-device-lng': String(lng),
      'x-whoami-request-id': crypto.randomUUID(),
      Cookie: cookieString(jar),
    },
  });
  if (r3.status !== 200) throw new MintError(`whoami food HTTP ${r3.status}`, r3.status);
  const who = await r3.json().catch(() => ({}));
  mergeSetCookies(jar, r3);

  const zoneHeaders = who && who.headers && typeof who.headers === 'object' ? who.headers : {};
  const { exp, kid } = decodeJwtExp(jar.nguestv2 || '');

  if (!jar.nguestv2) throw new MintError('no nguestv2 cookie returned', 0);

  return {
    device_id: deviceId,
    visitor_id: visitorId,
    cookie_string: cookieString(jar),
    zone_codes: zoneHeaders,
    food_zonecode: zoneHeaders['x-food-zonecode'] || null,
    resolved_area: setloc.area || null,
    nguestv2_exp: exp,
    nguestv2_kid: kid,
    mintedAt: Date.now(),
  };
}

function remainingMs(session) {
  if (!session) return 0;
  const byExp = session.nguestv2_exp ? Date.parse(session.nguestv2_exp) - Date.now() : Infinity;
  const byAge = session.mintedAt + TOKEN_LIFETIME_MS - Date.now();
  return Math.max(0, Math.min(byExp, byAge));
}

function detailHeaders(session, lat, lng) {
  const h = {
    'User-Agent': UA,
    'x-platform': 'ios',
    'x-build': BUILD,
    'x-mp': 'noon',
    'x-content': 'mobile',
    'x-locale': 'en-ae',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-device-id': session.device_id,
    'x-visitor-id': session.visitor_id,
    'x-mp-country': 'ae',
    'x-experience': 'food',
    'x-device-lat': String(lat),
    'x-device-lng': String(lng),
    'x-lat': String(Math.round(lat * 1e7)),
    'x-lng': String(Math.round(lng * 1e7)),
    'x-whoami-request-id': crypto.randomUUID(),
    Cookie: session.cookie_string,
  };
  for (const [k, v] of Object.entries(session.zone_codes || {})) {
    if (v !== null && typeof v !== 'object' && !k.toLowerCase().includes('ab-test')) h[k] = String(v);
  }
  return h;
}

async function fetchDetail(session, outlet, lat, lng) {
  const started = Date.now();
  const resp = await fetch(DETAIL_URL, {
    method: 'POST',
    headers: detailHeaders(session, lat, lng),
    body: JSON.stringify({
      outletCode: outlet,
      lat: Math.round(lat * 1e7),
      lng: Math.round(lng * 1e7),
    }),
  });
  const elapsed = Date.now() - started;
  const text = await resp.text();
  let payload = null;
  if (resp.status === 200) { try { payload = JSON.parse(text); } catch { payload = null; } }
  return { status: resp.status, payload, elapsed, body: text.slice(0, 300) };
}

(async () => {
  console.log(`[detail-sample] delay=${DELAY_MS}ms call_budget=${CALL_BUDGET} (minting on this runner)`);
  try {
    const ip = await (await fetch('https://api.ipify.org')).text();
    console.log(`[detail-sample] runner IP ${ip}`);
  } catch { /* not important */ }

  const pending = await supabase('/rpc/noon_detail_sample_pending', {
    method: 'POST', body: { p_limit: LIMIT },
  });
  console.log(`[detail-sample] ${pending.length} outlets to fetch`);
  if (!pending.length) { console.log('nothing to do'); return; }

  let calls = 0, mints = 0, mintFails = 0;
  let session = null;

  // A mint failure is an IP-class problem, not an item problem: abort the run
  // so the job can be re-dispatched onto a fresh runner. Never mark an outlet
  // failed because the session could not be built — that is what abandoned 9
  // areas in the listing run.
  async function ensureSession(lat, lng, needMs) {
    if (session && remainingMs(session) >= needMs) return session;
    try {
      session = await mintSession(lat, lng);
      mints++; calls += 3;
      console.log(
        `[detail-sample] minted token #${mints} | device=${session.device_id} ` +
        `| zone=${session.food_zonecode} | exp=${session.nguestv2_exp}`
      );
      return session;
    } catch (e) {
      mintFails++;
      throw e;
    }
  }

  let ok = 0, failed = 0, stopped = null;

  try {
    await ensureSession(pending[0].probe_lat, pending[0].probe_lng, 60000);
  } catch (e) {
    console.error(`[detail-sample] could not mint on this IP: ${e.message}`);
    console.error('[detail-sample] this is an IP-class failure — re-run to get a fresh runner');
    process.exit(78);
  }

  for (let i = 0; i < pending.length; i++) {
    const it = pending[i];
    if (calls >= CALL_BUDGET) { stopped = `call budget ${CALL_BUDGET} reached at item ${i + 1}`; break; }

    // keep enough life for the rest of the list, capped at one token's worth
    const needMs = Math.min(TOKEN_LIFETIME_MS - 25000, (pending.length - i) * (DELAY_MS + 1200));
    try {
      await ensureSession(it.probe_lat, it.probe_lng, Math.max(needMs, 30000));
    } catch (e) {
      stopped = `mint failed mid-run after ${calls} calls: ${e.message}`;
      break;                       // leave remaining outlets untouched for a re-run
    }

    let r;
    try {
      r = await fetchDetail(session, it.noon_outlet_code, it.probe_lat, it.probe_lng);
    } catch (e) {
      r = { status: 0, payload: null, elapsed: null, body: e.message };
    }
    calls++;

    if (r.status === 429 || r.status === 403) {
      stopped = `HTTP ${r.status} after ${calls} calls — IP budget reached`;
      break;                       // do NOT record: the outlet is fine, the IP is not
    }

    await supabase('/rpc/noon_detail_sample_record', {
      method: 'POST',
      body: {
        p_outlet: it.noon_outlet_code,
        p_http: r.status,
        p_payload: r.status === 200 ? r.payload : null,
        p_error: r.status === 200 ? null : `HTTP ${r.status}: ${r.body}`,
        p_elapsed_ms: r.elapsed,
      },
    });

    if (r.status === 200) {
      ok++;
      const d = (r.payload && r.payload.data) || {};
      const menu = d.menu || {};
      console.log(
        `[${String(i + 1).padStart(3)}/${pending.length}] ${it.noon_outlet_code} ${it.sample_stratum} ` +
        `"${d.name || '?'}" items=${Array.isArray(menu.items) ? menu.items.length : '-'} ` +
        `cats=${Array.isArray(menu.categories) ? menu.categories.length : '-'} ` +
        `oms=${d.externalOmsCode || '-'} ${r.elapsed}ms`
      );
    } else {
      failed++;
      console.log(`[${i + 1}/${pending.length}] ${it.noon_outlet_code} HTTP ${r.status} ${r.body}`);
    }

    await sleep(DELAY_MS);
  }

  console.log('--- detail sample done ---');
  console.log(`  ok          : ${ok}`);
  console.log(`  failed      : ${failed}`);
  console.log(`  calls used  : ${calls}`);
  console.log(`  mints       : ${mints} (failures ${mintFails})`);
  if (stopped) console.log(`  stopped     : ${stopped}`);
  console.log('  re-run this workflow to continue any outlets left unfetched.');
  if (ok === 0) process.exit(1);
})().catch((e) => {
  console.error(`[detail-sample] fatal: ${e.stack || e.message}`);
  process.exit(1);
});
