// noon/uae/ranking-sample.js
//
// Noon UAE — Ranking SAMPLE worker (one GitHub Actions job per machine).
//
// Supabase is the brain: it holds the area queue, dispatches this workflow and
// decides on replacements. This worker only: machine_start -> claim area ->
// mint its own token -> walk the whole area listing in scroll order -> fetch
// the admon ad carousel -> save -> repeat.
//
// The listing card is sent up untouched in `c`; extraction lives in
// noon_sample_save() so there is one place to change it.
//
// The auth chain, header builder and listing call below are lifted verbatim
// from noon/uae/queue-worker.js, which has run a full 26,564-branch scrape.
// Do not retype these URLs from memory - they span three different hosts.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RUN_ID, MACHINE_NO
//      PAGE_DELAY_MS (default 1000), WALL_LIMIT_SEC (default 6600)

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUN_ID        = parseInt(process.env.RUN_ID || '0', 10);
const MACHINE_NO    = parseInt(process.env.MACHINE_NO || '0', 10);
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID || '';
const PAGE_DELAY_MS = parseInt(process.env.PAGE_DELAY_MS || '1000', 10);
const WALL_LIMIT_SEC = parseInt(process.env.WALL_LIMIT_SEC || '6600', 10);

const UA    = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const BUILD = '22098';
const WHOAMI_URL       = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami';
const SET_LOCATION_URL = 'https://api-app.noon.com/_vs/st/mp-identity-api-geo/serviceable-geo-info/set-location-by-lat-lng';
const WHOAMI_FOOD_URL  = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami?experience=food&select_nearby=1';
const SEARCH_URL       = 'https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/search';
const ADMON_URL        = 'https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/admon/content-ad/banner-carousel'
                       + '?entity_type=food_banner_module&entity_code=homepage_hero_banner_ads_carousel_ae'
                       + '&limit=20&min_assets=2';

const PAGE_LIMIT      = 60;
const PAGE_SAFETY_CAP = 120;     // a 3,000-outlet area is ~50 pages
const CHUNK           = 400;     // listing rows per save call
const TOKEN_LIFE_MS   = 240000;  // remint at 4 min; noon's token lives 5

if (!SUPABASE_URL || !SUPABASE_KEY || !RUN_ID || !MACHINE_NO) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RUN_ID / MACHINE_NO');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(fn, body) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`RPC ${fn} ${resp.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ── Proven blocks, copied from queue-worker.js ──────────────────────────────
function mergeSetCookies(jar, resp) {
  const list = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const c of list) {
    const m = /^([^=]+)=([^;]+)/.exec(c);
    if (m) jar[m[1]] = m[2];
  }
}

const cookieString = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

function decodeJwt(jwt) {
  try {
    const seg = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(Buffer.from(seg + '='.repeat((4 - (seg.length % 4)) % 4), 'base64').toString('utf8'));
    return { exp: p.exp ? new Date(p.exp * 1000).toISOString() : null, kid: p.kid || null };
  } catch { return { exp: null, kid: null }; }
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
// ── Sample-specific ─────────────────────────────────────────────────────────

// Build the `loc` shape listingPage() expects from a freshly minted session.
function locFrom(session, lat, lng) {
  return { session, lat, lng, cookie: session.cookie_string, zoneHeaders: session.zone_codes || {} };
}

// listingPage() flattens outlets out of the whole tree. For ranking we also
// need the widget modules, which sit beside the cards in `results`.
async function listingPageWithModules(loc, token) {
  const r = await listingPage(loc, token);
  return r;
}

async function fetchAds(loc) {
  const headers = {
    ...baseHeaders(loc.session, loc.lat, loc.lng),
    'x-mp-country': 'ae', 'x-experience': 'food',
    'x-lat': String(Math.round(loc.lat * 1e7)),
    'x-lng': String(Math.round(loc.lng * 1e7)),
    'x-border-enabled': 'true', 'x-rocket-enabled': 'true',
    'x-whoami-request-id': crypto.randomUUID(),
    Cookie: loc.cookie,
  };
  for (const [k, v] of Object.entries(loc.zoneHeaders)) {
    if (v !== null && typeof v !== 'object' && !k.toLowerCase().includes('ab-test')) headers[k] = String(v);
  }
  const resp = await fetch(ADMON_URL, { headers });
  if (resp.status === 429) throw Object.assign(new Error('admon 429'), { rateLimited: true });
  if (resp.status === 403) throw Object.assign(new Error('admon 403'), { forbidden: true });
  if (!resp.ok) return [];
  const json = await resp.json().catch(() => ({}));
  return (json.data || []).map((d, slot) => ({ slot, d }));
}

// The widget modules live in results[] alongside the cards; grab them from a
// raw first-page call so the campaign/banner layer is captured once per area.
async function firstPageModules(loc) {
  const headers = {
    ...baseHeaders(loc.session, loc.lat, loc.lng),
    'x-mp-country': 'ae', 'x-experience': 'food',
    'x-lat': String(Math.round(loc.lat * 1e7)),
    'x-lng': String(Math.round(loc.lng * 1e7)),
    'x-border-enabled': 'true', 'x-rocket-enabled': 'true',
    'x-whoami-request-id': crypto.randomUUID(),
    Cookie: loc.cookie, 'Content-Type': 'application/json',
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
  const resp = await fetch(SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!resp.ok) return [];
  const json = await resp.json().catch(() => ({}));
  const mods = [];
  (Array.isArray(json.results) ? json.results : []).forEach((el, idx) => {
    if (el && Array.isArray(el.modules)) for (const mod of el.modules) mods.push({ idx, mod });
  });
  return mods;
}

async function processArea(area) {
  const lat = area.latitude, lng = area.longitude;
  let session = await mintSessionLocal(lat, lng);
  let loc = locFrom(session, lat, lng);

  // campaign / banner layer, once per area
  const mods = await firstPageModules(loc);
  if (mods.length) {
    await rpc('noon_sample_save', {
      p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_area_id: area.noon_area_id,
      p_rows: [], p_widgets: mods, p_ads: [], p_final: false,
    });
  }

  const seen = new Set();
  let rank = 0, page = 0, token = null, stop = 'page cap';
  let buffer = [];

  const flush = async () => {
    if (!buffer.length) return;
    await rpc('noon_sample_save', {
      p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_area_id: area.noon_area_id,
      p_rows: buffer, p_widgets: [], p_ads: [], p_final: false,
    });
    buffer = [];
  };

  while (page < PAGE_SAFETY_CAP) {
    if (Date.now() - session.mintedAt > TOKEN_LIFE_MS) {
      session = await mintSessionLocal(lat, lng);
      loc = locFrom(session, lat, lng);
    }
    page++;
    const r = await listingPage(loc, token);

    let fresh = 0;
    for (const c of r.outlets) {
      if (!c.outletCode || seen.has(c.outletCode)) continue;
      seen.add(c.outletCode);
      rank++; fresh++;
      buffer.push({ r: rank, p: page, n: 1, c });
    }
    if (buffer.length >= CHUNK) await flush();

    if (r.outlets.length === 0) { stop = `empty page ${page}`; break; }
    if (fresh === 0)            { stop = `no new outlets at page ${page}`; break; }
    if (!r.token)               { stop = `no searchToken at page ${page}`; break; }
    token = r.token;
    await sleep(PAGE_DELAY_MS);
  }
  await flush();

  const ads = await fetchAds(loc);
  await rpc('noon_sample_save', {
    p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_area_id: area.noon_area_id,
    p_rows: [], p_widgets: [], p_ads: ads, p_final: true, p_pages: page,
  });
  return { outlets: seen.size, pages: page, ads: ads.length, modules: mods.length, stop };
}

(async () => {
  if (typeof fetch !== 'function') throw new Error('Node 18+ required');
  const ip = await fetch('https://api.ipify.org').then((r) => r.text()).catch(() => 'unknown');
  console.log(`[m${MACHINE_NO}] run=${RUN_ID} ip=${ip}`);

  const start = await rpc('noon_sample_machine_start', {
    p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_ip: ip, p_gh: GITHUB_RUN_ID,
  });
  if (start.action === 'stop_job') { console.log(`stopping: ${start.reason}`); return; }

  const t0 = Date.now();
  let endReason = 'finished';

  while (true) {
    if ((Date.now() - t0) / 1000 > WALL_LIMIT_SEC) { endReason = 'wall limit'; break; }

    const claim = await rpc('noon_sample_claim', { p_run_id: RUN_ID, p_machine_no: MACHINE_NO });
    if (claim.done) { endReason = claim.reason; break; }
    const area = claim.area;
    console.log(`[m${MACHINE_NO}] area ${area.noon_area_id} ${area.area_name} ...`);

    try {
      const out = await processArea(area);
      console.log(`[m${MACHINE_NO}] area ${area.noon_area_id} done | ${out.outlets} outlets over ${out.pages} pages | ${out.ads} ads | ${out.modules} modules | ${out.stop}`);
    } catch (e) {
      const kind = e.rateLimited ? 'rate_limited' : e.forbidden ? 'blocked' : 'error';
      console.log(`[m${MACHINE_NO}] area ${area.noon_area_id} ${kind}: ${e.message}`);
      if (kind === 'error') {
        await rpc('noon_sample_save', {
          p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_area_id: area.noon_area_id,
          p_rows: [], p_widgets: [], p_ads: [], p_final: true, p_error: e.message.slice(0, 300),
        });
        continue;
      }
      // 429/403: this IP is spent. Hand the area back and retire so Supabase
      // dispatches a replacement on a fresh runner IP.
      endReason = kind; break;
    }
  }

  const rep = await rpc('noon_sample_machine_end', {
    p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_reason: endReason,
  });
  console.log(`[m${MACHINE_NO}] ended: ${endReason} | ${JSON.stringify(rep)}`);
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
