#!/usr/bin/env python3
# careem/uae/register-branches.py
#
# Takes merchants from careem_restaurant_list_test, fetches /v1/restaurants/{id}
# with the Cloudflare bypass, and calls careem_register_merchant to populate
# careem_brand, careem_branch, careem_branch_information,
# careem_branch_delivery_area, careem_cuisines and the registration queue in
# one transaction per merchant.
#
# 5-machine matrix: each worker takes an even slice via round-robin
# (i % NUM_MACHINES == MACHINE_NO - 1). Serial inside the slice with a 1500 ms
# delay. Shared guest token from careem_auth_token.
#
# Prints ONE line per merchant as it's processed, flushed immediately,
# so the GitHub Actions log scrolls live.
#
# Env (all optional unless marked required):
#   SUPABASE_URL                    required
#   SUPABASE_SERVICE_ROLE_KEY       required
#   MACHINE_NO                      1..5 (default 1)
#   NUM_MACHINES                    (default 1)
#   CAREEM_REGISTER_LIMIT           total merchants across ALL machines (default 30, 0 = no cap)
#   CAREEM_SKIP_REGISTERED          '1' = skip merchants already in careem_branch (default 1)
#   CAREEM_DELAY_MS                 pacing per machine (default 1500)
#   CAREEM_RETRIES                  retries per merchant on transient failure (default 3)
#   CAREEM_PROBE_LAT, _LNG          header lat/lng (default Downtown Dubai)

import os
import sys
import json
import time
import base64
import secrets

from curl_cffi import requests  # noqa: E402


# ─── env ──────────────────────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr, flush=True)
    sys.exit(1)

MACHINE_NO       = int(os.environ.get("MACHINE_NO",      "1"))
NUM_MACHINES     = int(os.environ.get("NUM_MACHINES",    "1"))
REGISTER_LIMIT   = int(os.environ.get("CAREEM_REGISTER_LIMIT", "30"))  # 0 = no cap
SKIP_REGISTERED  = os.environ.get("CAREEM_SKIP_REGISTERED", "1") == "1"
DELAY_MS         = int(os.environ.get("CAREEM_DELAY_MS", "1500"))
RETRIES          = int(os.environ.get("CAREEM_RETRIES",  "3"))
LAT              = os.environ.get("CAREEM_PROBE_LAT", "25.1972")
LNG              = os.environ.get("CAREEM_PROBE_LNG", "55.2744")

DEVICE = {
    "app_version": "26.39.0",
    "os": "iOS/27.0.1",
    "appengine_api_version": "2026-09-17",
    "device_id": "D0O8gpXoJdQ2L5lC",
}
HOST_APIGW = "apigateway.careemdash." + "com"

TAG = f"[m{MACHINE_NO}]"


def log(msg):
    """Print one line immediately — unbuffered."""
    print(msg, flush=True)


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
        raise RuntimeError(f"PostgREST {r.status_code}: {r.text[:400]}")
    try:
        return r.json()
    except Exception:
        return None


def sb_get(path):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers=_sb_headers(),
        timeout=60,
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


# ─── Candidate selection ──────────────────────────────────────────────
def pick_candidates():
    """
    Pull merchant rows from careem_restaurant_list_test, ordered by
    merchant_id for deterministic slicing. Optionally skip ones already
    in careem_branch. Then take first REGISTER_LIMIT and keep this
    machine's round-robin slice.
    """
    # Already-registered set
    skip_ids = set()
    if SKIP_REGISTERED:
        page = 0
        while True:
            rows = sb_get(f"careem_branch?select=careem_branch_id&limit=1000&offset={page*1000}")
            if not rows:
                break
            skip_ids.update(r["careem_branch_id"] for r in rows)
            if len(rows) < 1000:
                break
            page += 1
        log(f"{TAG} {len(skip_ids)} already-registered branches will be skipped")

    # Pull list_test (paginated), ordered by merchant_id
    all_rows = []
    page = 0
    while True:
        rows = sb_get(
            "careem_restaurant_list_test?"
            "select=careem_merchant_id,careem_name,restaurant_page_url,image_url,careem_area_ids"
            f"&order=careem_merchant_id.asc&limit=1000&offset={page*1000}"
        )
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < 1000:
            break
        page += 1
    log(f"{TAG} fetched {len(all_rows)} candidate rows from careem_restaurant_list_test")

    # Filter out already-registered
    if skip_ids:
        all_rows = [r for r in all_rows if r["careem_merchant_id"] not in skip_ids]
        log(f"{TAG} after skip filter: {len(all_rows)} candidates")

    # Global cap first (so all 5 machines see the same universe)
    if REGISTER_LIMIT > 0:
        all_rows = all_rows[:REGISTER_LIMIT]
        log(f"{TAG} applying global limit → {len(all_rows)}")

    # Round-robin slice
    my_slice = [r for i, r in enumerate(all_rows) if i % NUM_MACHINES == MACHINE_NO - 1]
    log(f"{TAG} my slice: {len(my_slice)} merchants")
    return my_slice


# ─── Careem fetch ─────────────────────────────────────────────────────
def session_id():
    return "REG-" + secrets.token_hex(4).upper()


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
            if r.status_code == 429:
                last_err = f"429 attempt {attempt}"
                log(f"{TAG}   ! 429 (attempt {attempt}/{RETRIES}) — sleep 30s")
                time.sleep(30)
                continue
            if r.status_code >= 500:
                last_err = f"{r.status_code} attempt {attempt}"
                log(f"{TAG}   ! {r.status_code} (attempt {attempt}/{RETRIES}) — backoff {2**attempt}s")
                time.sleep(2 ** attempt)
                continue
            return {
                "status": r.status_code,
                "ms": ms,
                "bytes": len(r.content),
                "json": r.json() if r.ok else None,
                "body_head": r.text[:200] if not r.ok else None,
                "error": None,
            }
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            log(f"{TAG}   ! exception (attempt {attempt}/{RETRIES}): {last_err}")
            time.sleep(2 ** attempt)
    return {"status": 0, "ms": 0, "bytes": 0, "json": None, "body_head": None, "error": last_err}


# ─── main ─────────────────────────────────────────────────────────────
def main():
    log("=" * 70)
    log(f" Careem UAE — register-branches  machine {MACHINE_NO}/{NUM_MACHINES}")
    log(f" limit={REGISTER_LIMIT}  skip_registered={SKIP_REGISTERED}  "
        f"delay={DELAY_MS}ms  retries={RETRIES}")
    log("=" * 70)

    tok = get_token()
    sub = decode_jwt_sub(tok["access_token"])
    log(f"{TAG} token jti={(tok.get('jwt_jti') or '')[:8]}  sub={sub}  expires={tok.get('expires_at')}")

    candidates = pick_candidates()
    total = len(candidates)
    if total == 0:
        log(f"{TAG} nothing to do — exiting cleanly")
        return

    ok = 0
    err = 0
    log("")
    log(f"{TAG} {'#':>5}  {'merchant':>10}  {'ms':>5}  {'bytes':>8}  brand → branch")
    log(f"{TAG} " + "-" * 90)

    for i, row in enumerate(candidates, start=1):
        mid       = row["careem_merchant_id"]
        card_name = row.get("careem_name")
        card_url  = row.get("restaurant_page_url")
        card_img  = row.get("image_url")
        area_ids  = row.get("careem_area_ids") or []

        r = fetch_restaurant(mid, tok["access_token"], sub)

        if r["json"] is None:
            err += 1
            log(f"{TAG} {i:>5}  {mid:>10}  {r['ms']:>5}  {r['bytes']:>8}  "
                f"[HTTP {r['status']}] ERR  {(r['error'] or r['body_head'] or '')[:80]}")
            try:
                sb_rpc("careem_register_merchant_failed", {
                    "p_merchant_id":   mid,
                    "p_card_name":     card_name,
                    "p_card_url":      card_url,
                    "p_card_image_url": card_img,
                    "p_area_id":       area_ids[0] if area_ids else None,
                    "p_error":         (r["error"] or r["body_head"] or f"HTTP {r['status']}")[:400],
                })
            except Exception as e:
                log(f"{TAG}        ! queue-fail upsert error: {e}")
        else:
            try:
                sb_rpc("careem_register_merchant", {
                    "p_merchant_id":    mid,
                    "p_card_name":      card_name,
                    "p_card_url":       card_url,
                    "p_card_image_url": card_img,
                    "p_json":           r["json"],
                    "p_area_ids":       area_ids,
                })
                ok += 1
                brand_name = (r["json"].get("brand") or {}).get("name") or "?"
                branch_name = r["json"].get("name") or "?"
                location   = r["json"].get("location") or "?"
                log(f"{TAG} {i:>5}  {mid:>10}  {r['ms']:>5}  {r['bytes']:>8}  "
                    f"{brand_name[:28]:<28} → {branch_name[:25]:<25} ({location[:18]}) "
                    f"[{len(area_ids)} areas]")
            except Exception as e:
                err += 1
                log(f"{TAG} {i:>5}  {mid:>10}  {r['ms']:>5}  {r['bytes']:>8}  "
                    f"UPSERT FAIL: {str(e)[:120]}")

        if i < total:
            time.sleep(DELAY_MS / 1000.0)

    log("")
    log(f"{TAG} DONE — ok={ok}  err={err}  total={total}")


if __name__ == "__main__":
    main()
