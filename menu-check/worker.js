#!/usr/bin/env node
// menu-check/worker.js
//
// Menu-check worker. One GitHub Actions run = one "machine" in a Supabase
// menu_check_run. Supabase (menu_check_* functions) is the controller:
//   * menu_check_start / menu_check_stop are called by you.
//   * menu_check_tick (pg_cron, every minute) keeps the pool at its size,
//     marks silent machines lost and puts their restaurant back in the queue.
//
// This machine:
//   1. menu_check_machine_start      -> gets jobs_per_machine, delay, stop time
//   2. loop jobs_per_machine times:
//        menu_check_claim             -> one restaurant (platform + ids)
//        fetch its live menu from this runner's own IP
//        menu_check_report            -> SAVED IMMEDIATELY (stop-safe)
//   3. menu_check_machine_end        -> Supabase launches a fresh machine (fresh IP)
//
// Rules (same spirit as noon/uae/ranking-scrape.js):
//   * 429 / 403 from any app stops this machine immediately; the restaurant is
//     re-queued for a fresh machine on a fresh IP.
//   * If GitHub cancels the job (or you stop the run) the in-flight restaurant
//     is released back to the queue; everything already reported is kept.
//   * Noon: guest token minted on this runner's IP for the first outlet, then
//     re-bound to each next outlet's location (set-location + whoami-food).
//     Re-minted if older than 4 minutes (token lives ~5 minutes).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RUN_ID, MACHINE_NO, GITHUB_RUN_ID

'use strict';

const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUN_ID = Number(process.env.RUN_ID);
const MACHINE = Number(process.env.MACHINE_NO);
const GH_RUN_ID = process.env.GITHUB_RUN_ID || '';
if (!SUPABASE_URL || !SUPABASE_KEY || !RUN_ID || !MACHINE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RUN_ID / MACHINE_NO');
  process.exit(1);
}

const START_TIME = Date.now();
const WALL_LIMIT_MS = 12 * 60 * 1000;   // hard cap per machine
const HTTP_TIMEOUT_MS = 25_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[m${MACHINE}] ${msg}`);

// -- Supabase RPC ------------------------------------------------------------

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
        signal: AbortSignal.timeout(20_000),
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`rpc(${name}) ${resp.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (attempt >= 3) throw e;
      log(`rpc(${name}) attempt ${attempt} failed: ${e.message} - retrying`);
      await sleep(2_000 * attempt);
    }
  }
}

// -- HTTP helpers --------------------------------------------------------------

class HttpError extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
    this.blocked = status === 429 || status === 403;
  }
}

async function http(url, opts = {}) {
  const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (resp.status === 429 || resp.status === 403) {
    throw new HttpError(`${new URL(url).host} HTTP ${resp.status}`, resp.status);
  }
  return resp;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const DIRHAM_RE = //g;
const clean = (s) => (typeof s === 'string' ? s.replace(DIRHAM_RE, 'AED').trim() || null : null);

function dedupeItems(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const key = String(it.id ?? it.n);
    if (!it.n || seen.has(key)) continue;
    seen.add(key);
    out.push({ n: clean(it.n), p: num(it.p) });
  }
  return out;
}

// -- Talabat -------------------------------------------------------------------

async function fetchTalabat(item) {
  const resp = await http(`https://api.talabat.com/menubff/v4/branches/${item.call_id}/menu`, {
    headers: {
      // same headers as talabat/uae/register-branch.js (works from GitHub runners)
      'User-Agent': 'talabat/8701 CFNetwork/3896.100.1.2.1 Darwin/27.0.0',
      Accept: '*/*', 'Accept-Language': 'en-US', 'Accept-Encoding': 'gzip, deflate, br',
      appbrand: '1', 'x-country': 'ae',
      'x-app-version': '13.93.0', 'x-device-version': '13.93.0', 'x-device-source': '4',
      'x-device-framework': 'flutter', 'x-marshmallow-version': 'mm3', 'http2-enabled': 'true',
      tokentypekey: 'guest',
    },
  });
  if (!resp.ok) throw new HttpError(`talabat HTTP ${resp.status}`, resp.status);
  const b = await resp.json();
  const rest = b?.vendor?.result?.restaurant || {};
  const sections = (b?.menu?.result?.menu?.menuSection || []).filter((s) => Number(s.id) > 0);
  const items = [];
  for (const s of sections) for (const i of s.itm || []) items.push({ id: i.id, n: i.nm, p: i.pr });
  return {
    ok: true, name: clean(rest.bna || rest.na), area: clean(rest.an), address: null,
    categories: sections.length, items: dedupeItems(items),
  };
}

// -- Careem (existing guest token pool) ----------------------------------------

let careemTokens = null;
let careemIdx = 0;

function jwtSub(tok) {
  try {
    const p = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8')).sub || '';
  } catch (_) { return ''; }
}

async function fetchCareem(item) {
  if (!careemTokens) {
    careemTokens = (await rpc('menu_check_careem_tokens', {})) || [];
    careemIdx = MACHINE % Math.max(careemTokens.length, 1);
  }
  if (!careemTokens.length) throw new Error('no live Careem token in pool');
  const lat = String(item.lat ?? '25.1972');
  const lng = String(item.lng ?? '55.2744');
  let resp = null;
  for (let t = 0; t < Math.min(3, careemTokens.length); t++) {
    const tok = careemTokens[(careemIdx + t) % careemTokens.length];
    const sess = 'MENU-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    resp = await fetch(`https://apigateway.careemdash.com/v1/restaurants/${item.call_id}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        SESSION_ID: sess, 'X-Careem-Beta': 'false', 'User-Agent': 'ICMA/26.39.0', 'X-Careem-Agent': 'ICMA',
        'X-Careem-Session-Id': sess, Agent: 'ICMA', 'Time-Zone': 'Asia/Dubai', lat, lng,
        'x-careem-userid': jwtSub(tok), Version: '26.39.0', 'X-Careem-Version': '26.39.0',
        'x-careem-user-location': `${lat},${lng}`, 'x-careem-appengine-api-version': '2026-09-17',
        'X-Careem-Operating-System': 'iOS/27.0.1', Authorization: `Bearer ${tok}`,
        'x-careem-permissions': 'location:granted', 'Accept-Language': 'en',
        'x-careem-device-id': 'D0O8gpXoJdQ2L5lC', Accept: '*/*',
      },
    });
    if (resp.status === 429) throw new HttpError('careem HTTP 429', 429);
    if (resp.status !== 401 && resp.status !== 403) break;
    careemIdx = (careemIdx + 1) % careemTokens.length;   // token rejected -> next one
  }
  if (resp.status === 403) throw new HttpError('careem HTTP 403', 403);
  if (resp.status === 404) return { ok: false, unavailable: true, error: 'careem 404 (restaurant not found)' };
  if (!resp.ok) throw new HttpError(`careem HTTP ${resp.status}`, resp.status);
  const b = await resp.json();
  const groups = b?.menu?.groups || [];
  const items = [];
  for (const g of groups) for (const i of g.items || []) items.push({ id: i.id, n: i.item, p: i?.price?.total });
  return {
    ok: true, name: clean(b.name), area: clean(b.location), address: null,
    categories: groups.length, items: dedupeItems(items),
  };
}

// -- Deliveroo (menu page, nearest delivery areas) ------------------------------

async function fetchDeliveroo(item) {
  if (!item.page_url) return { ok: false, unavailable: true, error: 'no Deliveroo page URL' };
  const geos = (item.geohashes && item.geohashes.length) ? item.geohashes : [''];
  let lastNote = 'no menu on page';
  for (const gh of geos) {
    const url = gh ? `${item.page_url}?geohash=${gh}` : item.page_url;
    const resp = await http(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    if (resp.status === 404) return { ok: false, unavailable: true, error: 'deliveroo 404 (page gone)' };
    if (!resp.ok) throw new HttpError(`deliveroo HTTP ${resp.status}`, resp.status);
    const html = await resp.text();
    const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    if (!m) { lastNote = 'no page data'; continue; }
    let d;
    try { d = JSON.parse(m[1]); } catch (_) { lastNote = 'page data unreadable'; continue; }
    const menu = d?.props?.initialState?.menuPage?.menu || {};
    const meta = menu?.metas?.root;
    if (!meta) { lastNote = 'no menu on page'; continue; }
    if (meta?.restaurant?.menuDisabled) { lastNote = 'not delivering to nearest areas (offline or out of range)'; continue; }
    const cats = meta.categories || [];
    if (!cats.length) { lastNote = 'menu has no categories'; continue; }
    const catIds = new Set(cats.map((c) => c.id));
    const items = (meta.items || [])
      .filter((x) => catIds.has(x.categoryId))
      .map((x) => ({ id: x.id, n: x.name, p: x?.price?.fractional != null ? x.price.fractional / 100 : null }));
    const rest = meta.restaurant || {};
    const title = (menu?.header?.title || '').trim();
    return {
      ok: true, name: clean(title || rest.name), area: clean(rest?.location?.address?.neighborhood),
      address: clean(rest?.location?.address?.address1), categories: cats.length, items: dedupeItems(items),
    };
  }
  return { ok: false, unavailable: true, error: `deliveroo: ${lastNote}` };
}

// -- Noon (token minted on this runner's IP) ------------------------------------

const NOON_UA = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const NOON_BUILD = '22098';
const NOON_WHOAMI = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami';
const NOON_SET_LOCATION = 'https://api-app.noon.com/_vs/st/mp-identity-api-geo/serviceable-geo-info/set-location-by-lat-lng';
const NOON_WHOAMI_FOOD = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami?experience=food&select_nearby=1';
const NOON_DETAILS = 'https://api-app-fd.noon.com/_svc/mp-food-api-mpnoon/consumer/restaurant/outlet/details/guest/partial';
const NOON_TOKEN_MAX_AGE_MS = 4 * 60 * 1000;

let noon = null;   // { deviceId, visitorId, jar, zones, mintedAt }
let noonTokens = 0;

function mergeSetCookies(jar, resp) {
  const list = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const c of list) {
    const m = /^([^=]+)=([^;]+)/.exec(c);
    if (m) jar[m[1]] = m[2];
  }
}
const cookieStr = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

function noonBase(s) {
  return {
    'User-Agent': NOON_UA, 'x-platform': 'ios', 'x-build': NOON_BUILD, 'x-mp': 'noon',
    'x-content': 'mobile', Accept: 'application/json', 'x-device-id': s.deviceId, 'x-visitor-id': s.visitorId,
  };
}

// set-location + whoami-food: binds the session (and its cookies/zone headers) to lat/lng
async function noonLocate(s, lat, lng) {
  const loc = { 'x-experience': 'ecom', 'x-locale': 'en-ae', 'x-device-lat': String(lat), 'x-device-lng': String(lng) };
  const r2 = await http(NOON_SET_LOCATION, {
    method: 'POST',
    headers: { ...noonBase(s), ...loc, 'Content-Type': 'application/json', Cookie: cookieStr(s.jar) },
    body: JSON.stringify({ location: { lat, lng }, lang: 'en' }),
  });
  if (!r2.ok) throw new HttpError(`noon set-location HTTP ${r2.status}`, r2.status);
  mergeSetCookies(s.jar, r2);
  const r3 = await http(NOON_WHOAMI_FOOD, {
    headers: { ...noonBase(s), ...loc, 'x-whoami-request-id': crypto.randomUUID(), Cookie: cookieStr(s.jar) },
  });
  if (!r3.ok) throw new HttpError(`noon whoami-food HTTP ${r3.status}`, r3.status);
  const who = await r3.json().catch(() => ({}));
  mergeSetCookies(s.jar, r3);
  s.zones = who && who.headers && typeof who.headers === 'object' ? who.headers : {};
}

async function noonSession(lat, lng) {
  if (noon && Date.now() - noon.mintedAt < NOON_TOKEN_MAX_AGE_MS) {
    await noonLocate(noon, lat, lng);
    return noon;
  }
  const s = { deviceId: crypto.randomUUID(), visitorId: crypto.randomUUID(), jar: {}, zones: {}, mintedAt: Date.now() };
  const r1 = await http(NOON_WHOAMI, {
    headers: { ...noonBase(s), 'x-experience': 'ecom', 'x-whoami-request-id': crypto.randomUUID() },
  });
  if (!r1.ok) throw new HttpError(`noon whoami HTTP ${r1.status}`, r1.status);
  mergeSetCookies(s.jar, r1);
  await noonLocate(s, lat, lng);
  if (!s.jar.nguestv2) throw new Error('noon mint produced no nguestv2');
  noon = s;
  noonTokens++;
  log(`noon token #${noonTokens} zone=${s.zones['x-food-zonecode'] || '-'}`);
  return s;
}

async function fetchNoon(item) {
  const lat = item.lat ?? 25.0780582;
  const lng = item.lng ?? 55.1533782;
  const s = await noonSession(lat, lng);
  const h = {
    ...noonBase(s), 'x-locale': 'en-ae', 'x-mp-country': 'ae', 'x-experience': 'food',
    'x-device-lat': String(lat), 'x-device-lng': String(lng),
    'x-lat': String(Math.round(lat * 1e7)), 'x-lng': String(Math.round(lng * 1e7)),
    'x-whoami-request-id': crypto.randomUUID(), Cookie: cookieStr(s.jar), 'Content-Type': 'application/json',
  };
  for (const [k, v] of Object.entries(s.zones || {})) {
    if (v == null || typeof v !== 'string' || k.toLowerCase().includes('ab-test') || v.startsWith('{') || v.startsWith('[')) continue;
    h[k] = v;
  }
  const resp = await http(NOON_DETAILS, {
    method: 'POST', headers: h,
    body: JSON.stringify({ outletCode: item.call_id, lat: Math.round(lat * 1e7), lng: Math.round(lng * 1e7) }),
  });
  if (resp.status === 404) return { ok: false, unavailable: true, error: 'noon 404 (outlet not found)' };
  if (!resp.ok) throw new HttpError(`noon details HTTP ${resp.status}`, resp.status);
  const d = (await resp.json())?.data || {};
  const menu = d.menu || {};
  const byCode = new Map((menu.items || []).map((x) => [x.itemCode, x]));
  const cats = (menu.categories || []).filter((c) =>
    (c.isActive ?? true) && Number(c.position ?? 0) >= 0 && !['trending', 'discounted_items'].includes(c.categoryType || ''));
  const items = [];
  for (const c of cats) {
    for (const code of c.items || []) {
      const it = byCode.get(code);
      if (it && it.itemType === 'main') items.push({ id: code, n: it.name, p: it.discountPrice ?? it.price });
    }
  }
  const addr = typeof d.address === 'string' ? d.address : (d.address && (d.address.line1 || d.address.area)) || null;
  return {
    ok: true, name: clean(d.name), area: clean(d.cityName), address: clean(addr),
    categories: cats.length, items: dedupeItems(items),
  };
}

const FETCH = { talabat: fetchTalabat, careem: fetchCareem, deliveroo: fetchDeliveroo, noon: fetchNoon };

// -- Stop handling: release the in-flight restaurant if GitHub cancels us ------

let current = null;
let ending = false;

async function endMachine(reason) {
  if (ending) return null;
  ending = true;
  try {
    return await rpc('menu_check_machine_end', { p_run_id: RUN_ID, p_machine_no: MACHINE, p_reason: reason });
  } catch (e) {
    log(`machine_end failed: ${e.message} (the supervisor will release anything left)`);
    return null;
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(`${sig} received${current ? ` while on ${current.platform} ${current.branch_id}` : ''} - releasing and exiting`);
    await endMachine(`cancelled (${sig})`);
    process.exit(0);
  });
}

// -- Main ----------------------------------------------------------------------

(async () => {
  log(`starting | run=${RUN_ID} | gh=${GH_RUN_ID}`);
  const st = await rpc('menu_check_machine_start', { p_run_id: RUN_ID, p_machine_no: MACHINE, p_gh_run_id: GH_RUN_ID });
  if (!st || st.stop) {
    log(`told to stop before starting: ${st && st.reason}`);
    await endMachine(`not started: ${st && st.reason}`);
    return;
  }
  const jobs = Number(st.jobs_per_machine) || 5;
  const delayMs = Number(st.item_delay_ms) || 1000;
  const stopAt = Date.parse(st.stop_at) || (START_TIME + WALL_LIMIT_MS);
  log(`jobs=${jobs} delay=${delayMs}ms stop_at=${new Date(stopAt).toISOString()}`);

  let exitReason = 'job quota reached';
  let done = 0;
  for (let j = 0; j < jobs; j++) {
    if (Date.now() >= stopAt) { exitReason = 'stop time'; break; }
    if (Date.now() - START_TIME > WALL_LIMIT_MS) { exitReason = 'wall limit'; break; }

    const item = await rpc('menu_check_claim', { p_run_id: RUN_ID, p_machine_no: MACHINE });
    if (!item || item.stop) { exitReason = (item && item.reason) || 'nothing to claim'; break; }
    current = item;

    const t0 = Date.now();
    let status, result = null, error = null, httpStatus = null;
    try {
      const fetcher = FETCH[item.platform];
      if (!fetcher) throw new Error(`unknown platform ${item.platform}`);
      result = await fetcher(item);
      status = result.ok ? 'done' : 'unavailable';
      error = result.error || null;
    } catch (e) {
      status = e.blocked ? 'blocked' : 'error';
      error = e.message.slice(0, 500);
      httpStatus = e.status || null;
    }
    const elapsed = Date.now() - t0;

    const rep = await rpc('menu_check_report', {
      p_run_id: RUN_ID, p_machine_no: MACHINE, p_platform: item.platform, p_branch_id: item.branch_id,
      p_status: status, p_result: result, p_error: error, p_http_status: httpStatus, p_elapsed_ms: elapsed,
    });
    current = null;
    done++;
    log(`${item.platform} ${item.branch_id} (${item.name || '-'}): ${status}` +
        `${result && result.items ? `, ${result.items.length} items` : ''}${error ? ` | ${error}` : ''} | ${elapsed}ms -> ${rep && rep.queue_status}`);

    if (status === 'blocked' || (rep && rep.action === 'stop')) { exitReason = 'blocked (429/403)'; break; }
    if (j < jobs - 1) await sleep(delayMs);
  }

  const end = await endMachine(exitReason);
  log(`=== done: ${done} restaurant(s), noon tokens=${noonTokens}, ${Math.round((Date.now() - START_TIME) / 1000)}s, exit="${exitReason}", end=${JSON.stringify(end)}`);
})().catch(async (e) => {
  console.error(`[m${MACHINE}] FATAL: ${e.message}`);
  await endMachine(`fatal: ${String(e.message).slice(0, 200)}`);
  process.exit(1);
});
