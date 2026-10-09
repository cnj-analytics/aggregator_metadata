#!/usr/bin/env python3
# careem/uae/restaurant-fields-probe.py
#
# Follow-up probe to restaurant-page-probe.py. The first probe gave us the
# full field inventory (188 leaf paths across 6 restaurants). This probe
# answers the specific questions we still have before the full-scale scrape:
#
#   1. Is `contract_id` really an operator identifier? Fetch multiple
#      same-brand branches and group by brand. If contract_ids cluster by
#      brand (or by legal operator), we have Careem's version of Talabat's
#      brandLegalName.
#
#   2. What is the sub-shape of the key nested fields we haven't yet looked
#      inside?  promotions, tags, rating, price, menu, delivery_zones, link,
#      superapp_link, brand. The first probe showed they exist on 6/6 but
#      only sampled the first leaf of each.
#
# Everything prints into the run log so we read the result in the job
# summary — no artifact download needed.
#
# Env:
#   SUPABASE_URL                 — required
#   SUPABASE_SERVICE_ROLE_KEY    — required
#   CAREEM_PROBE_IDS             — optional CSV of merchant_ids. Default is
#                                  8 picked from the test data: 2 branches
#                                  each of McDonald's, Krispy Kreme,
#                                  Bikanervala and Luca.
#   CAREEM_PROBE_DELAY_MS        — optional, default 1500
#   CAREEM_PROBE_LAT, _LNG       — optional, default Downtown Dubai
#   OUT_DIR                      — optional, default ./out

import os
import sys
import json
import time
import pathlib
import base64

from curl_cffi import requests  # noqa: E402


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
    sys.exit(1)

DELAY_MS = int(os.environ.get("CAREEM_PROBE_DELAY_MS", "1500"))
LAT = os.environ.get("CAREEM_PROBE_LAT", "25.1972")
LNG = os.environ.get("CAREEM_PROBE_LNG", "55.2744")
OUT_DIR = pathlib.Path(os.environ.get("OUT_DIR", "./out"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

DEVICE = {
    "app_version": "26.39.0",
    "os": "iOS/27.0.1",
    "appengine_api_version": "2026-09-17",
    "device_id": "D0O8gpXoJdQ2L5lC",
}

# Same-brand clusters picked from careem_restaurant_list_test:
#   McDonald's   brand 1003992 → 1052131, 1103748
#   Krispy Kreme brand 160     → 923821,  1033651
#   Bikanervala  brand 1003853 → 1006915, 1043497
#   Luca         brand 4496    → 925746,  1108541
DEFAULT_IDS = [
    1052131, 1103748,   # McDonald's
    923821,  1033651,   # Krispy Kreme
    1006915, 1043497,   # Bikanervala
    925746,  1108541,   # Luca
]


def session_id():
    import secrets
    return "FIELDS-" + secrets.token_hex(4).upper()


def decode_jwt_sub(token):
    try:
        p = token.split(".")[1]
        p += "=" * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p)).get("sub")
    except Exception:
        return None


def get_token():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/rpc/careem_token_latest",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
        },
        json={},
    )
    r.raise_for_status()
    rows = r.json()
    row = rows[0] if isinstance(rows, list) else rows
    if not row or not row.get("access_token"):
        raise RuntimeError("careem_token_latest returned no token")
    return row


def hdrs(token, sub):
    sess = session_id()
    host_apigw = "apigateway.careemdash." + "com"
    return {
        "Host": host_apigw,
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
    host_apigw = "apigateway.careemdash." + "com"
    url = "https://" + host_apigw + "/v1/restaurants/" + str(merchant_id)
    t0 = time.time()
    r = requests.get(url, headers=hdrs(token, sub), impersonate="safari18_0", timeout=20)
    ms = int((time.time() - t0) * 1000)
    body = r.text
    return {
        "status": r.status_code,
        "ms": ms,
        "bytes": len(body),
        "json": r.json() if r.ok else None,
        "body_head": body[:400] if not r.ok else None,
    }


def pretty(d, max_chars=1800):
    """Format a sub-tree as pretty JSON, truncated for log readability."""
    s = json.dumps(d, indent=2, ensure_ascii=False)
    if len(s) > max_chars:
        s = s[: max_chars - 50] + "\n    ... (truncated, full in artifact)"
    return s


def describe_menu(menu):
    """menu is huge; return a shape-only summary."""
    if not isinstance(menu, dict):
        return {"type": type(menu).__name__}
    out = {"top_level_keys": sorted(menu.keys())}
    for key in ("sections", "categories", "groups", "items"):
        if key in menu and isinstance(menu[key], list):
            out[f"{key}_count"] = len(menu[key])
            if menu[key]:
                first = menu[key][0]
                if isinstance(first, dict):
                    out[f"{key}_first_keys"] = sorted(first.keys())
                    # If the first section has items, descend one more level
                    for sub_key in ("items", "products", "item_list"):
                        if sub_key in first and isinstance(first[sub_key], list) and first[sub_key]:
                            out[f"{key}_first_{sub_key}_count"] = len(first[sub_key])
                            item0 = first[sub_key][0]
                            if isinstance(item0, dict):
                                out[f"{key}_first_{sub_key}_first_keys"] = sorted(item0.keys())
    return out


def main():
    ids_env = os.environ.get("CAREEM_PROBE_IDS", "").strip()
    ids = DEFAULT_IDS if not ids_env else [int(x.strip()) for x in ids_env.split(",") if x.strip()]

    print("=" * 70)
    print(" Careem UAE — restaurant-fields follow-up probe")
    print("=" * 70)
    print(f" Sample ids ({len(ids)}): {ids}")
    print(f" lat={LAT} lng={LNG}  delay={DELAY_MS}ms")

    tok = get_token()
    sub = decode_jwt_sub(tok["access_token"])
    print(f"\nSTEP 1: Token  jti={(tok.get('jwt_jti') or '')[:8]} sub={sub}  expires={tok.get('expires_at')}")

    print(f"\nSTEP 2: Fetching {len(ids)} restaurants")
    rows = []
    for i, mid in enumerate(ids):
        r = fetch_restaurant(mid, tok["access_token"], sub)
        print(f"  [{r['status']}] merchant={mid}  size={r['bytes']}B  ms={r['ms']}")
        if r["json"] is not None:
            # Save per-merchant raw to artifact
            (OUT_DIR / f"restaurant_{mid}.json").write_text(
                json.dumps(r["json"], indent=2, ensure_ascii=False)
            )
            rows.append((mid, r["json"]))
        if i < len(ids) - 1:
            time.sleep(DELAY_MS / 1000.0)

    if not rows:
        print("\nNo 200 responses. See errors above.")
        return

    # ────────────────────────────────────────────────────────────────────
    # Operator-ID validation: do contract_ids cluster by brand?
    # ────────────────────────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print(" STEP 3: contract_id ↔ brand clustering (operator-ID test)")
    print("=" * 70)
    print(f"\n  {'merchant_id':>12}  {'brand_id':>8}  {'contract_id':>12}  "
          f"{'brand.count':>11}  {'location':<25}  name")
    print("  " + "-" * 95)
    by_brand = {}
    for mid, j in rows:
        contract = j.get("contract_id")
        brand_id = j.get("brand_id") or (j.get("brand") or {}).get("id")
        brand_name = (j.get("brand") or {}).get("name") or "?"
        brand_count = (j.get("brand") or {}).get("count")
        location = j.get("location") or "?"
        name = j.get("name") or j.get("merchant_sub_text") or "?"
        print(f"  {mid:>12}  {brand_id!s:>8}  {contract!s:>12}  "
              f"{brand_count!s:>11}  {location[:25]:<25}  {name}")
        by_brand.setdefault(brand_id, []).append((mid, contract, brand_name))

    print("\n  Grouped by brand:")
    for brand_id, members in by_brand.items():
        contracts = {c for _, c, _ in members}
        verdict = "✓ single contract_id across all branches" if len(contracts) == 1 \
            else "✗ MULTIPLE contract_ids — not an operator id"
        bname = members[0][2]
        print(f"    brand {brand_id} ({bname}): n={len(members)}  contract_ids={sorted(c for c in contracts if c is not None)}  {verdict}")

    # ────────────────────────────────────────────────────────────────────
    # Sub-shape dump: inspect one representative per brand
    # ────────────────────────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print(" STEP 4: Sub-shape dump — one representative per brand")
    print("=" * 70)
    seen_brands = set()
    for mid, j in rows:
        bid = j.get("brand_id") or (j.get("brand") or {}).get("id")
        if bid in seen_brands:
            continue
        seen_brands.add(bid)

        name = j.get("name") or "?"
        print(f"\n  ── merchant {mid}  brand {bid}  “{name}”  ────────────────────")

        print(f"\n    link           = {j.get('link')}")
        print(f"    superapp_link  = {j.get('superapp_link')}")
        print(f"    image_url      = {j.get('image_url')}")
        print(f"    logo_url       = {j.get('logo_url')}")

        print("\n    brand (full) =")
        print("    " + pretty(j.get("brand"), 900).replace("\n", "\n    "))

        print("\n    rating =")
        print("    " + pretty(j.get("rating"), 500).replace("\n", "\n    "))

        print("\n    price =")
        print("    " + pretty(j.get("price"), 500).replace("\n", "\n    "))

        print("\n    tags =")
        print("    " + pretty(j.get("tags"), 1200).replace("\n", "\n    "))

        print("\n    promotions =")
        print("    " + pretty(j.get("promotions"), 1500).replace("\n", "\n    "))

        print("\n    delivery (full) =")
        print("    " + pretty(j.get("delivery"), 700).replace("\n", "\n    "))

        print("\n    delivery_zones[0:3] =")
        dz = j.get("delivery_zones") or []
        print("    " + pretty(dz[:3], 1000).replace("\n", "\n    "))
        print(f"    delivery_zones total length = {len(dz)}")

        print("\n    menu shape =")
        print("    " + pretty(describe_menu(j.get("menu")), 1500).replace("\n", "\n    "))

    print("\n" + "=" * 70)
    print(" DONE — full raw JSONs for all merchants are in the uploaded artifact")
    print("=" * 70)


if __name__ == "__main__":
    main()
