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
//                                        stop the run. A refusal on this machine's FIRST request
//                                        means its address was already flagged: Supabase retires
//                                        the machine and starts a replacement (capped). A refusal
//                                        after working means our pace: everyone pauses and slows.
//   6. deliveroo_ranking_machine_end   – always, when the machine stops for any reason
//
// For each area:
//   1. Fetch the area's full listing page (deliveroo_area.deliveroo_area_url).
//   2. Read every restaurant card in order -> rank 1..N plus rating, open/closed,
//      fast tag and promo badge.
//   3. Known partners  -> deliveroo_ranking_analysis. Unknown partners -> deliveroo_ranking_pending
//      + deliveroo_partner_registration_queue. The save call also adds new (partner, area) links.
//   4. Update deliveroo_branch.deliveroo_branch_image_url when the card image changed.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RUN_ID, MACHINE_NO, GITHUB_RUN_ID,
//      UPDATE_IMAGES ("true" default), SUMMARY_FILE (default summary.json)

const fs = require('fs');
const { parseListing, imageBase } = require('./ranking-parse');

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

// 429 and 403 are returned straight away (no retry here): Supabase decides what happens next.
async function fetchPage(url) {
  let errors = 0, lastErr = null;
  while (errors <= MAX_RETRIES) {
    try {
      const resp = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      if (resp.status === 429 || resp.status === 403) {
        await resp.text().catch(() => {});
        return { status: resp.status, html: null, error: `http_${resp.status}` };
      }
      if (resp.status >= 500) {
        errors++; lastErr = `http_${resp.status}`;
        if (errors > MAX_RETRIES) break;
        await sleep(RETRY_DELAY_MS * errors);
        continue;
      }
      const html = await resp.text();
      return { status: resp.status, html };
    } catch (e) {
      errors++; lastErr = e.message;
      if (errors > MAX_RETRIES) break;
      await sleep(RETRY_DELAY_MS * errors);
    }
  }
  return { status: null, html: null, error: lastErr };
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

  let lastFetchAt = 0, gapSeconds = 20, endReason = 'finished';
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
      rated: 0, not_rated: 0, new: 0, open: 0, closed: 0, fast: 0, with_promo: 0,
      scope: {}, unknown_promos: {}, anomalies: {}, image_examples: [], error: null,
    };

    try {
      const tf = Date.now();
      const listing = toListingUrl(area.deliveroo_area_url);
      s.url_fixed = listing.fixed;
      if (listing.fixed) log(`  stored URL not in listing format – using ${listing.url}`);
      let page = await fetchPage(listing.url);
      lastFetchAt = Date.now();
      s.fetch_ms = Date.now() - tf;
      s.http_status = page.status;
      if (page.status === 429) { s.rate_limits = 1; throw Object.assign(new Error('http_429'), { code: 'rate_limited' }); }
      if (page.status === 403) throw Object.assign(new Error('http_403'), { code: 'blocked' });
      if (!page.html) throw Object.assign(new Error(page.error || 'fetch_failed'), { code: 'fetch_failed' });
      s.bytes = Buffer.byteLength(page.html);
      // 404 = Deliveroo has no public listing for this area. Not an error: no data this hour.
      if (page.status === 404) throw Object.assign(new Error('no public listing page (404)'), { code: 'not_found' });
      if (page.status !== 200) throw Object.assign(new Error(`http_${page.status}`), { code: `http_${page.status}` });

      let parsed = parseListing(page.html);
      if (parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.error });

      // Some areas (e.g. JBR) show 0 restaurants at Deliveroo's default point for the area
      // but a full list at a real address. Retry once at the area's stored geohash.
      if (parsed.cards.length === 0 && area.deliveroo_area_geohash && !/[?&]geohash=/.test(listing.url)) {
        const wait = lastFetchAt + gapSeconds * 1000 - Date.now();
        if (wait > 0) await sleep(wait);
        const geoUrl = `${listing.url}&geohash=${encodeURIComponent(area.deliveroo_area_geohash)}`;
        const retry = await fetchPage(geoUrl);
        lastFetchAt = Date.now();
        s.geohash_retry = retry.status;
        if (retry.html && retry.status === 200) {
          const p2 = parseListing(retry.html);
          if (!p2.error && p2.cards.length > 0) {
            page = retry; parsed = p2; s.bytes = Buffer.byteLength(retry.html); s.used_geohash = true;
            log(`  0 cards at default point – ${p2.cards.length} at stored geohash`);
          }
        }
      }

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
          // Deliveroo's generic menu-tag pictures are not the branch's own image – ignore them.
          if (UPDATE_IMAGES && c.imageUrl && !/\/images\/menu_tags\//.test(c.imageUrl) && imageBase(c.imageUrl) !== imageBase(stored)) {
            // Keep the stored URL's query template if there is one; swap only the image path.
            const q = stored && stored.includes('?') ? stored.slice(stored.indexOf('?')) : (c.imageUrl.includes('?') ? c.imageUrl.slice(c.imageUrl.indexOf('?')) : '');
            imageUpdates.push({ partnerId: c.partnerId, name: c.name, stored: imageBase(stored), url: imageBase(c.imageUrl) + q });
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
      if (s.used_geohash) s.status += '_geohash';
    } catch (e) {
      s.status = e.code || 'error';
      s.error = e.message.slice(0, 300);
      if (s.status === 'not_found') s.error = null;
    }

    s.total_ms = Date.now() - t0;

    // Report to Supabase: it records the area and decides what this machine does next.
    const outcome = /^ok/.test(s.status) ? s.status.replace('_dry_run', '')
      : ['not_found', 'rate_limited', 'blocked'].includes(s.status) ? s.status : 'failed';
    const rep = await rpc('deliveroo_ranking_report', {
      p_run_id: RUN_ID, p_area_id: area.deliveroo_area_id, p_machine_no: MACHINE_NO,
      p_result: { status: outcome, http_status: s.http_status, cards: s.cards, ranking_rows: s.ranking_rows,
                  pending_rows: s.pending_rows, bytes: s.bytes, fetch_ms: s.fetch_ms, error: s.error },
    });
    if (s.status === 'rate_limited' && (rep.requeued || rep.flagged_address)) s.status = 'requeued_429';
    if (s.status === 'blocked' && rep.flagged_address) s.status = 'requeued_403';
    summaries.push(s);
    log(`${String(area.deliveroo_area_id).padStart(6)} ${area.deliveroo_area_name.padEnd(28)} ${s.status.padEnd(11)} ` +
        `cards=${s.cards}/${s.declared_count ?? '?'} rank=${s.ranking_rows} pending=${s.pending_rows} ` +
        `pairs+${s.delivery_pairs_added} img~${s.images_updated} ${(s.bytes / 1048576).toFixed(1)}MB ${s.total_ms}ms` +
        (s.error ? `  ERROR ${s.error}` : ''));
    // Keep the summary on disk after every area so a cancelled machine still reports.
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaries, null, 1));

    if (rep.flagged_address) {
      log(`Refused on this machine's first request – its address was already flagged. Supabase retired this machine` +
          (rep.replacement_machine ? ` and started machine ${rep.replacement_machine}.` : ' (replacement limit reached).'));
      endReason = 'flagged address'; break;
    }
    if (rep.paused_seconds) log(`429 – Supabase paused all machines for ${rep.paused_seconds}s; pace now ${rep.gap_seconds}s.`);
    if (rep.action === 'stop_job') { log(`Supabase stopped this machine${rep.reason ? `: ${rep.reason}` : ' (403 after working – not replaced)'}.`); endReason = rep.reason || '403 after working'; process.exitCode = 2; break; }
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
