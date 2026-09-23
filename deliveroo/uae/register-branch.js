// register-branch.js
//
// Deliveroo UAE – register new partners (one job of JOB_COUNT).
//
// Started by Supabase (trigger on deliveroo_partner_registration_queue /
// deliveroo_ranking_pending) whenever the ranking scrape finds partner IDs that
// are not in deliveroo_branch. Each job:
//   1. claims the oldest waiting partner (deliveroo_registration_claim – no two jobs get the same one);
//   2. opens each restaurant's menu page (with the geohash of the area it was seen in);
//   3. builds the brand / branch / information record in the same format as existing rows
//      (brand name from the listing card; branch details from the menu page);
//   4. calls deliveroo_register_branch, which in one transaction creates the brand (if new),
//      branch, information and delivery areas, moves the parked ranking rows into
//      deliveroo_ranking_analysis and removes the partner from the queue;
//   5. on any problem calls deliveroo_registration_fail (retried up to 3 attempts);
//   6. repeats until the queue is empty or the time budget is used.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JOB_INDEX, JOB_COUNT,
//      CLAIM_SIZE (default 1), TIME_BUDGET_MIN (default 40), SUMMARY_FILE
// A successful registration removes the partner from the queue (done in deliveroo_register_branch).

const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JOB_INDEX = parseInt(process.env.JOB_INDEX || '0', 10);
const JOB_COUNT = parseInt(process.env.JOB_COUNT || '1', 10);
// One partner at a time, oldest first (first come, first served).
const CLAIM_SIZE = parseInt(process.env.CLAIM_SIZE || '1', 10);
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || '40', 10) * 60000;
const SUMMARY_FILE = process.env.SUMMARY_FILE || 'summary.json';

const DELAY_BETWEEN_PAGES_MS = 1500;
const START_STAGGER_MS = 2000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const MAX_RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_INITIAL_BACKOFF_MS = 60000;

// Same image URL template as the existing deliveroo_branch_image_url values.
const IMAGE_TEMPLATE = '?width={w}&height={h}&auto=webp&format=jpg&fit=crop&v={&quality}';
const FULFILMENT_TYPES = new Set(['DELIVEROO', 'RESTAURANT']);
const BRANCH_TYPES = new Set(['RESTAURANT', 'ON_DEMAND_CONVENIENCE', 'ON_DEMAND_CONVENIENCE_RAPID',
  'CHARITABLE_DONATION', 'GIFT_CARD_SHOP']);

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// --- Supabase --------------------------------------------------------------------

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
    if ((resp.status >= 500 || resp.status === 0) && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
    throw new Error(`rpc ${name} -> ${resp.status}: ${text.slice(0, 400)}`);
  }
}

// --- Page ------------------------------------------------------------------------

async function fetchPage(url) {
  let errors = 0, rateLimits = 0, lastErr = null;
  while (errors <= MAX_RETRIES && rateLimits <= MAX_RATE_LIMIT_RETRIES) {
    try {
      const resp = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      if (resp.status === 429) {
        rateLimits++; lastErr = 'http_429';
        if (rateLimits > MAX_RATE_LIMIT_RETRIES) break;
        await sleep(RATE_LIMIT_INITIAL_BACKOFF_MS * rateLimits);
        continue;
      }
      if (resp.status >= 500) {
        errors++; lastErr = `http_${resp.status}`;
        if (errors > MAX_RETRIES) break;
        await sleep(RETRY_DELAY_MS * errors);
        continue;
      }
      return { status: resp.status, finalUrl: resp.url, html: await resp.text() };
    } catch (e) {
      errors++; lastErr = e.message;
      if (errors > MAX_RETRIES) break;
      await sleep(RETRY_DELAY_MS * errors);
    }
  }
  return { status: null, html: null, error: lastErr };
}

function extractNextData(html) {
  const marker = '<script id="__NEXT_DATA__" type="application/json">';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const from = start + marker.length;
  const end = html.indexOf('</script>', from);
  return end === -1 ? null : JSON.parse(html.slice(from, end));
}

// The restaurant's own map pin, in the "Location" section of the page.
function findLocationPin(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const x of node) { const r = findLocationPin(x); if (r) return r; }
    return null;
  }
  if (node.header === 'Location') { const p = findFirstPin(node); if (p) return p; }
  for (const k of Object.keys(node)) { const r = findLocationPin(node[k]); if (r) return r; }
  return null;
}
function findFirstPin(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.map && Array.isArray(node.map.pins) && node.map.pins.length) {
    const p = node.map.pins[0];
    if (typeof p.lat === 'number' && typeof p.lon === 'number') return { lat: p.lat, lon: p.lon };
  }
  for (const k of Object.keys(node)) { const r = findFirstPin(node[k]); if (r) return r; }
  return null;
}

const clean = s => (s == null ? '' : String(s).replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim());

// "tim-hortons-rak-corniche-the-square-dr-thru" -> "Tim Hortons Rak Corniche The Square Dr Thru"
function branchNameFromSlug(slug) {
  return clean(slug).split('-').filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// "Tim Hortons - RAK Corniche The Square Dr Thru" -> "Tim Hortons"; "Fishy-Al Seef" stays whole
function brandNameFromRestaurantName(name) {
  const n = clean(name);
  const i = n.indexOf(' - ');
  return i > 0 ? n.slice(0, i).trim() : n;
}

function buildRecord(q, data) {
  const r = data?.props?.initialState?.menuPage?.menu?.metas?.root?.restaurant;
  if (!r) return { error: 'not_a_menu_page (delisted or redirected)' };
  if (r.drnId !== q.deliveroo_branch_partner_id) return { error: `drn_mismatch: page drnId ${r.drnId}` };

  const pin = findLocationPin(data?.props?.initialState);
  if (!pin) return { error: 'no_location_pin' };

  const addr = r.location?.address || {};
  const selfHref = r.links?.self?.href || '';
  const imgBase = q.deliveroo_partner_card_image_url ? q.deliveroo_partner_card_image_url.split('?')[0] : null;

  const rec = {
    partner_id: q.deliveroo_branch_partner_id,
    branch_id: String(r.id),
    branch_name: branchNameFromSlug(r.uname),
    brand_id: r.brandDrnId || null,
    // Brand name = the name on the listing-page card (matches existing deliveroo_brand rows).
    // Fallback only if the card name is missing: menu-page name up to " - ".
    brand_name: clean(q.deliveroo_partner_card_name) || brandNameFromRestaurantName(r.name),
    page_url: selfHref ? `https://deliveroo.ae/en${selfHref}` : q.deliveroo_partner_card_url,
    image_url: imgBase ? imgBase + IMAGE_TEMPLATE : null,
    address: clean(addr.address1) || null,
    menu_id: r.menuId != null ? String(r.menuId) : null,
    fulfilment_type: FULFILMENT_TYPES.has(r.fulfillmentType) ? r.fulfillmentType : null,
    branch_type: BRANCH_TYPES.has(r.branchType) ? r.branchType : null,
    area_name: clean(addr.neighborhood) || null,
    postcode: clean(addr.postCode) || null,
    latitude: pin.lat,
    longitude: pin.lon,
  };
  if (!rec.menu_id) return { error: 'no_menu_id' };
  if (!rec.area_name) return { error: 'no_area_name' };
  return { rec };
}

// --- Main ------------------------------------------------------------------------

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const started = Date.now();
  const results = [];
  if (JOB_INDEX > 0) await sleep(JOB_INDEX * START_STAGGER_MS);
  log(`Register job ${JOB_INDEX + 1}/${JOB_COUNT}`);

  while (Date.now() - started < TIME_BUDGET_MS) {
    const batch = await rpc('deliveroo_registration_claim', { p_limit: CLAIM_SIZE });
    if (!batch || !batch.length) { log('Queue empty – done.'); break; }

    for (const q of batch) {
      const t0 = Date.now();
      const res = { job: JOB_INDEX, partner_id: q.deliveroo_branch_partner_id, card_name: q.deliveroo_partner_card_name,
        area_id: q.deliveroo_area_id, attempt: q.deliveroo_registration_attempts, status: null, detail: null, ms: 0 };
      try {
        const base = q.deliveroo_partner_card_url;
        if (!base) throw new Error('no_card_url');
        const url = q.deliveroo_area_geohash ? `${base}?geohash=${encodeURIComponent(q.deliveroo_area_geohash)}` : base;
        const page = await fetchPage(url);
        if (!page.html) throw new Error(`fetch_failed: ${page.error}`);
        if (page.status !== 200) throw new Error(`http_${page.status}`);
        const data = extractNextData(page.html);
        if (!data) throw new Error('no_next_data');
        const built = buildRecord(q, data);
        if (built.error) throw new Error(built.error);
        const out = await rpc('deliveroo_register_branch', { p: built.rec });
        res.status = 'registered';
        res.detail = { ...out, branch_name: built.rec.branch_name, brand_name: built.rec.brand_name, area_name: built.rec.area_name };
      } catch (e) {
        res.status = 'failed';
        res.detail = e.message.slice(0, 300);
        try {
          res.queue_status = await rpc('deliveroo_registration_fail', { p_partner_id: q.deliveroo_branch_partner_id, p_error: res.detail });
        } catch (e2) { res.queue_status = `fail_rpc_error: ${e2.message.slice(0, 100)}`; }
      }
      res.ms = Date.now() - t0;
      results.push(res);
      log(`${res.status.padEnd(10)} ${(q.deliveroo_partner_card_name || '').slice(0, 40).padEnd(40)} ` +
          (res.status === 'registered'
            ? `areas+${res.detail.delivery_areas_added} rankings→${res.detail.rankings_moved} brand_new=${res.detail.brand_created}`
            : `${res.detail} (queue: ${res.queue_status})`));
      await sleep(DELAY_BETWEEN_PAGES_MS);
    }
  }
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(results, null, 1));
}

module.exports = { branchNameFromSlug, brandNameFromRestaurantName, buildRecord };

if (require.main === module) {
  main().catch(e => {
    console.error('FATAL:', e.message || e);
    try { fs.writeFileSync(SUMMARY_FILE, JSON.stringify([{ job: JOB_INDEX, status: 'fatal', detail: String(e.message || e) }])); } catch (_) {}
    process.exit(1);
  });
}
