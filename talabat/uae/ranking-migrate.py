"""ranking-migrate.py — one-off Iceberg bucket migration

Copies talabat.ranking_analysis from one Supabase Analytics Bucket to another.
Used to consolidate Talabat's dedicated bucket into the shared bucket that
already holds Deliveroo + Careem.

Reads source bucket, scans by (scrape_date), writes same partition into
destination with pyiceberg `overwrite(overwrite_filter=...)` — safe to re-run,
never duplicates.

Env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY     (Iceberg catalog auth)
  SUPABASE_S3_ACCESS_KEY_ID, SUPABASE_S3_SECRET_ACCESS_KEY, SUPABASE_S3_REGION
  SOURCE_BUCKET   (default talabat-ranking-archive)
  DEST_BUCKET     (default deliveroo-ranking-archive)
  NAMESPACE       (default talabat)
  TABLE           (default ranking_analysis)
  DRY_RUN         ("true" = list what would move; write nothing)
"""

import os
import sys
import time
from collections import defaultdict
from urllib.parse import urlparse

import pyarrow as pa
import pyarrow.compute as pc
from pyiceberg.catalog import load_catalog
from pyiceberg.expressions import EqualTo
from pyiceberg.transforms import IdentityTransform

SOURCE_BUCKET = os.environ.get("SOURCE_BUCKET", "talabat-ranking-archive")
DEST_BUCKET   = os.environ.get("DEST_BUCKET",   "deliveroo-ranking-archive")
NAMESPACE     = os.environ.get("NAMESPACE",     "talabat")
TABLE         = os.environ.get("TABLE",         "ranking_analysis")
DRY_RUN       = os.environ.get("DRY_RUN", "false").lower() == "true"

summary_lines = []


def out(line=""):
    print(line, flush=True)
    summary_lines.append(line)


def write_summary():
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write("\n".join(summary_lines) + "\n")


def _catalog(bucket):
    ref = urlparse(os.environ["SUPABASE_URL"]).hostname.split(".")[0]
    return load_catalog(
        f"supabase-{bucket}",
        type="rest",
        warehouse=bucket,
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


def _ensure_dest_table(dest_cat, source_table):
    """Create the destination table if missing, matching source schema + partitioning."""
    dest_cat.create_namespace_if_not_exists(NAMESPACE)
    try:
        return dest_cat.load_table((NAMESPACE, TABLE))
    except Exception:
        pass
    # Create with matching schema + partition on scrape_date, sort on branch_id.
    schema = source_table.schema().as_arrow()
    tbl = dest_cat.create_table(
        (NAMESPACE, TABLE),
        schema=schema,
        properties={
            "write.parquet.row-group-limit": "100000",
            "write.parquet.compression-codec": "zstd",
        },
    )
    with tbl.update_spec() as spec:
        spec.add_field("talabat_area_scrape_date", IdentityTransform(), "scrape_date")
    with tbl.update_sort_order() as so:
        so.asc("talabat_branch_id", IdentityTransform())
    return tbl


def main():
    t_start = time.time()
    out(f"## Talabat Iceberg migrate — {SOURCE_BUCKET} → {DEST_BUCKET} "
        f"({'DRY RUN' if DRY_RUN else 'live'})")
    out()

    src_cat = _catalog(SOURCE_BUCKET)
    try:
        src = src_cat.load_table((NAMESPACE, TABLE))
    except Exception as e:
        out(f"**Source table not found**: {NAMESPACE}.{TABLE} in {SOURCE_BUCKET} — {e}")
        return 1

    # List all distinct scrape_dates in the source table.
    date_scan = src.scan(selected_fields=("talabat_area_scrape_date",)).to_arrow()
    if date_scan.num_rows == 0:
        out("Source table is empty — nothing to migrate.")
        return 0
    unique_dates = sorted({d for d in date_scan.column("talabat_area_scrape_date").to_pylist()})
    out(f"Source holds **{date_scan.num_rows:,} rows** across **{len(unique_dates)} day(s)**: "
        f"{unique_dates[0]} → {unique_dates[-1]}")
    out()

    if DRY_RUN:
        out("| Day | Source rows | Dest rows (will) | Action |")
        out("|---|---|---|---|")
        for day in unique_dates:
            n = pc.sum(pc.cast(pc.equal(date_scan.column("talabat_area_scrape_date"), day), pa.int64())).as_py()
            out(f"| {day} | {n:,} | – | dry run |")
        out()
        out("Re-run with DRY_RUN=false to perform the migration.")
        return 0

    dest_cat = _catalog(DEST_BUCKET)
    dest = _ensure_dest_table(dest_cat, src)

    out("| Day | Source rows | Dest rows (after) | Match | Read s | Write s |")
    out("|---|---|---|---|---|---|")

    total_rows = 0
    failures = 0
    for day in unique_dates:
        t0 = time.time()
        data = src.scan(row_filter=EqualTo("talabat_area_scrape_date", day)).to_arrow()
        t_read = time.time() - t0
        n_src = data.num_rows

        try:
            t1 = time.time()
            dest.overwrite(data, overwrite_filter=EqualTo("talabat_area_scrape_date", day))
            t_write = time.time() - t1

            # Verify
            dest = dest_cat.load_table((NAMESPACE, TABLE))
            after = dest.scan(
                row_filter=EqualTo("talabat_area_scrape_date", day),
                selected_fields=("talabat_area_scrape_date",),
            ).to_arrow()
            n_dest = after.num_rows
            match = "✅" if n_dest == n_src else "❌"
            if n_dest != n_src:
                failures += 1
            out(f"| {day} | {n_src:,} | {n_dest:,} | {match} | {t_read:.0f} | {t_write:.0f} |")
        except Exception as e:
            failures += 1
            out(f"| {day} | {n_src:,} | – | **FAILED**: {type(e).__name__}: {str(e)[:120]} | {t_read:.0f} | – |")

        total_rows += n_src
        del data

    out()
    out(f"Total: **{total_rows:,} rows** across {len(unique_dates)} days in "
        f"{time.time() - t_start:.0f}s. Failures: {failures}.")
    if failures == 0:
        out()
        out("**Next steps:**")
        out("1. Update `.github/workflows/talabat-uae-ranking-export.yml`: "
            "set `ANALYTICS_BUCKET: deliveroo-ranking-archive`")
        out("2. Wait for one scheduled export cycle to confirm new bucket is being written to")
        out(f"3. Delete the standalone `{SOURCE_BUCKET}` analytics bucket in Supabase")
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
