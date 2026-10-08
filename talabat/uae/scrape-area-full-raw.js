// scrape-area-full-raw.js
//
// Talabat UAE — ONE-OFF vetting scrape of a single area, capturing EVERYTHING
// the composite-list endpoint returns so we can inspect what fields are
// available before designing the real ranking schema.
//
// For each page of the vendor-list composite-list response:
//   - every vendor card goes into talabat_test_bb_card (bid + a few extracted
//     fields for scanning, plus raw_card jsonb = source of truth)
//   - every non-vendor top-level key (promotions, filters, sections, hero,
//     collections, chip strips, etc.) goes into talabat_test_bb_section with
//     its key_path and raw_section jsonb
//
// Pagination: loops page=1..N until vendors array comes back empty, or hits
// MAX_PAGES (default 50) to prevent runaway. Pacing CALL_DELAY_MS between
// pages per worker IP (default 1500).
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   AREA_ID          default 1252 (Business Bay)
//   LAT, LNG         default 25.184, 55.2676
//   VERTICAL_ID      default 0 (restaurants)
//   PAGE_SIZE        default 1000
//   CALL_DELAY_MS    default 1500
//   MAX_PAGES        default 50

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AREA_ID       = parseInt(process.env.AREA_ID || '1252', 10);
const LAT           = process.env.LAT || '25.184';
const LNG           = process.env.LNG || '55.2676';
const VERTICAL_ID   = parseInt(process.env.VERTICAL_ID || '0', 10);
const PAGE_SIZE     = parseInt(process.env.PAGE_SIZE || '1000', 10);
const CALL_DELAY_MS = parseInt(process.env.CALL_DELAY_MS || '1500', 10);
const MAX_PAGES     = parseInt(process.env.MAX_PAGES || '50', 10);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Supabase ---------------------------------------------------------------

async function supabase(path, method, body = null, extraHeaders = {}) {
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
    throw new Error(`Supabase ${method} ${path.split('?')[0]} -> ${resp.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

// --- Talabat ---------------------------------------------------------------

const TALABAT_HEADERS = {
  'User-Agent': 'talabat/8701 CFNetwork/3896.100.1.2.1 Darwin/27.0.0',
  'Accept': '*/*',
  'Accept-Language': 'en-US',
  'Accept-Encoding': 'gzip, deflate, br',
  'appbrand': '1',
  'x-country': 'ae',
  'x-app-version': '13.93.0',
  'x-device-version': '13.93.0',
  'x-device-source': '4',
  'x-device-framework': 'flutter',
  'x-marshmallow-version': 'mm3',
  'http2-enabled': 'true',
  'tokentypekey': 'jwt',
  'Content-Length': '0',
};

async function fetchPage(page) {
  const url = `https://api.talabat.com/vendor-list/v1/composite-list/${LAT}/${LNG}` +
              `?countrycode=4&areaid=${AREA_ID}&vertical_id=${VERTICAL_ID}` +
              `&isCustomerPro=false&page=${page}&size=${PAGE_SIZE}`;
  const t0 = Date.now();
  const resp = await fetch(url, { method: 'GET', headers: TALABAT_HEADERS });
  const text = await resp.text();
  return { status: resp.status, text, elapsed: Date.now() - t0, url };
}

// Walk a parsed response and locate the vendors array + treat everything else
// as a "section". Talabat has shuffled this shape over versions, so we probe
// several known paths rather than hard-coding one.
function extractVendorsAndSections(parsed, pageNum) {
  const sections = [];
  const seenPaths = new Set();
  let vendors = null;
  let vendorsPath = null;

  // Known vendor array locations, in order of priority:
  const candidates = [
    () => parsed?.vendors,
    () => parsed?.data?.vendors,
    () => parsed?.result?.vendors,
    () => parsed?.restaurants,
    () => parsed?.data?.restaurants,
  ];
  const candidateNames = ['vendors', 'data.vendors', 'result.vendors', 'restaurants', 'data.restaurants'];
  for (let i = 0; i < candidates.length; i++) {
    const v = candidates[i]();
    if (Array.isArray(v) && v.length > 0) {
      vendors = v;
      vendorsPath = candidateNames[i];
      break;
    }
    if (Array.isArray(v) && vendors == null) {
      // Keep the first empty-array match in case nothing has data (last page)
      vendors = v;
      vendorsPath = candidateNames[i];
    }
  }
  if (vendors == null) {
    vendors = [];
    vendorsPath = '(none)';
  }

  // Record EVERYTHING else at the top level — and one level deep inside
  // common containers — as a section row for inspection.
  const skipKeys = new Set(['vendors', 'restaurants']);
  function visit(obj, prefix) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const k of Object.keys(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (skipKeys.has(k) && !prefix) continue;      // top-level vendors array
      if (path === vendorsPath) continue;             // skip the chosen vendors path
      if (seenPaths.has(path)) continue;
      const v = obj[k];
      if (v === null || v === undefined) continue;
      // Keep going into 'data' / 'result' wrappers so we don't miss sections
      // nested one level in; otherwise capture at this level.
      if ((k === 'data' || k === 'result') && typeof v === 'object' && !Array.isArray(v)) {
        visit(v, path);
        continue;
      }
      seenPaths.add(path);
      sections.push({
        page: pageNum,
        key_path: path,
        item_count: Array.isArray(v) ? v.length : 1,
        raw_section: v,
      });
    }
  }
  visit(parsed, '');

  return { vendors, vendorsPath, sections };
}

// Pull a few obvious fields from a card for easy scanning (full raw stays jsonb).
function summarizeCard(card) {
  const bid =
    card?.branch?.id ?? card?.branchId ?? card?.bid ?? card?.id ?? null;
  const chain_id = card?.chainId ?? card?.chain_id ?? card?.vendor?.chainId ?? null;
  const name = card?.name || card?.na || card?.title || null;
  const chain_name = card?.chainName || card?.chain_name || null;
  const branch_name = card?.branchName || card?.bna || card?.branch_name || null;
  const is_sponsored =
    card?.isSponsored ?? card?.sponsored ?? card?.is_sponsored ?? null;
  const rating = card?.rating ?? card?.rat ?? card?.averageRating ?? null;
  return { bid, chain_id, name, chain_name, branch_name, is_sponsored, rating };
}

// --- Main ------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log(`Talabat test scrape — area ${AREA_ID} @ ${LAT},${LNG} vertical=${VERTICAL_ID} size=${PAGE_SIZE}`);

  // Open a run row
  const [run] = await supabase('/talabat_test_bb_run', 'POST',
    [{ area_id: AREA_ID, lat: LAT, lng: LNG, vertical_id: VERTICAL_ID }],
    { Prefer: 'return=representation' });
  const RUN_ID = run.run_id;
  console.log(`Opened run_id=${RUN_ID}`);

  let page = 1;
  let totalVendors = 0;
  let totalSections = 0;
  let totalBytes = 0;
  let lastStatus = null;
  const rootKeys = new Set();
  const vendorsCards = [];
  const sectionsAll = [];
  let error = null;
  let notes = [];

  while (page <= MAX_PAGES) {
    let r;
    try {
      r = await fetchPage(page);
    } catch (e) {
      error = `page ${page}: ${e.message}`;
      break;
    }
    lastStatus = r.status;
    totalBytes += (r.text?.length || 0);
    if (r.status < 200 || r.status >= 300) {
      error = `page ${page}: HTTP ${r.status}: ${r.text.slice(0, 200)}`;
      console.error(error);
      break;
    }
    let parsed;
    try {
      parsed = JSON.parse(r.text);
    } catch (e) {
      error = `page ${page}: non-JSON: ${e.message}`;
      break;
    }

    for (const k of Object.keys(parsed || {})) rootKeys.add(k);

    const { vendors, vendorsPath, sections } = extractVendorsAndSections(parsed, page);
    console.log(`  page ${page}: ${r.status} ${(r.text.length/1024).toFixed(1)}KB ${r.elapsed}ms vendors(${vendorsPath})=${vendors.length} sections=${sections.length}`);

    // Build card rows
    let posInPage = 0;
    for (const card of vendors) {
      posInPage++;
      const s = summarizeCard(card);
      vendorsCards.push({
        run_id: RUN_ID,
        page,
        position_in_page: posInPage,
        overall_position: totalVendors + posInPage,
        section_label: card?.sectionLabel || card?.section_label || null,
        bid: s.bid != null ? Number(s.bid) : null,
        chain_id: s.chain_id != null ? Number(s.chain_id) : null,
        chain_name: s.chain_name,
        name: s.name,
        branch_name: s.branch_name,
        is_sponsored: typeof s.is_sponsored === 'boolean' ? s.is_sponsored : null,
        rating: s.rating != null ? Number(s.rating) : null,
        raw_card: card,
      });
    }
    totalVendors += vendors.length;

    // Build section rows
    for (const s of sections) {
      sectionsAll.push({ run_id: RUN_ID, ...s });
    }
    totalSections += sections.length;

    if (vendors.length === 0) {
      notes.push(`stopped at page ${page}: empty vendors array`);
      break;
    }
    if (vendors.length < PAGE_SIZE) {
      notes.push(`stopped at page ${page}: last page (returned ${vendors.length} < size ${PAGE_SIZE})`);
      // Fetch no further
      break;
    }
    page++;
    if (page <= MAX_PAGES) await sleep(CALL_DELAY_MS);
  }

  // Flush cards in chunks (jsonb payload per card can be big)
  const CHUNK = 100;
  for (let i = 0; i < vendorsCards.length; i += CHUNK) {
    const slice = vendorsCards.slice(i, i + CHUNK);
    await supabase('/talabat_test_bb_card', 'POST', slice, { Prefer: 'return=minimal' });
    console.log(`  flushed cards ${i+1}..${i+slice.length} / ${vendorsCards.length}`);
  }
  for (let i = 0; i < sectionsAll.length; i += CHUNK) {
    const slice = sectionsAll.slice(i, i + CHUNK);
    await supabase('/talabat_test_bb_section', 'POST', slice, { Prefer: 'return=minimal' });
    console.log(`  flushed sections ${i+1}..${i+slice.length} / ${sectionsAll.length}`);
  }

  // Close the run row
  await supabase(`/talabat_test_bb_run?run_id=eq.${RUN_ID}`, 'PATCH', {
    finished_at: new Date().toISOString(),
    pages_fetched: page,
    vendors_total: totalVendors,
    sections_total: totalSections,
    bytes_total: totalBytes,
    last_http_status: lastStatus,
    raw_root_keys: Array.from(rootKeys),
    error,
    notes: notes.join(' | ') || null,
  });

  const mins = ((Date.now() - t0) / 1000 / 60).toFixed(2);
  console.log('');
  console.log('=== DONE ===');
  console.log(`run_id=${RUN_ID} area_id=${AREA_ID}`);
  console.log(`pages=${page} vendors=${totalVendors} sections=${totalSections} bytes=${(totalBytes/1024/1024).toFixed(2)}MB`);
  console.log(`root keys observed: ${Array.from(rootKeys).join(', ')}`);
  console.log(`elapsed=${mins} min`);
  if (error) console.error(`ERROR: ${error}`);
  if (error) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
