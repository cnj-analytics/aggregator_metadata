"""ranking-export.py — Noon UAE

Daily export of finished hour sections of noon_ranking_analysis to the Supabase
Analytics Bucket (Apache Iceberg), so Postgres only needs to keep the last 24 hours.

Runs at 05:00 Dubai (01:00 UTC, inside the Noon scrape pause), from GitHub Actions:
  1. Ask Postgres which hour sections are finished (started 2+ hours ago) and not yet
     exported: noon_ranking_export_candidates().
  2. For each scrape date, read those hours (sorted by branch, then hour/area, in Arrow) and
     write them to noon.ranking_analysis (partitioned by scrape date). Charts are per
     branch, so this sort lets a branch lookup skip almost all of each file. The write
     replaces those exact hours, so a re-run never duplicates. Hours are written in chunks
     of up to CHUNK_HOURS (default 6). Each chunk reconnects to the bucket catalog right
     before writing and retries up to 3 times if the connection drops (safe: a retry
     replaces exactly the same hours, so it never duplicates).
  3. Read the hours back from the bucket, count rows per hour and record each hour with
     noon_ranking_record_export(), which refuses if Postgres and the bucket differ.
     Only recorded hours can ever be dropped from Postgres (noon_ranking_housekeeping drops
     partitions older than 24h that have a verified export).

Env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (Iceberg catalog auth)
  SUPABASE_DB_URL                           (direct Postgres connection string)
  SUPABASE_S3_ACCESS_KEY_ID, SUPABASE_S3_SECRET_ACCESS_KEY, SUPABASE_S3_REGION
  ANALYTICS_BUCKET   (default deliveroo-ranking-archive — shared with Deliveroo, Talabat, Careem)
  DRY_RUN            ("true" = read Postgres and report only; nothing written)
  GITHUB_RUN_ID, GITHUB_STEP_SUMMARY        (set by GitHub)
"""

import os
import sys
import time
from collections import defaultdict
from urllib.parse import urlparse

import psycopg
import pyarrow as pa
import pyarrow.compute as pc

DRY_RUN = os.environ.get("DRY_RUN", "false").lower() == "true"
BUCKET = os.environ.get("ANALYTICS_BUCKET", "deliveroo-ranking-archive")
NAMESPACE = "noon"
TABLE = "ranking_analysis"
SORT_COL = "noon_branch_id"
RUN_ID = os.environ.get("GITHUB_RUN_ID", "local")
FETCH_BATCH = 200_000
CHUNK_HOURS = int(os.environ.get("CHUNK_HOURS", "6"))
MAX_ATTEMPTS = 3

# Column spec mirrors Postgres noon_ranking_analysis (34 columns, same order).
# Postgres smallint -> int32 (Iceberg has no 16-bit int). Enums are exported as text.
COLUMNS = [
    ("noon_branch_id",                  pa.string(),                     False),
    ("noon_area_id",                    pa.int64(),                      False),
    ("noon_area_scrape_date",           pa.date32(),                     False),
    ("noon_area_scrape_hour",           pa.time64("us"),                 False),
    ("noon_listing_rank",               pa.int32(),                      True),
    ("noon_operating_status",           pa.string(),                     True),
    ("noon_operating_type",             pa.string(),                     True),
    ("noon_rating",                     pa.decimal128(3, 1),             True),
    ("noon_rating_count",               pa.int32(),                      True),
    ("noon_rating_status",              pa.string(),                     True),
    ("noon_has_promo",                  pa.bool_(),                      True),
    ("noon_promo_text",                 pa.string(),                     True),
    ("noon_promo_scope",                pa.string(),                     True),
    ("noon_promo_cap",                  pa.decimal128(10, 2),            True),
    ("noon_widget_group",               pa.string(),                     True),
    ("noon_is_personalized",            pa.bool_(),                      True),
    ("noon_is_sponsored",               pa.bool_(),                      True),
    ("noon_ad_slot",                    pa.int32(),                      True),
    ("noon_scraped_at",                 pa.timestamp("us", tz="UTC"),    False),
    ("noon_rating_display_count",       pa.string(),                     True),
    ("noon_promo_mini_tag",             pa.string(),                     True),
    ("noon_promo_extended_tag",         pa.string(),                     True),
    ("noon_promo_is_free_delivery",     pa.bool_(),                      True),
    ("noon_promo_is_non_free_delivery", pa.bool_(),                      True),
    ("noon_is_near_and_quick",          pa.bool_(),                      True),
    ("noon_card_price_tier",            pa.string(),                     True),
    ("noon_card_distance_m",            pa.int32(),                      True),
    ("noon_card_rating_title",          pa.string(),                     True),
    ("noon_card_delivery_fee",          pa.decimal128(10, 2),            True),
    ("noon_card_delivery_min_order",    pa.decimal128(10, 2),            True),
    ("noon_card_delivery_time",         pa.string(),                     True),
    ("noon_promo_percent",              pa.int32(),                      True),
    ("noon_is_vip",                     pa.bool_(),                      True),
    ("noon_vip_msg",                    pa.string(),                     True),
]
ARROW_SCHEMA = pa.schema([pa.field(n, t, nullable=nl) for n, t, nl in COLUMNS])

ENUM_COLS = {"noon_operating_status", "noon_operating_type", "noon_rating_status",
             "noon_promo_scope", "noon_widget_group"}
# Postgres numeric columns have mixed scale (e.g. delivery fee 2.9000000000000004 from
# float maths in the scraper), which breaks Arrow decimal rescaling. Round in SQL.
DECIMAL_COLS = {n: t for n, t, _ in COLUMNS if pa.types.is_decimal(t)}


def _project(name):
    if name in ENUM_COLS:
        return f"{name}::text as {name}"
    if name in DECIMAL_COLS:
        t = DECIMAL_COLS[name]
        return f"round({name}, {t.scale})::numeric({t.precision},{t.scale}) as {name}"
    return name


SELECT_LIST = ", ".join(_project(n) for n, _, _ in COLUMNS)

summary_lines = []


def out(line=""):
    print(line, flush=True)
    summary_lines.append(line)


def write_summary():
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write("\n".join(summary_lines) + "\n")


def load_table(name=TABLE, sort_col=SORT_COL):
    from pyiceberg.catalog import load_catalog
    from pyiceberg.transforms import IdentityTransform

    ref = urlparse(os.environ["SUPABASE_URL"]).hostname.split(".")[0]
    catalog = load_catalog(
        "supabase-analytics",
        type="rest",
        warehouse=BUCKET,
        uri=f"https://{ref}.supabase.co/storage/v1/iceberg",
        token=os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        **{
            "py-io-impl": "pyiceberg.io.pyarrow.PyArrowFileIO",
            "s3.endpoint": f"https://{ref}.supabase.co/storage/v1/s3",
            "s3.access-key-id": os.environ["SUPABASE_S3_ACCESS_KEY_ID"],
            "s3.secret-access-key": os.environ["SUPABASE_S3_SECRET_ACCESS_KEY"],
            "s3.region": os.environ.get("SUPABASE_S3_REGION", "ap-southeast-2"),
            "s3.force-virtual-addressing": False,
        },
    )
    catalog.create_namespace_if_not_exists(NAMESPACE)
    try:
        table = catalog.load_table((NAMESPACE, name))
    except Exception:
        table = None
    if table is not None:
        # Schema evolution: add any columns the Iceberg table lacks. Idempotent.
        existing_names = {f.name for f in table.schema().fields}
        missing = [(n, t) for n, t, _ in COLUMNS if n not in existing_names]
        if missing:
            from pyiceberg.types import (
                BooleanType, StringType, LongType, IntegerType, DateType,
                TimeType, TimestamptzType, DecimalType,
            )

            def pa_to_iceberg(pat):
                if pa.types.is_boolean(pat):   return BooleanType()
                if pa.types.is_string(pat):    return StringType()
                if pa.types.is_int64(pat):     return LongType()
                if pa.types.is_int32(pat):     return IntegerType()
                if pa.types.is_date32(pat):    return DateType()
                if pa.types.is_time(pat):      return TimeType()
                if pa.types.is_timestamp(pat): return TimestamptzType()
                if pa.types.is_decimal(pat):   return DecimalType(precision=pat.precision, scale=pat.scale)
                raise ValueError(f"unmapped pyarrow type: {pat}")

            with table.update_schema() as upd:
                for n, pat in missing:
                    upd.add_column(n, pa_to_iceberg(pat))
            table = catalog.load_table((NAMESPACE, name))
            print(f"Iceberg schema evolved — added: {', '.join(n for n, _ in missing)}", flush=True)
        return table
    table = catalog.create_table(
        (NAMESPACE, name),
        schema=ARROW_SCHEMA,
        properties={
            "write.parquet.row-group-limit": "100000",
            "write.parquet.compression-codec": "zstd",
        },
    )
    with table.update_spec() as spec:
        spec.add_field("noon_area_scrape_date", IdentityTransform(), "scrape_date")
    with table.update_sort_order() as so:
        so.asc(sort_col, IdentityTransform())
    return catalog.load_table((NAMESPACE, name))


def pg():
    """Fresh Postgres connection (a long bucket write can leave an old one idle for minutes)."""
    c = psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True)
    c.execute("set statement_timeout = 0")
    return c


def read_hours(conn, day, hours):
    """Read the given hours of one day as an Arrow table, sorted for branch lookups.

    Postgres streams each hour section as stored (no ORDER BY) to keep server-side sort
    off the Micro compute instance. The sort (branch_id, hour, area_id) is done here in
    Arrow instead, in memory on the runner.
    """
    sql = (
        f"select {SELECT_LIST} from public.noon_ranking_analysis "
        "where noon_area_scrape_date = %s and noon_area_scrape_hour = %s"
    )
    batches = []
    for h in hours:
        with conn.transaction(), conn.cursor(name="export_cur") as cur:
            cur.itersize = FETCH_BATCH
            cur.execute(sql, (day, h))
            while True:
                rows = cur.fetchmany(FETCH_BATCH)
                if not rows:
                    break
                cols = list(zip(*rows))
                batches.append(pa.record_batch(
                    [pa.array(c, type=t) for c, (_, t, _) in zip(cols, COLUMNS)],
                    schema=ARROW_SCHEMA,
                ))
    data = pa.Table.from_batches(batches, schema=ARROW_SCHEMA)
    if data.num_rows == 0:
        return data
    order = pc.sort_indices(data, sort_keys=[
        ("noon_branch_id", "ascending"),
        ("noon_area_scrape_hour", "ascending"),
        ("noon_area_id", "ascending"),
    ])
    return data.take(order)


def hours_filter(day, hours):
    from pyiceberg.expressions import And, EqualTo, In
    return And(EqualTo("noon_area_scrape_date", day), In("noon_area_scrape_hour", set(hours)))


def bucket_counts(table, day, hours):
    scan = table.scan(
        row_filter=hours_filter(day, hours),
        selected_fields=("noon_area_scrape_hour",),
    ).to_arrow()
    counts = defaultdict(int)
    if scan.num_rows:
        vc = pc.value_counts(scan.column("noon_area_scrape_hour"))
        for item in vc.to_pylist():
            counts[item["values"]] = item["counts"]
    return counts


def main():
    t_start = time.time()
    out(f"## Noon ranking export → Analytics Bucket ({'DRY RUN' if DRY_RUN else 'live'})")
    out()
    with pg() as conn:
        cands = conn.execute(
            "select noon_area_scrape_date, noon_area_scrape_hour, section_name, rows_postgres "
            "from public.noon_ranking_export_candidates() order by 1, 2"
        ).fetchall()
    if not cands:
        out("Nothing to export: every finished hour is already in the bucket.")
        return 0

    by_day = defaultdict(list)
    for d, h, sec, n in cands:
        by_day[d].append((h, sec, n))
    out(f"Hours to export: **{len(cands)}** across {len(by_day)} day(s), "
        f"{sum(c[3] for c in cands):,} rows.")
    out()
    out("| Day / hours | Hours | Rows (Postgres) | Rows (bucket) | Recorded | Seconds |")
    out("|---|---|---|---|---|---|")

    failures = 0
    for day, items in sorted(by_day.items()):
        chunks = [items[i:i + CHUNK_HOURS] for i in range(0, len(items), CHUNK_HOURS)]
        for chunk in chunks:
            hours = [h for h, _, _ in chunk]
            label = f"{day} {hours[0].strftime('%H')}-{hours[-1].strftime('%H')}h"
            pg_rows = sum(n for _, _, n in chunk)
            if DRY_RUN:
                out(f"| {label} | {len(hours)} | {pg_rows:,} | – | dry run | – |")
                continue
            t0 = time.time()
            with pg() as rc:
                data = read_hours(rc, day, hours)
            t_read = time.time() - t0
            print(f"[{label}] read {data.num_rows:,} rows from Postgres in {t_read:.0f}s", flush=True)
            counts, t_write = None, 0.0
            for attempt in range(1, MAX_ATTEMPTS + 1):
                t1 = time.time()
                try:
                    table = load_table()
                    flt = hours_filter(day, hours)
                    if data.num_rows:
                        table.overwrite(data, overwrite_filter=flt)
                    else:
                        table.delete(delete_filter=flt)   # empty hours: just clear any stale rows
                    t_write = time.time() - t1
                    table = load_table()
                    counts = bucket_counts(table, day, hours)
                    print(f"[{label}] written in {t_write:.0f}s (attempt {attempt})", flush=True)
                    break
                except Exception as e:
                    print(f"[{label}] attempt {attempt} failed after {time.time() - t1:.0f}s: "
                          f"{type(e).__name__}: {str(e)[:200]}", flush=True)
                    if attempt == MAX_ATTEMPTS:
                        failures += len(chunk)
                        out(f"| {label} | {len(hours)} | {pg_rows:,} | – | **NOT exported**: "
                            f"{type(e).__name__} | {time.time() - t0:.0f} |")
                    else:
                        time.sleep(20 * attempt)
            del data
            if counts is None:
                continue
            recorded = 0
            with pg() as rec:
                for h, sec, n in chunk:
                    try:
                        rec.execute(
                            "select public.noon_ranking_record_export(%s, %s, %s, %s)",
                            (day, h, counts.get(h, 0), RUN_ID),
                        )
                        recorded += 1
                    except Exception as e:
                        failures += 1
                        out(f"| {day} {h} | 1 | {n:,} | {counts.get(h, 0):,} | **NOT recorded**: {str(e)[:120]} | |")
            out(f"| {label} | {len(hours)} | {pg_rows:,} | {sum(counts.values()):,} | {recorded}/{len(hours)} | "
                f"{time.time() - t0:.0f} (read {t_read:.0f}, write {t_write:.0f}) |")

    out()
    out(f"Total time: {time.time() - t_start:.0f}s. Hours not recorded stay in Postgres and are retried next run.")
    return 1 if failures else 0


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    except Exception as e:
        out(f"**FAILED:** {type(e).__name__}: {str(e)[:500]}")
        raise
    finally:
        write_summary()
    sys.exit(code)
