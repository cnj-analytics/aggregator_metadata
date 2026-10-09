#!/usr/bin/env python3
# careem/uae/restaurant-page-probe.py
#
# Careem UAE — ONE-OFF per-restaurant endpoint probe.
#
# Hits `GET https://apigateway.careemdash.com/v1/restaurants/{merchant_id}`
# for a small, diverse sample of merchant_ids and reports:
#   * HTTP status
#   * Response size
#   * Every top-level key seen across the sample + how often it was present
#   * A field inventory of every leaf path (dot notation) with presence count
#     and a sample value — this is what we use to design the final
#     careem_branch_information schema.
#
# Why Python + curl_cffi: the apigateway.careemdash.com host sits behind
# Cloudflare and fingerprints the TLS ClientHello. The findings doc §5 says
# only curl_cffi with impersonate="safari18_0" passes that check reliably.
# Node fetch + default OpenSSL ciphers → HTTP 403.
#
# Env:
#   SUPABASE_URL                 — required
#   SUPABASE_SERVICE_ROLE_KEY    — required
#   CAREEM_PROBE_IDS             — optional CSV of merchant_ids to probe.
#                                  Default: six-sample picked across sponsored,
#                                  offer and plain cards from the current
#                                  careem_restaurant_list_test data.
#   CAREEM_PROBE_DELAY_MS        — optional, default 1500 (ms between calls)
#   CAREEM_PROBE_LAT, _LNG       — optional, lat/lng for the Careem headers.
#                                  Default = Downtown Dubai centroid, matches
#                                  the test harvest already in the DB.
#   OUT_DIR                      — optional, where to drop the raw JSON files.
#                                  Default: ./out
#
# Exit 0 even if some probes fail — the goal is a field-inventory report.
# The run.log is where you see per-id outcomes.

import os
import sys
import json
import time
import pathlib
import base64
import collections

# curl_cffi is installed by the workflow via pip. Imported after so the
# "missing env var" check still fails fast with a clear message.
from curl_cffi import requests  # noqa: E402


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
    sys.exit(1)

DELAY_MS = int(os.environ.get("CAREEM_PROBE_DELAY_MS", "1500"))
LAT = os.environ.get("CAREEM_PROBE_LAT", "25.1972")   # Downtown Dubai
LNG = os.environ.get("CAREEM_PROBE_LNG", "55.2744")
OUT_DIR = pathlib.Path(os.environ.get("OUT_DIR", "./out"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Device profile (mirrors sync-areas.js + listings-scrape-test.js) ─────
DEVICE = {
    "app_version": "26.39.0",
    "os": "iOS/27.0.1",
    "appengine_api_version": "2026-09-17",
    "device_id": "D0O8gpXoJdQ2L5lC",
}

# Default sample picked from the current test data:
#   sponsored: 1046083 (Gluten Free & More), 1103748 (McDonald's UAE 1)
#   offer:     324 (Bentoya Kitchen),        414 (Carluccio's)
#   plain:     1085590 (The Gelato Code),    1078276 (Birdies Restaurant)
DEFAULT_IDS = [1046083, 1103748, 324, 414, 1085590, 1078276]

ENDPOINT_BASE = "https://apigateway.careemapis.com/v1/restaurants"


def session_id():
    import secrets
    return "PROBE-" + secrets.token_hex(4).upper()


def decode_jwt_sub(token: str):
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return data.get("sub")
    except Exception:
        return None


def get_token():
    """Pull the latest guest token from Supabase careem_token_latest()."""
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


def careem_headers(token: str, sub: str):
    sess = session_id()
    return {
        "Host": "apigateway.careemdash.com",
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


def probe_one(merchant_id: int, token: str, sub: str):
    # Try the Cloudflare-protected per-restaurant endpoint FIRST (per findings
    # doc §4 — the "clean per-branch endpoint" that returns 97 columns of
    # data). The URL base and host header say apigateway.careemdash.com.
    urls_to_try = [
        f"https://apigateway.careemdash.com/v1/restaurants/{merchant_id}",
    ]
    hdrs = careem_headers(token, sub)
    out = {
        "merchant_id": merchant_id,
        "attempts": [],
    }
    for url in urls_to_try:
        t0 = time.time()
        try:
            r = requests.get(
                url,
                headers=hdrs,
                impersonate="safari18_0",   # TLS fingerprint that passes CF
                timeout=20,
            )
            elapsed_ms = int((time.time() - t0) * 1000)
            body = r.text
            attempt = {
                "url": url,
                "status": r.status_code,
                "elapsed_ms": elapsed_ms,
                "bytes": len(body),
            }
            try:
                attempt["json"] = r.json()
            except Exception:
                attempt["body_head"] = body[:400]
            out["attempts"].append(attempt)
            if r.status_code == 200 and "json" in attempt:
                out["ok_url"] = url
                out["json"] = attempt["json"]
                return out
        except Exception as e:
            out["attempts"].append({"url": url, "error": str(e), "elapsed_ms": int((time.time() - t0) * 1000)})
    return out


def walk_leaves(node, prefix=""):
    """Yield (dot_path, value) for every leaf in a nested JSON structure."""
    if isinstance(node, dict):
        if not node:
            yield (prefix or "<root>", "{}")
            return
        for k, v in node.items():
            path = f"{prefix}.{k}" if prefix else k
            yield from walk_leaves(v, path)
    elif isinstance(node, list):
        if not node:
            yield (f"{prefix}[]", "[]")
            return
        # Only descend into the first element for schema inventory, but note the length.
        yield (f"{prefix}[].length", len(node))
        yield from walk_leaves(node[0], f"{prefix}[]")
    else:
        yield (prefix or "<root>", node)


def sample_value(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    if len(s) > 80:
        s = s[:77] + "..."
    return s


def build_inventory(ok_probes):
    """From the list of (merchant_id, parsed_json), compute per-leaf-path
    presence count and one sample value."""
    paths = collections.defaultdict(lambda: {"n": 0, "sample": None, "types": set()})
    for mid, j in ok_probes:
        for path, val in walk_leaves(j):
            paths[path]["n"] += 1
            if paths[path]["sample"] is None:
                paths[path]["sample"] = sample_value(val)
            paths[path]["types"].add(type(val).__name__)
    # Sort by presence count descending, then path
    return sorted(
        paths.items(),
        key=lambda kv: (-kv[1]["n"], kv[0])
    )


def main():
    ids_env = os.environ.get("CAREEM_PROBE_IDS", "").strip()
    if ids_env:
        try:
            ids = [int(x.strip()) for x in ids_env.split(",") if x.strip()]
        except ValueError:
            print(f"CAREEM_PROBE_IDS must be a CSV of integers; got: {ids_env}", file=sys.stderr)
            sys.exit(1)
    else:
        ids = DEFAULT_IDS

    print("=" * 70)
    print(" Careem UAE — per-restaurant endpoint probe")
    print("=" * 70)
    print(f" Sample ids: {ids}")
    print(f" lat={LAT} lng={LNG}  delay={DELAY_MS}ms  out_dir={OUT_DIR}")

    print("\nSTEP 1: Pull token from Supabase")
    tok = get_token()
    sub = decode_jwt_sub(tok["access_token"])
    print(f"  jti={(tok.get('jwt_jti') or '')[:8]} sub={sub} expires_at={tok.get('expires_at')}")

    print(f"\nSTEP 2: Probe {len(ids)} merchant_ids on apigateway.careemdash.com")
    results = []
    ok_probes = []
    for i, mid in enumerate(ids):
        r = probe_one(mid, tok["access_token"], sub)
        results.append(r)
        for a in r.get("attempts", []):
            tag = a.get("status") or a.get("error", "?")
            size = a.get("bytes", 0)
            ms = a.get("elapsed_ms", 0)
            print(f"  [{tag}] merchant={mid} {a.get('url')}  size={size}B  {ms}ms")
        if r.get("json") is not None:
            ok_probes.append((mid, r["json"]))
            # Save raw json per merchant for later inspection
            out_file = OUT_DIR / f"restaurant_{mid}.json"
            out_file.write_text(json.dumps(r["json"], indent=2, ensure_ascii=False))
            print(f"    wrote {out_file} ({len(json.dumps(r['json']))} bytes)")
        if i < len(ids) - 1:
            time.sleep(DELAY_MS / 1000.0)

    # Write a combined summary artifact
    summary_path = OUT_DIR / "00-summary.json"
    summary_path.write_text(json.dumps({
        "sampled_ids": ids,
        "ok_count": len(ok_probes),
        "attempts_per_id": {str(r["merchant_id"]): r.get("attempts", []) for r in results},
    }, indent=2, ensure_ascii=False, default=str))

    if not ok_probes:
        print("\nNo 200 responses — nothing to inventory. See per-attempt errors above.")
        print("Common causes: Cloudflare 403 (TLS fingerprint mismatch — curl_cffi may be out of date),")
        print("token expired, or the endpoint path has changed.")
        return

    # Field inventory
    print(f"\nSTEP 3: Field inventory across {len(ok_probes)}/{len(ids)} successful probes")
    inventory = build_inventory(ok_probes)
    inv_path = OUT_DIR / "01-field-inventory.tsv"
    with open(inv_path, "w") as f:
        f.write("path\tn_of_" + str(len(ok_probes)) + "\ttypes\tsample\n")
        for path, info in inventory:
            types_str = ",".join(sorted(info["types"]))
            f.write(f"{path}\t{info['n']}\t{types_str}\t{info['sample']}\n")
    print(f"  wrote {inv_path}")

    # Print the top-level keys and a compact summary of the inventory
    print(f"\n  Top-level keys seen (across {len(ok_probes)} responses):")
    top = {}
    for mid, j in ok_probes:
        if isinstance(j, dict):
            for k in j.keys():
                top[k] = top.get(k, 0) + 1
    for k in sorted(top.keys(), key=lambda x: (-top[x], x)):
        print(f"    [{top[k]}/{len(ok_probes)}]  {k}")

    print(f"\n  Total distinct leaf paths: {len(inventory)}")
    print(f"\n  (full inventory + raw per-restaurant JSONs in the uploaded artifact)")


if __name__ == "__main__":
    main()
