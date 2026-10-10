# Noon Food (UAE) — scraping notes for future AI sessions

**Read this first.** If you (an AI) are picking up this repo and need to work on Noon Food scraping, this file + the project doc `claude/noon-keeta-findings.md` is everything you need.

---

## What's working today (verified 2026-10-10)

| Capability | How |
|---|---|
| Guest session minting | `SELECT public.noon_mint_session(lat, lng);` on Supabase |
| Area resolution | Response's `resolved_area` field (e.g. "Jumeirah Lakes Towers – Al Thanyah Fifth – Dubai") |
| Zone-code lookup | Response's `food_zonecode` and full `zone_codes` object |
| Full outlet enumeration | Chained `searchToken` pagination against `/mp-food-api-catalog/api/search` (~1,200 outlets per neighbourhood in 20 pages) |
| Menu detail per outlet | POST `/mp-food-api-mpnoon/consumer/restaurant/outlet/details/guest/partial` with `outletCode` + lat/lng in body |

**Measured ceiling for Dubai Marina: 1,196 unique outlets in 20 API calls.**

---

## What lives where

```
noon/
├── README.md                        ← you are here
└── uae/
    └── test-fetch.js                ← Node.js script that proves end-to-end

.github/workflows/
└── noon-uae-test-fetch.yml          ← workflow_dispatch runner

Supabase (project zxsglrnjlmghplecndue):
├── public.noon_mint_session(lat, lng)   ← SECURITY DEFINER function
└── public.noon_auth_session              ← audit log table (RLS enabled)
```

The function does ALL the auth work. Scrapers only need to call it, then use the returned cookies + zone-code headers for subsequent `/search` and `/outlet/details/guest/partial` calls.

---

## The Noon guest auth flow (what `noon_mint_session` does internally)

Noon Food has a 3-step guest activation. Each step depends on the cookies/state from the previous one. **The function handles all of this**; this is just so you understand the mechanism.

```
STEP 1  GET  https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami
             x-experience: ecom
         → mints `nguestv2` cookie (HS256 JWT, 5-min lifetime)
         → sets `x-available-ae=ecom-money` cookie (2 services)

STEP 2  POST https://api-app.noon.com/_vs/st/mp-identity-api-geo/
                      serviceable-geo-info/set-location-by-lat-lng
             body: {"location":{"lat":<F>,"lng":<F>},"lang":"en"}
             x-experience: ecom
         → returns {area, isServiceable, cityId}
         → sets `x-location-ecom-ae` cookie (base64 of {lat,lng,area,id_city})
         → sets `dcae=1` cookie
         → sets `ak_bmsc` cookie (Akamai bot management)

STEP 3  GET  https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami
                      ?experience=food&select_nearby=1
             x-experience: ecom   ← note: STAYS ecom, URL param switches context
         → upgrades `x-available-ae` to the full 10-services value
         → response body contains `headers` object with 10 zone codes:
             x-food-zonecode, x-ping-zonecode, x-out-zonecode,
             x-aster-zonecode, x-ecom-zonecode, x-nooninstant-zonecode,
             x-noonnownow-zonecode, x-rocket-zonecode, x-rocket-mp-zonecode,
             x-services-zonecode
```

**Critical gotchas (ALL learned the hard way):**
- The `nguestv2` JWT has 5-minute lifetime. Don't cache sessions beyond that.
- Dropping ANY of the 5 cookies on step 3 breaks the upgrade.
- Sending `x-experience: food` instead of `ecom` on step 3 causes the upgrade to silently no-op (server returns same 2-service value).
- The zone codes come from the step-3 **response body**, not from Set-Cookie headers. You MUST parse `body.headers.*` and echo them back on `/search`.
- Without `x-food-zonecode` header, `/search` returns `404 "unserviceable area"` even though you have a valid token.

---

## Using the session for scraping

After `SELECT noon_mint_session(lat, lng)` returns success, you get:

```json
{
  "ok": true,
  "device_id": "<uuid>",
  "visitor_id": "<uuid>",
  "lat": 25.078058, "lng": 55.153378,
  "lat_int": 250780581, "lng_int": 551533781,
  "resolved_area": "Jumeirah Lakes Towers - ...",
  "food_zonecode": "FOOD-AE-DXB-HUB4-DUBAI_MARINA",
  "nguestv2": "eyJhbGc...",
  "nguestv2_exp": "2026-10-10T09:27:08+00:00",
  "zone_codes": { "x-food-zonecode": "...", ...all 10... },
  "cookie_string": "nguestv2=...; x-available-ae=...; x-location-ecom-ae=...; dcae=1; ak_bmsc=...",
  "log_id": 1
}
```

### Headers to send on every `/mp-food-api-*` call

```
User-Agent: noon/22098 CFNetwork/3896.100.1.2.1 Darwin/27.0.0
x-platform: ios
x-build: 22098
x-mp: noon
x-mp-country: ae
x-experience: food
x-content: mobile
x-locale: en-ae
x-device-id: <session.device_id>
x-visitor-id: <session.visitor_id>
x-device-lat: <session.lat as float>
x-device-lng: <session.lng as float>
x-lat: <session.lat_int>
x-lng: <session.lng_int>
Cookie: <session.cookie_string>
(all 10 zone-code headers from session.zone_codes)
Content-Type: application/json   (POSTs only)
```

### Enumerate outlets (chained `searchToken` pagination)

```
POST https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/search
body: {
  "queryEntity": null, "q": null, "f": {}, "contexts": [],
  "withContent": true, "excludeOutletCodes": [],
  "limit": 60, "page": 1,
  "sort": {"by": "popularity", "dir": "desc"},
  "type": "outlet", "qType": "search_query",
  "getFallback": true,
  "searchToken": <token from PREVIOUS response — omit on first call>
}
```

Each response contains:
- `nbHits`: 60 (per-page count; NOT a global cap)
- `results[]`: nested — walk to find objects with `outletCode`
- `searchToken`: pass this back on the next call

Stop when `results` yields < 60 outlets. For Dubai Marina expect 20 pages.

### Fetch outlet detail (menu + everything)

```
POST https://api-app-fd.noon.com/_svc/mp-food-api-mpnoon/
            consumer/restaurant/outlet/details/guest/partial
body: {
  "outletCode": "BRGRKNXJCZ",
  "addressLat": 250780581,
  "addressLng": 551533781,
  "deliveryType": "default",
  "context": {"experience": null}
}
```

Returns ~80 top-level fields including the full `menu.items[]` list (126 items for Burger King alone). See `claude/noon-keeta-findings.md` sections 3.5j/3.5k for the complete field inventory.

### Image URLs

Outlet records carry CDN **paths**, not URLs. Build full URLs with:
```
Logo (200px):     https://f.nooncdn.com/food_production/<key>?width=200&format=webp
Banner (720px):   https://f.nooncdn.com/food_production/<key>?width=720&crop=720:328&format=webp
Menu item (780):  https://f.nooncdn.com/food_production/<key>?width=780&crop=1:1&format=webp
```

### Public web URL for sharing a restaurant

```
https://food.noon.com/uae-en/outlet/<outletCode>/
```

The `outletCode` from the API is the slug. No separate URL field needed.

---

## Testing

Run `test-fetch.js` locally or via the GitHub Actions workflow `noon-uae-test-fetch.yml`.

```bash
# Local run (requires env vars)
export SUPABASE_URL=https://zxsglrnjlmghplecndue.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<key>
node noon/uae/test-fetch.js

# GitHub Actions
# Trigger via "Run workflow" button on the noon-uae-test-fetch workflow
# Secrets needed: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (already configured for Careem)
```

What the test does:
1. Mints a session via `noon_mint_session` RPC
2. Paginates `/search` for 3 pages (should yield ~180 outlets)
3. Fetches full menu detail for 10 sample outlets
4. Writes everything to `noon-uae-test-output/` as JSON

Expected output: ~180 unique `outletCode`s, 10 menu JSONs averaging ~100-150 KB each.

---

## Why Option A (on-demand mint) and not cached tokens

Noon's `nguestv2` JWT lives for 5 minutes. Caching would mean refreshing every 4 minutes = 360 refreshes/day, and the cache is only useful if a scrape happens within that 4-minute window. Scrape runs are relatively infrequent (hourly at most, usually daily), so on-demand minting is simpler and no slower in practice. See `claude/noon-keeta-findings.md` section "Noon Supabase pipeline design" for the full reasoning.

---

## When something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| `noon_mint_session` returns `ok=false` with "whoami ecom returned HTTP X" | Noon changed the whoami endpoint or added anti-bot checks | Pull a fresh Proxyman capture, diff against the capture in findings |
| `/search` returns `404 "unserviceable area"` | Zone codes not being sent OR x-location-ecom-ae cookie missing | Verify the function's step-3 upgrade succeeded; look at `noon_auth_session.food_zonecode` |
| `/search` returns the SAME outlets repeatedly | searchToken not being chained from response→next request | Check that your scraper reads `response.searchToken` and sends it as `body.searchToken` next time |
| `/outlet/details/guest/partial` returns empty data | Likely a bad `outletCode` or lat/lng mismatch | lat/lng in body MUST be int `*1e7`, not float |
| HTTP 429 or Akamai challenge | Scraping too aggressively | Add delays (200-500ms between calls); use a fresh session per scrape job |

---

## When you need Keeta

Keeta is NOT in this folder yet. It's blocked on `mtgsig` anti-tampering signatures that we don't have the algorithm for. See `claude/noon-keeta-findings.md` section 4 for the full status and three possible paths forward.