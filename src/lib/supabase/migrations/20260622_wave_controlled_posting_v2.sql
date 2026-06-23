begin;

alter table public.studio_wave_payment_method_mappings
  add column if not exists anchor_normal_balance_type text;

update public.studio_wave_payment_method_mappings mapping
set anchor_normal_balance_type = account.normal_balance_type
from public.studio_wave_accounts account
where account.connection_id = mapping.connection_id
  and account.wave_account_id = mapping.wave_account_id
  and mapping.anchor_normal_balance_type is null;

alter table public.studio_wave_sync_lines
  add column if not exists anchor_normal_balance_type text,
  add column if not exists wave_external_id text,
  add column if not exists posting_status text not null default 'pending',
  add column if not exists posting_attempts integer not null default 0,
  add column if not exists wave_transaction_id text,
  add column if not exists posting_error text,
  add column if not exists posting_started_at timestamptz,
  add column if not exists posted_at timestamptz;

alter table public.studio_wave_sync_lines disable trigger protect_wave_approved_lines;

update public.studio_wave_sync_lines line
set anchor_normal_balance_type = account.normal_balance_type
from public.studio_wave_accounts account
where account.wave_account_id = line.wave_anchor_account_id
  and account.connection_id = (
    select run.connection_id from public.studio_wave_sync_runs run where run.id = line.run_id
  )
  and line.anchor_normal_balance_type is null;

update public.studio_wave_sync_lines
set wave_external_id = 'danceflow-wave-' || id::text
where wave_external_id is null;

alter table public.studio_wave_sync_lines
  alter column wave_external_id set not null;

create unique index if not exists studio_wave_sync_lines_external_id_uidx
  on public.studio_wave_sync_lines(wave_external_id);

alter table public.studio_wave_sync_lines drop constraint if exists studio_wave_sync_lines_posting_status_check;
alter table public.studio_wave_sync_lines add constraint studio_wave_sync_lines_posting_status_check
  check (posting_status in ('pending', 'posting', 'posted', 'failed', 'uncertain'));

alter table public.studio_wave_sync_runs
  add column if not exists posting_started_at timestamptz,
  add column if not exists posting_completed_at timestamptz,
  add column if not exists posted_by uuid references auth.users(id) on delete set null,
  add column if not exists posting_error text;

alter table public.studio_wave_sync_runs drop constraint if exists studio_wave_sync_runs_status_check;
alter table public.studio_wave_sync_runs add constraint studio_wave_sync_runs_status_check
  check (status in ('review', 'approved', 'posting', 'posted', 'failed', 'attention_required', 'cancelled'));

create or replace function public.protect_wave_approved_run()
returns trigger language plpgsql security definer set search_path = public as $$
declare was_approved boolean;
begin
  select approved_at is not null into was_approved from public.studio_wave_sync_runs
  where id = case when tg_op = 'DELETE' then old.run_id else new.run_id end;
  if not coalesce(was_approved, false) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then raise exception 'Approved Wave sync snapshots are immutable'; end if;
  if new.run_id <> old.run_id or new.studio_id <> old.studio_id or new.entry_date <> old.entry_date or
     new.payment_method_key <> old.payment_method_key or new.category <> old.category or
     new.direction <> old.direction or new.amount <> old.amount or new.currency <> old.currency or
     new.wave_category_account_id <> old.wave_category_account_id or
     new.wave_category_account_name <> old.wave_category_account_name or
     new.wave_anchor_account_id <> old.wave_anchor_account_id or
     new.wave_anchor_account_name <> old.wave_anchor_account_name or
     new.source_keys <> old.source_keys or new.source_count <> old.source_count or
     new.wave_external_id <> old.wave_external_id or
     new.anchor_normal_balance_type is distinct from old.anchor_normal_balance_type
  then raise exception 'Approved Wave sync snapshots are immutable'; end if;
  return new;
end;
$$;

alter table public.studio_wave_sync_lines enable trigger protect_wave_approved_lines;

create or replace function public.claim_next_wave_sync_line(target_run_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare target_run public.studio_wave_sync_runs%rowtype;
declare target_line_id uuid;
begin
  select * into target_run from public.studio_wave_sync_runs where id = target_run_id for update;
  if target_run.id is null or not public.can_manage_studio_wave(target_run.studio_id) then
    raise exception 'Wave sync run is unavailable';
  end if;
  if target_run.status not in ('approved', 'posting') then
    raise exception 'Only approved Wave runs can be posted';
  end if;
  if exists (
    select 1 from public.studio_wave_sync_lines
    where run_id = target_run.id and posting_status in ('posting', 'uncertain', 'failed')
  ) then raise exception 'Resolve the current posting result before continuing'; end if;

  select id into target_line_id
  from public.studio_wave_sync_lines
  where run_id = target_run.id and posting_status = 'pending'
  order by entry_date, id
  limit 1 for update skip locked;

  if target_line_id is null then
    if not exists (select 1 from public.studio_wave_sync_lines where run_id = target_run.id and posting_status <> 'posted') then
      update public.studio_wave_sync_runs
      set status = 'posted', posting_completed_at = now(), updated_at = now()
      where id = target_run.id;
    end if;
    return null;
  end if;

  update public.studio_wave_sync_lines
  set posting_status = 'posting', posting_attempts = posting_attempts + 1,
      posting_started_at = now(), posting_error = null
  where id = target_line_id;
  update public.studio_wave_sync_runs
  set status = 'posting', posting_started_at = coalesce(posting_started_at, now()),
      posted_by = coalesce(posted_by, auth.uid()), posting_error = null, updated_at = now()
  where id = target_run.id;
  return target_line_id;
end;
$$;

revoke all on function public.claim_next_wave_sync_line(uuid) from public;
grant execute on function public.claim_next_wave_sync_line(uuid) to authenticated;

create or replace function public.cancel_studio_wave_sync_run(target_run_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare target_run public.studio_wave_sync_runs%rowtype;
begin
  select * into target_run from public.studio_wave_sync_runs where id = target_run_id for update;
  if target_run.id is null or not public.can_manage_studio_wave(target_run.studio_id) then
    raise exception 'Wave sync run is unavailable';
  end if;
  if target_run.status not in ('review', 'approved', 'failed') then
    raise exception 'This run cannot be cancelled';
  end if;
  if exists (
    select 1 from public.studio_wave_sync_lines
    where run_id = target_run.id and posting_status in ('posted', 'posting', 'uncertain')
  ) then raise exception 'A run with posted or uncertain transactions cannot be cancelled'; end if;
  delete from public.studio_wave_sync_reservations where run_id = target_run.id;
  update public.studio_wave_sync_runs set status = 'cancelled', updated_at = now() where id = target_run.id;
end;
$$;

commit;
