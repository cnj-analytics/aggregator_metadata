-- noon/uae/sql/003_orchestration.sql
-- Supabase-orchestrated worker dispatch, modeled on deliveroo_ranking_*.
-- Workers are individual GitHub Actions workflow_dispatch runs. On IP block,
-- the worker reports to Supabase, which retires the machine, requeues work,
-- and dispatches a replacement. A run cannot finish until all items are done.

-- ── Settings ────────────────────────────────────────────────────────────────

create table if not exists public.noon_settings (
  id              integer primary key default 1 check (id = 1),
  github_repo     text    not null default 'cnj-analytics/aggregator_metadata',
  worker_workflow text    not null default 'noon-uae-worker.yml',
  machines        integer not null default 3,       -- concurrent workers
  max_replacements integer not null default 50,     -- safety cap per run
  delay_ms        integer not null default 200,     -- passed to worker
  claim_size      integer not null default 50,      -- batch size for claiming
  updated_at      timestamptz not null default now()
);

insert into public.noon_settings (id) values (1) on conflict do nothing;

-- ── Run tracking ────────────────────────────────────────────────────────────

create table if not exists public.noon_run (
  run_id          bigint generated always as identity primary key,
  batch_id        text    not null,                  -- links to noon_work_queue.batch_id
  status          text    not null default 'running', -- running | finished | stopped | failed
  trigger         text    not null default 'manual',  -- manual | test
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  stop_reason     text,
  target_machines integer not null default 3,
  machines_used   integer not null default 0,
  replacements    integer not null default 0,
  items_total     integer not null default 0,
  items_done      integer not null default 0,
  items_error     integer not null default 0,
  blocks          integer not null default 0          -- IP blocks encountered
);

create table if not exists public.noon_run_machine (
  run_id          bigint  not null references public.noon_run(run_id),
  machine_no      integer not null,
  status          text    not null default 'dispatched', -- dispatched | working | retired_blocked | finished | failed
  reason          text,                               -- initial | replacement: 403
  replaces        integer,                            -- machine_no it replaces
  dispatch_request_id bigint,                         -- pg_net request id
  dispatched_at   timestamptz not null default now(),
  started_at      timestamptz,                        -- when worker checks in
  last_seen_at    timestamptz,
  ended_at        timestamptz,
  end_reason      text,
  items_done      integer not null default 0,
  items_error     integer not null default 0,
  ip_address      text,
  primary key (run_id, machine_no)
);

-- ── Log (optional, useful for debugging) ────────────────────────────────────

create table if not exists public.noon_run_log (
  id         bigint generated always as identity primary key,
  run_id     bigint,
  event      text not null,
  machine_no integer,
  detail     text,
  created_at timestamptz not null default now()
);

create index if not exists noon_run_log_run_id_idx on public.noon_run_log(run_id);

-- ── Helper: log ─────────────────────────────────────────────────────────────

create or replace function public.noon_log(
  p_run_id bigint, p_event text, p_machine_no integer default null, p_detail text default null
) returns void language plpgsql as $$
begin
  insert into public.noon_run_log (run_id, event, machine_no, detail)
  values (p_run_id, p_event, p_machine_no, p_detail);
end $$;

-- ── Dispatch one worker via GitHub API ──────────────────────────────────────

create or replace function public.noon_dispatch_worker(
  p_run_id bigint,
  p_reason text default 'initial',
  p_replaces integer default null
) returns integer language plpgsql security definer as $$
declare
  s public.noon_settings;
  r public.noon_run;
  v_no   integer;
  v_token text;
  v_req  bigint;
begin
  select * into s from public.noon_settings where id = 1;
  select * into r from public.noon_run where run_id = p_run_id;

  -- Safety cap: 999 machines total
  if r.machines_used >= 999 then
    perform public.noon_log(p_run_id, 'safety_cap', null,
      '999 machines dispatched this run – hard cap reached');
    return null;
  end if;

  -- Max replacements check
  if p_replaces is not null and r.replacements >= s.max_replacements then
    perform public.noon_log(p_run_id, 'replacement_cap', null,
      format('max_replacements=%s reached', s.max_replacements));
    return null;
  end if;

  -- Next machine number
  select coalesce(max(machine_no), 0) + 1 into v_no
    from public.noon_run_machine where run_id = p_run_id;

  insert into public.noon_run_machine (run_id, machine_no, reason, replaces)
  values (p_run_id, v_no, p_reason, p_replaces);

  update public.noon_run
     set machines_used = machines_used + 1,
         replacements  = replacements + case when p_replaces is not null then 1 else 0 end
   where run_id = p_run_id;

  -- Read GitHub PAT from Vault
  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'github_pat' limit 1;

  if v_token is null then
    perform public.noon_log(p_run_id, 'dispatch_failed', v_no, 'no github_pat in Vault');
    return v_no;
  end if;

  -- Dispatch via GitHub API
  select net.http_post(
    url     := format('https://api.github.com/repos/%s/actions/workflows/%s/dispatches',
                      s.github_repo, s.worker_workflow),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'supabase-noon-control'
    ),
    body    := jsonb_build_object(
      'ref', 'main',
      'inputs', jsonb_build_object(
        'run_id',     p_run_id::text,
        'machine_no', v_no::text
      )
    )
  ) into v_req;

  update public.noon_run_machine
     set dispatch_request_id = v_req
   where run_id = p_run_id and machine_no = v_no;

  perform public.noon_log(p_run_id, 'machine_dispatched', v_no,
    p_reason || coalesce(' (replaces machine ' || p_replaces || ')', '')
    || format(' [%s machines used this run]', r.machines_used + 1));

  return v_no;
end $$;

-- ── Maybe finish: check if the run is complete ──────────────────────────────

create or replace function public.noon_maybe_finish(p_run_id bigint)
returns boolean language plpgsql as $$
declare
  v_active  integer;
  v_pending integer;
begin
  -- Any machines still alive?
  select count(*) into v_active
    from public.noon_run_machine
   where run_id = p_run_id and status in ('dispatched', 'working');

  if v_active > 0 then return false; end if;

  -- Any work left in the queue?
  select count(*) into v_pending
    from public.noon_work_queue q
    join public.noon_run r on r.batch_id = q.batch_id
   where r.run_id = p_run_id and q.status in ('pending', 'claimed');

  if v_pending > 0 then
    -- Work left but no machines: dispatch a new one
    perform public.noon_log(p_run_id, 'orphaned_work', null,
      format('%s items still pending/claimed but no active machines — dispatching rescue', v_pending));
    perform public.noon_dispatch_worker(p_run_id, 'rescue: orphaned work');
    return false;
  end if;

  -- All done
  update public.noon_run
     set status = 'finished', finished_at = now()
   where run_id = p_run_id and status = 'running';

  perform public.noon_log(p_run_id, 'run_finished', null, 'all items processed');
  return true;
end $$;

-- ── Worker check-in: called when the worker starts ──────────────────────────

create or replace function public.noon_worker_checkin(
  p_run_id bigint,
  p_machine_no integer,
  p_ip text default null
) returns jsonb language plpgsql as $$
declare
  r public.noon_run;
  m public.noon_run_machine;
begin
  select * into r from public.noon_run where run_id = p_run_id;
  if r.run_id is null then
    return jsonb_build_object('action', 'stop_job', 'reason', 'unknown run');
  end if;
  if r.status <> 'running' then
    return jsonb_build_object('action', 'stop_job', 'reason', 'run is ' || r.status);
  end if;

  select * into m from public.noon_run_machine
   where run_id = p_run_id and machine_no = p_machine_no;
  if m.run_id is null then
    return jsonb_build_object('action', 'stop_job', 'reason', 'unknown machine');
  end if;

  update public.noon_run_machine
     set status = 'working', started_at = now(), last_seen_at = now(),
         ip_address = coalesce(p_ip, ip_address)
   where run_id = p_run_id and machine_no = p_machine_no;

  perform public.noon_log(p_run_id, 'worker_started', p_machine_no,
    coalesce('IP: ' || p_ip, 'no IP reported'));

  return jsonb_build_object(
    'action', 'continue',
    'batch_id', r.batch_id,
    'delay_ms', (select delay_ms from public.noon_settings where id = 1),
    'claim_size', (select claim_size from public.noon_settings where id = 1)
  );
end $$;

-- ── Worker heartbeat: called periodically during work ───────────────────────

create or replace function public.noon_worker_heartbeat(
  p_run_id bigint,
  p_machine_no integer,
  p_items_done integer default 0,
  p_items_error integer default 0
) returns jsonb language plpgsql as $$
declare
  r public.noon_run;
begin
  select * into r from public.noon_run where run_id = p_run_id;
  if r.run_id is null or r.status <> 'running' then
    return jsonb_build_object('action', 'stop_job', 'reason', 'run is not running');
  end if;

  update public.noon_run_machine
     set last_seen_at = now(),
         items_done  = p_items_done,
         items_error = p_items_error
   where run_id = p_run_id and machine_no = p_machine_no;

  return jsonb_build_object('action', 'continue');
end $$;

-- ── Worker report block: IP is blocked, retire + replace ────────────────────

create or replace function public.noon_worker_report_block(
  p_run_id bigint,
  p_machine_no integer,
  p_items_done integer default 0,
  p_items_error integer default 0
) returns jsonb language plpgsql as $$
declare
  r   public.noon_run;
  m   public.noon_run_machine;
  v_pending integer;
  v_repl    integer;
begin
  select * into r from public.noon_run where run_id = p_run_id for update;
  select * into m from public.noon_run_machine
   where run_id = p_run_id and machine_no = p_machine_no for update;

  if r.run_id is null or m.run_id is null then
    return jsonb_build_object('action', 'stop_job', 'reason', 'unknown run or machine');
  end if;

  -- Retire this machine
  update public.noon_run_machine
     set status = 'retired_blocked', ended_at = now(),
         items_done  = p_items_done,
         items_error = p_items_error,
         end_reason  = format('IP blocked after %s items done', p_items_done)
   where run_id = p_run_id and machine_no = p_machine_no;

  update public.noon_run
     set blocks     = blocks + 1,
         items_done = (select coalesce(sum(rm.items_done), 0)
                         from public.noon_run_machine rm where rm.run_id = p_run_id),
         items_error = (select coalesce(sum(rm.items_error), 0)
                          from public.noon_run_machine rm where rm.run_id = p_run_id)
   where run_id = p_run_id;

  perform public.noon_log(p_run_id, 'ip_blocked', p_machine_no,
    format('machine %s IP blocked after %s items', p_machine_no, p_items_done));

  -- Check if there is still work to do
  select count(*) into v_pending
    from public.noon_work_queue
   where batch_id = r.batch_id and status in ('pending', 'claimed');

  if v_pending > 0 then
    -- Dispatch a replacement
    v_repl := public.noon_dispatch_worker(p_run_id, 'replacement: IP blocked', p_machine_no);
    if v_repl is not null then
      perform public.noon_log(p_run_id, 'machine_replaced', p_machine_no,
        format('machine %s replaced by machine %s (%s items remaining)', p_machine_no, v_repl, v_pending));
    else
      -- Could not dispatch (cap reached) — check if run can finish
      perform public.noon_maybe_finish(p_run_id);
    end if;
  else
    -- No work left, maybe we're done
    perform public.noon_maybe_finish(p_run_id);
  end if;

  return jsonb_build_object(
    'action', 'stop_job',
    'replaced', v_repl is not null,
    'replacement_machine', v_repl,
    'reason', 'IP blocked'
  );
end $$;

-- ── Worker finished: called when worker drains the queue cleanly ────────────

create or replace function public.noon_worker_finished(
  p_run_id bigint,
  p_machine_no integer,
  p_items_done integer default 0,
  p_items_error integer default 0
) returns jsonb language plpgsql as $$
begin
  update public.noon_run_machine
     set status = 'finished', ended_at = now(),
         items_done  = p_items_done,
         items_error = p_items_error,
         end_reason  = 'queue drained'
   where run_id = p_run_id and machine_no = p_machine_no;

  update public.noon_run
     set items_done = (select coalesce(sum(rm.items_done), 0)
                         from public.noon_run_machine rm where rm.run_id = p_run_id),
         items_error = (select coalesce(sum(rm.items_error), 0)
                          from public.noon_run_machine rm where rm.run_id = p_run_id)
   where run_id = p_run_id;

  perform public.noon_log(p_run_id, 'worker_finished', p_machine_no,
    format('machine %s finished cleanly with %s items', p_machine_no, p_items_done));

  perform public.noon_maybe_finish(p_run_id);

  return jsonb_build_object('action', 'done');
end $$;

-- ── Run begin: seeds the queue and dispatches N workers ─────────────────────

create or replace function public.noon_run_begin(
  p_trigger text default 'manual',
  p_modes text[] default array['zone','area']
) returns jsonb language plpgsql security definer as $$
declare
  s       public.noon_settings;
  v_other public.noon_run;
  v_run_id bigint;
  v_batch  text;
  v_total  integer;
  i        integer;
begin
  select * into s from public.noon_settings where id = 1;

  -- Check for already-running run
  select * into v_other from public.noon_run where status = 'running' order by run_id desc limit 1;
  if found then
    return jsonb_build_object('error', true, 'reason',
      format('run %s is still running (started %s)', v_other.run_id, v_other.started_at));
  end if;

  -- Generate a batch ID
  v_batch := 'run-' || to_char(now() at time zone 'Asia/Dubai', 'YYYYMMDD-HH24MISS');

  -- Seed the work queue (call queue-seed.js logic via the existing seeded data approach)
  -- The queue is seeded BEFORE this function by queue-seed.js in the workflow.
  -- This function just creates the run record and dispatches workers.
  -- The batch_id is passed in from the control workflow after seeding.

  -- Actually, let's have the control workflow seed first, then call this with the batch_id.
  -- Re-design: accept batch_id as parameter.

  -- Count items in the queue for this batch
  select count(*) into v_total from public.noon_work_queue where batch_id = v_batch;

  -- Create the run
  insert into public.noon_run (batch_id, trigger, target_machines, items_total)
  values (v_batch, p_trigger, s.machines, v_total)
  returning run_id into v_run_id;

  perform public.noon_log(v_run_id, 'run_started', null,
    format('%s run: %s items, %s machines', p_trigger, v_total, s.machines));

  -- Dispatch N workers
  for i in 1..s.machines loop
    perform public.noon_dispatch_worker(v_run_id, 'initial');
  end loop;

  return jsonb_build_object(
    'run_id', v_run_id,
    'batch_id', v_batch,
    'items', v_total,
    'machines', s.machines
  );
end $$;

-- ── Simpler run_begin that takes a pre-seeded batch_id ──────────────────────

create or replace function public.noon_run_begin_with_batch(
  p_batch_id text,
  p_trigger text default 'manual'
) returns jsonb language plpgsql security definer as $$
declare
  s        public.noon_settings;
  v_other  public.noon_run;
  v_run_id bigint;
  v_total  integer;
  i        integer;
begin
  select * into s from public.noon_settings where id = 1;

  -- Check for already-running run
  select * into v_other from public.noon_run where status = 'running' order by run_id desc limit 1;
  if found then
    return jsonb_build_object('error', true, 'reason',
      format('run %s is still running (started %s)', v_other.run_id, v_other.started_at));
  end if;

  -- Count items
  select count(*) into v_total from public.noon_work_queue where batch_id = p_batch_id;
  if v_total = 0 then
    return jsonb_build_object('error', true, 'reason', 'no items in queue for batch ' || p_batch_id);
  end if;

  -- Create the run
  insert into public.noon_run (batch_id, trigger, target_machines, items_total)
  values (p_batch_id, p_trigger, s.machines, v_total)
  returning run_id into v_run_id;

  perform public.noon_log(v_run_id, 'run_started', null,
    format('%s run: batch=%s, %s items, dispatching %s machines',
           p_trigger, p_batch_id, v_total, s.machines));

  -- Dispatch N workers
  for i in 1..s.machines loop
    perform public.noon_dispatch_worker(v_run_id, 'initial');
  end loop;

  return jsonb_build_object(
    'run_id', v_run_id,
    'batch_id', p_batch_id,
    'items', v_total,
    'machines', s.machines
  );
end $$;

-- ── Stop a running run ──────────────────────────────────────────────────────

create or replace function public.noon_stop(p_reason text default 'manual stop')
returns jsonb language plpgsql as $$
declare
  r public.noon_run;
begin
  select * into r from public.noon_run where status = 'running' order by run_id desc limit 1;
  if not found then
    return jsonb_build_object('error', true, 'reason', 'no running run');
  end if;

  update public.noon_run
     set status = 'stopped', stop_reason = p_reason, finished_at = now()
   where run_id = r.run_id;

  -- Mark all active machines as stopped
  update public.noon_run_machine
     set status = 'failed', ended_at = now(), end_reason = p_reason
   where run_id = r.run_id and status in ('dispatched', 'working');

  perform public.noon_log(r.run_id, 'run_stopped', null, p_reason);

  return jsonb_build_object('stopped', true, 'run_id', r.run_id);
end $$;

-- ── Run overview view for status reporting ──────────────────────────────────

create or replace view public.noon_run_overview as
select
  r.run_id,
  r.batch_id,
  r.trigger,
  r.status,
  to_char(r.started_at at time zone 'Asia/Dubai', 'YYYY-MM-DD HH24:MI') as started_dubai,
  round(extract(epoch from coalesce(r.finished_at, now()) - r.started_at) / 60, 1) as minutes,
  r.items_total,
  r.items_done,
  r.items_error,
  r.items_total - r.items_done - r.items_error as items_remaining,
  r.machines_used,
  r.replacements,
  r.blocks
from public.noon_run r;

-- Grant access for the service role
grant all on public.noon_settings to service_role;
grant all on public.noon_run to service_role;
grant all on public.noon_run_machine to service_role;
grant all on public.noon_run_log to service_role;
grant select on public.noon_run_overview to service_role;
grant usage, select on all sequences in schema public to service_role;
