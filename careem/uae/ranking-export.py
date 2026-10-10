#!/usr/bin/env python3
# careem/uae/ranking-export.py
#
# Daily export: copies finished hours of careem_ranking_analysis to
# the analytics S3 bucket as Iceberg (table: careem.ranking_analysis).
# Records each verified hour in careem_ranking_export_log so the next
# hourly run's housekeeping can drop old partitions safely.
#
# Env:
#   SUPABASE_DB_URL                postgres://... connection string
#   SUPABASE_S3_ACCESS_KEY_ID
#   SUPABASE_S3_SECRET_ACCESS_KEY
#   SUPABASE_S3_REGION             e.g. ap-southeast-2
#   ANALYTICS_BUCKET               careem-ranking-archive
#   DRY_RUN                        'true' to list only, don't write

import os, sys, json
from datetime import date, time, datetime, timezone
import psycopg
import pyarrow as pa
from pyiceberg.catalog import load_catalog

DB_URL     = os.environ["SUPABASE_DB_URL"]
BUCKET     = os.environ["ANALYTICS_BUCKET"]
REGION     = os.environ["SUPABASE_S3_REGION"]
AK         = os.environ["SUPABASE_S3_ACCESS_KEY_ID"]
SK         = os.environ["SUPABASE_S3_SECRET_ACCESS_KEY"]
DRY_RUN    = os.environ.get("DRY_RUN", "false").lower() == "true"
NAMESPACE  = "careem"
TABLE_NAME = "ranking_analysis"

print(f"Careem ranking export — bucket={BUCKET} region={REGION} dry_run={DRY_RUN}", flush=True)


def partitions_to_export():
    """Hour-partitions that exist in Postgres but not in the export log."""
    sql = """
    with parts as (
      select c.relname,
             to_timestamp(substring(c.relname from '_p(\\d{8}_\\d{2})$'),'YYYYMMDD_HH24')::timestamp as start_ts
        from pg_inherits i join pg_class c on c.oid = i.inhrelid
       where i.inhparent = 'public.careem_ranking_analysis'::regclass
    )
    select relname, start_ts::date as d, start_ts::time as h
      from parts
     where start_ts <= (now() at time zone 'Asia/Dubai') - interval '1 hour'
       and not exists (
         select 1 from public.careem_ranking_export_log l
          where l.careem_area_scrape_date = parts.start_ts::date
            and l.careem_area_scrape_hour = parts.start_ts::time)
     order by start_ts;
    """
    with psycopg.connect(DB_URL) as conn, conn.cursor() as cur:
        cur.execute(sql)
        return [(r[0], r[1], r[2]) for r in cur.fetchall()]


def fetch_partition(part_name):
    sql = f"""
      select careem_branch_id, careem_area_id, careem_area_scrape_date, careem_area_scrape_hour,
             careem_listing_rank, careem_listing_appearances,
             careem_is_available, careem_is_busy, careem_availability_text,
             careem_rating, careem_rating_count, careem_eta_minutes,
             careem_is_cplus, careem_has_offer, careem_offer_id, careem_offer_text,
             careem_is_sponsored, careem_ad_id, careem_scraped_at
        from public.{part_name}
    """
    with psycopg.connect(DB_URL) as conn, conn.cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()
        cols = [c.name for c in cur.description]
        return rows, cols


def load_iceberg_catalog():
    return load_catalog(
        "careem_catalog",
        **{
            "type": "sql",
            "uri": f"sqlite:///:memory:",
            "warehouse": f"s3://{BUCKET}/",
            "s3.access-key-id": AK,
            "s3.secret-access-key": SK,
            "s3.region": REGION,
            "s3.endpoint": f"https://{BUCKET}.s3-{REGION}.amazonaws.com",
            "py-io-impl": "pyiceberg.io.pyarrow.PyArrowFileIO",
        },
    )


def ensure_table(catalog):
    schema = pa.schema([
        ("careem_branch_id",            pa.int64()),
        ("careem_area_id",              pa.int64()),
        ("careem_area_scrape_date",     pa.date32()),
        ("careem_area_scrape_hour",     pa.string()),
        ("careem_listing_rank",         pa.int16()),
        ("careem_listing_appearances",  pa.int16()),
        ("careem_is_available",         pa.bool_()),
        ("careem_is_busy",              pa.bool_()),
        ("careem_availability_text",    pa.string()),
        ("careem_rating",               pa.float64()),
        ("careem_rating_count",         pa.int32()),
        ("careem_eta_minutes",          pa.int16()),
        ("careem_is_cplus",             pa.bool_()),
        ("careem_has_offer",            pa.bool_()),
        ("careem_offer_id",             pa.int64()),
        ("careem_offer_text",           pa.string()),
        ("careem_is_sponsored",         pa.bool_()),
        ("careem_ad_id",                pa.int64()),
        ("careem_scraped_at",           pa.timestamp("us", tz="UTC")),
    ])
    full = f"{NAMESPACE}.{TABLE_NAME}"
    try:
        return catalog.load_table(full)
    except Exception:
        try: catalog.create_namespace(NAMESPACE)
        except Exception: pass
        return catalog.create_table(full, schema=schema)


def write_hour(table, rows, cols):
    data = {c: [] for c in cols}
    for r in rows:
        for i, c in enumerate(cols):
            v = r[i]
            if c == "careem_area_scrape_hour" and isinstance(v, time):
                v = v.strftime("%H:%M:%S")
            data[c].append(v)
    arrow = pa.table(data)
    table.append(arrow)
    return len(rows)


def record_export(d, h, n_pg, n_bucket):
    sql = """
    insert into public.careem_ranking_export_log
      (careem_area_scrape_date, careem_area_scrape_hour,
       careem_export_rows_postgres, careem_export_rows_bucket, careem_export_run)
    values (%s, %s, %s, %s, %s)
    on conflict (careem_area_scrape_date, careem_area_scrape_hour) do update
      set careem_export_rows_postgres = excluded.careem_export_rows_postgres,
          careem_export_rows_bucket   = excluded.careem_export_rows_bucket,
          careem_export_run           = excluded.careem_export_run,
          exported_at                 = now();
    """
    run_label = os.environ.get("GITHUB_RUN_ID") or "manual"
    with psycopg.connect(DB_URL) as conn, conn.cursor() as cur:
        cur.execute(sql, (d, h, n_pg, n_bucket, run_label))
        conn.commit()


def main():
    parts = partitions_to_export()
    if not parts:
        print("Nothing to export", flush=True); return
    print(f"{len(parts)} hour(s) to export", flush=True)
    for name, d, h in parts:
        print(f"  {name}  date={d} hour={h}", flush=True)

    if DRY_RUN:
        print("Dry run — nothing written", flush=True); return

    catalog = load_iceberg_catalog()
    table   = ensure_table(catalog)

    for name, d, h in parts:
        rows, cols = fetch_partition(name)
        n = len(rows)
        if n == 0:
            print(f"[{name}] 0 rows, logging empty export", flush=True)
            record_export(d, h, 0, 0); continue
        n_bucket = write_hour(table, rows, cols)
        record_export(d, h, n, n_bucket)
        print(f"[{name}] exported {n_bucket} rows", flush=True)

    print("Done.", flush=True)


if __name__ == "__main__":
    try: main()
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr, flush=True); raise
