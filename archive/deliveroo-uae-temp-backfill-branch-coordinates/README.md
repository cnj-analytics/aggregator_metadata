# ARCHIVED – Deliveroo UAE branch coordinates backfill (one-off)

**Status:** Archived on 23 Sep 2026. Not active – GitHub only runs workflows in `.github/workflows/`, so this one can no longer be triggered.

## What it did

Filled `deliveroo_branch_information.deliveroo_branch_location_latitude` and `deliveroo_branch_location_longitude` in Supabase for every branch.

For each row with no latitude it:

1. Fetched the branch page (`deliveroo_branch.deliveroo_branch_page_url`) with `?geohash=` taken from one of the branch's own delivery areas (`deliveroo_branch_delivery_area` → `deliveroo_area.deliveroo_area_geohash`). Deliveroo returns 403 without a geohash.
2. Read the restaurant's `drnId` and the map pin in the "Location" section of `__NEXT_DATA__`.
3. Wrote lat/lon only when `drnId` matched `deliveroo_branch_partner_id`. Mismatches were logged, never written.

It ran as 20 parallel GitHub Actions jobs (about 43 minutes), with 1.5s between pages and a 60s+ backoff on 429s.

## Outcome

- 16,155 branches filled. No drnId mismatches.
- 34 delisted branches (their menu URL redirects to the area listing) were removed from `deliveroo_branch_information`. They were flagged `deliveroo_branch_is_active = false` in `deliveroo_branch`, and a copy was kept in `backup_deliveroo_branch_information_delisted_20260923`.
- Both columns were then set to `numeric(9,6) NOT NULL`.

## Files

| File | Original location |
|---|---|
| `deliveroo-uae-temp-backfill-branch-coordinates.yml` | `.github/workflows/` |
| `temp-backfill-branch-coordinates.js` | `deliveroo/uae/` |
| `temp-backfill-report.js` | `deliveroo/uae/` |

## Reusing it

Move the `.yml` back into `.github/workflows/` and the two scripts back into `deliveroo/uae/`; the workflow expects those paths. Known issue: each job pages through the empty rows with offsets while other jobs are filling them in, which can skip a few rows. Just re-run it, or switch to keyset pagination (`partner_id > last`).
