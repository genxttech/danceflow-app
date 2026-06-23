begin;

create table if not exists public.studio_wave_payment_method_mappings (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_wave_connections(id) on delete cascade,
  payment_method_key text not null check (payment_method_key in ('stripe', 'cash', 'check', 'bank', 'card', 'other')),
  wave_account_id text not null,
  wave_account_name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (studio_id, payment_method_key)
);

insert into public.studio_wave_payment_method_mappings (
  studio_id, connection_id, payment_method_key, wave_account_id, wave_account_name, created_by
)
select studio_id, id, 'stripe', default_anchor_account_id, default_anchor_account_name, connected_by
from public.studio_wave_connections
where default_anchor_account_id is not null
on conflict (studio_id, payment_method_key) do nothing;

create table if not exists public.studio_wave_sync_runs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_wave_connections(id),
  status text not null default 'review' check (status in ('review', 'approved', 'cancelled', 'posted', 'failed')),
  period_start date not null,
  period_end date not null,
  currency text not null,
  source_entry_count integer not null default 0,
  posting_line_count integer not null default 0,
  total_debits numeric(14,2) not null default 0,
  total_credits numeric(14,2) not null default 0,
  configuration_snapshot jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start),
  check (total_debits = total_credits)
);

create table if not exists public.studio_wave_sync_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.studio_wave_sync_runs(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  entry_date date not null,
  payment_method_key text not null,
  category text not null,
  direction text not null check (direction in ('debit', 'credit')),
  amount numeric(14,2) not null check (amount > 0),
  currency text not null,
  wave_category_account_id text not null,
  wave_category_account_name text not null,
  wave_anchor_account_id text not null,
  wave_anchor_account_name text not null,
  source_keys jsonb not null default '[]'::jsonb,
  source_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.studio_wave_sync_reservations (
  studio_id uuid not null references public.studios(id) on delete cascade,
  idempotency_key text not null,
  run_id uuid not null references public.studio_wave_sync_runs(id) on delete cascade,
  reserved_at timestamptz not null default now(),
  primary key (studio_id, idempotency_key)
);

create index if not exists studio_wave_sync_runs_studio_created_idx
  on public.studio_wave_sync_runs(studio_id, created_at desc);
create index if not exists studio_wave_sync_lines_run_idx on public.studio_wave_sync_lines(run_id);
create index if not exists studio_wave_sync_reservations_run_idx on public.studio_wave_sync_reservations(run_id);

alter table public.studio_wave_payment_method_mappings enable row level security;
alter table public.studio_wave_sync_runs enable row level security;
alter table public.studio_wave_sync_lines enable row level security;
alter table public.studio_wave_sync_reservations enable row level security;

drop policy if exists studio_wave_payment_methods_manage on public.studio_wave_payment_method_mappings;
create policy studio_wave_payment_methods_manage on public.studio_wave_payment_method_mappings for all to authenticated
using (public.can_manage_studio_wave(studio_id)) with check (public.can_manage_studio_wave(studio_id));

drop policy if exists studio_wave_sync_runs_select on public.studio_wave_sync_runs;
drop policy if exists studio_wave_sync_runs_insert on public.studio_wave_sync_runs;
drop policy if exists studio_wave_sync_runs_delete_review on public.studio_wave_sync_runs;
create policy studio_wave_sync_runs_select on public.studio_wave_sync_runs for select to authenticated
using (public.can_manage_studio_wave(studio_id));
create policy studio_wave_sync_runs_insert on public.studio_wave_sync_runs for insert to authenticated
with check (public.can_manage_studio_wave(studio_id) and status = 'review' and approved_at is null);
create policy studio_wave_sync_runs_delete_review on public.studio_wave_sync_runs for delete to authenticated
using (public.can_manage_studio_wave(studio_id) and status = 'review' and approved_at is null);

drop policy if exists studio_wave_sync_lines_select on public.studio_wave_sync_lines;
drop policy if exists studio_wave_sync_lines_insert_review on public.studio_wave_sync_lines;
drop policy if exists studio_wave_sync_lines_delete_review on public.studio_wave_sync_lines;
create policy studio_wave_sync_lines_select on public.studio_wave_sync_lines for select to authenticated
using (public.can_manage_studio_wave(studio_id));
create policy studio_wave_sync_lines_insert_review on public.studio_wave_sync_lines for insert to authenticated
with check (
  public.can_manage_studio_wave(studio_id)
  and exists (select 1 from public.studio_wave_sync_runs run where run.id = studio_wave_sync_lines.run_id and run.status = 'review' and run.approved_at is null)
);
create policy studio_wave_sync_lines_delete_review on public.studio_wave_sync_lines for delete to authenticated
using (
  public.can_manage_studio_wave(studio_id)
  and exists (select 1 from public.studio_wave_sync_runs run where run.id = studio_wave_sync_lines.run_id and run.status = 'review' and run.approved_at is null)
);

drop policy if exists studio_wave_sync_reservations_select on public.studio_wave_sync_reservations;
create policy studio_wave_sync_reservations_select on public.studio_wave_sync_reservations for select to authenticated
using (public.can_manage_studio_wave(studio_id));

create or replace function public.protect_wave_approved_run()
returns trigger language plpgsql security definer set search_path = public as $$
declare was_approved boolean;
begin
  select approved_at is not null into was_approved from public.studio_wave_sync_runs
  where id = case when tg_op = 'DELETE' then old.run_id else new.run_id end;
  if coalesce(was_approved, false) then
    raise exception 'Approved Wave sync snapshots are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists protect_wave_approved_lines on public.studio_wave_sync_lines;
create trigger protect_wave_approved_lines before update or delete on public.studio_wave_sync_lines
for each row execute function public.protect_wave_approved_run();

create or replace function public.protect_wave_approved_run_record()
returns trigger language plpgsql as $$
begin
  if old.approved_at is not null and (
    new.studio_id <> old.studio_id or new.connection_id <> old.connection_id or
    new.period_start <> old.period_start or new.period_end <> old.period_end or
    new.currency <> old.currency or new.source_entry_count <> old.source_entry_count or
    new.posting_line_count <> old.posting_line_count or new.total_debits <> old.total_debits or
    new.total_credits <> old.total_credits or new.configuration_snapshot <> old.configuration_snapshot
    or new.approved_at is distinct from old.approved_at
    or new.approved_by is distinct from old.approved_by
  ) then raise exception 'Approved Wave sync snapshots are immutable'; end if;
  return new;
end;
$$;

drop trigger if exists protect_wave_approved_run_record on public.studio_wave_sync_runs;
create trigger protect_wave_approved_run_record before update on public.studio_wave_sync_runs
for each row execute function public.protect_wave_approved_run_record();

create or replace function public.approve_studio_wave_sync_run(target_run_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare target_run public.studio_wave_sync_runs%rowtype;
begin
  select * into target_run from public.studio_wave_sync_runs where id = target_run_id for update;
  if target_run.id is null or not public.can_manage_studio_wave(target_run.studio_id) then
    raise exception 'Wave sync run is unavailable';
  end if;
  if target_run.status <> 'review' then raise exception 'Only review runs can be approved'; end if;

  insert into public.studio_wave_sync_reservations (studio_id, idempotency_key, run_id)
  select target_run.studio_id, source_key, target_run.id
  from public.studio_wave_sync_lines line
  cross join lateral jsonb_array_elements_text(line.source_keys) as keys(source_key)
  where line.run_id = target_run.id;

  update public.studio_wave_sync_runs
  set status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now()
  where id = target_run.id;
end;
$$;

create or replace function public.cancel_studio_wave_sync_run(target_run_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare target_run public.studio_wave_sync_runs%rowtype;
begin
  select * into target_run from public.studio_wave_sync_runs where id = target_run_id for update;
  if target_run.id is null or not public.can_manage_studio_wave(target_run.studio_id) then
    raise exception 'Wave sync run is unavailable';
  end if;
  if target_run.status not in ('review', 'approved') then raise exception 'This run cannot be cancelled'; end if;
  delete from public.studio_wave_sync_reservations where run_id = target_run.id;
  update public.studio_wave_sync_runs set status = 'cancelled', updated_at = now() where id = target_run.id;
end;
$$;

revoke all on function public.approve_studio_wave_sync_run(uuid) from public;
revoke all on function public.cancel_studio_wave_sync_run(uuid) from public;
grant execute on function public.approve_studio_wave_sync_run(uuid) to authenticated;
grant execute on function public.cancel_studio_wave_sync_run(uuid) to authenticated;

commit;
