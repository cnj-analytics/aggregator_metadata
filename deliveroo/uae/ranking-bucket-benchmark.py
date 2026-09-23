"""ranking-bucket-benchmark.py  (temporary – batch 5 speed test)

Builds a realistic 31-day test table in the Analytics Bucket so chart queries can be timed
before 31 real days exist. It copies one real exported hour (default 2026-09-23 18:00) into
31 days x 21 hours (06:00 -> 02:00), one write per day, rows sorted by partner – exactly the
layout the daily export produces. Written to a separate namespace (deliveroo_bench) so it
never mixes with real data.

MODE=build  -> create/replace deliveroo_bench.ranking_31d
MODE=drop   -> delete the test table (and namespace)

Env: same secrets as ranking-export.py, plus SOURCE_DATE / SOURCE_HOUR, DAYS (default 31).
"""
import datetime as dt
import os
import sys
import time

import pyarrow as pa
import pyarrow.compute as pc

sys.path.insert(0, os.path.dirname(__file__))
import importlib.util
spec = importlib.util.spec_from_file_location("rx", os.path.join(os.path.dirname(__file__), "ranking-export.py"))
rx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rx)

NS, TBL = "deliveroo_bench", "ranking_31d"
MODE = os.environ.get("MODE", "build")
SOURCE_DATE = dt.date.fromisoformat(os.environ.get("SOURCE_DATE", "2026-09-23"))
SOURCE_HOUR = dt.time(int(os.environ.get("SOURCE_HOUR", "18")))
DAYS = int(os.environ.get("DAYS", "31"))
HOURS = [dt.time(h) for h in list(range(6, 24)) + [0, 1, 2]]


def catalog():
    from pyiceberg.catalog import load_catalog
    from urllib.parse import urlparse
    ref = urlparse(os.environ["SUPABASE_URL"]).hostname.split(".")[0]
    return load_catalog(
        "supabase-analytics", type="rest", warehouse=rx.BUCKET,
        uri=f"https://{ref}.supabase.co/storage/v1/iceberg", token=os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        **{"py-io-impl": "pyiceberg.io.pyarrow.PyArrowFileIO",
           "s3.endpoint": f"https://{ref}.supabase.co/storage/v1/s3",
           "s3.access-key-id": os.environ["SUPABASE_S3_ACCESS_KEY_ID"],
           "s3.secret-access-key": os.environ["SUPABASE_S3_SECRET_ACCESS_KEY"],
           "s3.region": os.environ.get("SUPABASE_S3_REGION", "ap-southeast-2"),
           "s3.force-virtual-addressing": False})


def main():
    cat = catalog()
    if MODE == "drop":
        try:
            cat.drop_table((NS, TBL), purge_requested=True)
            print("Dropped", NS, TBL)
        except Exception as e:
            print("drop_table:", e)
        try:
            cat.drop_namespace(NS)
        except Exception as e:
            print("drop_namespace:", e)
        return

    import psycopg
    from pyiceberg.transforms import IdentityTransform
    t0 = time.time()
    with psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True) as conn:
        conn.execute("set statement_timeout = 0")
        base = rx.read_hours(conn, SOURCE_DATE, [SOURCE_HOUR])
    print(f"Source hour {SOURCE_DATE} {SOURCE_HOUR}: {base.num_rows:,} rows ({time.time()-t0:.0f}s)")

    cat.create_namespace_if_not_exists(NS)
    try:
        cat.drop_table((NS, TBL), purge_requested=True)
    except Exception:
        pass
    table = cat.create_table((NS, TBL), schema=rx.ARROW_SCHEMA, properties={
        "write.parquet.row-group-limit": "100000", "write.parquet.compression-codec": "zstd"})
    with table.update_spec() as s:
        s.add_field("deliveroo_area_scrape_date", IdentityTransform(), "scrape_date")

    first = SOURCE_DATE - dt.timedelta(days=DAYS - 1)
    total = 0
    for d in range(DAYS):
        day = first + dt.timedelta(days=d)
        td = time.time()
        parts = []
        for h in HOURS:
            di = base.schema.get_field_index("deliveroo_area_scrape_date")
            hi = base.schema.get_field_index("deliveroo_area_scrape_hour")
            t = base.set_column(di, base.schema.field(di), pa.array([day] * base.num_rows, type=pa.date32()))
            t = t.set_column(hi, base.schema.field(hi), pa.array([h] * base.num_rows, type=pa.time64("us")))
            parts.append(t)
        day_tbl = pa.concat_tables(parts)
        idx = pc.sort_indices(day_tbl, sort_keys=[("deliveroo_branch_partner_id", "ascending"),
                                                   ("deliveroo_area_scrape_hour", "ascending"),
                                                   ("deliveroo_area_id", "ascending")])
        day_tbl = day_tbl.take(idx)
        table.append(day_tbl)
        total += day_tbl.num_rows
        print(f"  {day}: {day_tbl.num_rows:,} rows written ({time.time()-td:.0f}s)", flush=True)
        del parts, day_tbl
    table.refresh()
    files = list(table.inspect.files().to_pylist()) if hasattr(table, "inspect") else []
    size = sum(f.get("file_size_in_bytes", 0) for f in files)
    print(f"Done: {total:,} rows, {len(files)} files, {size/1e9:.2f} GB, {size/max(total,1):.1f} bytes/row, {time.time()-t0:.0f}s")
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write(f"## Bucket benchmark table\n\n{DAYS} days × 21 hours from {SOURCE_DATE} {SOURCE_HOUR}: "
                    f"**{total:,} rows**, {len(files)} files, **{size/1e9:.2f} GB**, {size/max(total,1):.1f} bytes/row, "
                    f"{time.time()-t0:.0f} s\n")


if __name__ == "__main__":
    main()
