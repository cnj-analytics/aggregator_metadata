// careem/uae/ranking-scrape.js
//
// Careem UAE — Ranking worker (one GitHub Actions job per machine).
// Loops: machine_start -> claim area -> fetch all pages -> parse -> report ->
// sleep. Exits on 429/5xx, deadline, "no areas left", or wall limit.
//
// Env (all required unless noted):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RUN_ID            bigint (from workflow input)
//   MACHINE_NO        integer (from workflow input)
//   GITHUB_RUN_ID     informational
//   PAGE_DELAY_MS     delay between page fetches within one area (default 1000)
//   WALL_LIMIT_SEC    hard stop (default 21000 = 5h50m)

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUN_ID         = process.env.RUN_ID;
const MACHINE_NO     = parseInt(process.env.MACHINE_NO || '0', 10);
const GITHUB_RUN_ID  = process.env.GITHUB_RUN_ID || '';
const PAGE_DELAY_MS  = parseInt(process.env.PAGE_DELAY_MS || '1000', 10);
const WALL_LIMIT_SEC = parseInt(process.env.WALL_LIMIT_SEC || '21000', 10);
const MAX_PAGES      = 150;

if (!SUPABASE_URL || !SUPABASE_KEY || !RUN_ID || !MACHINE_NO) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RUN_ID / MACHINE_NO');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEVICE = {
  app_version: '26.39.0',
  os: 'iOS/27.0.1',
  appengine_api_version: '2026-09-17',
  device_id: 'D0O8gpXoJdQ2L5lC',
};
const LISTINGS_URL_BASE =
  'https://appengine.careemapis.com/v1/page/food-discovery-home/component/v/1/food-discovery-all-restaurants-v2';

// ── Supabase RPC ───────────────────────────────────────────────────────
async function rpc(fn, body) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`RPC ${fn} ${resp.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

function sessionId() {
  return 'RANK-' + Math.random().toString(16).slice(2, 10).toUpperCase();
}
function decodeJwtSub(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/') + '===';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).sub;
  } catch { return null; }
}

async function getToken() {
  // 10-token pool test: each machine picks a slot by machine_no.
  // m1→slot1, m2→slot2, ..., m10→slot10, m11→slot1, m12→slot2, ..., m20→slot10.
  // Two machines share each access_token.
  const slot = ((MACHINE_NO - 1) % 10) + 1;
  const rows = await rpc('careem_scraper_token_by_slot', { p_slot: slot });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.access_token) {
    throw new Error(`careem_scraper_token_by_slot slot=${slot} returned nothing`);
  }
  console.log(`[m${MACHINE_NO}] using token slot ${slot} (jti=${row.jwt_jti})`);
  return row.access_token;
}

// ── Careem listing fetch ───────────────────────────────────────────────
function careemHeaders(token, user_id, lat, lng, sessId) {
  return {
    Host: 'appengine.careemapis.com',
    SESSION_ID: sessId,
    'X-Careem-Beta': 'false',
    'User-Agent': 'ICMA/' + DEVICE.app_version,
    'X-Careem-Agent': 'ICMA',
    'X-Careem-Session-Id': sessId,
    Agent: 'ICMA',
    'Time-Zone': 'Asia/Dubai',
    lng: String(lng),
    lat: String(lat),
    'x-careem-userid': String(user_id || ''),
    Version: DEVICE.app_version,
    'X-Careem-Version': DEVICE.app_version,
    'x-careem-user-location': `${lat},${lng}`,
    'x-careem-appengine-api-version': DEVICE.appengine_api_version,
    'X-Careem-Operating-System': DEVICE.os,
    Authorization: 'Bearer ' + token,
    'x-careem-permissions': 'location:granted',
    'Accept-Language': 'en',
    'x-careem-device-id': DEVICE.device_id,
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
  };
}

function pageUrl(page) {
  return `${LISTINGS_URL_BASE}?sp_page=${page}&sp_offset=0&sp_category=food_disc_all_restaurants`;
}

// Walk the response and collect every restaurant card. We DO NOT dedup here —
// parseCards keeps the first sighting as the rank and counts repeats as
// appearances (needed to measure sponsored exposure across pages).
function collectCards(node, out, depth) {
  out = out || []; depth = depth || 0;
  if (!node || depth > 20) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectCards(n, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;
  const mid = node.merchant_id || node.outlet_id || node.restaurant_id;
  const bid = node.brand_id;
  if (mid && bid && (node.merchant_name || node.brand_name)) {
    out.push(node);
  }
  for (const k of Object.keys(node)) {
    if (typeof node[k] === 'object') collectCards(node[k], out, depth + 1);
  }
  return out;
}

async function fetchPage(token, sub, page, area) {
  const sessId = sessionId();
  const headers = careemHeaders(token, sub, area.latitude, area.longitude, sessId);
  const t0 = Date.now();
  const resp = await fetch(pageUrl(page), { headers, redirect: 'follow' });
  const text = await resp.text();
  return { status: resp.status, text, elapsed: Date.now() - t0, bytes: text.length };
}

// ── Parse card → positional slot row ───────────────────────────────────
function toBool(v) { return v === true || v === 'true'; }
function toNum(v)  { return (v === null || v === undefined || v === '') ? null : Number(v); }

function parseCards(cards) {
  // first-sighting rank per merchant_id + appearances counter
  const firstRank = new Map();  // merchant_id -> rank
  const appearances = new Map();
  const firstCard = new Map();  // merchant_id -> card
  let rank = 0;
  for (const c of cards) {
    const mid = c.merchant_id || c.outlet_id || c.restaurant_id;
    if (!mid) continue;
    const key = String(mid);
    if (!firstRank.has(key)) {
      rank += 1;
      firstRank.set(key, rank);
      firstCard.set(key, c);
    }
    appearances.set(key, (appearances.get(key) || 0) + 1);
  }

  const rows = [];
  for (const [key, r] of firstRank) {
    const c = firstCard.get(key);
    const app = appearances.get(key) || 1;
    rows.push([
      key,                                               // 0 branch_id (as text, cast bigint in SQL)
      r,                                                 // 1 rank
      app,                                               // 2 appearances
      toBool(c.merchant_availability),                   // 3 is_available
      toBool(c.is_busy),                                 // 4 is_busy
      c.availability || '',                              // 5 availability_text
      toNum(c.merchant_rating),                          // 6 rating
      toNum(c.no_of_reviews),                            // 7 rating_count
      toNum(c.eta_minutes),                              // 8 eta_minutes
      toBool(c.is_cplus),                                // 9 is_cplus
      toBool(c.is_offer),                                // 10 has_offer
      toNum(c.offer_id),                                 // 11 offer_id
      c.offer_text || '',                                // 12 offer_text
      toBool(c.is_ad_slot),                              // 13 is_sponsored
      toNum(c.ad_id),                                    // 14 ad_id
      c.merchant_name || '',                             // 15 card_name
      '',                                                // 16 card_image_url (not in Careem listing)
      '',                                                // 17 card_url
    ]);
  }
  return rows;
}

// ── Process one area ───────────────────────────────────────────────────
async function processArea({ token, sub, area, scrape_date, scrape_hour, dry_run }) {
  const t0 = Date.now();
  const cards = [];
  let totalBytes = 0, totalFetchMs = 0, httpStatus = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let fp;
    try { fp = await fetchPage(token, sub, page, area); }
    catch (e) {
      return { status: 'failed', error: `fetch failed: ${e.message}`,
               cards: cards.length, bytes: totalBytes, fetch_ms: totalFetchMs };
    }
    httpStatus = fp.status;
    totalBytes += fp.bytes;
    totalFetchMs += fp.elapsed;

    if (fp.status === 429) return { status: 'rate_limited', http_status: 429, error: 'http_429',
                                    cards: cards.length, bytes: totalBytes, fetch_ms: totalFetchMs };
    if (fp.status === 403) return { status: 'blocked', http_status: 403, error: 'http_403',
                                    cards: cards.length, bytes: totalBytes, fetch_ms: totalFetchMs };
    if (fp.status === 204 || (fp.status >= 200 && fp.status < 300 && fp.bytes === 0)) {
      // empty = end of pages
      break;
    }
    if (fp.status < 200 || fp.status >= 400) {
      return { status: 'failed', http_status: fp.status, error: `http_${fp.status}`,
               cards: cards.length, bytes: totalBytes, fetch_ms: totalFetchMs };
    }

    let parsed;
    try { parsed = JSON.parse(fp.text); }
    catch (e) {
      return { status: 'failed', http_status: fp.status, error: `non-JSON: ${e.message}`,
               cards: cards.length, bytes: totalBytes, fetch_ms: totalFetchMs };
    }

    const pageCards = collectCards(parsed, [], 0);
    console.log(`[m${MACHINE_NO}]   area ${area.careem_area_id} page ${page} → ${pageCards.length} cards, ${fp.bytes}B, ${fp.elapsed}ms (status ${fp.status})`);
    if (pageCards.length === 0) break;
    for (const c of pageCards) cards.push(c);

    await sleep(PAGE_DELAY_MS);
  }

  const rows = parseCards(cards);
  if (dry_run) {
    return { status: 'ok', http_status: httpStatus, cards: cards.length,
             ranking_rows: rows.length, pending_rows: 0, bytes: totalBytes, fetch_ms: totalFetchMs };
  }

  try {
    const saved = await rpc('careem_ranking_save_area_hour', {
      p_area_id: area.careem_area_id,
      p_date:    scrape_date,
      p_hour:    scrape_hour + ':00',
      p_rows:    rows,
    });
    return {
      status: 'ok', http_status: httpStatus, cards: cards.length,
      ranking_rows: (saved?.inserted || 0),
      pending_rows: (saved?.pending  || 0),
      bytes: totalBytes, fetch_ms: totalFetchMs,
    };
  } catch (e) {
    return { status: 'failed', http_status: httpStatus, error: `save_area_hour: ${e.message}`,
             cards: cards.length, bytes: totalBytes, fetch_ms: totalFetchMs };
  }
}

// ── Main loop ──────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`Careem ranking worker starting — run ${RUN_ID} machine ${MACHINE_NO} github_run ${GITHUB_RUN_ID}`);

  const start = await rpc('careem_ranking_machine_start', {
    p_run_id: parseInt(RUN_ID, 10),
    p_machine_no: MACHINE_NO,
    p_github_run_id: GITHUB_RUN_ID,
  });
  if (start?.stop) {
    console.log(`machine_start says stop: ${start.reason}`);
    return;
  }
  console.log(`run date=${start.scrape_date} hour=${start.scrape_hour} dry_run=${start.dry_run}`);

  const token = await getToken();
  const sub = decodeJwtSub(token);
  console.log(`token loaded, sub=${sub}`);

  let areasDone = 0, areasFailed = 0;

  while (true) {
    if ((Date.now() - t0) / 1000 > WALL_LIMIT_SEC) {
      console.log('wall limit reached');
      break;
    }
    let claim;
    try { claim = await rpc('careem_ranking_claim', {
      p_run_id: parseInt(RUN_ID, 10),
      p_machine_no: MACHINE_NO,
    }); } catch (e) { console.error('claim failed:', e.message); break; }

    if (claim?.done) {
      console.log(`claim done: ${claim.reason}`);
      break;
    }
    const area = claim.area;
    const waitMs = Math.max(0, claim.wait_ms || 0);
    if (waitMs > 0) await sleep(waitMs);

    console.log(`[m${MACHINE_NO}] area ${area.careem_area_id} ${area.area_name} fetching...`);
    const outcome = await processArea({
      token, sub, area,
      scrape_date: start.scrape_date,
      scrape_hour: start.scrape_hour,
      dry_run: start.dry_run,
    });
    console.log(`[m${MACHINE_NO}] area ${area.careem_area_id} → ${outcome.status} ` +
                `cards=${outcome.cards||0} rows=${outcome.ranking_rows||0} ` +
                `pending=${outcome.pending_rows||0} bytes=${outcome.bytes||0}`);

    try {
      const rep = await rpc('careem_ranking_report', {
        p_run_id: parseInt(RUN_ID, 10),
        p_machine_no: MACHINE_NO,
        p_area_id: area.careem_area_id,
        p_result: outcome,
      });
      if (rep?.action === 'stop_job') {
        console.log(`report returned stop_job: ${rep.reason || 'rate limit/block'}`);
        break;
      }
    } catch (e) {
      console.error(`report failed for area ${area.careem_area_id}: ${e.message}`);
    }

    if (outcome.status === 'ok') areasDone++;
    else areasFailed++;

    const gap = parseFloat(claim.gap_seconds || '1') * 1000;
    await sleep(gap);
  }

  try {
    await rpc('careem_ranking_machine_end', {
      p_run_id: parseInt(RUN_ID, 10),
      p_machine_no: MACHINE_NO,
      p_reason: `finished: ok=${areasDone} fail=${areasFailed}`,
    });
  } catch (e) { console.error('machine_end failed:', e.message); }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`DONE — areas ok=${areasDone} fail=${areasFailed} elapsed=${mins} min`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
