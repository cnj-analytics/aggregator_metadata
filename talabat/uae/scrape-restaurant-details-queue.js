// scrape-restaurant-details-queue.js
//
// Talabat UAE — Per-restaurant detail scraper (QUEUE-DRIVEN).
//
// Loops: claim_batch via RPC -> fetch menu endpoint per branch ->
// complete_batch via RPC. Multiple workers can run in parallel because
// Supabase does the atomic claim with FOR UPDATE SKIP LOCKED.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   WORKER_ID        text, defaults to "worker-${WORKER_INDEX}" or random
//   WORKER_INDEX     int from GitHub matrix, used in default worker id
//   BATCH_SIZE       claim this many rows per round (default 25)
//   CALL_DELAY_MS    pacing between menu-endpoint calls per worker (default 1500)
//   WALL_LIMIT_SEC   stop claiming after this many seconds (default 5100 = 85 min)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_INDEX = process.env.WORKER_INDEX ?? '0';
const WORKER_ID = process.env.WORKER_ID
  || `worker-${WORKER_INDEX}-${Math.random().toString(36).slice(2, 8)}`;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '25', 10);
const CALL_DELAY_MS = parseInt(process.env.CALL_DELAY_MS || '1500', 10);
const WALL_LIMIT_SEC = parseInt(process.env.WALL_LIMIT_SEC || '5100', 10);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Supabase helpers -------------------------------------------------------

async function supabaseRpc(fn, body) {
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
  if (!resp.ok) {
    throw new Error(`RPC ${fn} ${resp.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function claimBatch() {
  return supabaseRpc('talabat_detail_claim_batch', {
    p_worker_id: WORKER_ID,
    p_batch_size: BATCH_SIZE,
  });
}

async function completeBatch(results) {
  return supabaseRpc('talabat_detail_complete_batch', {
    p_worker_id: WORKER_ID,
    p_results: results,
  });
}

// --- Talabat menu endpoint --------------------------------------------------

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
  'tokentypekey': 'guest',
};

async function fetchMenu(menuApiUrl) {
  const t0 = Date.now();
  const resp = await fetch(menuApiUrl, { method: 'GET', headers: TALABAT_HEADERS });
  const text = await resp.text();
  return { status: resp.status, text, elapsed: Date.now() - t0 };
}

function extractRestaurantBlock(parsed) {
  const vendor = parsed?.vendor || parsed;
  const result = vendor?.result || vendor;
  return result?.restaurant || null;
}

// Shape the fields we store in the normalized schema (NOT the whole raw blob).
function buildResult(branch_id, menuApiUrl, result) {
  const base = {
    branch_id,
    success: false,
    menu_api_url: menuApiUrl,
    vendor_id: null,
    legal_name: null,
    rating: null,
    delivery_time_text: null,
    status: null,
    error: null,
  };

  if (result.error) {
    return { ...base, error: result.error };
  }

  const r = extractRestaurantBlock(result.parsed) || {};
  const dtxt = r.dtxt || r.delivery_text || (typeof r.dtim === 'string' ? r.dtim : null);

  return {
    ...base,
    success: true,
    vendor_id: r.id != null ? String(r.id) : null,
    legal_name: r.brandLegalName || null,
    rating: r.rat != null ? String(r.rat) : null,
    delivery_time_text: dtxt,
    status: r.status_description || null,
  };
}

// --- Main ------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const deadline = t0 + WALL_LIMIT_SEC * 1000;
  console.log(`Talabat UAE — queue-driven restaurant detail scraper`);
  console.log(`WORKER_ID=${WORKER_ID}  BATCH_SIZE=${BATCH_SIZE}  CALL_DELAY_MS=${CALL_DELAY_MS}`);
  console.log(`Wall limit: ${WALL_LIMIT_SEC}s`);
  console.log('');

  let totalProcessed = 0;
  let totalOk = 0;
  let totalFailed = 0;
  let round = 0;

  while (Date.now() < deadline) {
    round++;
    let batch;
    try {
      batch = await claimBatch();
    } catch (e) {
      console.error(`[round ${round}] claim failed: ${e.message}`);
      await sleep(2000);
      continue;
    }

    if (!batch || batch.length === 0) {
      console.log(`[round ${round}] queue is empty — worker done.`);
      break;
    }

    console.log(`[round ${round}] claimed ${batch.length} branches`);

    const results = [];
    for (let i = 0; i < batch.length; i++) {
      if (Date.now() > deadline) {
        console.log(`  wall deadline reached mid-batch, flushing partial…`);
        break;
      }

      const row = batch[i];
      const bid = row.talabat_branch_id;
      const menuApiUrl = row.menu_api_url;
      const brand = row.brand_name || '(no brand)';

      if (!menuApiUrl) {
        results.push({
          branch_id: bid, success: false, menu_api_url: null,
          vendor_id: null, legal_name: null, rating: null,
          delivery_time_text: null, status: null,
          error: 'no menu_api_url in branch_information',
        });
        continue;
      }

      let fetchResult = { parsed: null, error: null, status: null, elapsed: null };
      try {
        const resp = await fetchMenu(menuApiUrl);
        fetchResult.status = resp.status;
        fetchResult.elapsed = resp.elapsed;
        if (resp.status >= 200 && resp.status < 400) {
          try {
            fetchResult.parsed = JSON.parse(resp.text);
          } catch (e) {
            fetchResult.error = `non-JSON: ${e.message}`;
          }
        } else {
          fetchResult.error = `HTTP ${resp.status}`;
        }
      } catch (e) {
        fetchResult.error = e.message;
      }

      const row_result = buildResult(bid, menuApiUrl, fetchResult);
      results.push(row_result);
      totalProcessed++;

      if (row_result.success) {
        totalOk++;
        if ((i + 1) % 5 === 0 || i === batch.length - 1) {
          console.log(
            `  [${i + 1}/${batch.length}] bid=${bid} ${brand}: ` +
            `${fetchResult.status} ${fetchResult.elapsed}ms ` +
            `legal=${row_result.legal_name || '-'}`,
          );
        }
      } else {
        totalFailed++;
        console.error(`  [${i + 1}/${batch.length}] bid=${bid} FAIL: ${row_result.error}`);
      }

      // Pace between calls so this worker's IP stays polite.
      if (i < batch.length - 1) await sleep(CALL_DELAY_MS);
    }

    // Flush this batch's results back to the queue.
    try {
      const flush = await completeBatch(results);
      console.log(`  flush: ${JSON.stringify(flush)}`);
    } catch (e) {
      console.error(`  flush failed: ${e.message} — rows will be reaped and retried`);
    }
  }

  const elapsedMin = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log('');
  console.log('=== DONE ===');
  console.log(`WORKER_ID: ${WORKER_ID}`);
  console.log(`Processed: ${totalProcessed}  (ok=${totalOk}  fail=${totalFailed})`);
  console.log(`Rounds:    ${round}`);
  console.log(`Elapsed:   ${elapsedMin} min`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
