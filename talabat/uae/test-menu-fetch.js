// test-menu-fetch.js
//
// Talabat UAE — Menu endpoint smoke test
//
// Standalone probe for `GET /menubff/v4/branches/{bid}/menu` on api.talabat.com.
// Writes nothing to Supabase — exists only to confirm the endpoint is reachable
// from GitHub Actions and to show the shape of the data we'd get later.
//
// Env:
//   BID         Talabat branch id (required). Default input in the workflow is
//               690394 (McDonald's — Box park, Business Bay).
//   AREA_ID     Delivery area id (optional, default 1252 Business Bay).
//   LAT, LNG    Delivery coordinate (optional, defaults to Business Bay centroid).
//   OUT_DIR     Where to write the raw dump (default ./out).

const fs = require('fs');
const path = require('path');

const BID = process.env.BID ? parseInt(process.env.BID, 10) : 690394;
const AREA_ID = process.env.AREA_ID ? parseInt(process.env.AREA_ID, 10) : 1252;
const LAT = process.env.LAT || '25.184';
const LNG = process.env.LNG || '55.2676';
const OUT_DIR = process.env.OUT_DIR || './out';

fs.mkdirSync(OUT_DIR, { recursive: true });

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
  // Menu endpoint uses the guest token-type (listings uses jwt).
  'tokentypekey': 'guest',
};

async function main() {
  const url =
    `https://api.talabat.com/menubff/v4/branches/${BID}/menu` +
    `?branchId=${BID}&countryId=4&areaId=${AREA_ID}` +
    `&latitude=${LAT}&longitude=${LNG}`;

  console.log(`BID=${BID}  AREA_ID=${AREA_ID}  @ ${LAT},${LNG}`);
  console.log('URL:', url);
  console.log('---');

  const t0 = Date.now();
  const resp = await fetch(url, { method: 'GET', headers: TALABAT_HEADERS });
  const text = await resp.text();
  const elapsed = Date.now() - t0;

  console.log(`HTTP ${resp.status}   ${text.length} bytes   ${elapsed}ms`);

  if (!resp.ok) {
    console.error('Body:', text.slice(0, 1000));
    fs.writeFileSync(path.join(OUT_DIR, `menu-${BID}-error.txt`), text);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error('Non-JSON response.');
    fs.writeFileSync(path.join(OUT_DIR, `menu-${BID}-raw.txt`), text);
    process.exit(1);
  }

  // Save the full raw payload for inspection.
  fs.writeFileSync(path.join(OUT_DIR, `menu-${BID}-raw.json`), JSON.stringify(data));

  console.log('\n=== TOP-LEVEL KEYS ===');
  console.log(Object.keys(data || {}).join(', '));

  // The brief says restaurant metadata lives at vendor.result.restaurant.
  const vendor = data.vendor || data?.data?.vendor || data;
  const result = vendor?.result || vendor;
  const restaurant = result?.restaurant || result;

  if (restaurant) {
    console.log('\n=== RESTAURANT KEYS ===');
    console.log(Object.keys(restaurant).join(', '));

    const summary = {
      id: restaurant.id,
      bid: restaurant.bid,
      na: restaurant.na,
      bna: restaurant.bna,
      mna: restaurant.mna,
      brandLegalName: restaurant.brandLegalName,
      lat: restaurant.lat,
      lon: restaurant.lon,
      addr: restaurant.addr,
      an: restaurant.an,
      rat: restaurant.rat,
      trt: restaurant.trt,
      dch: restaurant.dch,
      serviceFees: restaurant.serviceFees,
      serviceFeesCapMin: restaurant.serviceFeesCapMin,
      serviceFeesCapMax: restaurant.serviceFeesCapMax,
      unified_rating_count: restaurant?.unified_rating?.count,
      cuisines: Array.isArray(restaurant.cus)
        ? restaurant.cus.map((c) => c.na || c.name).slice(0, 10)
        : null,
    };
    console.log('\n=== RESTAURANT SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('\n(no restaurant block found at vendor.result.restaurant)');
  }

  // Menu sections overview.
  const menu = result?.menu || restaurant?.menu;
  if (menu) {
    const sections = menu.menuSection || menu.sections || menu.categories || [];
    const itemCount = sections.reduce((n, s) => {
      return n + ((s.items || s.menuItems || []).length);
    }, 0);
    console.log('\n=== MENU OVERVIEW ===');
    console.log(`sections=${sections.length}  items(approx)=${itemCount}`);
    if (sections[0]) {
      console.log('first section keys:', Object.keys(sections[0]).join(', '));
      console.log('first section name:', sections[0].name || sections[0].na);
    }
  } else {
    console.log('\n(no menu block found)');
  }

  console.log('\nDone. Raw payload saved to out/menu-${BID}-raw.json for inspection.');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
