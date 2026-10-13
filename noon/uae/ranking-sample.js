// noon/uae/ranking-sample.js
//
// Noon UAE — Ranking SAMPLE worker (one GitHub Actions job per machine).
//
// Supabase is the brain: it holds the queue and dispatches this workflow.
// This worker only: machine_start -> claim area -> mint its own token ->
// walk the whole area listing -> fetch the admon ad carousel -> save -> repeat.
//
// Everything the listing card carries is sent up untouched in `c`; the
// extraction lives in noon_sample_save() so there is one place to change it.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RUN_ID, MACHINE_NO
//      PAGE_DELAY_MS (default 1000), WALL_LIMIT_SEC (default 18000)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUN_ID       = parseInt(process.env.RUN_ID || '0', 10);
const MACHINE_NO   = parseInt(process.env.MACHINE_NO || '0', 10);
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID || '';
const PAGE_DELAY_MS = parseInt(process.env.PAGE_DELAY_MS || '1000', 10);
const WALL_LIMIT_SEC = parseInt(process.env.WALL_LIMIT_SEC || '18000', 10);

const PAGE_LIMIT     = 60;
const PAGE_SAFETY_CAP = 120;        // a 3,000-outlet area is ~50 pages
const CHUNK           = 400;        // rows per save call
const TOKEN_LIFE_MS   = 240000;     // remint at 4 min; noon's token lives 5

if (!SUPABASE_URL || !SUPABASE_KEY || !RUN_ID || !MACHINE_NO) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RUN_ID / MACHINE_NO');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA    = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const BUILD = '22098';

const SEARCH_URL = 'https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/search';
const ADMON_URL  = 'https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/admon/content-ad/banner-carousel'
                 + '?entity_type=food_banner_module&entity_code=homepage_hero_banner_ads_carousel_ae'
                 + '&limit=20&min_assets=2';
const WHOAMI = 'https://api-app-fd.noon.com/_svc/mp-food-whoami-mpnoon/whoami';
const SETLOC = 'https://api-app-fd.noon.com/_svc/mp-food-whoami-mpnoon/set-location-by-lat-lng';

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

function cookieString(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
function collectCookies(resp, jar) {
  const raw = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

// Three-step guest auth. nguestv2 is issued by step 1; steps 2 and 3 attach
// the location and hand back the zone headers noon expects echoed back.
async function mintSession(lat, lng) {
  const jar = {};
  const deviceId  = crypto.randomUUID();
  const visitorId = crypto.randomUUID();
  const base = {
    'User-Agent': UA, 'x-platform': 'ios', 'x-build': BUILD, 'x-mp': 'noon',
    'x-content': 'mobile', 'x-locale': 'en-ae', Accept: 'application/json',
    'x-device-id': deviceId, 'x-visitor-id': visitorId,
    'x-device-lat': String(lat), 'x-device-lng': String(lng),
    'x-mp-country': 'ae',
    'x-lat': String(Math.round(lat * 1e7)), 'x-lng': String(Math.round(lng * 1e7)),
    'x-border-enabled': 'true', 'x-rocket-enabled': 'true',
  };

  let r = await fetch(`${WHOAMI}?x-experience=ecom`, { headers: { ...base, 'x-whoami-request-id': crypto.randomUUID() } });
  if (!r.ok) throw new Error(`whoami1 ${r.status}`);
  collectCookies(r, jar);

  r = await fetch(SETLOC, {
    method: 'POST',
    headers: { ...base, 'x-experience': 'food', 'x-whoami-request-id': crypto.randomUUID(),
               Cookie: cookieString(jar), 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: Math.round(lat * 1e7), lng: Math.round(lng * 1e7) }),
  });
  collectCookies(r, jar);

  r = await fetch(`${WHOAMI}?experience=food&select_nearby=1`, {
    headers: { ...base, 'x-experience': 'food', 'x-whoami-request-id': crypto.randomUUID(), Cookie: cookieString(jar) },
  });
  if (!r.ok) throw new Error(`whoami3 ${r.status}`);
  collectCookies(r, jar);

  const zone = {};
  for (const [k, v] of r.headers.entries()) {
    if (k.toLowerCase().startsWith('x-') && !k.toLowerCase().includes('ab-test')) zone[k] = v;
  }
  return { deviceId, visitorId, jar, zone, mintedAt: Date.now(), lat, lng };
}

function headersFor(s) {
  const h = {
    'User-Agent': UA, 'x-platform': 'ios', 'x-build': BUILD, 'x-mp': 'noon',
    'x-content': 'mobile', 'x-locale': 'en-ae', Accept: 'application/json',
    'x-device-id': s.deviceId, 'x-visitor-id': s.visitorId,
    'x-device-lat': String(s.lat), 'x-device-lng': String(s.lng),
    'x-mp-country': 'ae', 'x-experience': 'food',
    'x-lat': String(Math.round(s.lat * 1e7)), 'x-lng': String(Math.round(s.lng * 1e7)),
    'x-border-enabled': 'true', 'x-rocket-enabled': 'true',
    'x-whoami-request-id': crypto.randomUUID(),
    Cookie: cookieString(s.jar),
  };
  for (const [k, v] of Object.entries(s.zone)) h[k] = v;
  return h;
}

class Rate extends Error { constructor(m) { super(m); this.rateLimited = true; } }
class Blocked extends Error { constructor(m) { super(m); this.forbidden = true; } }

// /search ignores `page`. The response's searchToken is the real cursor and
// must be chained, or every request re-serves the first 60 outlets.
async function fetchPage(s, searchToken) {
  const body = {
    queryEntity: null, q: null, f: {}, contexts: [], withContent: true,
    excludeOutletCodes: [], limit: PAGE_LIMIT, page: 1,
    sort: { by: 'popularity', dir: 'desc' },
    type: 'outlet', qType: 'search_query', getFallback: true,
  };
  if (searchToken) body.searchToken = searchToken;

  const resp = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { ...headersFor(s), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.status === 429) throw new Rate('search 429');
  if (resp.status === 403) throw new Blocked('search 403');
  if (!resp.ok) throw new Error(`search HTTP ${resp.status}`);
  const json = await resp.json();

  // results is one mixed array: outlet cards in scroll order, widget modules
  // interleaved. Rank counts cards only.
  const cards = [], modules = [];
  const results = Array.isArray(json.results) ? json.results : [];
  results.forEach((el, idx) => {
    if (el && typeof el === 'object' && el.outletCode) cards.push(el);
    else if (el && Array.isArray(el.modules)) {
      for (const mod of el.modules) modules.push({ idx, mod });
    }
  });
  return { cards, modules, token: json.searchToken || null };
}

async function fetchAds(s) {
  const resp = await fetch(ADMON_URL, { headers: headersFor(s) });
  if (resp.status === 429) throw new Rate('admon 429');
  if (resp.status === 403) throw new Blocked('admon 403');
  if (!resp.ok) return [];
  const json = await resp.json();
  return (json.data || []).map((d, slot) => ({ slot, d }));
}

async function processArea(area) {
  let s = await mintSession(area.latitude, area.longitude);
  const seen = new Map();            // outletCode -> rank
  let rank = 0, page = 0, token = null, stop = 'cap';
  let modulesSent = false;
  let buffer = [];

  const flush = async (final, pages, err) => {
    await rpc('noon_sample_save', {
      p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_area_id: area.noon_area_id,
      p_rows: buffer, p_widgets: [], p_ads: [], p_final: false,
    });
    buffer = [];
  };

  while (page < PAGE_SAFETY_CAP) {
    if (Date.now() - s.mintedAt > TOKEN_LIFE_MS) s = await mintSession(area.latitude, area.longitude);
    page++;
    const r = await fetchPage(s, token);

    if (!modulesSent && r.modules.length) {
      await rpc('noon_sample_save', {
        p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_area_id: area.noon_area_id,
        p_rows: [], p_widgets: r.modules, p_ads: [], p_final: false,
      });
      modulesSent = true;
    }

    let fresh = 0;
    for (const c of r.cards) {
      if (seen.has(c.outletCode)) continue;
      rank++; fresh++;
      seen.set(c.outletCode, rank);
      buffer.push({ r: rank, p: page, n: 1, c });
    }
    if (buffer.length >= CHUNK) await flush();

    if (r.cards.length === 0) { stop = `empty page ${page}`; break; }
    if (fresh === 0)          { stop = `no new outlets at page ${page}`; break; }
    if (!r.token)             { stop = `no searchToken at page ${page}`; break; }
    token = r.token;
    await sleep(PAGE_DELAY_MS);
  }

  if (buffer.length) await flush();

  const ads = await fetchAds(s);
  await rpc('noon_sample_save', {
    p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_area_id: area.noon_area_id,
    p_rows: [], p_widgets: [], p_ads: ads, p_final: true, p_pages: page,
  });
  return { outlets: seen.size, pages: page, ads: ads.length, stop };
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
      console.log(`[m${MACHINE_NO}] area ${area.noon_area_id} done | ${out.outlets} outlets over ${out.pages} pages | ${out.ads} ads | ${out.stop}`);
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
      // dispatches a replacement machine on a fresh runner IP.
      endReason = kind; break;
    }
  }

  const rep = await rpc('noon_sample_machine_end', {
    p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_reason: endReason,
  });
  console.log(`[m${MACHINE_NO}] ended: ${endReason} | ${JSON.stringify(rep)}`);
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
