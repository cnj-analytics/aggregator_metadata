#!/usr/bin/env node
// noon/uae/test-multi-token.js
//
// Test: one worker per machine, one token per worker, one IP per machine.
// Designed to run as a GitHub Actions matrix job — each job gets its own
// runner (own IP) and mints its own token from Supabase.
//
// On 403:
//   1. Token is burned — mint a fresh one and resume from where we left off
//   2. If the fresh token also 403s immediately — IP is blocked, exit
//
// Every single request is logged so you can watch live.
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   WORKER_ID            which worker this is (0, 1, 2, ...)   required
//   REQUESTS_PER_TOKEN   max requests per token                (default 5500)
//   DELAY_MS             delay between requests                (default 100)

'use strict';

const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const WORKER_ID = process.env.WORKER_ID || '0';
const REQUESTS_PER_TOKEN = Number(process.env.REQUESTS_PER_TOKEN || '5500');
const DELAY_MS = Number(process.env.DELAY_MS || '100');

const UA = 'noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const SET_LOCATION_URL = 'https://api-app.noon.com/_vs/st/mp-identity-api-geo/serviceable-geo-info/set-location-by-lat-lng';
const WHOAMI_FOOD_URL = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami?experience=food&select_nearby=1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Supabase RPC (mint only) ────────────────────────────────────────────────

async function supabase(path, opts = {}) {
  const resp = await fetch(SUPABASE_URL + '/rest/v1' + path, {
    method: opts.method || 'GET',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Supabase ${path} -> ${resp.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function mintSession(lat = 25.078058170938117, lng = 55.15337817083452) {
  const s = await supabase('/rpc/noon_mint_session', { method: 'POST', body: { p_lat: lat, p_lng: lng } });
  if (!s || s.ok !== true) throw new Error(`noon_mint_session ok=false: ${s && s.error}`);
  return s;
}

// ── Locate (direct HTTP from this machine) ──────────────────────────────────

function mergeSetCookies(jar, resp) {
  const list = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const c of list) {
    const m = /^([^=]+)=([^;]+)/.exec(c);
    if (m) jar[m[1]] = m[2];
  }
}
const cookieString = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function locate(session, jar, lat, lng) {
  const h = {
    'User-Agent': UA,
    'x-platform': 'ios',
    'x-build': '22098',
    'x-mp': 'noon',
    'x-content': 'mobile',
    'x-locale': 'en-ae',
    'x-device-id': session.device_id,
    'x-visitor-id': session.visitor_id,
    'x-device-lat': String(lat),
    'x-device-lng': String(lng),
    Accept: 'application/json',
    'x-experience': 'ecom',
  };

  const r1 = await fetch(SET_LOCATION_URL, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json', Cookie: cookieString(jar) },
    body: JSON.stringify({ location: { lat, lng }, lang: 'en' }),
  });
  if (!r1.ok) return { ok: false, step: 'set-location', status: r1.status };
  mergeSetCookies(jar, r1);

  const r2 = await fetch(WHOAMI_FOOD_URL, {
    headers: { ...h, 'x-whoami-request-id': crypto.randomUUID(), Cookie: cookieString(jar) },
  });
  if (!r2.ok) return { ok: false, step: 'whoami-food', status: r2.status };
  const who = await r2.json();
  mergeSetCookies(jar, r2);

  const zone = who && who.headers && who.headers['x-food-zonecode'];
  return { ok: true, zone: zone || null };
}

// ── Test points: cycle through several UAE locations ────────────────────────

const TEST_POINTS = [
  [25.2048, 55.2708],  // Dubai
  [25.0800, 55.1400],  // Dubai Marina
  [24.4539, 54.3773],  // Abu Dhabi
  [25.3463, 55.4209],  // Sharjah
  [25.4052, 55.5136],  // Ajman
  [24.1914, 55.7606],  // Al Ain
  [25.7895, 55.9432],  // Ras Al Khaimah
  [25.5600, 55.5500],  // Umm Al Quwain
];

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  if (typeof fetch !== 'function') throw new Error('Node 18+ required');

  console.log(`[worker ${WORKER_ID}] starting on this machine`);
  console.log(`[worker ${WORKER_ID}] requests_per_token=${REQUESTS_PER_TOKEN} delay_ms=${DELAY_MS}`);

  let session = await mintSession();
  let jar = { ...(session.cookies || {}) };
  let tokenNumber = 1;
  let totalSuccesses = 0;
  let tokenSuccesses = 0;

  console.log(`[worker ${WORKER_ID}] token #${tokenNumber} minted | device_id=${session.device_id} | visitor_id=${session.visitor_id}`);
  console.log('');

  for (let i = 1; i <= REQUESTS_PER_TOKEN; i++) {
    const [lat, lng] = TEST_POINTS[(i - 1) % TEST_POINTS.length];
    const res = await locate(session, jar, lat, lng);

    if (res.ok) {
      totalSuccesses++;
      tokenSuccesses++;
      console.log(`[worker ${WORKER_ID}] ${i}/${REQUESTS_PER_TOKEN} OK | token#${tokenNumber} (${tokenSuccesses} on this token) | zone=${res.zone} | lat=${lat} lng=${lng}`);
    } else {
      console.log(`[worker ${WORKER_ID}] ${i}/${REQUESTS_PER_TOKEN} FAIL | ${res.step} HTTP ${res.status} | lat=${lat} lng=${lng}`);

      if (res.status === 403) {
        console.log(`[worker ${WORKER_ID}] GOT 403 on token #${tokenNumber} after ${tokenSuccesses} successful requests`);
        console.log(`[worker ${WORKER_ID}] total successes so far: ${totalSuccesses}`);
        console.log(`[worker ${WORKER_ID}] minting fresh token...`);

        // Mint a new token and retry
        try {
          session = await mintSession();
          jar = { ...(session.cookies || {}) };
          tokenNumber++;
          tokenSuccesses = 0;
          console.log(`[worker ${WORKER_ID}] token #${tokenNumber} minted | device_id=${session.device_id} | visitor_id=${session.visitor_id}`);

          // Test the new token immediately
          const retryRes = await locate(session, jar, lat, lng);
          if (retryRes.ok) {
            totalSuccesses++;
            tokenSuccesses++;
            console.log(`[worker ${WORKER_ID}] ${i}/${REQUESTS_PER_TOKEN} RETRY OK | token#${tokenNumber} | zone=${retryRes.zone} | lat=${lat} lng=${lng}`);
            console.log(`[worker ${WORKER_ID}] new token works — continuing`);
          } else if (retryRes.status === 403) {
            console.log(`[worker ${WORKER_ID}] ${i}/${REQUESTS_PER_TOKEN} RETRY FAIL | ${retryRes.step} HTTP ${retryRes.status}`);
            console.log(`[worker ${WORKER_ID}] FRESH TOKEN ALSO 403 — IP IS BLOCKED`);
            console.log(`[worker ${WORKER_ID}] stopping at request ${i}/${REQUESTS_PER_TOKEN}`);
            break;
          } else {
            console.log(`[worker ${WORKER_ID}] ${i}/${REQUESTS_PER_TOKEN} RETRY FAIL | ${retryRes.step} HTTP ${retryRes.status} — continuing`);
          }
        } catch (mintErr) {
          console.log(`[worker ${WORKER_ID}] MINT FAILED: ${mintErr.message}`);
          console.log(`[worker ${WORKER_ID}] stopping at request ${i}/${REQUESTS_PER_TOKEN}`);
          break;
        }
      } else if (res.status === 429) {
        console.log(`[worker ${WORKER_ID}] GOT 429 — pausing 30s then continuing`);
        await sleep(30000);
      }
    }

    await sleep(DELAY_MS);
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`  worker ${WORKER_ID}: ${totalSuccesses} total successes out of ${REQUESTS_PER_TOKEN} max`);
  console.log(`  tokens used: ${tokenNumber}`);
  console.log(`  last token successes: ${tokenSuccesses}`);
})().catch((e) => {
  console.error('[worker] FATAL:', e);
  process.exit(1);
});
