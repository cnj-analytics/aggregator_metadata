"""ranking-read-speedtest.py  (temporary, READ-ONLY)

Times reading one restaurant's ranking rows straight from the Analytics Bucket (Iceberg),
the way a Vercel function would – no Postgres connection at all, nothing is written.

For each partner it measures:
  1. pyiceberg: plan (find files) + read, for 1 day and for every exported day.
  2. Skipping: how many Parquet row groups (100k-row chunks) actually contain that partner,
     i.e. how much of each file a smart reader needs to download.
  3. DuckDB (iceberg extension, REST catalog): same queries, as an alternative reader.

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_S3_ACCESS_KEY_ID,
     SUPABASE_S3_SECRET_ACCESS_KEY, SUPABASE_S3_REGION, ANALYTICS_BUCKET,
     PARTNERS (comma separated), ONE_DAY (YYYY-MM-DD)
"""
import datetime as dt
import os
import time
from urllib.parse import urlparse

BUCKET = os.environ.get("ANALYTICS_BUCKET", "deliveroo-ranking-archive")
REF = urlparse(os.environ["SUPABASE_URL"]).hostname.split(".")[0]
REGION = os.environ.get("SUPABASE_S3_REGION", "ap-southeast-2")
PARTNERS = [p.strip() for p in os.environ["PARTNERS"].split(",") if p.strip()]
ONE_DAY = dt.date.fromisoformat(os.environ.get("ONE_DAY", "2026-09-26"))
COLS = ("deliveroo_area_scrape_date", "deliveroo_area_scrape_hour", "deliveroo_area_id",
        "deliveroo_listing_rank", "deliveroo_partner_operating_status", "deliveroo_partner_rating",
        "deliveroo_partner_rating_count", "deliveroo_partner_has_free_delivery_promo_badge",
        "deliveroo_partner_has_non_delivery_promo_badge")

lines = []


def out(s=""):
    print(s, flush=True)
    lines.append(s)


def catalog():
    from pyiceberg.catalog import load_catalog
    return load_catalog(
        "supabase-analytics", type="rest", warehouse=BUCKET,
        uri=f"https://{REF}.supabase.co/storage/v1/iceberg",
        token=os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        **{"py-io-impl": "pyiceberg.io.pyarrow.PyArrowFileIO",
           "s3.endpoint": f"https://{REF}.supabase.co/storage/v1/s3",
           "s3.access-key-id": os.environ["SUPABASE_S3_ACCESS_KEY_ID"],
           "s3.secret-access-key": os.environ["SUPABASE_S3_SECRET_ACCESS_KEY"],
           "s3.region": REGION, "s3.force-virtual-addressing": False})


def pyiceberg_tests(table, days):
    from pyiceberg.expressions import And, EqualTo, GreaterThanOrEqual, LessThanOrEqual
    out("### 1. pyiceberg (Python) – direct read")
    out()
    out("| Restaurant | Range | Files | Plan s | Read s | Total s | Rows |")
    out("|---|---|---|---|---|---|---|")
    for p in PARTNERS:
        for label, d0, d1 in (("1 day", ONE_DAY, ONE_DAY), (f"all {len(days)} days", days[0], days[-1])):
            for attempt in ("cold", "warm"):
                flt = And(EqualTo("deliveroo_branch_partner_id", p),
                          And(GreaterThanOrEqual("deliveroo_area_scrape_date", d0.isoformat()),
                              LessThanOrEqual("deliveroo_area_scrape_date", d1.isoformat())))
                t0 = time.time()
                scan = table.scan(row_filter=flt, selected_fields=COLS)
                tasks = list(scan.plan_files())
                t1 = time.time()
                data = scan.to_arrow()
                t2 = time.time()
                out(f"| {p[:8]} | {label} ({attempt}) | {len(tasks)} | {t1-t0:.1f} | {t2-t1:.1f} | "
                    f"**{t2-t0:.1f}** | {data.num_rows:,} |")
    out()


def skipping_test(table, days):
    import pyarrow.parquet as pq
    out("### 2. How much of each file is needed (row-group skipping)")
    out()
    files = table.inspect.files().to_pylist()
    tot_bytes = sum(f["file_size_in_bytes"] for f in files)
    tot_rows = sum(f["record_count"] for f in files)
    out(f"Bucket table: **{len(files)} data files**, {tot_rows:,} rows, {tot_bytes/1e9:.2f} GB, "
        f"days {days[0]} → {days[-1]}.")
    out()
    per_day = {}
    for f in files:
        d = f["partition"].get("scrape_date") if isinstance(f["partition"], dict) else None
        per_day.setdefault(str(d), []).append(f)
    out("| Day | Files | Rows | MB |")
    out("|---|---|---|---|")
    for d in sorted(per_day):
        fs = per_day[d]
        out(f"| {d} | {len(fs)} | {sum(x['record_count'] for x in fs):,} | {sum(x['file_size_in_bytes'] for x in fs)/1e6:.0f} |")
    out()
    fs_io = table.io
    day_files = [f for f in files if str(f["partition"].get("scrape_date")) in (str(ONE_DAY), ONE_DAY.isoformat())]
    out(f"Row groups for {ONE_DAY} ({len(day_files)} files):")
    out()
    out("| Restaurant | Row groups total | Row groups containing it | Share to read |")
    out("|---|---|---|---|")
    metas = []
    t0 = time.time()
    for f in day_files:
        with fs_io.new_input(f["file_path"]).open() as fh:
            metas.append(pq.ParquetFile(fh).metadata)
    t_meta = time.time() - t0
    for p in PARTNERS:
        total = hit = 0
        for m in metas:
            col = m.schema.to_arrow_schema().get_field_index("deliveroo_branch_partner_id")
            for rg in range(m.num_row_groups):
                total += 1
                st = m.row_group(rg).column(col).statistics
                lo = st.min.decode() if st is not None and isinstance(st.min, bytes) else (st.min if st is not None else None)
                hi = st.max.decode() if st is not None and isinstance(st.max, bytes) else (st.max if st is not None else None)
                if st is None or not st.has_min_max or (lo <= p <= hi):
                    hit += 1
        out(f"| {p[:8]} | {total} | {hit} | {hit/max(total,1):.1%} |")
    out()
    out(f"(Reading the file footers for that day took {t_meta:.1f}s.)")
    out()


def duckdb_tests(days):
    import duckdb
    out("### 3. DuckDB (iceberg extension) – direct read")
    out()
    con = duckdb.connect()
    t0 = time.time()
    try:
        for ext in ("httpfs", "iceberg"):
            con.execute(f"INSTALL {ext}; LOAD {ext};")
        con.execute(f"""CREATE SECRET s3s (TYPE s3, KEY_ID '{os.environ["SUPABASE_S3_ACCESS_KEY_ID"]}',
            SECRET '{os.environ["SUPABASE_S3_SECRET_ACCESS_KEY"]}', REGION '{REGION}',
            ENDPOINT '{REF}.supabase.co/storage/v1/s3', URL_STYLE 'path', USE_SSL true)""")
        con.execute(f"""CREATE SECRET ice (TYPE iceberg, TOKEN '{os.environ["SUPABASE_SERVICE_ROLE_KEY"]}')""")
        con.execute(f"""ATTACH '{BUCKET}' AS arch (TYPE iceberg,
            ENDPOINT 'https://{REF}.supabase.co/storage/v1/iceberg', SECRET ice)""")
    except Exception as e:
        out(f"DuckDB could not connect: `{type(e).__name__}: {str(e)[:300]}`")
        out()
        return
    out(f"Connect + attach: {time.time()-t0:.1f}s")
    out()
    out("| Restaurant | Range | Seconds | Rows |")
    out("|---|---|---|---|")
    cols = ", ".join(COLS)
    for p in PARTNERS:
        for label, d0, d1 in (("1 day", ONE_DAY, ONE_DAY), (f"all {len(days)} days", days[0], days[-1])):
            for attempt in ("cold", "warm"):
                t = time.time()
                try:
                    n = con.execute(
                        f"select count(*) from (select {cols} from arch.deliveroo.ranking_analysis "
                        f"where deliveroo_branch_partner_id = ? and deliveroo_area_scrape_date between ? and ?)",
                        [p, d0, d1]).fetchone()[0]
                    out(f"| {p[:8]} | {label} ({attempt}) | **{time.time()-t:.1f}** | {n:,} |")
                except Exception as e:
                    out(f"| {p[:8]} | {label} ({attempt}) | error | `{str(e)[:150]}` |")
    out()


def main():
    t_all = time.time()
    out("## Direct Iceberg read speed test (read-only, no Postgres)")
    out()
    t0 = time.time()
    cat = catalog()
    table = cat.load_table(("deliveroo", "ranking_analysis"))
    out(f"Catalog connect + load table: **{time.time()-t0:.1f}s**")
    out(f"Partition spec: `{table.spec()}` · Sort order: `{table.sort_order()}` · "
        f"Snapshots: {len(table.metadata.snapshots)}")
    out()
    files = table.inspect.files().to_pylist()
    days = sorted({dt.date.fromisoformat(str(f["partition"]["scrape_date"])) for f in files})
    for section in (lambda: skipping_test(table, days), lambda: pyiceberg_tests(table, days),
                    lambda: duckdb_tests(days)):
        try:
            section()
        except Exception as e:
            out(f"Section failed: `{type(e).__name__}: {str(e)[:300]}`")
            out()
    out(f"Total run time: {time.time()-t_all:.0f}s. Runner region: GitHub-hosted (US); bucket region: {REGION}.")
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
