-- noon/uae/sql/004_probe_page_counts.sql
--
-- Follow-up to 003, after the first probe run.
--
-- Two findings from that run:
--
--   1. The /search response envelope carries nbPages and nbHits — Noon's own
--      totals for the current query. Recording them turns "did we exhaust the
--      list?" from an inference into a check: pages walked should reach
--      nb_pages, and unique outlets should land near nb_hits.
--
--   2. noon_restaurant_list_probe_areas joined the page log to the card table,
--      so every page row was multiplied by the number of cards in that area —
--      an area with 2 pages and 120 cards reported 240 pages and 14,400 cards.
--      The page log already holds everything the summary needs, so it now
--      aggregates on its own and counts unique outlets as sum(new_outlets)
--      (new_outlets is per-page "not seen earlier in this area", so the sum
--      counts each outlet exactly once).
--
-- Column names and order of the view are unchanged so it can be replaced in
-- place; the new totals are appended at the end.

alter table public.noon_restaurant_list_probe_page
  add column if not exists nb_pages integer,
  add column if not exists nb_hits  integer;

create or replace view public.noon_restaurant_list_probe_areas as
select
  pg.probe_batch,
  pg.noon_area_id,
  pg.area_name,
  pg.noon_zone_code,
  count(*)                                     as pages,
  max(pg.page_no)                              as last_page,
  sum(pg.cards_on_page)                        as cards_seen,
  sum(pg.new_outlets)                          as unique_outlets,
  sum(pg.response_bytes)                       as bytes,
  round(avg(pg.elapsed_ms))                    as avg_ms,
  count(*) filter (where pg.error is not null) as failed_pages,
  bool_or(pg.got_search_token is null)         as token_exhausted,
  max(pg.nb_pages)                             as server_nb_pages,
  max(pg.nb_hits)                              as server_nb_hits,
  min(pg.fetched_at)                           as started_at,
  max(pg.fetched_at)                           as finished_at
from public.noon_restaurant_list_probe_page pg
group by 1,2,3,4
order by unique_outlets desc;

comment on view public.noon_restaurant_list_probe_areas is
  'THROWAWAY. Per-area probe result, aggregated from the page log alone. unique_outlets sums new_outlets per page so each outlet counts once. server_nb_pages / server_nb_hits are Noon''s own totals, for checking that pagination really exhausted the list.';
