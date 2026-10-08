// talabat/uae/register-branch.js
//
// Talabat UAE — Register Branch worker. Fired on-demand by Supabase trigger
// when the registration queue has pending rows. Loops: claim batch -> fetch
// each branch's menu endpoint -> parse brand/legal entity/location/metadata
// -> call talabat_register_branch -> on failure call talabat_registration_fail.
//
// Multiple workers can run in parallel; the claim RPC uses FOR UPDATE SKIP
// LOCKED, so no two workers get the same branch.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   BATCH_SIZE       claim this many per round (default 25)
//   CALL_DELAY_MS    pacing between menu fetches (default 1500)
//   WALL_LIMIT_SEC   hard stop (default 5100 = 85 min, below GH's 6h)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BATCH_SIZE   = parseInt(process.env.BATCH_SIZE || '25', 10);
const CALL_DELAY_MS = parseInt(process.env.CALL_DELAY_MS || '1500', 10);
const WALL_LIMIT_SEC = parseInt(process.env.WALL_LIMIT_SEC || '5100', 10);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Talabat menu endpoint (mobile menubff). guest token works without auth.
const MENU_HEADERS = {
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

function menuUrl(bid) {
  return `https://api.talabat.com/menubff/v4/branches/${bid}/menu`;
}

async function fetchMenu(bid) {
  const resp = await fetch(menuUrl(bid), { method: 'GET', headers: MENU_HEADERS });
  const text = await resp.text();
  return { status: resp.status, text };
}

// Extract the fields register_branch needs out of the menu response.
function parseMenuForRegister(parsed, row) {
  // menubff v4 response:
  //   parsed.vendor.result.restaurant.*  OR  parsed.result.restaurant.*
  const vendor = parsed?.vendor || parsed;
  const result = vendor?.result || vendor;
  const r = result?.restaurant || {};

  // Brand (chain) info
  const brand_id          = r.chainId != null ? String(r.chainId) : null;
  const brand_name        = r.chain || r.chainName || r.brand || r.branchName || null;

  // Legal entity (sometimes present as brandLegalName)
  const legal_entity_name = r.brandLegalName || null;

  // Branch metadata
  const branch_name       = r.branchName || r.name || row.talabat_card_name;
  const page_url          = r.url || (`https://www.talabat.com/uae/restaurant/${row.talabat_branch_id}/${row.talabat_card_slug || ''}`).replace(/\/$/, '');
  const image_url         = r.logo || r.logoUrl || row.talabat_card_image_url;
  const menu_api_url      = menuUrl(row.talabat_branch_id);
  const vendor_id         = r.id ?? null;
  const area_name         = r.area || r.areaName || null;
  const latitude          = r.latitude ?? null;
  const longitude         = r.longitude ?? null;
  const branch_type       = r.shopType || r.verticalType || null;
  const rating            = r.rat ?? r.rating ?? null;
  const delivery_time_text = r.dtxt || r.deliveryText || (r.dtim != null ? String(r.dtim) : null);
  const status            = r.status_description || r.statusDescription || r.statusText || null;
  const minimum_order     = r.mna ?? r.minimumOrder ?? null;

  return {
    branch_id:         row.talabat_branch_id,
    branch_name,
    brand_id,
    brand_name,
    legal_entity_name,
    page_url,
    image_url,
    menu_api_url,
    vendor_id:         vendor_id != null ? String(vendor_id) : null,
    area_name,
    latitude:          latitude  != null ? String(latitude)  : null,
    longitude:         longitude != null ? String(longitude) : null,
    branch_type,
    rating:            rating != null ? String(rating) : null,
    delivery_time_text,
    status,
    minimum_order:     minimum_order != null ? String(minimum_order) : null,
  };
}

async function processOne(row) {
  const bid = row.talabat_branch_id;
  let resp;
  try {
    resp = await fetchMenu(bid);
  } catch (e) {
    await rpc('talabat_registration_fail', { p_branch_id: bid, p_error: `fetch: ${e.message}` });
    return { bid, ok: false, error: `fetch: ${e.message}` };
  }
  if (resp.status < 200 || resp.status >= 400) {
    await rpc('talabat_registration_fail', { p_branch_id: bid, p_error: `http_${resp.status}` });
    return { bid, ok: false, error: `http_${resp.status}` };
  }
  let parsed;
  try { parsed = JSON.parse(resp.text); }
  catch (e) {
    await rpc('talabat_registration_fail', { p_branch_id: bid, p_error: `non-JSON: ${e.message}` });
    return { bid, ok: false, error: `non-JSON: ${e.message}` };
  }

  let payload;
  try { payload = parseMenuForRegister(parsed, row); }
  catch (e) {
    await rpc('talabat_registration_fail', { p_branch_id: bid, p_error: `parse: ${e.message}` });
    return { bid, ok: false, error: `parse: ${e.message}` };
  }

  try {
    // RPC signature is talabat_register_branch(p jsonb) — must wrap the
    // payload as {p: ...} so PostgREST passes it as a single parameter
    // rather than treating every top-level key as a separate function arg.
    const r = await rpc('talabat_register_branch', { p: payload });
    return { bid, ok: true, info: r };
  } catch (e) {
    await rpc('talabat_registration_fail', { p_branch_id: bid, p_error: `register: ${e.message}` });
    return { bid, ok: false, error: `register: ${e.message}` };
  }
}

async function main() {
  const t0 = Date.now();
  const deadline = t0 + WALL_LIMIT_SEC * 1000;
  console.log(`Talabat register-branch worker — batch=${BATCH_SIZE} delay=${CALL_DELAY_MS}ms`);

  let round = 0;
  let processed = 0;
  let ok = 0;
  let failed = 0;

  while (Date.now() < deadline) {
    round++;
    let batch;
    try {
      batch = await rpc('talabat_registration_claim', { p_limit: BATCH_SIZE });
    } catch (e) {
      console.error(`[round ${round}] claim failed: ${e.message}`);
      await sleep(2000);
      continue;
    }
    if (!Array.isArray(batch) || batch.length === 0) {
      console.log(`[round ${round}] queue drained — exiting`);
      break;
    }
    console.log(`[round ${round}] claimed ${batch.length} branches`);

    for (let i = 0; i < batch.length; i++) {
      if (Date.now() > deadline) {
        console.log('  wall deadline reached mid-batch');
        break;
      }
      const row = batch[i];
      const r = await processOne(row);
      processed++;
      if (r.ok) {
        ok++;
        if ((i + 1) % 5 === 0 || i === batch.length - 1) {
          console.log(`  [${i + 1}/${batch.length}] bid=${r.bid}: brand=${r.info?.brand_created} moved=${r.info?.rankings_moved}`);
        }
      } else {
        failed++;
        console.error(`  [${i + 1}/${batch.length}] bid=${r.bid} FAIL: ${r.error}`);
      }
      if (i < batch.length - 1) await sleep(CALL_DELAY_MS);
    }
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`DONE — processed=${processed} ok=${ok} fail=${failed} rounds=${round} elapsed=${mins} min`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
