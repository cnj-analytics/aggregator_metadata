-- noon/uae/sql/001_noon_city_hub_zone_area.sql
--
-- Noon Food (UAE) geography: country -> city -> hub -> zone -> area.
-- Applied to Supabase project zxsglrnjlmghplecndue as migration
-- noon_city_hub, noon_zone, noon_area, noon_touch_updated_at, noon_refresh_active.
-- Kept here as the source of truth.
--
-- What is native to Noon and what is not:
--   noon_city, noon_hub, noon_zone  -> NATIVE. Parsed from the food zone code
--       Noon returns for a location, e.g. FOOD-AE-DXB-HUB4-DUBAI_MARINA
--       = country AE / city DXB / hub 4 / zone DUBAI_MARINA.
--       Discovered by noon/uae/sync-areas.js (mode=zones) with a UAE grid scan.
--   noon_area -> NOT native. Noon exposes no area IDs, names or area URLs.
--       Restaurant lists depend on the exact location (snapped internally by
--       Noon to hidden points), not on the zone. So areas are sampling points:
--       every Talabat UAE area centroid, plus one fill-in point for any Noon
--       zone that contains no Talabat area. Each area is linked to the Noon
--       zone that covers it and is active iff Noon lists >= 1 restaurant there.
--       Probed by noon/uae/sync-areas.js (mode=areas).
--
-- Active roll-up (noon_refresh_active()):
--   area active  -> its zone is active -> its hub is active -> its city is active.

-- ── noon_city ───────────────────────────────────────────────────────────────
create table if not exists public.noon_city (
  noon_city_code   text primary key,                 -- 'DXB', 'AUH', 'QAJ' ...
  noon_city_name   text,                             -- readable name (Noon only gives the code)
  country_id       uuid not null references public.aggregator_country(deliveroo_country_id),
  talabat_city_id  bigint references public.talabat_city(city_id),  -- cross-platform link, null if Talabat has no such city
  is_active        boolean not null default false,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.noon_city is
  'Noon Food UAE cities, native to Noon: the city segment of the food zone code (FOOD-AE-<CITY>-HUB<n>-<ZONE>). Filled by noon/uae/sync-areas.js mode=zones. is_active = any hub active.';

-- ── noon_hub ────────────────────────────────────────────────────────────────
create table if not exists public.noon_hub (
  noon_hub_id      text primary key,                 -- '<CITY>-HUB<n>', e.g. 'DXB-HUB4' (hub numbers repeat across cities)
  noon_city_code   text not null references public.noon_city(noon_city_code),
  hub_number       integer not null,
  is_active        boolean not null default false,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (noon_city_code, hub_number)
);
comment on table public.noon_hub is
  'Noon Food UAE hubs, native to Noon: the HUB<n> segment of the food zone code. Unique per city. is_active = any zone active.';

-- ── noon_zone ───────────────────────────────────────────────────────────────
create table if not exists public.noon_zone (
  noon_zone_code   text primary key,                 -- full code: 'FOOD-AE-DXB-HUB4-DUBAI_MARINA' (sent as x-food-zonecode)
  noon_hub_id      text not null references public.noon_hub(noon_hub_id),
  noon_city_code   text not null references public.noon_city(noon_city_code),
  zone_key         text not null,                    -- 'DUBAI_MARINA'
  zone_name        text not null,                    -- 'Dubai Marina' (readable form of zone_key)
  latitude         double precision,                 -- representative point: the grid hit closest to the hits' centre
  longitude        double precision,
  geohash          text,
  grid_hit_count   integer,                          -- grid points (last scan) that resolved to this zone
  min_latitude     double precision,                 -- bounding box of those grid hits
  max_latitude     double precision,
  min_longitude    double precision,
  max_longitude    double precision,
  is_active        boolean not null default false,   -- any noon_area in this zone is active
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(), -- last zone scan that saw it; older than the latest scan = no longer returned by Noon
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.noon_zone is
  'Noon Food UAE delivery zones, native to Noon (x-food-zonecode from whoami?experience=food). Discovered by a UAE grid scan. Noon also assigns zones to sea/desert points, so is_active comes from noon_area probes, not from the zone existing.';
create index if not exists noon_zone_hub_idx  on public.noon_zone (noon_hub_id);
create index if not exists noon_zone_city_idx on public.noon_zone (noon_city_code);

-- ── noon_area ───────────────────────────────────────────────────────────────
create table if not exists public.noon_area (
  noon_area_id           bigint generated always as identity primary key,
  source_key             text not null unique,       -- 'talabat:<area_id>' or 'zone:<noon_zone_code>' (upsert key)
  area_source            text not null check (area_source in ('talabat','noon_zone')),
  talabat_area_id        bigint unique references public.talabat_area(area_id),
  area_name              text not null,
  area_name_ar           text,
  area_slug              text,
  latitude               double precision not null,  -- the point Noon is queried at
  longitude              double precision not null,
  geohash                text,
  noon_zone_code         text references public.noon_zone(noon_zone_code),  -- zone Noon assigns to this point (null = Noon serves no zone here)
  noon_hub_id            text references public.noon_hub(noon_hub_id),
  noon_city_code         text references public.noon_city(noon_city_code),
  noon_geo_city_id       integer,                    -- raw cityId from Noon's geo service (not reliable as a city key)
  noon_resolved_address  text,                       -- address string Noon's geo service returns for the point
  is_active              boolean not null default false,  -- Noon lists >= 1 restaurant at this point
  restaurant_count_page1 integer,                    -- restaurants on the first listing page (max 60); sanity check only
  listing_fingerprint    text,                       -- md5 of first-page outlet codes + distances; equal = Noon gives these areas the same list
  last_probed_at         timestamptz,
  probe_error            text,                       -- set when the last probe failed; is_active is then left unchanged
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
comment on table public.noon_area is
  'Noon Food UAE sampling points (Noon has no native areas). One row per Talabat UAE area (area_source=talabat) plus one fill-in per Noon zone with no Talabat area (area_source=noon_zone). Linked to the Noon zone covering the point. is_active = Noon lists >= 1 restaurant at (latitude, longitude). Areas sharing a listing_fingerprint get an identical list.';
create index if not exists noon_area_zone_idx on public.noon_area (noon_zone_code);
create index if not exists noon_area_city_idx on public.noon_area (noon_city_code);
create index if not exists noon_area_hub_idx  on public.noon_area (noon_hub_id);
create index if not exists noon_hub_city_idx  on public.noon_hub (noon_city_code);
create index if not exists noon_city_talabat_idx on public.noon_city (talabat_city_id);
create index if not exists noon_area_fp_idx   on public.noon_area (listing_fingerprint);

-- ── updated_at triggers ─────────────────────────────────────────────────────
create or replace function public.noon_touch_updated_at()
returns trigger language plpgsql set search_path = public as $fn$
begin new.updated_at := now(); return new; end $fn$;

create trigger noon_city_touch before update on public.noon_city for each row execute function public.noon_touch_updated_at();
create trigger noon_hub_touch  before update on public.noon_hub  for each row execute function public.noon_touch_updated_at();
create trigger noon_zone_touch before update on public.noon_zone for each row execute function public.noon_touch_updated_at();
create trigger noon_area_touch before update on public.noon_area for each row execute function public.noon_touch_updated_at();

-- ── RLS: same as the other platforms (service_role only, no public policies) ─
alter table public.noon_city enable row level security;
alter table public.noon_hub  enable row level security;
alter table public.noon_zone enable row level security;
alter table public.noon_area enable row level security;

-- ── Active roll-up: area -> zone -> hub -> city ─────────────────────────────
create or replace function public.noon_refresh_active()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare r jsonb;
begin
  update public.noon_zone z
     set is_active = exists (select 1 from public.noon_area a
                              where a.noon_zone_code = z.noon_zone_code and a.is_active)
   where z.is_active is distinct from exists (select 1 from public.noon_area a
                              where a.noon_zone_code = z.noon_zone_code and a.is_active);

  update public.noon_hub h
     set is_active = exists (select 1 from public.noon_zone z
                              where z.noon_hub_id = h.noon_hub_id and z.is_active)
   where h.is_active is distinct from exists (select 1 from public.noon_zone z
                              where z.noon_hub_id = h.noon_hub_id and z.is_active);

  update public.noon_city c
     set is_active = exists (select 1 from public.noon_hub h
                              where h.noon_city_code = c.noon_city_code and h.is_active)
   where c.is_active is distinct from exists (select 1 from public.noon_hub h
                              where h.noon_city_code = c.noon_city_code and h.is_active);

  select jsonb_build_object(
    'cities_active', (select count(*) from public.noon_city where is_active),
    'cities_total',  (select count(*) from public.noon_city),
    'hubs_active',   (select count(*) from public.noon_hub  where is_active),
    'hubs_total',    (select count(*) from public.noon_hub),
    'zones_active',  (select count(*) from public.noon_zone where is_active),
    'zones_total',   (select count(*) from public.noon_zone),
    'areas_active',  (select count(*) from public.noon_area where is_active),
    'areas_total',   (select count(*) from public.noon_area),
    'areas_errored', (select count(*) from public.noon_area where probe_error is not null)
  ) into r;
  return r;
end $fn$;

revoke all on function public.noon_refresh_active() from public, anon, authenticated;
grant execute on function public.noon_refresh_active() to service_role;
revoke all on function public.noon_touch_updated_at() from public, anon, authenticated;
