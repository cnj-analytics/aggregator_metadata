// ranking-scrape.js
//
// Deliveroo UAE – hourly area ranking scrape (one job of JOB_COUNT).
//
// For each active area assigned to this job:
//   1. Fetch the area's full listing page (deliveroo_area.deliveroo_area_url).
//   2. Read every restaurant card in order -> rank 1..N plus rating, open/closed,
//      fast tag and promo badge.
//   3. Known partners  -> deliveroo_ranking_analysis (upsert on the unique index).
//      Unknown partners -> deliveroo_ranking_pending + deliveroo_partner_registration_queue.
//   4. (Supabase) the save call also adds new (partner, area) links to
//      deliveroo_branch_delivery_area, skipping ones that already exist.
//   5. Update deliveroo_branch.deliveroo_branch_image_url when the card image changed.
//   6. Write a per-area summary (JSON) for the report job.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   JOB_INDEX (0-based), JOB_COUNT (15)
//   SCRAPE_DATE (YYYY-MM-DD, Dubai), SCRAPE_HOUR (HH:00) – set once by the setup job
//   AREA_IDS   (optional, comma list; empty = all active areas)
//   DRY_RUN    ("true" = read and parse only, write nothing)
//   UPDATE_IMAGES ("true" default)
//   SUMMARY_FILE (default summary.json)

const fs = require('fs');
const { parseListing, imageBase } = require('./ranking-parse');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JOB_INDEX = parseInt(process.env.JOB_INDEX || '0', 10);
const JOB_COUNT = parseInt(process.env.JOB_COUNT || '15', 10);
const SCRAPE_DATE = process.env.SCRAPE_DATE;
const SCRAPE_HOUR = process.env.SCRAPE_HOUR;
const AREA_IDS = (process.env.AREA_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';
const UPDATE_IMAGES = (process.env.UPDATE_IMAGES || 'true').toLowerCase() === 'true';
const SUMMARY_FILE = process.env.SUMMARY_FILE || 'summary.json';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const MAX_RATE_LIMIT_RETRIES = 2; // wait 60s, then 120s, then skip the area
const RATE_LIMIT_INITIAL_BACKOFF_MS = 60000;
const DELAY_BETWEEN_AREAS_MS = 2000;
const MAX_CONSECUTIVE_BLOCKS = 3;
const MAX_403_RETRIES = 2;
const BLOCK_RETRY_DELAY_MS = 20000;
const WRITE_CHUNK = 1000;
const START_STAGGER_MS = 3000; // used only when pacing is off (small manual runs)
// Pacing: each job spreads its areas evenly over SPREAD_MINUTES, and the jobs are offset
// from each other, so requests to Deliveroo (and writes to Supabase) arrive at a steady
// rate across the hour instead of in bursts. Default 20 for full runs, 0 (off) when
// AREA_IDS is given.
const SPREAD_MINUTES = process.env.SPREAD_MINUTES !== undefined && process.env.SPREAD_MINUTES !== ''
  ? Number(process.env.SPREAD_MINUTES)
  : (AREA_IDS.length ? 0 : 20);

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

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
//  has_promo, has_free_delivery_promo, has_non_delivery_promo, promo_text, promo_scope]
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
  ];
}

// --- Area URL ---------------------------------------------------------------------
// The full listing needs ?collection=restaurants&collection=all-restaurants. Whatever
// is stored in deliveroo_area_url, rebuild it to that form: keep the path and any other
// query parameters, drop any existing collection values, then add the two required ones.
// Returns { url, fixed } – fixed=true when the stored URL was not already correct.
const LISTING_COLLECTIONS = ['restaurants', 'all-restaurants'];

function toListingUrl(stored) {
  const u = new URL(String(stored).trim());
  const current = u.searchParams.getAll('collection');
  u.searchParams.delete('collection');
  for (const c of LISTING_COLLECTIONS) u.searchParams.append('collection', c);
  const fixed = current.join(',') !== LISTING_COLLECTIONS.join(',');
  return { url: u.toString(), fixed };
}

// --- Page fetch -----------------------------------------------------------------

async function fetchPage(url) {
  let errors = 0, rateLimits = 0, blocks = 0, lastErr = null;
  while (errors <= MAX_RETRIES && rateLimits <= MAX_RATE_LIMIT_RETRIES) {
    try {
      const resp = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      // An occasional one-off 403: wait and try again (20s, then 40s) before giving up.
      if (resp.status === 403 && blocks < MAX_403_RETRIES) {
        blocks++;
        await resp.text().catch(() => {});
        log(`  403 – retrying in ${(BLOCK_RETRY_DELAY_MS * blocks) / 1000}s`);
        await sleep(BLOCK_RETRY_DELAY_MS * blocks);
        continue;
      }
      if (resp.status === 429) {
        rateLimits++; lastErr = 'http_429';
        if (rateLimits > MAX_RATE_LIMIT_RETRIES) break;
        const wait = RATE_LIMIT_INITIAL_BACKOFF_MS * rateLimits;
        log(`  429 – backing off ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (resp.status >= 500) {
        errors++; lastErr = `http_${resp.status}`;
        if (errors > MAX_RETRIES) break;
        await sleep(RETRY_DELAY_MS * errors);
        continue;
      }
      const html = await resp.text();
      return { status: resp.status, html, rateLimits, blocks };
    } catch (e) {
      errors++; lastErr = e.message;
      if (errors > MAX_RETRIES) break;
      await sleep(RETRY_DELAY_MS * errors);
    }
  }
  return { status: null, html: null, rateLimits, error: lastErr };
}

// --- Main -------------------------------------------------------------------------

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(SCRAPE_DATE || '') || !/^\d{2}:00$/.test(SCRAPE_HOUR || '')) {
    throw new Error(`Bad SCRAPE_DATE/SCRAPE_HOUR: ${SCRAPE_DATE} ${SCRAPE_HOUR}`);
  }

  // Areas: active only, stable order, round-robin across jobs.
  let areas = await fetchAll(
    'deliveroo_area',
    'deliveroo_area_id,deliveroo_area_name,deliveroo_area_url',
    'deliveroo_area_id',
    '&deliveroo_area_is_active=is.true'
  );
  if (AREA_IDS.length) areas = areas.filter(a => AREA_IDS.includes(String(a.deliveroo_area_id)));
  // JOB_COUNT can be lowered for tests (e.g. 1); matrix jobs above it do nothing.
  if (JOB_INDEX >= JOB_COUNT) {
    log(`Job ${JOB_INDEX + 1} not used (job_count=${JOB_COUNT}).`);
    fs.writeFileSync(SUMMARY_FILE, '[]');
    return;
  }
  const mine = areas.filter((_, i) => i % JOB_COUNT === JOB_INDEX);
  log(`Job ${JOB_INDEX + 1}/${JOB_COUNT} · ${SCRAPE_DATE} ${SCRAPE_HOUR} · dry_run=${DRY_RUN} · ${mine.length} of ${areas.length} areas`);

  const summaries = [];
  if (!mine.length) {
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaries));
    return;
  }

  const slotMs = SPREAD_MINUTES > 0 ? (SPREAD_MINUTES * 60000) / mine.length : 0;
  const t0Run = Date.now();
  const offsetMs = slotMs ? Math.round((JOB_INDEX * slotMs) / JOB_COUNT) : JOB_INDEX * START_STAGGER_MS;
  if (slotMs) log(`Pacing: one area every ${(slotMs / 1000).toFixed(0)}s over ${SPREAD_MINUTES} min, offset ${(offsetMs / 1000).toFixed(0)}s`);

  // Known partners + current images (one read per job).
  const branches = await fetchAll(
    'deliveroo_branch',
    'deliveroo_branch_partner_id,deliveroo_branch_image_url',
    'deliveroo_branch_partner_id'
  );
  const known = new Map(branches.map(b => [b.deliveroo_branch_partner_id, b.deliveroo_branch_image_url]));
  log(`Known partners: ${known.size}`);

  let consecutiveBlocks = 0;

  for (const [ai, area] of mine.entries()) {
    // Wait for this area's slot (area 0 at the job offset, then every slotMs).
    const due = t0Run + offsetMs + ai * slotMs;
    if (Date.now() < due) await sleep(due - Date.now());
    const t0 = Date.now();
    const s = {
      job: JOB_INDEX, area_id: area.deliveroo_area_id, area_name: area.deliveroo_area_name,
      status: null, http_status: null, bytes: 0, fetch_ms: 0, total_ms: 0, rate_limits: 0,
      declared_count: null, cards: 0, ranking_rows: 0, pending_rows: 0, queued_partners: 0, replaced_rows: 0,
      delivery_pairs_added: 0, images_updated: 0, rank_gaps: 0, duplicate_partners: 0,
      rated: 0, not_rated: 0, new: 0, open: 0, closed: 0, fast: 0, with_promo: 0,
      scope: {}, unknown_promos: {}, anomalies: {}, image_examples: [], error: null,
    };

    try {
      const tf = Date.now();
      const listing = toListingUrl(area.deliveroo_area_url);
      s.url_fixed = listing.fixed;
      if (listing.fixed) log(`  stored URL not in listing format – using ${listing.url}`);
      const page = await fetchPage(listing.url);
      s.fetch_ms = Date.now() - tf;
      s.rate_limits = page.rateLimits;
      s.http_status = page.status;
      if (!page.html) throw Object.assign(new Error(page.error || 'fetch_failed'), { code: 'fetch_failed' });
      s.bytes = Buffer.byteLength(page.html);
      if (page.status !== 200) throw Object.assign(new Error(`http_${page.status}`), { code: `http_${page.status}` });

      const parsed = parseListing(page.html);
      if (parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.error });
      consecutiveBlocks = 0;

      s.declared_count = parsed.declaredCount;
      s.cards = parsed.cards.length;
      s.unknown_promos = parsed.unknownPromos;
      for (const a of parsed.anomalies) s.anomalies[a] = (s.anomalies[a] || 0) + 1;

      // Duplicates / rank checks
      const seen = new Set();
      const cards = [];
      for (const c of parsed.cards) {
        if (seen.has(c.partnerId)) { s.duplicate_partners++; continue; }
        seen.add(c.partnerId);
        cards.push(c);
      }
      // Ranks come straight from card order, so this should always be 0.
      s.rank_gaps = parsed.cards.filter((c, i) => c.row.deliveroo_listing_rank !== i + 1).length;

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
        const sc = r.deliveroo_partner_promo_scope || (r.deliveroo_partner_has_promo_badge ? 'unrecognised' : 'no_badge');
        s.scope[sc] = (s.scope[sc] || 0) + 1;

        const row = { deliveroo_branch_partner_id: c.partnerId, ...base, ...r };
        if (known.has(c.partnerId)) {
          rankingRows.push(row);
          const stored = known.get(c.partnerId);
          if (UPDATE_IMAGES && c.imageUrl && imageBase(c.imageUrl) !== imageBase(stored)) {
            // Keep the stored URL's query template if there is one; swap only the image path.
            const q = stored && stored.includes('?') ? stored.slice(stored.indexOf('?')) : (c.imageUrl.includes('?') ? c.imageUrl.slice(c.imageUrl.indexOf('?')) : '');
            imageUpdates.push({ partnerId: c.partnerId, url: imageBase(c.imageUrl) + q });
            if (s.image_examples.length < 5) {
              s.image_examples.push({ partner: c.partnerId, name: c.name, stored: imageBase(stored), card: imageBase(c.imageUrl) });
            }
          }
        } else {
          pendingRows.push(row);
          queueRows.push({
            deliveroo_branch_partner_id: c.partnerId,
            deliveroo_branch_id: c.branchId,
            deliveroo_partner_card_name: c.name,
            deliveroo_partner_card_url: c.cardUrl || '',
            deliveroo_partner_card_image_url: c.imageUrl,
            deliveroo_area_id: area.deliveroo_area_id,
          });
        }
      }

      s.ranking_rows = rankingRows.length;
      s.pending_rows = pendingRows.length;
      s.queued_partners = queueRows.length;
      s.images_updated = imageUpdates.length;

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
        for (const u of imageUpdates) {
          await supabase(
            `/deliveroo_branch?deliveroo_branch_partner_id=eq.${encodeURIComponent(u.partnerId)}`,
            'PATCH', { deliveroo_branch_image_url: u.url }, { Prefer: 'return=minimal' }
          );
          known.set(u.partnerId, u.url);
        }
      }
      s.status = DRY_RUN ? 'ok_dry_run' : 'ok';
    } catch (e) {
      s.status = e.code || 'error';
      s.error = e.message.slice(0, 300);
      if (/^http_(403|429)|fetch_failed/.test(s.status)) consecutiveBlocks++;
    }

    s.total_ms = Date.now() - t0;
    summaries.push(s);
    log(`${String(area.deliveroo_area_id).padStart(6)} ${area.deliveroo_area_name.padEnd(28)} ${s.status.padEnd(11)} ` +
        `cards=${s.cards}/${s.declared_count ?? '?'} rank=${s.ranking_rows} pending=${s.pending_rows} ` +
        `pairs+${s.delivery_pairs_added} img~${s.images_updated} ${(s.bytes / 1048576).toFixed(1)}MB ${s.total_ms}ms` +
        (s.error ? `  ERROR ${s.error}` : ''));

    if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
      log(`STOPPING: ${MAX_CONSECUTIVE_BLOCKS} consecutive blocked areas.`);
      process.exitCode = 2;
      break;
    }
    // Keep the summary on disk after every area so a cancelled job still reports.
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaries, null, 1));
    if (!slotMs) await sleep(DELAY_BETWEEN_AREAS_MS);
  }

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaries, null, 1));
  if (summaries.some(s => !/^ok/.test(s.status))) process.exitCode = process.exitCode || 1;
}

if (require.main === module) {
  main().catch(e => {
    console.error('FATAL:', e.message || e);
    try { fs.writeFileSync(SUMMARY_FILE, JSON.stringify([{ job: JOB_INDEX, status: 'fatal', error: String(e.message || e) }])); } catch (_) {}
    process.exit(1);
  });
}
