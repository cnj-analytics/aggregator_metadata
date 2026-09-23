// temp-backfill-branch-coordinates.js
//
// TEMPORARY one-off backfill. Delete once deliveroo_branch_information
// has coordinates for every row.
//
// For each deliveroo_branch_information row with no latitude yet:
//   1. Fetch the branch page (deliveroo_branch.deliveroo_branch_page_url).
//      No customer location is sent, so the page's customerLocation stays 0,0.
//   2. Read the restaurant's drnId and the restaurant map pin from the
//      "Location" section of __NEXT_DATA__.
//   3. If drnId == deliveroo_branch_partner_id -> write lat/lon.
//      If drnId differs -> DO NOT write; log as drn_mismatch for review.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SHARD_INDEX (0-based), SHARD_COUNT   -> which slice of rows this job owns
//   LIMIT_PER_SHARD (0 = no limit)       -> cap for test runs
//   DRY_RUN ("true" = don't write to Supabase)
//   RESULTS_FILE (CSV output path, default results.csv)

const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHARD_INDEX = parseInt(process.env.SHARD_INDEX || '0', 10);
const SHARD_COUNT = parseInt(process.env.SHARD_COUNT || '1', 10);
const LIMIT_PER_SHARD = parseInt(process.env.LIMIT_PER_SHARD || '0', 10);
const DRY_RUN = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';
const RESULTS_FILE = process.env.RESULTS_FILE || 'results.csv';

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 5000;
const DELAY_BETWEEN_PAGES_MS = 300;
const PAGE_SIZE = 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Supabase ---------------------------------------------------------

async function supabase(path, method, body = null, extraHeaders = {}) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        method,
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      if (!resp.ok) {
        if (resp.status >= 500 && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
        throw new Error(`Supabase ${method} ${path} -> ${resp.status}: ${text}`);
      }
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

// All rows still missing latitude, with their page URL, in a stable order.
async function loadPendingRows() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await supabase(
      '/deliveroo_branch_information' +
        '?select=deliveroo_branch_partner_id,deliveroo_branch_id,deliveroo_branch(deliveroo_branch_page_url)' +
        '&deliveroo_branch_location_latitude=is.null' +
        '&order=deliveroo_branch_partner_id.asc' +
        `&limit=${PAGE_SIZE}&offset=${offset}`,
      'GET'
    );
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

// --- Page fetch & extraction -----------------------------------------

async function fetchWithRetry(url) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AreaSync/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (resp.status === 429 || resp.status >= 500) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`  ${resp.status} -- retrying in ${delay / 1000}s`);
        await sleep(delay);
        lastErr = `http_${resp.status}`;
        continue;
      }
      return { resp, retries: attempt };
    } catch (e) {
      lastErr = e.message;
      const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.log(`  fetch error (${e.message}) -- retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
  return { resp: null, retries: MAX_RETRIES, error: lastErr };
}

// Depth-first search for the layout whose header is "Location" and return
// the first map pin inside it.
function findLocationPin(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const x of node) { const r = findLocationPin(x); if (r) return r; }
    return null;
  }
  if (node.header === 'Location') {
    const pin = findFirstPin(node);
    if (pin) return pin;
  }
  for (const k of Object.keys(node)) {
    const r = findLocationPin(node[k]);
    if (r) return r;
  }
  return null;
}

function findFirstPin(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.map && Array.isArray(node.map.pins) && node.map.pins.length > 0) {
    const p = node.map.pins[0];
    if (typeof p.lat === 'number' && typeof p.lon === 'number') return { lat: p.lat, lon: p.lon };
  }
  for (const k of Object.keys(node)) {
    const r = findFirstPin(node[k]);
    if (r) return r;
  }
  return null;
}

function extract(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
  if (!m) return { error: 'no_next_data' };
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return { error: 'next_data_parse_error' }; }
  const restaurant = data?.props?.initialState?.menuPage?.menu?.metas?.root?.restaurant;
  const pin = findLocationPin(data?.props?.initialState);
  return {
    drnId: restaurant?.drnId || null,
    restaurantId: restaurant?.id || null,
    pin,
  };
}

// --- CSV --------------------------------------------------------------

const CSV_HEADER = [
  'shard', 'partner_id', 'branch_id', 'url', 'status', 'http_status', 'final_url',
  'page_drn_id', 'page_restaurant_id', 'lat', 'lon', 'ms', 'retries', 'error',
];
const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function shardOf(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % SHARD_COUNT;
}

// --- Main -------------------------------------------------------------

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  console.log(`Shard ${SHARD_INDEX + 1}/${SHARD_COUNT}  limit=${LIMIT_PER_SHARD || 'none'}  dry_run=${DRY_RUN}`);

  const all = await loadPendingRows();
  // Shard by a stable hash of the partner ID (not list position), so jobs that
  // start at slightly different times never overlap or leave gaps.
  let mine = all.filter(r => shardOf(r.deliveroo_branch_partner_id) === SHARD_INDEX);
  if (LIMIT_PER_SHARD > 0) mine = mine.slice(0, LIMIT_PER_SHARD);
  console.log(`Pending rows overall: ${all.length}. This shard: ${mine.length}\n`);

  const out = fs.createWriteStream(RESULTS_FILE);
  out.write(CSV_HEADER.join(',') + '\n');

  const counts = {};
  const started = Date.now();

  for (let i = 0; i < mine.length; i++) {
    const row = mine[i];
    const partnerId = row.deliveroo_branch_partner_id;
    const url = row.deliveroo_branch?.deliveroo_branch_page_url;
    const rec = {
      shard: SHARD_INDEX, partner_id: partnerId, branch_id: row.deliveroo_branch_id, url,
      status: null, http_status: null, final_url: null, page_drn_id: null,
      page_restaurant_id: null, lat: null, lon: null, ms: null, retries: 0, error: null,
    };
    const t0 = Date.now();

    try {
      if (!url) {
        rec.status = 'no_url';
      } else {
        const { resp, retries, error } = await fetchWithRetry(url);
        rec.retries = retries;
        if (!resp) {
          rec.status = 'fetch_failed';
          rec.error = error;
        } else {
          rec.http_status = resp.status;
          if (resp.url && resp.url !== url) rec.final_url = resp.url;
          if (!resp.ok) {
            rec.status = `http_${resp.status}`;
          } else {
            const x = extract(await resp.text());
            if (x.error) {
              rec.status = x.error;
            } else {
              rec.page_drn_id = x.drnId;
              rec.page_restaurant_id = x.restaurantId;
              if (x.pin) { rec.lat = x.pin.lat; rec.lon = x.pin.lon; }

              if (!x.drnId) rec.status = 'no_drn_id';
              else if (x.drnId !== partnerId) rec.status = 'drn_mismatch'; // not written
              else if (!x.pin) rec.status = 'no_pin';
              else {
                if (!DRY_RUN) {
                  await supabase(
                    `/deliveroo_branch_information?deliveroo_branch_partner_id=eq.${encodeURIComponent(partnerId)}`,
                    'PATCH',
                    {
                      deliveroo_branch_location_latitude: x.pin.lat,
                      deliveroo_branch_location_longitude: x.pin.lon,
                    },
                    { Prefer: 'return=minimal' }
                  );
                }
                rec.status = DRY_RUN ? 'ok_dry_run' : 'updated';
              }
            }
          }
        }
      }
    } catch (e) {
      rec.status = 'error';
      rec.error = e.message;
    }

    rec.ms = Date.now() - t0;
    counts[rec.status] = (counts[rec.status] || 0) + 1;
    out.write(CSV_HEADER.map(h => csvCell(rec[h])).join(',') + '\n');
    console.log(
      `[${i + 1}/${mine.length}] ${rec.status.padEnd(14)} ${rec.ms}ms  ${rec.lat ?? ''},${rec.lon ?? ''}  ${url}` +
        (rec.status === 'drn_mismatch' ? `  (page drnId ${rec.page_drn_id})` : '')
    );

    await sleep(DELAY_BETWEEN_PAGES_MS);
  }

  await new Promise(r => out.end(r));
  const secs = (Date.now() - started) / 1000;
  console.log(`\nDone in ${secs.toFixed(1)}s (${mine.length ? (secs / mine.length).toFixed(2) : 0}s per URL incl. delay)`);
  console.log('Counts:', JSON.stringify(counts));
}

module.exports = { extract };

if (require.main === module) {
  main().catch(e => {
    console.error('FATAL:', e.message || e);
    process.exit(1);
  });
}
