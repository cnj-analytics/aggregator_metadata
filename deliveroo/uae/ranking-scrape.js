// ranking-scrape.js – one worker machine of the hourly ranking scrape.
//
// Supabase is the traffic controller (deliveroo_ranking_* functions). It starts this workflow
// once per machine, tells the machine which run it belongs to, and from then on hands out one
// area at a time with a time slot. The machine only fetches, saves and reports:
//   1. deliveroo_ranking_machine_start – check in, get the run's date/hour
//   2. deliveroo_ranking_claim         – next area + time slot (Supabase sets the pace, planned
//                                        breaks and pauses; it slows down on a 429 and speeds up
//                                        after clean stretches)
//   3. deliveroo_ranking_check         – just before sending: still on, not paused?
//   4. fetch + parse + save (below)
//   5. deliveroo_ranking_report        – outcome; Supabase replies continue / stop this machine /
//                                        stop the run. On a 429: Supabase immediately stops this
//                                        machine and dispatches a replacement from the pool (up to
//                                        15 total). The area is requeued for the next machine.
//                                        On a 403: machine stops, not replaced; second 403 stops
//                                        the entire run.
//   6. deliveroo_ranking_machine_end   – always, when the machine stops for any reason
//
// For each area:
//   1. Fetch Deliveroo's mobile FeedV2 GraphQL endpoint anonymously (lat/lng from
//      deliveroo_area). ~22% more partners than the HTML path, ~3× faster, and
//      the response carries sponsored-slot flags that HTML strips out.
//   2. Read every UICard in order -> rank 1..N plus rating, open/closed, fast tag,
//      promo badge, and the new is_sponsored flag.
//   3. Known partners  -> deliveroo_ranking_analysis. Unknown partners -> deliveroo_ranking_pending
//      + deliveroo_partner_registration_queue (with card_url resolved via a single
//      HTML fallback fetch per area — only when there is at least one unknown).
//   4. Update deliveroo_branch.deliveroo_branch_image_url when the card image changed.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RUN_ID, MACHINE_NO, GITHUB_RUN_ID,
//      UPDATE_IMAGES ("true" default), SUMMARY_FILE (default summary.json)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseListing, imageBase } = require('./ranking-parse-mobile');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUN_ID = parseInt(process.env.RUN_ID || '0', 10);
const MACHINE_NO = parseInt(process.env.MACHINE_NO || '0', 10);
const UPDATE_IMAGES = (process.env.UPDATE_IMAGES || 'true').toLowerCase() === 'true';
const SUMMARY_FILE = process.env.SUMMARY_FILE || 'summary.json';
// Set from Supabase when the machine checks in.
let SCRAPE_DATE = null, SCRAPE_HOUR = null, DRY_RUN = false;

const MAX_RETRIES = 3;          // network errors / 5xx only (429/403 go to Supabase)
const RETRY_DELAY_MS = 5000;
const WRITE_CHUNK = 1000;

// --- Mobile GraphQL endpoint ------------------------------------------------

const GRAPHQL_URL = 'https://co-m.ae.deliveroo.com/consumer/graphql/';
const BODY_TEMPLATE_PATH = path.join(__dirname, 'mobile-feedv2-body.json');
const BODY_TEMPLATE = JSON.parse(fs.readFileSync(BODY_TEMPLATE_PATH, 'utf-8'));

function uuid() { return crypto.randomUUID().toUpperCase(); }

function mobileHeaders() {
  const guid = uuid();
  return {
    'User-Agent': 'Deliveroo-OrderApp/3.342.0 (iPhone18,2; iOS27.0.1; Release; en_US; 697347)',
    'X-Roo-App-Version': '3.342.0',
    'X-Roo-Sticky-Guid': guid,
    'X-Roo-Guid': guid,
    'X-Roo-Country': 'ae',
    'X-Roo-Platform': 'iOS',
    'X-Roo-External-Device-Id': uuid(),
    'X-Roo-Rooblocks-Version': '5.3.0',
    'apollographql-client-name': 'com.deliveroo.orderapp-apollo-ios',
    'apollographql-client-version': '3.342.0-697347',
    'X-APOLLO-OPERATION-NAME': 'FeedV2',
    'X-APOLLO-OPERATION-TYPE': 'query',
    'Accept': 'multipart/mixed;deferSpec=20220824,application/json',
    'Content-Type': 'application/json',
    'Accept-Language': 'en-US',
  };
}

function buildMobileBody(lat, lng) {
  const body = JSON.parse(JSON.stringify(BODY_TEMPLATE));
  if (body.variables?.location) {
    body.variables.location.lat = lat;
    body.variables.location.lon = lng;
  }
  if (body.variables) body.variables.uuid = uuid();
  return body;
}

// Construct the restaurant-page URL from the area URL and the restaurant name.
// Deliveroo's URL pattern (verified from 15 existing branches, no exceptions):
//   https://deliveroo.ae/en/menu/{city-slug}/{area-slug}/{name-slug}
// — no random hash suffix. The city/area slugs come from the stored area URL
//   (/en/restaurants/{city}/{area}), the name slug from the restaurant name.
// register-branch.js then fetches that URL to pull brand + branch details.
function slugifyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\w\s-]/g, '')        // strip punctuation except underscore/dash
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
function parseAreaUrl(areaUrl) {
  // returns {city, area} slugs, or null on malformed URL
  try {
    const u = new URL(String(areaUrl).trim());
    const m = u.pathname.match(/^\/en\/restaurants\/([^/]+)\/([^/]+)\/?$/);
    return m ? { city: decodeURIComponent(m[1]).toLowerCase(), area: decodeURIComponent(m[2]).toLowerCase() } : null;
  } catch (_) { return null; }
}
function constructCardUrl(areaCityArea, restaurantName) {
  if (!areaCityArea || !restaurantName) return '';
  const slug = slugifyName(restaurantName);
  if (!slug) return '';
  return `https://deliveroo.ae/en/menu/${areaCityArea.city}/${areaCityArea.area}/${slug}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// --- Supabase -----------------------------------------------------------------

async function supabase(path, method = 'GET', body = null, extraHeaders = {}) {
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
        throw new Error(`Supabase ${method} ${path.split('?')[0]} -> ${resp.status}: ${text.slice(0, 500)}`);
      }
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (attempt >= 3 || /-> 4\d\d/.test(e.message)) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

// Keyset pagination (stable even while other jobs write).
async function fetchAll(table, select, orderCol, filters = '') {
  const rows = [];
  let last = null;
  for (;;) {
    const cursor = last === null ? '' : `&${orderCol}=gt.${encodeURIComponent(last)}`;
    const page = await supabase(`/${table}?select=${select}${filters}${cursor}&order=${orderCol}.asc&limit=1000`);
    rows.push(...page);
    if (page.length < 1000) break;
    last = page[page.length - 1][orderCol];
  }
  return rows;
}

async function writeChunks(path, rows, prefer) {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    await supabase(path, 'POST', rows.slice(i, i + WRITE_CHUNK), { Prefer: prefer });
  }
}

// --- Compact rows ---------------------------------------------------------------
// Order must match deliveroo_ranking_save_area_hour:
// [partner_id, rank, rating_status, rating, rating_count, operating_status, fast_tag,
//  has_promo, has_free_delivery_promo, has_non_delivery_promo, promo_text, promo_scope,
//  is_sponsored]                                              ^-- new on mobile path
function toCompact(r) {
  return [
    r.deliveroo_branch_partner_id,
    r.deliveroo_listing_rank,
    r.deliveroo_partner_rating_status,
    r.deliveroo_partner_rating ?? null,
    r.deliveroo_partner_rating_count ?? null,
    r.deliveroo_partner_operating_status,
    !!r.deliveroo_partner_fast_tag_visible,
    !!r.deliveroo_partner_has_promo_badge,
    !!r.deliveroo_partner_has_free_delivery_promo_badge,
    !!r.deliveroo_partner_has_non_delivery_promo_badge,
    r.deliveroo_partner_promo_badge_text ?? null,
    r.deliveroo_partner_promo_scope ?? null,
    !!r.deliveroo_partner_is_sponsored,
  ];
}

// --- Mobile GraphQL fetch ---------------------------------------------------
// 429 and 403 are returned straight away (no retry here): Supabase decides what happens next.
async function fetchMobileListing(lat, lng) {
  let errors = 0, lastErr = null;
  while (errors <= MAX_RETRIES) {
    try {
      const resp = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: mobileHeaders(),
        body: JSON.stringify(buildMobileBody(lat, lng)),
      });
      if (resp.status === 429 || resp.status === 403) {
        await resp.text().catch(() => {});
        return { status: resp.status, body: null, error: `http_${resp.status}` };
      }
      if (resp.status >= 500) {
        errors++; lastErr = `http_${resp.status}`;
        if (errors > MAX_RETRIES) break;
        await sleep(RETRY_DELAY_MS * errors);
        continue;
      }
      const text = await resp.text();
      return { status: resp.status, body: text };
    } catch (e) {
      errors++; lastErr = e.message;
      if (errors > MAX_RETRIES) break;
      await sleep(RETRY_DELAY_MS * errors);
    }
  }
  return { status: null, body: null, error: lastErr };
}

const rpc = (name, body) => supabase(`/rpc/${name}`, 'POST', body);

// --- Main -------------------------------------------------------------------------

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  if (!RUN_ID || !MACHINE_NO) throw new Error('Missing RUN_ID / MACHINE_NO (set by Supabase when it starts this machine)');

  const hello = await rpc('deliveroo_ranking_machine_start',
    { p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_github_run_id: process.env.GITHUB_RUN_ID || null });
  if (hello.stop) { log(`Not needed: ${hello.reason}`); fs.writeFileSync(SUMMARY_FILE, '[]'); return 'not needed: ' + hello.reason; }
  SCRAPE_DATE = hello.scrape_date; SCRAPE_HOUR = hello.scrape_hour; DRY_RUN = !!hello.dry_run;
  log(`Run ${RUN_ID} · machine ${MACHINE_NO} · ${SCRAPE_DATE} ${SCRAPE_HOUR} · dry_run=${DRY_RUN}`);

  const summaries = [];
  // Known partners + current images (one read per machine).
  const branches = await fetchAll(
    'deliveroo_branch',
    'deliveroo_branch_partner_id,deliveroo_branch_image_url',
    'deliveroo_branch_partner_id'
  );
  const known = new Map(branches.map(b => [b.deliveroo_branch_partner_id, b.deliveroo_branch_image_url]));
  log(`Known partners: ${known.size}`);

  let gapSeconds = 20, endReason = 'finished';
  for (;;) {
    const c = await rpc('deliveroo_ranking_claim', { p_run_id: RUN_ID, p_machine_no: MACHINE_NO });
    if (c.done) { log(`No more areas for this machine: ${c.reason}`); endReason = c.reason; break; }
    if (!c.area) {
      log(`Paused – ${c.reason} (checking again in ${c.wait_seconds}s)`);
      await sleep(Math.max(5, Number(c.wait_seconds) || 5) * 1000);
      continue;
    }
    const area = c.area;
    gapSeconds = Number(c.gap_seconds) || gapSeconds;
    if (c.wait_ms > 0) await sleep(c.wait_ms);
    // The run may have been paused or stopped while this machine waited for its slot.
    const chk = await rpc('deliveroo_ranking_check', { p_run_id: RUN_ID, p_machine_no: MACHINE_NO });
    if (!chk.go) {
      await rpc('deliveroo_ranking_report', { p_run_id: RUN_ID, p_area_id: area.deliveroo_area_id, p_machine_no: MACHINE_NO, p_result: { status: 'released' } });
      if (chk.run_status !== 'running' || chk.machine_status !== 'working') { log(`Stopping: ${chk.reason || chk.run_status}`); endReason = chk.reason || 'run stopped'; break; }
      continue;
    }
    if (c.batch_break) log('Planned break for all machines after this area.');
    const t0 = Date.now();
    const s = {
      machine: MACHINE_NO, run_id: RUN_ID, area_id: area.deliveroo_area_id, area_name: area.deliveroo_area_name,
      status: null, http_status: null, bytes: 0, fetch_ms: 0, total_ms: 0, rate_limits: 0,
      declared_count: null, cards: 0, ranking_rows: 0, pending_rows: 0, queued_partners: 0, replaced_rows: 0,
      delivery_pairs_added: 0, images_updated: 0, rank_gaps: 0, duplicate_partners: 0,
      rated: 0, not_rated: 0, new: 0, open: 0, closed: 0, fast: 0, with_promo: 0, sponsored: 0,
      scope: {}, unknown_promos: {}, anomalies: {}, image_examples: [],
      source: 'mobile_graphql',
      error: null,
    };

    try {
      const lat = Number(area.deliveroo_area_latitude);
      const lng = Number(area.deliveroo_area_longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw Object.assign(new Error('area has no latitude/longitude'), { code: 'no_coords' });
      }

      const tf = Date.now();
      const page = await fetchMobileListing(lat, lng);
      s.fetch_ms = Date.now() - tf;
      s.http_status = page.status;
      if (page.status === 429) { s.rate_limits = 1; throw Object.assign(new Error('http_429'), { code: 'rate_limited' }); }
      if (page.status === 403) throw Object.assign(new Error('http_403'), { code: 'blocked' });
      if (!page.body) throw Object.assign(new Error(page.error || 'fetch_failed'), { code: 'fetch_failed' });
      s.bytes = Buffer.byteLength(page.body);
      if (page.status !== 200) throw Object.assign(new Error(`http_${page.status}`), { code: `http_${page.status}` });

      const parsed = parseListing(page.body);
      if (parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.error });

      s.declared_count = parsed.declaredCount;
      s.cards = parsed.cards.length;
      s.unknown_promos = parsed.unknownPromos;
      for (const a of parsed.anomalies) s.anomalies[a] = (s.anomalies[a] || 0) + 1;

      // Duplicates / rank checks (ranking-parse-mobile.js already dedupes, but keep the counters)
      const seen = new Set();
      const cards = [];
      for (const c of parsed.cards) {
        if (seen.has(c.partnerId)) { s.duplicate_partners++; continue; }
        seen.add(c.partnerId);
        cards.push(c);
      }
      s.rank_gaps = parsed.cards.filter((c, i) => c.row.deliveroo_listing_rank !== i + 1).length;

      // Resolve {city, area} slugs from the stored area URL once per area, so
      // we can construct the restaurant-page URL for each unknown partner.
      // See constructCardUrl() for the URL pattern (no random hash suffix).
      const areaSlugs = parseAreaUrl(area.deliveroo_area_url);
      if (!areaSlugs) s.anomalies['area_url_unparseable'] = (s.anomalies['area_url_unparseable'] || 0) + 1;

      const base = {
        deliveroo_area_id: area.deliveroo_area_id,
        deliveroo_area_scrape_date: SCRAPE_DATE,
        deliveroo_area_scrape_hour: SCRAPE_HOUR,
      };
      const rankingRows = [];
      const pendingRows = [];
      const queueRows = [];
      const imageUpdates = [];

      for (const c of cards) {
        const r = c.row;
        s[r.deliveroo_partner_rating_status]++;
        s[r.deliveroo_partner_operating_status]++;
        if (r.deliveroo_partner_fast_tag_visible) s.fast++;
        if (r.deliveroo_partner_has_promo_badge) s.with_promo++;
        if (r.deliveroo_partner_is_sponsored) s.sponsored++;
        const sc = r.deliveroo_partner_promo_scope || (r.deliveroo_partner_has_promo_badge ? 'unrecognised' : 'no_badge');
        s.scope[sc] = (s.scope[sc] || 0) + 1;

        const row = { deliveroo_branch_partner_id: c.partnerId, ...base, ...r };
        if (known.has(c.partnerId)) {
          rankingRows.push(row);
          const stored = known.get(c.partnerId);
          // Deliveroo's generic menu-tag pictures are not the branch's own image – ignore them.
          if (UPDATE_IMAGES && c.imageUrl && !/\/images\/menu_tags\//.test(c.imageUrl) && imageBase(c.imageUrl) !== imageBase(stored)) {
            // Keep the stored URL's query template if there is one; swap only the image path.
            const q = stored && stored.includes('?') ? stored.slice(stored.indexOf('?')) : (c.imageUrl.includes('?') ? c.imageUrl.slice(c.imageUrl.indexOf('?')) : '');
            imageUpdates.push({ partnerId: c.partnerId, name: c.name, stored: imageBase(stored), url: imageBase(c.imageUrl) + q });
          }
        } else {
          pendingRows.push(row);
          // Construct the card URL — Deliveroo's URL pattern is deterministic
          // from (city-slug, area-slug, name-slug), no random hash. If an area
          // URL couldn't be parsed, we fall back to '' (register-branch will
          // mark the partner failed; a later retry can use another area).
          const cardUrl = constructCardUrl(areaSlugs, c.name);
          queueRows.push({
            deliveroo_branch_partner_id: c.partnerId,
            deliveroo_branch_id: c.branchId,
            deliveroo_partner_card_name: c.name,
            deliveroo_partner_card_url: cardUrl,
            deliveroo_partner_card_image_url: c.imageUrl,
            deliveroo_area_id: area.deliveroo_area_id,
          });
        }
      }

      s.ranking_rows = rankingRows.length;
      s.pending_rows = pendingRows.length;
      s.queued_partners = queueRows.length;
      s.images_updated = 0;

      if (!DRY_RUN) {
        // One transaction per area+hour: clear that hour's rows, then insert the fresh listing.
        // A re-run of the same hour therefore replaces rather than mixes.
        // Rows go as compact arrays (see toCompact) – about 4x smaller than objects with
        // column names, and far quicker for the database to read.
        const res = await supabase('/rpc/deliveroo_ranking_save_area_hour', 'POST', {
          p_area_id: area.deliveroo_area_id,
          p_date: SCRAPE_DATE,
          p_hour: SCRAPE_HOUR,
          p_rows: rankingRows.map(toCompact),
          p_pending: pendingRows.map(toCompact),
        });
        s.replaced_rows = res?.deleted ?? 0;
        // Supabase adds any new (partner, area) links itself inside that call and skips duplicates.
        s.delivery_pairs_added = res?.pairs_added ?? 0;
        if (res && (res.inserted !== rankingRows.length || res.inserted_pending !== pendingRows.length)) {
          throw new Error(`insert count mismatch: ${JSON.stringify(res)}`);
        }
        if (queueRows.length) {
          await writeChunks('/deliveroo_partner_registration_queue?on_conflict=deliveroo_branch_partner_id',
            queueRows, 'resolution=ignore-duplicates,return=minimal');
        }
        // Supabase applies the image rule (skip generic pictures, at most one change per
        // branch per 24h, log every change) and says whether it changed anything.
        for (const u of imageUpdates) {
          const changed = await supabase('/rpc/deliveroo_branch_update_image', 'POST',
            { p_partner_id: u.partnerId, p_new_url: u.url, p_area_id: area.deliveroo_area_id });
          if (changed === true) {
            s.images_updated++;
            if (s.image_examples.length < 5) {
              s.image_examples.push({ partner: u.partnerId, name: u.name, stored: u.stored, card: imageBase(u.url) });
            }
          }
          known.set(u.partnerId, u.url);
        }
      }
      s.status = DRY_RUN ? 'ok_dry_run' : 'ok';
    } catch (e) {
      s.status = e.code || 'error';
      s.error = e.message.slice(0, 300);
    }

    s.total_ms = Date.now() - t0;

    // Report to Supabase: it records the area and decides what this machine does next.
    const outcome = /^ok/.test(s.status) ? s.status.replace('_dry_run', '')
      : ['rate_limited', 'blocked', 'no_coords'].includes(s.status) ? s.status : 'failed';
    const rep = await rpc('deliveroo_ranking_report', {
      p_run_id: RUN_ID, p_area_id: area.deliveroo_area_id, p_machine_no: MACHINE_NO,
      p_result: { status: outcome, http_status: s.http_status, cards: s.cards, ranking_rows: s.ranking_rows,
                  pending_rows: s.pending_rows, bytes: s.bytes, fetch_ms: s.fetch_ms,
                  sponsored: s.sponsored, source: s.source, error: s.error },
    });
    // On 429: Supabase stops this machine and dispatches a replacement from the pool.
    if (s.status === 'rate_limited' && rep.action === 'stop_job') s.status = 'requeued_429';
    if (s.status === 'blocked' && rep.action === 'stop_job') s.status = 'requeued_403';
    summaries.push(s);
    log(`${String(area.deliveroo_area_id).padStart(6)} ${area.deliveroo_area_name.padEnd(28)} ${s.status.padEnd(11)} ` +
        `cards=${s.cards}/${s.declared_count ?? '?'} rank=${s.ranking_rows} pend=${s.pending_rows} ` +
        `spons=${s.sponsored} pairs+${s.delivery_pairs_added} img~${s.images_updated} ` +
        `${(s.bytes / 1048576).toFixed(1)}MB ${s.total_ms}ms` +
        (s.error ? `  ERROR ${s.error}` : ''));
    // Keep the summary on disk after every area so a cancelled machine still reports.
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaries, null, 1));

    if (rep.action === 'stop_job') {
      const replaced = rep.replaced ? ` Replacement machine ${rep.replacement_machine} dispatched.` : ' No replacement (pool exhausted or no work left).';
      log(`429/403 – Supabase stopped this machine.${replaced}`);
      endReason = rep.reason || 'stopped by Supabase'; process.exitCode = 2; break;
    }
    if (rep.action === 'stop') { log('Run stopped by Supabase (second 403).'); endReason = 'run stopped (second 403)'; process.exitCode = 2; break; }
  }

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaries, null, 1));
  if (summaries.some(s => s.status === 'failed' || s.status === 'fetch_failed' || /^http_|^parse|^error/.test(s.status))) {
    process.exitCode = process.exitCode || 1;
  }
  return endReason;
}

if (require.main === module) {
  (async () => {
    let reason = 'finished';
    try {
      reason = (await main()) || 'finished';
    } catch (e) {
      console.error('FATAL:', e.message || e);
      reason = 'crashed: ' + String(e.message || e).slice(0, 200);
      try { if (!fs.existsSync(SUMMARY_FILE)) fs.writeFileSync(SUMMARY_FILE, JSON.stringify([{ machine: MACHINE_NO, status: 'fatal', error: String(e.message || e) }])); } catch (_) {}
      process.exitCode = 1;
    } finally {
      if (RUN_ID && MACHINE_NO) {
        try { await rpc('deliveroo_ranking_machine_end', { p_run_id: RUN_ID, p_machine_no: MACHINE_NO, p_reason: reason }); }
        catch (e) { console.error('Could not report machine end:', e.message); }
      }
    }
  })();
}
