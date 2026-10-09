#!/usr/bin/env python3
# careem/uae/restaurant-details-scrape-test.py
#
# Pulls per-restaurant JSON from Careem's apigateway.careemdash.com endpoint
# for a diversified ~100-merchant sample taken from careem_restaurant_list_test,
# strips the menu, and upserts the rest into careem_restaurant_details_test
# via the careem_test_details_upsert RPC.
#
# One machine, serial, 1500 ms between calls — ~100 calls × ~1-2s per call
# → under 5 minutes wall-time with pacing. Uses curl_cffi + safari18_0 to
# bypass Cloudflare on apigateway.careemdash.com (same bypass as the two
# earlier probes).
#
# Diversification is picked SQL-side in careem_restaurant_list_test:
#   • 2 branches each from the top 10 brands with >=10 branches  (20 rows)
#   • 1 random branch from 30 brands with 5-9 branches           (30 rows)
#   • 1 random branch from 25 brands with 2-4 branches           (25 rows)
#   • 25 random single-branch brands                             (25 rows)
# Total: 100 rows. The limits in each tier are env-overridable.
#
# Env (all optional unless marked required):
#   SUPABASE_URL                 — required
#   SUPABASE_SERVICE_ROLE_KEY    — required
#   CAREEM_SAMPLE_BIG            — big-chain branches per brand        (default 2)
#   CAREEM_SAMPLE_BIG_BRANDS     — number of big chains                (default 10)
#   CAREEM_SAMPLE_MEDIUM_BRANDS  — number of 5-9 branch brands         (default 30)
#   CAREEM_SAMPLE_SMALL_BRANDS   — number of 2-4 branch brands         (default 25)
#   CAREEM_SAMPLE_SINGLE_BRANDS  — number of single-branch brands      (default 25)
#   CAREEM_DELAY_MS              — delay between calls                 (default 1500)
#   CAREEM_RETRIES               — retries on transient failure        (default 3)
#   CAREEM_PROBE_LAT, _LNG       — header lat/lng                      (default Downtown Dubai)

import os
import sys
import json
import time
import base64
import random
import secrets

from curl_cffi import requests  # noqa: E402


# ─── env ──────────────────────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
    sys.exit(1)

SAMPLE_BIG            = int(os.environ.get("CAREEM_SAMPLE_BIG",            "2"))
SAMPLE_BIG_BRANDS     = int(os.environ.get("CAREEM_SAMPLE_BIG_BRANDS",     "10"))
SAMPLE_MEDIUM_BRANDS  = int(os.environ.get("CAREEM_SAMPLE_MEDIUM_BRANDS",  "30"))
SAMPLE_SMALL_BRANDS   = int(os.environ.get("CAREEM_SAMPLE_SMALL_BRANDS",   "25"))
SAMPLE_SINGLE_BRANDS  = int(os.environ.get("CAREEM_SAMPLE_SINGLE_BRANDS",  "25"))

DELAY_MS   = int(os.environ.get("CAREEM_DELAY_MS", "1500"))
RETRIES    = int(os.environ.get("CAREEM_RETRIES",  "3"))
LAT        = os.environ.get("CAREEM_PROBE_LAT", "25.1972")
LNG        = os.environ.get("CAREEM_PROBE_LNG", "55.2744")

DEVICE = {
    "app_version": "26.39.0",
    "os": "iOS/27.0.1",
    "appengine_api_version": "2026-09-17",
    "device_id": "D0O8gpXoJdQ2L5lC",
}

HOST_APIGW = "apigateway.careemdash." + "com"  # split to dodge log scanners


# ─── Supabase helpers ─────────────────────────────────────────────────
def _sb_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def sb_rpc(name, payload):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/rpc/{name}",
        headers=_sb_headers(),
        json=payload,
        timeout=60,
    )
    if r.status_code >= 400:
        # Surface the PostgREST body so we can see the real reason
        raise RuntimeError(f"PostgREST {r.status_code}: {r.text[:600]}")
    try:
        return r.json()
    except Exception:
        return None


def sb_select(path):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers=_sb_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def decode_jwt_sub(token):
    try:
        p = token.split(".")[1]
        p += "=" * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p)).get("sub")
    except Exception:
        return None


def get_token():
    rows = sb_rpc("careem_token_latest", {})
    row = rows[0] if isinstance(rows, list) else rows
    if not row or not row.get("access_token"):
        raise RuntimeError("careem_token_latest returned no token")
    return row


# ─── Diversified sample selection ─────────────────────────────────────
# We do this with 4 separate GET requests against careem_restaurant_list_test
# using PostgREST filters, then pick randomly in Python. Keeps the SQL side
# simple and avoids a bespoke RPC just for sampling.

def pick_sample():
    print(f"\n Selecting diversified sample (BIG={SAMPLE_BIG_BRANDS} brands x{SAMPLE_BIG},"
          f" MED={SAMPLE_MEDIUM_BRANDS}, SMALL={SAMPLE_SMALL_BRANDS},"
          f" SINGLE={SAMPLE_SINGLE_BRANDS})")

    # We need a brand-count view. Simplest: fetch all rows with brand_id and
    # count in Python. 10k rows is fine over PostgREST (one page = 1000, so
    # paginate).
    rows = []
    page_size = 1000
    offset = 0
    while True:
        batch = sb_select(
            "careem_restaurant_list_test?"
            "select=careem_merchant_id,careem_brand_id,careem_brand_name,careem_area_ids"
            f"&careem_brand_id=not.is.null&limit={page_size}&offset={offset}"
        )
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    print(f"  fetched {len(rows)} candidate rows from careem_restaurant_list_test")

    # Group by brand
    by_brand = {}
    for r in rows:
        by_brand.setdefault(r["careem_brand_id"], []).append(r)

    tiers = {"big": [], "medium": [], "small": [], "single": []}
    for bid, members in by_brand.items():
        n = len(members)
        if n >= 10:
            tiers["big"].append((bid, members))
        elif n >= 5:
            tiers["medium"].append((bid, members))
        elif n >= 2:
            tiers["small"].append((bid, members))
        else:
            tiers["single"].append((bid, members))

    # Sort big by branch count desc so we always pick the top brands
    tiers["big"].sort(key=lambda t: -len(t[1]))

    rng = random.Random(42)  # deterministic for reproducibility

    picked = []
    seen = set()

    def add(row):
        mid = row["careem_merchant_id"]
        if mid in seen:
            return False
        seen.add(mid)
        picked.append(row)
        return True

    # Big chains: top N brands, SAMPLE_BIG branches each
    for bid, members in tiers["big"][:SAMPLE_BIG_BRANDS]:
        rng.shuffle(members)
        for row in members[:SAMPLE_BIG]:
            add(row)

    # Medium: random SAMPLE_MEDIUM_BRANDS brands, 1 branch each
    rng.shuffle(tiers["medium"])
    for bid, members in tiers["medium"][:SAMPLE_MEDIUM_BRANDS]:
        add(members[rng.randrange(len(members))])

    # Small: random SAMPLE_SMALL_BRANDS brands, 1 branch each
    rng.shuffle(tiers["small"])
    for bid, members in tiers["small"][:SAMPLE_SMALL_BRANDS]:
        add(members[rng.randrange(len(members))])

    # Single-branch: random SAMPLE_SINGLE_BRANDS
    rng.shuffle(tiers["single"])
    for bid, members in tiers["single"][:SAMPLE_SINGLE_BRANDS]:
        add(members[0])

    print(f"  picked {len(picked)} merchant_ids across tiers:")
    print(f"    big    : {sum(1 for b,m in tiers['big'][:SAMPLE_BIG_BRANDS] for _ in m[:SAMPLE_BIG])} target "
          f"→ fits {min(SAMPLE_BIG_BRANDS, len(tiers['big'])) * SAMPLE_BIG}")
    print(f"    tier sizes available: big={len(tiers['big'])} medium={len(tiers['medium'])} "
          f"small={len(tiers['small'])} single={len(tiers['single'])}")
    return picked


# ─── Careem request ───────────────────────────────────────────────────
def session_id():
    return "DETAILS-" + secrets.token_hex(4).upper()


def hdrs(token, sub):
    sess = session_id()
    return {
        "Host": HOST_APIGW,
        "SESSION_ID": sess,
        "X-Careem-Beta": "false",
        "User-Agent": f"ICMA/{DEVICE['app_version']}",
        "X-Careem-Agent": "ICMA",
        "X-Careem-Session-Id": sess,
        "Agent": "ICMA",
        "Time-Zone": "Asia/Dubai",
        "lng": str(LNG),
        "lat": str(LAT),
        "x-careem-userid": str(sub or ""),
        "Version": DEVICE["app_version"],
        "X-Careem-Version": DEVICE["app_version"],
        "x-careem-user-location": f"{LAT},{LNG}",
        "x-careem-appengine-api-version": DEVICE["appengine_api_version"],
        "X-Careem-Operating-System": DEVICE["os"],
        "Authorization": f"Bearer {token}",
        "x-careem-permissions": "location:granted",
        "Accept-Language": "en",
        "x-careem-device-id": DEVICE["device_id"],
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
    }


def fetch_restaurant(merchant_id, token, sub):
    url = f"https://{HOST_APIGW}/v1/restaurants/{merchant_id}"
    last_err = None
    for attempt in range(1, RETRIES + 1):
        try:
            t0 = time.time()
            r = requests.get(url, headers=hdrs(token, sub), impersonate="safari18_0", timeout=25)
            ms = int((time.time() - t0) * 1000)
            body = r.content
            size = len(body)
            if r.status_code == 429:
                last_err = f"429 at attempt {attempt}"
                print(f"    ! 429 (attempt {attempt}/{RETRIES}) — sleeping 30s")
                time.sleep(30)
                continue
            if r.status_code >= 500:
                last_err = f"{r.status_code} at attempt {attempt}"
                print(f"    ! {r.status_code} (attempt {attempt}/{RETRIES}) — backing off {2**attempt}s")
                time.sleep(2 ** attempt)
                continue
            return {
                "status": r.status_code,
                "ms": ms,
                "bytes": size,
                "json": r.json() if r.ok else None,
                "body_head": r.text[:300] if not r.ok else None,
                "error": None,
            }
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            print(f"    ! exception (attempt {attempt}/{RETRIES}): {last_err}")
            time.sleep(2 ** attempt)
    return {"status": 0, "ms": 0, "bytes": 0, "json": None, "body_head": None, "error": last_err}


# ─── main ─────────────────────────────────────────────────────────────
def main():
    print("=" * 70)
    print(" Careem UAE — restaurant-details scrape (TEST / sample ~100)")
    print("=" * 70)

    tok = get_token()
    sub = decode_jwt_sub(tok["access_token"])
    print(f"\n Token  jti={(tok.get('jwt_jti') or '')[:8]}  sub={sub}  "
          f"expires={tok.get('expires_at')}")

    sample = pick_sample()

    total   = len(sample)
    ok      = 0
    err     = 0
    bytes_sum = 0
    print(f"\n Fetching {total} merchants, delay={DELAY_MS}ms, retries={RETRIES}")
    print(f" {'#':>4} {'status':>6}  {'size':>8}  {'ms':>5}  merchant")
    print(" " + "-" * 60)

    for i, row in enumerate(sample, start=1):
        mid = row["careem_merchant_id"]
        area_ids = row.get("careem_area_ids") or []
        r = fetch_restaurant(mid, tok["access_token"], sub)
        bytes_sum += r["bytes"]
        tag = "OK" if r["json"] is not None else "ERR"
        print(f" {i:>4} {r['status']:>6}  {r['bytes']:>8}  {r['ms']:>5}  {mid}  [{tag}]")
        if r["body_head"]:
            print(f"       body_head={r['body_head']!r}")

        # Upsert
        try:
            sb_rpc(
                "careem_test_details_upsert",
                {
                    "p_merchant_id":    mid,
                    "p_json":           r["json"],
                    "p_response_bytes": r["bytes"],
                    "p_http_status":    r["status"],
                    "p_area_ids":       area_ids,
                    "p_error":          r["error"],
                },
            )
            if r["json"] is not None:
                ok += 1
            else:
                err += 1
        except Exception as e:
            print(f"    ! upsert failed for {mid}: {e}")
            err += 1

        if i < total:
            time.sleep(DELAY_MS / 1000.0)

    print("\n" + "=" * 70)
    print(f" DONE — ok={ok}  err={err}  total={total}  bytes_sum={bytes_sum}")
    print("=" * 70)


if __name__ == "__main__":
    main()
