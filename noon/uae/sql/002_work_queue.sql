-- noon/uae/sql/002_work_queue.sql
--
-- Work queue for orchestrated zone scan and area probing.
-- Each item = one (lat,lng) point to locate (zones mode) or one area to probe
-- (areas mode). Workers claim batches atomically with FOR UPDATE SKIP LOCKED,
-- so multiple GitHub Actions runners (each with its own IP) can work in parallel
-- without collisions.
--
-- Lifecycle:
--   1. queue-seed.js inserts items with status='pending'.
--   2. queue-worker.js calls noon_claim_work() to grab a batch, processes each,
--      calls noon_complete_work() per item (sets status='done'/'error').
--   3. On IP block the worker calls noon_release_work() to return all its
--      claimed-but-unprocessed items to 'pending' so another machine picks them up.
--   4. queue-finalize.js reads 'done' items and upserts noon_city/hub/zone/area.
--
-- Re-running the workflow against the same batch_id picks up where it left off:
-- only 'pending' items are claimable.

-- ── noon_work_queue ─────────────────────────────────────────────────────────
create table if not exists public.noon_work_queue (
  id              bigint generated always as identity primary key,
  batch_id        text not null,
  mode            text not null check (mode in ('zone','area')),

  latitude        double precision not null,
  longitude       double precision not null,

  source_key      text,
  area_source     text,
  talabat_area_id bigint,
  area_name       text,
  area_name_ar    text,
  area_slug       text,

  status          text not null default 'pending' check (status in ('pending','claimed','done','error')),
  worker_id       text,
  claimed_at      timestamptz,
  completed_at    timestamptz,

  result          jsonb,
  error           text,

  created_at      timestamptz not null default now()
);

comment on table public.noon_work_queue is
  'Orchestration queue for Noon zone/area scraping. Items are claimed atomically by workers and released on IP block. batch_id groups items per workflow run.';

create index if not exists noon_wq_batch_status_idx on public.noon_work_queue (batch_id, status);
create index if not exists noon_wq_worker_idx      on public.noon_work_queue (worker_id, status);
create index if not exists noon_wq_batch_mode_idx  on public.noon_work_queue (batch_id, mode);

-- RLS: service_role only, same as all other Noon tables.
alter table public.noon_work_queue enable row level security;

-- ── noon_claim_work(batch_id, worker_id, batch_size) ────────────────────
create or replace function public.noon_claim_work(
  p_batch_id   text,
  p_worker_id  text,
  p_batch_size integer default 50
)
returns setof public.noon_work_queue
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return query
    with claimed as (
      select id
      from public.noon_work_queue
      where batch_id = p_batch_id
        and status = 'pending'
      order by id
      limit p_batch_size
      for update skip locked
    )
    update public.noon_work_queue q
       set status     = 'claimed',
           worker_id  = p_worker_id,
           claimed_at = now()
    from claimed c
    where q.id = c.id
    returning q.*;
end $fn$;

revoke all on function public.noon_claim_work(text, text, integer) from public, anon, authenticated;
grant execute on function public.noon_claim_work(text, text, integer) to service_role;

-- ── noon_complete_work(item_id, status, result, error) ────────────────
create or replace function public.noon_complete_work(
  p_id      bigint,
  p_status  text,
  p_result  jsonb    default null,
  p_error   text     default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.noon_work_queue
     set status       = p_status,
         result       = p_result,
         error        = p_error,
         completed_at = now()
   where id = p_id;
end $fn$;

revoke all on function public.noon_complete_work(bigint, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.noon_complete_work(bigint, text, jsonb, text) to service_role;

-- ── noon_release_work(worker_id, batch_id) ──────────────────────────
create or replace function public.noon_release_work(
  p_worker_id text,
  p_batch_id  text
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare released integer;
begin
  update public.noon_work_queue
     set status     = 'pending',
         worker_id  = null,
         claimed_at = null
   where worker_id = p_worker_id
     and batch_id  = p_batch_id
     and status    = 'claimed';
  get diagnostics released = row_count;
  return released;
end $fn$;

revoke all on function public.noon_release_work(text, text) from public, anon, authenticated;
grant execute on function public.noon_release_work(text, text) to service_role;

-- ── noon_queue_status(batch_id) ─────────────────────────────────────
create or replace function public.noon_queue_status(p_batch_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare r jsonb;
begin
  select jsonb_build_object(
    'batch_id', p_batch_id,
    'total',    count(*),
    'pending',  count(*) filter (where status = 'pending'),
    'claimed',  count(*) filter (where status = 'claimed'),
    'done',     count(*) filter (where status = 'done'),
    'error',    count(*) filter (where status = 'error')
  ) into r
  from public.noon_work_queue
  where batch_id = p_batch_id;
  return r;
end $fn$;

revoke all on function public.noon_queue_status(text) from public, anon, authenticated;
grant execute on function public.noon_queue_status(text) to service_role;
