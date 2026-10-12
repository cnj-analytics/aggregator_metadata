-- noon/uae/sql/003_restaurant_list_probe.sql
--
-- THROWAWAY field-discovery probe for the Noon Food listings endpoint.
--
-- Purpose: before designing noon_restaurant_list_queue, capture the COMPLETE
-- raw restaurant card exactly as /mp-food-api-catalog/api/search returns it,
-- for every page of every probed area, so we can enumerate which fields exist,
-- how often they are populated, and what they contain.
--
-- Nothing here is linked to the geography or final tables by FK on purpose —
-- noon_area_id is recorded as a plain bigint. Relational modelling happens in
-- the next phase, once the field inventory is agreed.
--
-- Drop both tables and the views once noon_restaurant_list_queue is designed.

-- ── page-level log (includes pages that returned zero cards) ────────────────
create table if not exists public.noon_restaurant_list_probe_page (
  id                bigint generated always as identity primary key,
  probe_batch       text    not null,
  noon_area_id      bigint  not null,
  area_name         text,
  noon_zone_code    text,
  latitude          double precision,
  longitude         double precision,

  page_no           integer not null,
  sent_search_token text,                  -- token chained in from the previous page
  got_search_token  text,                  -- token returned by this page
  http_status       integer,
  cards_on_page     integer not null default 0,
  new_outlets       integer not null default 0,   -- not seen on earlier pages of this area
  response_bytes    integer,
  elapsed_ms        integer,

  -- every top-level key of the response envelope, so we can see what sits
  -- alongside results[] (facets, totals, banners, sections, …)
  envelope_keys     jsonb,
  error             text,
  fetched_at        timestamptz not null default now()
);

comment on table public.noon_restaurant_list_probe_page is
  'THROWAWAY. One row per /search page request during the listings field-discovery probe. Keeps zero-card and errored pages too, so pagination behaviour is auditable. Drop with noon_restaurant_list_probe.';

create index if not exists noon_rlp_page_batch_idx on public.noon_restaurant_list_probe_page (probe_batch, noon_area_id, page_no);

-- ── card-level capture ──────────────────────────────────────────────────────
create table if not exists public.noon_restaurant_list_probe (
  id              bigint generated always as identity primary key,
  probe_batch     text    not null,
  noon_area_id    bigint  not null,
  area_name       text,
  noon_zone_code  text,

  page_no         integer not null,
  card_index      integer not null,       -- position within the page, 0-based
  rank_in_area    integer,                -- position across the whole area list
  outlet_code     text,                   -- extracted for convenience only

  raw_card        jsonb   not null,       -- the card EXACTLY as returned
  card_bytes      integer,

  fetched_at      timestamptz not null default now()
);

comment on table public.noon_restaurant_list_probe is
  'THROWAWAY. One row per restaurant card per area per page, with the untouched raw card. Source for the field inventory that defines noon_restaurant_list_queue. Drop once that table is designed.';

create index if not exists noon_rlp_batch_idx   on public.noon_restaurant_list_probe (probe_batch, noon_area_id, page_no);
create index if not exists noon_rlp_outlet_idx  on public.noon_restaurant_list_probe (outlet_code);
create index if not exists noon_rlp_raw_gin_idx on public.noon_restaurant_list_probe using gin (raw_card);

-- RLS: service_role only, same as every other Noon table.
alter table public.noon_restaurant_list_probe      enable row level security;
alter table public.noon_restaurant_list_probe_page enable row level security;


-- ════════════════════════════════════════════════════════════════════════════
-- FIELD INVENTORY
-- ════════════════════════════════════════════════════════════════════════════

-- Flatten every card to dotted paths, 3 levels deep, arrays collapsed to [].
-- This is the answer to "what fields are available per area url".
create or replace function public.noon_probe_flatten(p_card jsonb)
returns table (path text, json_type text, value jsonb)
language sql
immutable
set search_path = public
as $fn$
  with recursive walk as (
    select k.key::text as path, k.value as value, 1 as depth
      from jsonb_each(p_card) k
    union all
    select case when jsonb_typeof(w.value) = 'array' then w.path || '[]'
                else w.path || '.' || c.key end,
           c.value,
           w.depth + 1
      from walk w
      cross join lateral (
        select key, value from jsonb_each(w.value)
          where jsonb_typeof(w.value) = 'object'
        union all
        select '', value from jsonb_array_elements(w.value)
          where jsonb_typeof(w.value) = 'array'
      ) c
     where w.depth < 3
       and jsonb_typeof(w.value) in ('object','array')
  )
  select path, jsonb_typeof(value), value from walk;
$fn$;

-- Per-field rollup: how many cards carry it, fill rate, type mix, samples.
create or replace view public.noon_restaurant_list_probe_fields as
with total as (select count(*)::numeric n from public.noon_restaurant_list_probe),
     f as (
       select p.id, x.path, x.json_type, x.value
         from public.noon_restaurant_list_probe p
         cross join lateral public.noon_probe_flatten(p.raw_card) x
     )
select
  path,
  string_agg(distinct json_type, ',' order by json_type)        as json_types,
  count(distinct id)                                            as cards_with_field,
  round(100.0 * count(distinct id) / nullif((select n from total),0), 1) as fill_pct,
  count(*) filter (where json_type not in ('null'))             as non_null_values,
  count(distinct value)                                         as distinct_values,
  (array_agg(distinct left(value::text, 70) order by left(value::text, 70)))[1:3] as sample_values
from f
group by path
order by cards_with_field desc, path;

comment on view public.noon_restaurant_list_probe_fields is
  'THROWAWAY. Field inventory of the probed listing cards: dotted path, type, fill rate and sample values. Read this to decide the columns of noon_restaurant_list_queue.';

-- Area-level summary: did pagination exhaust, how many unique outlets.
create or replace view public.noon_restaurant_list_probe_areas as
select
  pg.probe_batch,
  pg.noon_area_id,
  pg.area_name,
  pg.noon_zone_code,
  count(*)                                        as pages,
  max(pg.page_no)                                 as last_page,
  sum(pg.cards_on_page)                           as cards_seen,
  count(distinct c.outlet_code)                   as unique_outlets,
  sum(pg.response_bytes)                          as bytes,
  round(avg(pg.elapsed_ms))                       as avg_ms,
  count(*) filter (where pg.error is not null)    as failed_pages,
  bool_or(pg.got_search_token is null)            as token_exhausted
from public.noon_restaurant_list_probe_page pg
left join public.noon_restaurant_list_probe c
       on c.probe_batch = pg.probe_batch
      and c.noon_area_id = pg.noon_area_id
group by 1,2,3,4
order by unique_outlets desc;

-- Repeat-rate check: how much do restaurants overlap across probed areas?
-- This is the evidence for the dedup + area-array design of the real queue.
create or replace view public.noon_restaurant_list_probe_overlap as
select
  outlet_code,
  count(distinct noon_area_id)                                  as areas_seen_in,
  array_agg(distinct noon_area_id order by noon_area_id)         as noon_area_ids,
  min(rank_in_area)                                             as best_rank,
  (array_agg(raw_card ->> 'name'))[1]                           as name_guess
from public.noon_restaurant_list_probe
where outlet_code is not null
group by outlet_code
order by areas_seen_in desc, outlet_code;
