"""ranking-export.py — Careem UAE

Daily export of finished hour sections of careem_ranking_analysis to the Supabase
Analytics Bucket (Apache Iceberg), so Postgres only needs to keep the last 24 hours.

Runs at 04:00 Dubai (inside the 03:00-05:59 pause), from GitHub Actions:
1. Ask Postgres which hour sections are finished (started 2+ hours ago) and not yet
   exported: careem_ranking_export_candidates().
2. For each scrape date, read those hours (sorted by branch, then hour/area, in Arrow)
   and write them to careem.ranking_analysis (partitioned by scrape date). The sort
   lets a branch lookup skip almost all of each file. The write replaces those exact
   hours, so a re-run never duplicates.
3. Read the hours back from the bucket, count rows per hour, record each hour with
   careem_ranking_record_export() which refuses if Postgres and bucket differ.
   Only recorded hours can ever be dropped from Postgres (hourly retention step).

Env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (Iceberg catalog auth)
  SUPABASE_DB_URL                           (direct Postgres connection string)
  SUPABASE_S3_ACCESS_KEY_ID, SUPABASE_S3_SECRET_ACCESS_KEY, SUPABASE_S3_REGION
  ANALYTICS_BUCKET                          (default deliveroo-ranking-archive — shared with Deliveroo, Careem uses its own namespace)
  DRY_RUN                                   ("true" = read Postgres and report only)
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
NAMESPACE = "careem"
TABLE = "ranking_analysis"       # sorted by branch (charts are per branch)
RUN_ID = os.environ.get("GITHUB_RUN_ID", "local")
FETCH_BATCH = 200_000
CHUNK_HOURS = int(os.environ.get("CHUNK_HOURS", "6"))
MAX_ATTEMPTS = 3

# Careem schema — 19 columns.
COLUMNS = [
    ("careem_branch_id",             pa.int64(),                      False),
    ("careem_area_id",               pa.int64(),                      False),
    ("careem_area_scrape_date",      pa.date32(),                     False),
    ("careem_area_scrape_hour",      pa.time64("us"),                 False),
    ("careem_listing_rank",          pa.int16(),                      False),
    ("careem_listing_appearances",   pa.int16(),                      False),
    ("careem_is_available",          pa.bool_(),                      True),
    ("careem_is_busy",               pa.bool_(),                      True),
    ("careem_availability_text",     pa.string(),                     True),
    ("careem_rating",                pa.decimal128(3, 1),             True),
    ("careem_rating_count",          pa.int32(),                      True),
    ("careem_eta_minutes",           pa.int16(),                      True),
    ("careem_is_cplus",              pa.bool_(),                      True),
    ("careem_has_offer",             pa.bool_(),                      True),
    ("careem_offer_id",              pa.int64(),                      True),
    ("careem_offer_text",            pa.string(),                     True),
    ("careem_is_sponsored",          pa.bool_(),                      True),
    ("careem_ad_id",                 pa.int64(),                      True),
    ("careem_scraped_at",            pa.timestamp("us", tz="UTC"),    False),
]
ARROW_SCHEMA = pa.schema([pa.field(n, t, nullable=nl) for n, t, nl in COLUMNS])
SELECT_LIST = ", ".join(n for n, _, _ in COLUMNS)

summary_lines = []

def out(line=""):
    print(line, flush=True)
    summary_lines.append(line)

def write_summary():
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write("\n".join(summary_lines) + "\n")

def load_table(name=TABLE, sort_col="careem_branch_id"):
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
            "py-io-impl":           "pyiceberg.io.pyarrow.PyArrowFileIO",
            "s3.endpoint":          f"https://{ref}.supabase.co/storage/v1/s3",
            "s3.access-key-id":     os.environ["SUPABASE_S3_ACCESS_KEY_ID"],
            "s3.secret-access-key": os.environ["SUPABASE_S3_SECRET_ACCESS_KEY"],
            "s3.region":            os.environ.get("SUPABASE_S3_REGION", "ap-southeast-2"),
            "s3.force-virtual-addressing": False,
        },
    )
    catalog.create_namespace_if_not_exists(NAMESPACE)
    try:
        table = catalog.load_table((NAMESPACE, name))
    except Exception:
        table = None
    if table is not None:
        # Schema evolution: add any columns in ARROW_SCHEMA that the Iceberg table
        # doesn't have yet. Idempotent. Added as optional (Iceberg requires that
        # for new columns against existing data).
        existing_names = {f.name for f in table.schema().fields}
        missing = [(n, t) for n, t, _ in COLUMNS if n not in existing_names]
        if missing:
            from pyiceberg.types import (
                BooleanType, StringType, LongType, IntegerType, DateType,
                TimeType, TimestamptzType, DecimalType,
            )
            def pa_to_iceberg(pat):
                if pa.types.is_boolean(pat): return BooleanType()
                if pa.types.is_string(pat):  return StringType()
                if pa.types.is_int64(pat):   return LongType()
                if pa.types.is_int32(pat):   return IntegerType()
                if pa.types.is_int16(pat):   return IntegerType()
                if pa.types.is_date32(pat):  return DateType()
                if pa.types.is_time(pat):    return TimeType()
                if pa.types.is_timestamp(pat): return TimestamptzType()
                if pa.types.is_decimal(pat): return DecimalType(precision=pat.precision, scale=pat.scale)
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
        spec.add_field("careem_area_scrape_date", IdentityTransform(), "scrape_date")
    with table.update_sort_order() as so:
        so.asc(sort_col, IdentityTransform())
    return table

def pg():
    """Fresh Postgres connection (a long bucket write can leave an old one idle for many minutes)."""
    c = psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True)
    c.execute("set statement_timeout = 0")
    return c

def read_hours(conn, day, hours):
    """Read the given hours of one day as an Arrow table, sorted for branch lookups.

    The sort (branch, hour, area) is done here in Arrow (in memory on the runner)
    rather than server-side to avoid Postgres sorting millions of rows on Micro
    compute (would spill to disk and take many minutes).
    """
    sql = (
        f"select {SELECT_LIST} from public.careem_ranking_analysis "
        "where careem_area_scrape_date = %s and careem_area_scrape_hour = %s"
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
                batches.append(pa.record_batch([pa.array(c, type=t) for c, (_, t, _) in zip(cols, COLUMNS)],
                                               schema=ARROW_SCHEMA))
    data = pa.Table.from_batches(batches, schema=ARROW_SCHEMA)
    order = pc.sort_indices(data, sort_keys=[("careem_branch_id",          "ascending"),
                                             ("careem_area_scrape_hour",   "ascending"),
                                             ("careem_area_id",            "ascending")])
    return data.take(order)

def bucket_counts(table, day, hours):
    from pyiceberg.expressions import And, EqualTo, In
    scan = table.scan(
        row_filter=And(EqualTo("careem_area_scrape_date", day),
                       In("careem_area_scrape_hour", set(hours))),
        selected_fields=("careem_area_scrape_hour",),
    ).to_arrow()
    counts = defaultdict(int)
    if scan.num_rows:
        vc = pc.value_counts(scan.column("careem_area_scrape_hour"))
        for item in vc.to_pylist():
            counts[item["values"]] = item["counts"]
    return counts

def main():
    t_start = time.time()
    out(f"## Careem ranking export → Analytics Bucket ({'DRY RUN' if DRY_RUN else 'live'})")
    out()
    with psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True) as conn:
        conn.execute("set statement_timeout = 0")
        cands = conn.execute(
            "select scrape_date, scrape_hour, section, row_count "
            "from public.careem_ranking_export_candidates() order by 1, 2"
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
                try:
                    t1 = time.time()
                    table = load_table(TABLE, "careem_branch_id")
                    from pyiceberg.expressions import And, EqualTo, In
                    flt = And(EqualTo("careem_area_scrape_date", day),
                              In("careem_area_scrape_hour", set(hours)))
                    table.overwrite(data, overwrite_filter=flt)
                    t_write = time.time() - t1
                    table = load_table(TABLE, "careem_branch_id")
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
            if counts is None:
                continue
            del data
            recorded = 0
            rec = pg()
            for h, sec, n in chunk:
                try:
                    rec.execute("select public.careem_ranking_record_export(%s, %s, %s, %s)",
                                (day, h, counts.get(h, 0), RUN_ID))
                    recorded += 1
                except Exception as e:
                    failures += 1
                    out(f"| {day} {h} | 1 | {n:,} | {counts.get(h, 0):,} | **NOT recorded**: {str(e)[:120]} | |")
            rec.close()
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
