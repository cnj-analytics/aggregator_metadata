"""ranking-export.py

Daily export of finished hour sections of deliveroo_ranking_analysis to the Supabase
Analytics Bucket (Apache Iceberg), so Postgres only needs to keep the last 24 hours.

Runs at 04:00 Dubai (inside the 03:00-05:59 pause), from GitHub Actions:
  1. Ask Postgres which hour sections are finished (started 2+ hours ago) and not yet
     exported: deliveroo_ranking_export_candidates().
  2. For each scrape date, read those hours sorted by partner, then date/hour/area, and
     write them to the Iceberg table deliveroo.ranking_analysis (partitioned by
     scrape date). The write replaces those exact hours, so a re-run never duplicates.
  3. Read the hours back from the bucket, count rows per hour and record each hour with
     deliveroo_ranking_record_export(), which refuses if Postgres and the bucket differ.
     Only recorded hours can ever be dropped from Postgres (hourly retention step).

Env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (Iceberg catalog auth)
  SUPABASE_DB_URL                           (direct Postgres connection string)
  SUPABASE_S3_ACCESS_KEY_ID, SUPABASE_S3_SECRET_ACCESS_KEY, SUPABASE_S3_REGION
  ANALYTICS_BUCKET   (default deliveroo-ranking-archive)
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
NAMESPACE = "deliveroo"
TABLE = "ranking_analysis"
RUN_ID = os.environ.get("GITHUB_RUN_ID", "local")
FETCH_BATCH = 200_000

COLUMNS = [
    ("deliveroo_branch_partner_id", pa.string(), False),
    ("deliveroo_area_id", pa.int64(), False),
    ("deliveroo_area_scrape_date", pa.date32(), False),
    ("deliveroo_area_scrape_hour", pa.time64("us"), False),
    ("deliveroo_listing_rank", pa.int32(), False),
    ("deliveroo_partner_rating_status", pa.string(), False),
    ("deliveroo_partner_rating", pa.decimal128(3, 1), True),
    ("deliveroo_partner_rating_count", pa.int32(), True),
    ("deliveroo_partner_operating_status", pa.string(), False),
    ("deliveroo_partner_fast_tag_visible", pa.bool_(), False),
    ("deliveroo_partner_has_promo_badge", pa.bool_(), False),
    ("deliveroo_partner_has_free_delivery_promo_badge", pa.bool_(), False),
    ("deliveroo_partner_has_non_delivery_promo_badge", pa.bool_(), False),
    ("deliveroo_partner_promo_badge_text", pa.string(), True),
    ("deliveroo_partner_promo_scope", pa.string(), True),
    ("deliveroo_scraped_at", pa.timestamp("us", tz="UTC"), False),
]
ARROW_SCHEMA = pa.schema([pa.field(n, t, nullable=nl) for n, t, nl in COLUMNS])
# Enums are exported as text so any Iceberg reader can use them.
SELECT_LIST = ", ".join(
    f"{n}::text" if n in ("deliveroo_partner_rating_status", "deliveroo_partner_operating_status",
                          "deliveroo_partner_promo_scope") else n
    for n, _, _ in COLUMNS
)

summary_lines = []


def out(line=""):
    print(line, flush=True)
    summary_lines.append(line)


def write_summary():
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write("\n".join(summary_lines) + "\n")


def load_table():
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
        return catalog.load_table((NAMESPACE, TABLE))
    except Exception:
        pass
    table = catalog.create_table(
        (NAMESPACE, TABLE),
        schema=ARROW_SCHEMA,
        properties={
            # Smaller row groups = a partner lookup skips more of each file.
            "write.parquet.row-group-limit": "100000",
            "write.parquet.compression-codec": "zstd",
        },
    )
    with table.update_spec() as spec:
        spec.add_field("deliveroo_area_scrape_date", IdentityTransform(), "scrape_date")
    with table.update_sort_order() as so:  # rows are also written already sorted
        so.asc("deliveroo_branch_partner_id", IdentityTransform())
    return table


def read_hours(conn, day, hours):
    """Read the given hours of one day, sorted for partner lookups, as an Arrow table."""
    sql = (
        f"select {SELECT_LIST} from public.deliveroo_ranking_analysis "
        "where deliveroo_area_scrape_date = %s and deliveroo_area_scrape_hour = any(%s) "
        "order by deliveroo_branch_partner_id, deliveroo_area_scrape_hour, deliveroo_area_id"
    )
    batches = []
    # Server-side cursor (streams rows) needs a transaction; the connection is autocommit.
    with conn.transaction(), conn.cursor(name="export_cur") as cur:
        cur.itersize = FETCH_BATCH
        cur.execute(sql, (day, hours))
        while True:
            rows = cur.fetchmany(FETCH_BATCH)
            if not rows:
                break
            cols = list(zip(*rows))
            batches.append(pa.record_batch([pa.array(c, type=t) for c, (_, t, _) in zip(cols, COLUMNS)],
                                           schema=ARROW_SCHEMA))
    return pa.Table.from_batches(batches, schema=ARROW_SCHEMA)


def bucket_counts(table, day, hours):
    from pyiceberg.expressions import And, EqualTo, In
    scan = table.scan(
        row_filter=And(EqualTo("deliveroo_area_scrape_date", day),
                       In("deliveroo_area_scrape_hour", set(hours))),
        selected_fields=("deliveroo_area_scrape_hour",),
    ).to_arrow()
    counts = defaultdict(int)
    if scan.num_rows:
        vc = pc.value_counts(scan.column("deliveroo_area_scrape_hour"))
        for item in vc.to_pylist():
            counts[item["values"]] = item["counts"]
    return counts


def main():
    t_start = time.time()
    out(f"## Ranking export → Analytics Bucket ({'DRY RUN' if DRY_RUN else 'live'})")
    out()
    with psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True) as conn:
        conn.execute("set statement_timeout = 0")
        cands = conn.execute(
            "select scrape_date, scrape_hour, section, row_count "
            "from public.deliveroo_ranking_export_candidates() order by 1, 2"
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
        out("| Day | Hours | Rows (Postgres) | Rows (bucket) | Recorded | Seconds |")
        out("|---|---|---|---|---|---|")

        table = None if DRY_RUN else load_table()
        failures = 0
        for day, items in sorted(by_day.items()):
            t0 = time.time()
            hours = [h for h, _, _ in items]
            pg_rows = sum(n for _, _, n in items)
            if DRY_RUN:
                out(f"| {day} | {len(hours)} | {pg_rows:,} | – | dry run | – |")
                continue
            data = read_hours(conn, day, hours)
            from pyiceberg.expressions import And, EqualTo, In
            # Replace exactly these hours (safe to re-run; never duplicates).
            table.overwrite(
                data,
                overwrite_filter=And(EqualTo("deliveroo_area_scrape_date", day),
                                     In("deliveroo_area_scrape_hour", set(hours))),
            )
            table.refresh()
            counts = bucket_counts(table, day, hours)
            recorded = 0
            for h, sec, n in items:
                try:
                    conn.execute("select public.deliveroo_ranking_record_export(%s, %s, %s, %s)",
                                 (day, h, counts.get(h, 0), RUN_ID))
                    recorded += 1
                except Exception as e:
                    failures += 1
                    out(f"| {day} {h} | 1 | {n:,} | {counts.get(h, 0):,} | **NOT recorded**: {str(e)[:120]} | |")
            out(f"| {day} | {len(hours)} | {pg_rows:,} | {sum(counts.values()):,} | {recorded}/{len(hours)} | "
                f"{time.time() - t0:.0f} |")

    out()
    out(f"Total time: {time.time() - t_start:.0f}s. Hours not recorded stay in Postgres and are retried next run.")
    return 1 if failures else 0


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    except Exception as e:  # make the failure visible in the run summary
        out(f"**FAILED:** {type(e).__name__}: {str(e)[:500]}")
        raise
    finally:
        write_summary()
    sys.exit(code)
