-- Phase 9B: immutable payroll approval snapshot, payment evidence and export
-- (finalization) evidence.
--
-- The 9A lifecycle stays authoritative (earning pending -> approved -> paid;
-- batch draft/in_review -> approved -> paid; period open/in_review ->
-- approved -> paid). No new payroll status is introduced. Instead:
--   1. approve_payroll_batch freezes, in the same transaction as the
--      approval, one approval snapshot per batch (header: batch, period
--      context, totals, worker/earning counts, approver identity evidence,
--      fingerprint) plus one line per approved earning with every value the
--      payroll CSV / PDF packet consume. If any part of the snapshot fails,
--      the batch is not approved. A batch can only become approved together
--      with its snapshot (batch trigger).
--   2. mark_payroll_batch_paid verifies the snapshot against the batch
--      (totals, line set, fingerprint) and records one immutable payment
--      evidence row (disburser identity evidence, method, reference, totals).
--      A batch can only become paid together with its payment evidence.
--      Batches approved before this migration (no snapshot) remain payable
--      through an explicit legacy path whose evidence says so; a batch
--      approved after activation without a snapshot is refused.
--   3. record_payroll_export appends one immutable export event per
--      successful approved-batch CSV / PDF export (repeat exports append;
--      nothing is overwritten). "Exported" is evidence, not a status.
--   4. Actor evidence (id, display name, email, acting role) is copied at the
--      time of the action with no foreign key to profiles, so later profile
--      changes or deletion cannot alter or null it.
--   5. Evidence tables are append-only for everyone (UPDATE / DELETE /
--      TRUNCATE refused), written only by the payroll RPCs (no write
--      policies, no write grants), readable by studio owner/admin like the
--      other payroll tables, and tied to one studio by composite foreign
--      keys (snapshot -> batch/period, line -> snapshot/earning in that
--      batch, payment/export -> batch/snapshot).
--   6. get_payroll_batch_export is the trusted, explicitly studio-scoped
--      reader behind the batch CSV / PDF exports: the caller must be an
--      owner/admin of the named studio or a platform admin naming an
--      existing studio, the batch must belong to that studio, and it returns
--      only the batch, period, snapshot, lines, payment evidence, (for
--      batches without a snapshot) the batch's earnings, and the named
--      studio's packet presentation fields (name, public name, logo URL). Platform admins
--      export through it without any direct table read; the evidence tables'
--      SELECT policies stay owner/admin of the studio.
--   7. The fingerprint is an md5 over the canonical text of every snapshot
--      line (quote_nullable per field, ordered by earning id) prefixed with
--      the batch id: it detects snapshot corruption and export mismatch; it
--      is not a security signature.
--
-- No existing payroll data is read into snapshots: batches approved before
-- this migration are not back-filled (PROD had no payroll batches at review).
-- Not in this slice: compensation history (9C), shared CSV (9D), earning_date
-- business date / UX (9E).
--
-- Preflight fails closed unless the replaced 9A functions are byte-identical
-- to the reviewed DEV == PROD definitions. Rollback:
-- rollback/20261103090000_phase9b_payroll_approval_evidence_rollback.sql.

begin;

-- ============================================================================
-- PREFLIGHT
-- ============================================================================

do $$
declare
  v_expected constant jsonb := jsonb_build_object(
    'approve_payroll_batch', 'b3708b15b06a39b22c4eba1491349082',
    'mark_payroll_batch_paid', 'f9d45874bf654c166e24af23b465227a',
    'enforce_payroll_batch_integrity', 'e597564335e7bf4ec98623ef8640e41f',
    'payroll_actor_role', '586438d56a5925319416258126df2f88'
  );
  r record;
  v_md5 text;
  v_count int;
begin
  for r in select key, value from jsonb_each_text(v_expected) loop
    select count(*), max(md5(p.prosrc)) into v_count, v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = r.key;
    if v_count <> 1 or v_md5 is distinct from r.value then
      raise exception 'Phase 9B preflight: public.% is not the reviewed 9A definition (count %, md5 %).', r.key, v_count, v_md5;
    end if;
  end loop;

  if to_regclass('public.payroll_batch_approval_snapshots') is not null
     or to_regclass('public.payroll_batch_approval_snapshot_lines') is not null
     or to_regclass('public.payroll_batch_payment_evidence') is not null
     or to_regclass('public.payroll_export_events') is not null
     or to_regclass('public.payroll_evidence_activation') is not null
     or to_regprocedure('public.record_payroll_export(uuid, uuid, text, integer, numeric)') is not null
     or to_regprocedure('public.get_payroll_batch_export(uuid, uuid)') is not null then
    raise exception 'Phase 9B preflight: Phase 9B objects already exist.';
  end if;

  if to_regprocedure('public.prevent_payroll_history_delete()') is null
     or (select count(*) from pg_trigger where not tgisinternal and tgname in (
           'trg_enforce_payroll_batch_integrity', 'trg_prevent_payroll_batch_history_delete')) <> 2 then
    raise exception 'Phase 9B preflight: Phase 9A is not applied.';
  end if;

  if (select string_agg(column_name, ',' order by column_name) from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name in ('email', 'full_name')) is distinct from 'email,full_name' then
    raise exception 'Phase 9B preflight: profiles.full_name / profiles.email are missing.';
  end if;
end
$$;

-- ============================================================================
-- 1. COMPOSITE KEYS FOR STRUCTURAL SAME-STUDIO REFERENCES
-- ============================================================================

create unique index payroll_pay_periods_id_studio_key on public.payroll_pay_periods (id, studio_id);
create unique index payroll_batches_id_studio_period_key on public.payroll_batches (id, studio_id, pay_period_id);
create unique index instructor_earnings_id_studio_batch_key on public.instructor_earnings (id, studio_id, payroll_batch_id);

-- ============================================================================
-- 2. EVIDENCE TABLES
-- ============================================================================

-- When immutable approval snapshots began. A batch approved before this
-- instant has no snapshot (legacy); one approved after it must have one.
create table public.payroll_evidence_activation (
  singleton boolean primary key default true check (singleton),
  activated_at timestamptz not null default now()
);
insert into public.payroll_evidence_activation (singleton) values (true);

create table public.payroll_batch_approval_snapshots (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id),
  payroll_batch_id uuid not null,
  pay_period_id uuid not null,
  snapshot_version integer not null default 1 check (snapshot_version = 1),
  batch_number bigint not null,
  provider text not null,
  provider_batch_reference text,
  period_start date not null,
  period_end date not null,
  pay_date date,
  approved_at timestamptz not null,
  approved_by uuid,
  approved_by_name text,
  approved_by_email text,
  approved_by_role text not null check (approved_by_role in ('studio_owner', 'studio_admin', 'platform_admin')),
  worker_count integer not null check (worker_count >= 0),
  earning_count integer not null check (earning_count >= 0),
  compensation_total numeric not null,
  reimbursement_total numeric not null,
  deduction_total numeric not null,
  net_payment_total numeric not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  constraint payroll_batch_approval_snapshots_batch_key unique (payroll_batch_id),
  constraint payroll_batch_approval_snapshots_id_studio_batch_key unique (id, studio_id, payroll_batch_id),
  constraint payroll_batch_approval_snapshots_batch_fkey foreign key (payroll_batch_id, studio_id, pay_period_id)
    references public.payroll_batches (id, studio_id, pay_period_id),
  constraint payroll_batch_approval_snapshots_period_fkey foreign key (pay_period_id, studio_id)
    references public.payroll_pay_periods (id, studio_id)
);

create table public.payroll_batch_approval_snapshot_lines (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null,
  studio_id uuid not null,
  payroll_batch_id uuid not null,
  line_number integer not null check (line_number > 0),
  earning_id uuid not null,
  instructor_id uuid not null,
  instructor_name text,
  client_id uuid,
  client_name text,
  appointment_id uuid,
  appointment_type text,
  source_type text not null,
  earning_date date not null,
  gross_revenue_basis numeric not null,
  pay_mode text not null,
  pay_rate_amount numeric not null,
  pay_percentage numeric not null,
  attendance_count integer not null,
  earning_amount numeric not null,
  adjustment_type text,
  override_reason text,
  worker_classification_snapshot text,
  accounting_category_snapshot text,
  taxable_compensation_amount numeric not null,
  reimbursement_amount numeric not null,
  deduction_amount numeric not null,
  net_amount numeric not null,
  notes text,
  constraint payroll_snapshot_lines_earning_key unique (snapshot_id, earning_id),
  constraint payroll_snapshot_lines_number_key unique (snapshot_id, line_number),
  constraint payroll_snapshot_lines_snapshot_fkey foreign key (snapshot_id, studio_id, payroll_batch_id)
    references public.payroll_batch_approval_snapshots (id, studio_id, payroll_batch_id),
  constraint payroll_snapshot_lines_earning_fkey foreign key (earning_id, studio_id, payroll_batch_id)
    references public.instructor_earnings (id, studio_id, payroll_batch_id),
  constraint payroll_snapshot_lines_net_check check (net_amount = taxable_compensation_amount + reimbursement_amount - deduction_amount)
);
create index payroll_snapshot_lines_snapshot_idx on public.payroll_batch_approval_snapshot_lines (snapshot_id, line_number);

create table public.payroll_batch_payment_evidence (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id),
  payroll_batch_id uuid not null,
  pay_period_id uuid not null,
  snapshot_id uuid,
  snapshot_fingerprint text,
  legacy_without_snapshot boolean not null,
  paid_at timestamptz not null,
  paid_by uuid,
  paid_by_name text,
  paid_by_email text,
  paid_by_role text not null check (paid_by_role in ('studio_owner', 'platform_admin')),
  payment_method text not null,
  provider_batch_reference text,
  earning_count integer not null check (earning_count >= 0),
  compensation_total numeric not null,
  reimbursement_total numeric not null,
  deduction_total numeric not null,
  net_payment_total numeric not null,
  created_at timestamptz not null default now(),
  constraint payroll_payment_evidence_batch_key unique (payroll_batch_id),
  constraint payroll_payment_evidence_batch_fkey foreign key (payroll_batch_id, studio_id, pay_period_id)
    references public.payroll_batches (id, studio_id, pay_period_id),
  constraint payroll_payment_evidence_snapshot_fkey foreign key (snapshot_id, studio_id, payroll_batch_id)
    references public.payroll_batch_approval_snapshots (id, studio_id, payroll_batch_id),
  constraint payroll_payment_evidence_snapshot_shape check (
    (legacy_without_snapshot and snapshot_id is null and snapshot_fingerprint is null)
    or (not legacy_without_snapshot and snapshot_id is not null and snapshot_fingerprint is not null))
);

create table public.payroll_export_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id),
  payroll_batch_id uuid not null,
  pay_period_id uuid not null,
  snapshot_id uuid,
  snapshot_fingerprint text,
  export_source text not null check (export_source in ('approval_snapshot', 'legacy_live')),
  export_type text not null check (export_type in ('csv', 'pdf')),
  format_version integer not null default 1 check (format_version = 1),
  line_count integer not null check (line_count >= 0),
  net_payment_total numeric not null,
  exported_at timestamptz not null default now(),
  exported_by uuid,
  exported_by_name text,
  exported_by_email text,
  exported_by_role text not null check (exported_by_role in ('studio_owner', 'studio_admin', 'platform_admin')),
  constraint payroll_export_events_batch_fkey foreign key (payroll_batch_id, studio_id, pay_period_id)
    references public.payroll_batches (id, studio_id, pay_period_id),
  constraint payroll_export_events_snapshot_fkey foreign key (snapshot_id, studio_id, payroll_batch_id)
    references public.payroll_batch_approval_snapshots (id, studio_id, payroll_batch_id),
  constraint payroll_export_events_source_shape check (
    (export_source = 'legacy_live' and snapshot_id is null and snapshot_fingerprint is null)
    or (export_source = 'approval_snapshot' and snapshot_id is not null and snapshot_fingerprint is not null))
);
create index payroll_export_events_batch_idx on public.payroll_export_events (studio_id, payroll_batch_id, exported_at desc);

-- ============================================================================
-- 3. APPEND-ONLY GUARD, RLS, GRANTS
-- ============================================================================

create function public.prevent_payroll_evidence_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Payroll evidence is immutable.';
end;
$$;
revoke all on function public.prevent_payroll_evidence_change() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['payroll_evidence_activation', 'payroll_batch_approval_snapshots',
    'payroll_batch_approval_snapshot_lines', 'payroll_batch_payment_evidence', 'payroll_export_events'] loop
    execute format('create trigger trg_%s_immutable before update or delete on public.%I for each row execute function public.prevent_payroll_evidence_change()', t, t);
    execute format('create trigger trg_%s_no_truncate before truncate on public.%I for each statement execute function public.prevent_payroll_evidence_change()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
  foreach t in array array['payroll_batch_approval_snapshots', 'payroll_batch_approval_snapshot_lines',
    'payroll_batch_payment_evidence', 'payroll_export_events'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format($p$create policy %I on public.%I for select to authenticated using (
      exists (select 1 from public.user_studio_roles usr
              where usr.studio_id = %I.studio_id and usr.user_id = auth.uid() and usr.active = true
                and usr.role = any (array['studio_owner'::app_role, 'studio_admin'::app_role])))$p$,
      t || '_select', t, t);
  end loop;
end
$$;

-- ============================================================================
-- 4. CANONICAL LINE TEXT AND FINGERPRINT
-- ============================================================================

create function public.payroll_snapshot_line_text(
  p_earning_id uuid, p_instructor_id uuid, p_instructor_name text, p_client_id uuid, p_client_name text,
  p_appointment_id uuid, p_appointment_type text, p_source_type text, p_earning_date date,
  p_gross_revenue_basis numeric, p_pay_mode text, p_pay_rate_amount numeric, p_pay_percentage numeric,
  p_attendance_count integer, p_earning_amount numeric, p_adjustment_type text, p_override_reason text,
  p_worker_classification text, p_accounting_category text, p_taxable numeric, p_reimbursement numeric,
  p_deduction numeric, p_notes text)
returns text
language sql
immutable
set search_path = public
as $$
  select concat_ws('|',
    quote_nullable(p_earning_id::text), quote_nullable(p_instructor_id::text), quote_nullable(p_instructor_name),
    quote_nullable(p_client_id::text), quote_nullable(p_client_name), quote_nullable(p_appointment_id::text),
    quote_nullable(p_appointment_type), quote_nullable(p_source_type), quote_nullable(to_char(p_earning_date, 'YYYY-MM-DD')),
    quote_nullable(p_gross_revenue_basis::text), quote_nullable(p_pay_mode), quote_nullable(p_pay_rate_amount::text),
    quote_nullable(p_pay_percentage::text), quote_nullable(p_attendance_count::text), quote_nullable(p_earning_amount::text),
    quote_nullable(p_adjustment_type), quote_nullable(p_override_reason), quote_nullable(p_worker_classification),
    quote_nullable(p_accounting_category), quote_nullable(p_taxable::text), quote_nullable(p_reimbursement::text),
    quote_nullable(p_deduction::text), quote_nullable(p_notes));
$$;
revoke all on function public.payroll_snapshot_line_text(uuid, uuid, text, uuid, text, uuid, text, text, date, numeric, text,
  numeric, numeric, integer, numeric, text, text, text, text, numeric, numeric, numeric, text) from public, anon, authenticated;

create function public.payroll_approval_snapshot_fingerprint(p_snapshot_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select md5(s.payroll_batch_id::text || E'\n' || coalesce((
    select string_agg(public.payroll_snapshot_line_text(
        l.earning_id, l.instructor_id, l.instructor_name, l.client_id, l.client_name, l.appointment_id,
        l.appointment_type, l.source_type, l.earning_date, l.gross_revenue_basis, l.pay_mode, l.pay_rate_amount,
        l.pay_percentage, l.attendance_count, l.earning_amount, l.adjustment_type, l.override_reason,
        l.worker_classification_snapshot, l.accounting_category_snapshot, l.taxable_compensation_amount,
        l.reimbursement_amount, l.deduction_amount, l.notes), E'\n' order by l.earning_id)
    from public.payroll_batch_approval_snapshot_lines l
    where l.snapshot_id = s.id and l.studio_id = s.studio_id), ''))
  from public.payroll_batch_approval_snapshots s
  where s.id = p_snapshot_id;
$$;
revoke all on function public.payroll_approval_snapshot_fingerprint(uuid) from public, anon, authenticated;

-- ============================================================================
-- 5. BATCH INTEGRITY: approval requires its snapshot, payment its evidence
-- ============================================================================

create or replace function public.enforce_payroll_batch_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bypass boolean := public.payroll_transition_bypass_enabled();
  v_stamps constant text[] := array['status', 'compensation_total', 'reimbursement_total', 'deduction_total',
    'net_payment_total', 'earning_count', 'approved_at', 'approved_by', 'paid_at', 'paid_by', 'payment_method',
    'voided_at', 'voided_by', 'void_reason', 'locked_at'];
  v_payment_fields constant text[] := array['status', 'paid_at', 'paid_by', 'payment_method',
    'provider_batch_reference', 'locked_at', 'updated_by', 'updated_at'];
  v_new jsonb := to_jsonb(new);
  v_old jsonb;
  v_period_studio uuid;
  v_period_status text;
begin
  if tg_op = 'INSERT' then
    select studio_id, status into v_period_studio, v_period_status
    from public.payroll_pay_periods where id = new.pay_period_id;
    if v_period_studio is null or v_period_studio <> new.studio_id then
      raise exception 'Payroll batch pay period must belong to the same studio.';
    end if;
    if v_period_status in ('paid', 'void') then
      raise exception 'Closed pay periods cannot receive payroll batches.';
    end if;
    if new.status <> 'draft' or new.compensation_total <> 0 or new.reimbursement_total <> 0
       or new.deduction_total <> 0 or new.net_payment_total <> 0 or new.earning_count <> 0
       or new.approved_at is not null or new.paid_at is not null or new.voided_at is not null
       or new.locked_at is not null then
      raise exception 'New payroll batches must start as empty drafts.';
    end if;
    return new;
  end if;

  v_old := to_jsonb(old);

  if new.studio_id is distinct from old.studio_id or new.pay_period_id is distinct from old.pay_period_id
     or new.batch_number is distinct from old.batch_number then
    raise exception 'Payroll batch studio, pay period and number cannot be changed.';
  end if;

  if old.status in ('paid', 'void') then
    if (v_new - 'updated_at') is distinct from (v_old - 'updated_at') then
      raise exception 'Closed payroll records cannot be changed.';
    end if;
    return new;
  end if;

  if not v_bypass and exists (select 1 from unnest(v_stamps) f where (v_new -> f) is distinct from (v_old -> f)) then
    raise exception 'Payroll batch status and totals are managed by payroll operations.';
  end if;

  if old.status = 'approved' then
    -- Approved totals are frozen; the only change left is canonical payment.
    if (v_new - v_payment_fields) is distinct from (v_old - v_payment_fields)
       or (new.status = 'approved'
           and (v_new - array['updated_by', 'updated_at']) is distinct from (v_old - array['updated_by', 'updated_at'])) then
      raise exception 'Approved payroll batches are locked.';
    end if;
  end if;

  if new.status is distinct from old.status then
    if not ((old.status = 'draft' and new.status in ('in_review', 'approved', 'void'))
            or (old.status = 'in_review' and new.status in ('approved', 'void'))
            or (old.status = 'approved' and new.status = 'paid')) then
      raise exception 'Invalid payroll batch transition from % to %.', old.status, new.status;
    end if;
    if new.status = 'approved' and exists (
      select 1 from public.instructor_earnings e
      where e.payroll_batch_id = new.id and e.status not in ('approved', 'void')) then
      raise exception 'Only approved earnings can be approved in a payroll batch.';
    end if;
    -- Phase 9B: approval and its immutable snapshot happen together.
    if new.status = 'approved' and not exists (
      select 1 from public.payroll_batch_approval_snapshots s
      where s.payroll_batch_id = new.id and s.studio_id = new.studio_id) then
      raise exception 'A payroll batch is approved only together with its approval snapshot.';
    end if;
    if new.status = 'paid' and exists (
      select 1 from public.instructor_earnings e
      where e.payroll_batch_id = new.id and e.status not in ('paid', 'void')) then
      raise exception 'A payroll batch is paid only after its earnings are paid.';
    end if;
    -- Phase 9B: payment and its immutable evidence happen together.
    if new.status = 'paid' and not exists (
      select 1 from public.payroll_batch_payment_evidence p
      where p.payroll_batch_id = new.id and p.studio_id = new.studio_id) then
      raise exception 'A payroll batch is paid only together with its payment evidence.';
    end if;
  end if;

  return new;
end;
$$;
revoke all on function public.enforce_payroll_batch_integrity() from public, anon, authenticated;

-- ============================================================================
-- 6. APPROVAL: snapshot + approval in one transaction
-- ============================================================================

create or replace function public.approve_payroll_batch(p_studio_id uuid, p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text;
  v_batch record;
  v_period record;
  v_actor record;
  v_src record;
  v_snapshot_id uuid;
  v_now timestamptz := now();
begin
  v_role := public.payroll_actor_role(p_studio_id);
  if coalesce(v_role, '') not in ('studio_owner', 'studio_admin', 'platform_admin') then
    raise exception 'Payroll access denied.';
  end if;
  select id, pay_period_id, status into v_batch
  from public.payroll_batches
  where id = p_batch_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Payroll batch not found.'; end if;
  if v_batch.status not in ('draft', 'in_review') then
    raise exception 'Only draft or in-review batches can be approved.';
  end if;
  select id, status, period_start, period_end, pay_date into v_period
  from public.payroll_pay_periods
  where id = v_batch.pay_period_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Pay period not found.'; end if;
  if exists (
    select 1 from public.instructor_earnings e
    where e.payroll_batch_id = v_batch.id
      and (e.studio_id <> p_studio_id or e.pay_period_id is distinct from v_batch.pay_period_id
           or e.status not in ('approved', 'void') or e.locked_at is null)
  ) then
    raise exception 'Payroll batch contains earnings that are not approved for this studio.';
  end if;
  if exists (select 1 from public.payroll_batch_approval_snapshots where payroll_batch_id = v_batch.id) then
    raise exception 'Payroll batch already has an approval snapshot.';
  end if;
  perform 1 from public.instructor_earnings
  where payroll_batch_id = v_batch.id and studio_id = p_studio_id
  for update;

  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  perform public.refresh_payroll_batch_totals(v_batch.id);

  select id, batch_number, provider, provider_batch_reference, compensation_total, reimbursement_total,
         deduction_total, net_payment_total, earning_count into v_batch
  from public.payroll_batches where id = p_batch_id and studio_id = p_studio_id;

  select p.id, coalesce(nullif(trim(p.full_name), ''), nullif(trim(p.email), '')) as display_name,
         nullif(trim(p.email), '') as email into v_actor
  from public.profiles p where p.id = auth.uid();

  -- Source rows, canonical totals and fingerprint (same line text as the
  -- stored lines; verified against them below).
  select count(*)::int as earning_count, count(distinct e.instructor_id)::int as worker_count,
         coalesce(sum(e.taxable_compensation_amount), 0) as compensation_total,
         coalesce(sum(e.reimbursement_amount), 0) as reimbursement_total,
         coalesce(sum(e.deduction_amount), 0) as deduction_total,
         coalesce(sum(e.taxable_compensation_amount + e.reimbursement_amount - e.deduction_amount), 0) as net_payment_total,
         md5(v_batch.id::text || E'\n' || coalesce(string_agg(public.payroll_snapshot_line_text(
           e.id, e.instructor_id, nullif(trim(concat_ws(' ', i.first_name, i.last_name)), ''), e.client_id,
           nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), e.appointment_id, e.appointment_type,
           e.source_type, e.earning_date, e.gross_revenue_basis, e.pay_mode, e.pay_rate_amount, e.pay_percentage,
           e.attendance_count, e.earning_amount, e.adjustment_type, e.override_reason,
           e.worker_classification_snapshot, e.accounting_category_snapshot, e.taxable_compensation_amount,
           e.reimbursement_amount, e.deduction_amount, e.notes), E'\n' order by e.id), '')) as fingerprint
    into v_src
  from public.instructor_earnings e
  join public.instructors i on i.id = e.instructor_id and i.studio_id = e.studio_id
  left join public.clients c on c.id = e.client_id and c.studio_id = e.studio_id
  where e.payroll_batch_id = v_batch.id and e.studio_id = p_studio_id and e.status = 'approved';

  if (v_src.compensation_total, v_src.reimbursement_total, v_src.deduction_total, v_src.net_payment_total, v_src.earning_count)
     is distinct from (v_batch.compensation_total, v_batch.reimbursement_total, v_batch.deduction_total,
                       v_batch.net_payment_total, v_batch.earning_count) then
    raise exception 'Payroll batch totals do not match its approved earnings.';
  end if;

  insert into public.payroll_batch_approval_snapshots (
    studio_id, payroll_batch_id, pay_period_id, batch_number, provider, provider_batch_reference,
    period_start, period_end, pay_date, approved_at, approved_by, approved_by_name, approved_by_email, approved_by_role,
    worker_count, earning_count, compensation_total, reimbursement_total, deduction_total, net_payment_total, fingerprint)
  values (
    p_studio_id, v_batch.id, v_period.id, v_batch.batch_number, v_batch.provider, v_batch.provider_batch_reference,
    v_period.period_start, v_period.period_end, v_period.pay_date, v_now, auth.uid(), v_actor.display_name, v_actor.email, v_role,
    v_src.worker_count, v_src.earning_count, v_src.compensation_total, v_src.reimbursement_total,
    v_src.deduction_total, v_src.net_payment_total, v_src.fingerprint)
  returning id into v_snapshot_id;

  insert into public.payroll_batch_approval_snapshot_lines (
    snapshot_id, studio_id, payroll_batch_id, line_number, earning_id, instructor_id, instructor_name, client_id,
    client_name, appointment_id, appointment_type, source_type, earning_date, gross_revenue_basis, pay_mode,
    pay_rate_amount, pay_percentage, attendance_count, earning_amount, adjustment_type, override_reason,
    worker_classification_snapshot, accounting_category_snapshot, taxable_compensation_amount, reimbursement_amount,
    deduction_amount, net_amount, notes)
  select v_snapshot_id, p_studio_id, v_batch.id,
         row_number() over (order by e.earning_date, e.id)::int, e.id, e.instructor_id,
         nullif(trim(concat_ws(' ', i.first_name, i.last_name)), ''), e.client_id,
         nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), e.appointment_id, e.appointment_type,
         e.source_type, e.earning_date, e.gross_revenue_basis, e.pay_mode, e.pay_rate_amount, e.pay_percentage,
         e.attendance_count, e.earning_amount, e.adjustment_type, e.override_reason, e.worker_classification_snapshot,
         e.accounting_category_snapshot, e.taxable_compensation_amount, e.reimbursement_amount, e.deduction_amount,
         e.taxable_compensation_amount + e.reimbursement_amount - e.deduction_amount, e.notes
  from public.instructor_earnings e
  join public.instructors i on i.id = e.instructor_id and i.studio_id = e.studio_id
  left join public.clients c on c.id = e.client_id and c.studio_id = e.studio_id
  where e.payroll_batch_id = v_batch.id and e.studio_id = p_studio_id and e.status = 'approved';

  if (select count(*) from public.payroll_batch_approval_snapshot_lines where snapshot_id = v_snapshot_id) <> v_src.earning_count
     or public.payroll_approval_snapshot_fingerprint(v_snapshot_id) is distinct from v_src.fingerprint then
    raise exception 'Payroll approval snapshot failed verification.';
  end if;

  update public.payroll_batches
  set status = 'approved', approved_at = v_now, approved_by = auth.uid(), locked_at = v_now,
      updated_by = auth.uid(), updated_at = v_now
  where id = v_batch.id and studio_id = p_studio_id;
  update public.payroll_pay_periods
  set status = 'approved', approved_at = coalesce(approved_at, v_now), approved_by = coalesce(approved_by, auth.uid()),
      locked_at = coalesce(locked_at, v_now), updated_by = auth.uid(), updated_at = v_now
  where id = v_period.id and studio_id = p_studio_id and status in ('open', 'in_review');
  perform set_config('danceflow.payroll_transition_bypass', '', true);
end;
$function$;
revoke all on function public.approve_payroll_batch(uuid, uuid) from public, anon;
grant execute on function public.approve_payroll_batch(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- 7. PAYMENT: snapshot verification + payment evidence in one transaction
-- ============================================================================

create or replace function public.mark_payroll_batch_paid(p_studio_id uuid, p_batch_id uuid, p_payment_method text default 'external_payroll'::text, p_provider_batch_reference text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text;
  v_batch record;
  v_method text := coalesce(nullif(trim(p_payment_method), ''), 'external_payroll');
  v_reference text;
  v_expected int;
  v_paid int;
  v_totals record;
  v_snapshot record;
  v_has_snapshot boolean;
  v_actor record;
  v_now timestamptz := now();
begin
  v_role := public.payroll_actor_role(p_studio_id);
  if coalesce(v_role, '') not in ('studio_owner', 'platform_admin') then
    raise exception 'Only the studio owner can mark payroll paid.';
  end if;
  select id, pay_period_id, status, approved_at, provider_batch_reference, compensation_total, reimbursement_total,
         deduction_total, net_payment_total, earning_count
    into v_batch
  from public.payroll_batches
  where id = p_batch_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Payroll batch not found.'; end if;
  if v_batch.status <> 'approved' then
    raise exception 'The payroll batch must be approved before payment.';
  end if;
  perform 1 from public.payroll_pay_periods
  where id = v_batch.pay_period_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Pay period not found.'; end if;

  if exists (
    select 1 from public.instructor_earnings e
    where e.payroll_batch_id = v_batch.id
      and (e.studio_id <> p_studio_id or e.pay_period_id is distinct from v_batch.pay_period_id
           or e.status not in ('approved', 'void') or e.locked_at is null)
  ) then
    raise exception 'Payroll batch contains earnings that are not approved for this studio.';
  end if;

  select coalesce(sum(taxable_compensation_amount), 0) compensation_total,
    coalesce(sum(reimbursement_amount), 0) reimbursement_total,
    coalesce(sum(deduction_amount), 0) deduction_total,
    coalesce(sum(taxable_compensation_amount + reimbursement_amount - deduction_amount), 0) net_payment_total,
    count(*)::int earning_count
    into v_totals
  from public.instructor_earnings
  where payroll_batch_id = v_batch.id and studio_id = p_studio_id and status = 'approved';
  if (v_totals.compensation_total, v_totals.reimbursement_total, v_totals.deduction_total, v_totals.net_payment_total, v_totals.earning_count)
     is distinct from (v_batch.compensation_total, v_batch.reimbursement_total, v_batch.deduction_total, v_batch.net_payment_total, v_batch.earning_count) then
    raise exception 'Payroll batch totals do not match its approved earnings.';
  end if;
  v_expected := v_totals.earning_count;

  -- Phase 9B: the approval snapshot must still describe exactly this batch.
  select id, fingerprint, earning_count, compensation_total, reimbursement_total, deduction_total, net_payment_total
    into v_snapshot
  from public.payroll_batch_approval_snapshots
  where payroll_batch_id = v_batch.id and studio_id = p_studio_id;
  v_has_snapshot := found;
  if v_has_snapshot then
    if (v_snapshot.compensation_total, v_snapshot.reimbursement_total, v_snapshot.deduction_total,
        v_snapshot.net_payment_total, v_snapshot.earning_count)
       is distinct from (v_batch.compensation_total, v_batch.reimbursement_total, v_batch.deduction_total,
                         v_batch.net_payment_total, v_batch.earning_count)
       or exists (
         select l.earning_id from public.payroll_batch_approval_snapshot_lines l where l.snapshot_id = v_snapshot.id
         except
         select e.id from public.instructor_earnings e
         where e.payroll_batch_id = v_batch.id and e.studio_id = p_studio_id and e.status = 'approved')
       or exists (
         select e.id from public.instructor_earnings e
         where e.payroll_batch_id = v_batch.id and e.studio_id = p_studio_id and e.status = 'approved'
         except
         select l.earning_id from public.payroll_batch_approval_snapshot_lines l where l.snapshot_id = v_snapshot.id) then
      raise exception 'Payroll approval snapshot does not match the batch.';
    end if;
    if public.payroll_approval_snapshot_fingerprint(v_snapshot.id) is distinct from v_snapshot.fingerprint then
      raise exception 'Payroll approval snapshot failed verification.';
    end if;
  elsif v_batch.approved_at is null
        or v_batch.approved_at >= (select activated_at from public.payroll_evidence_activation) then
    -- Only batches approved before snapshots existed may be paid without one.
    raise exception 'Payroll batch is missing its approval snapshot.';
  end if;

  select coalesce(nullif(trim(p.full_name), ''), nullif(trim(p.email), '')) as display_name,
         nullif(trim(p.email), '') as email into v_actor
  from public.profiles p where p.id = auth.uid();
  v_reference := coalesce(nullif(trim(p_provider_batch_reference), ''), v_batch.provider_batch_reference);

  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  update public.instructor_earnings
  set status = 'paid', paid_at = v_now, paid_by = auth.uid(), payment_method = v_method, updated_at = v_now
  where studio_id = p_studio_id and payroll_batch_id = v_batch.id and status = 'approved';
  get diagnostics v_paid = row_count;
  if v_paid <> v_expected then
    raise exception 'Payroll batch payment did not cover every approved earning.';
  end if;

  insert into public.payroll_batch_payment_evidence (
    studio_id, payroll_batch_id, pay_period_id, snapshot_id, snapshot_fingerprint, legacy_without_snapshot,
    paid_at, paid_by, paid_by_name, paid_by_email, paid_by_role, payment_method, provider_batch_reference,
    earning_count, compensation_total, reimbursement_total, deduction_total, net_payment_total)
  values (
    p_studio_id, v_batch.id, v_batch.pay_period_id,
    case when v_has_snapshot then v_snapshot.id end, case when v_has_snapshot then v_snapshot.fingerprint end,
    not v_has_snapshot, v_now, auth.uid(), v_actor.display_name, v_actor.email, v_role, v_method, v_reference,
    v_batch.earning_count, v_batch.compensation_total, v_batch.reimbursement_total, v_batch.deduction_total,
    v_batch.net_payment_total);

  update public.payroll_batches
  set status = 'paid', paid_at = v_now, paid_by = auth.uid(), payment_method = v_method,
      provider_batch_reference = v_reference,
      locked_at = coalesce(locked_at, v_now), updated_by = auth.uid(), updated_at = v_now
  where id = v_batch.id and studio_id = p_studio_id;
  update public.payroll_pay_periods
  set status = 'paid', paid_at = v_now, paid_by = auth.uid(), locked_at = coalesce(locked_at, v_now),
      updated_by = auth.uid(), updated_at = v_now
  where id = v_batch.pay_period_id and studio_id = p_studio_id and status = 'approved'
    and not exists (select 1 from public.payroll_batches b
                    where b.pay_period_id = v_batch.pay_period_id and b.status not in ('paid', 'void'))
    and not exists (select 1 from public.instructor_earnings e
                    where e.pay_period_id = v_batch.pay_period_id and e.payroll_batch_id is null and e.status <> 'void');
  perform set_config('danceflow.payroll_transition_bypass', '', true);
end;
$function$;
revoke all on function public.mark_payroll_batch_paid(uuid, uuid, text, text) from public, anon;
grant execute on function public.mark_payroll_batch_paid(uuid, uuid, text, text) to authenticated, service_role;

-- ============================================================================
-- 8. EXPORT (FINALIZATION) EVIDENCE: append one event per successful export
-- ============================================================================

create function public.record_payroll_export(p_studio_id uuid, p_batch_id uuid, p_export_type text,
  p_line_count integer, p_net_payment_total numeric)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text;
  v_batch record;
  v_snapshot record;
  v_snapshot_id uuid;
  v_fingerprint text;
  v_actor record;
  v_id uuid;
begin
  v_role := public.payroll_actor_role(p_studio_id);
  if coalesce(v_role, '') not in ('studio_owner', 'studio_admin', 'platform_admin') then
    raise exception 'Payroll access denied.';
  end if;
  if p_export_type is null or p_export_type not in ('csv', 'pdf') then
    raise exception 'Unsupported payroll export type.';
  end if;
  select id, pay_period_id, status, approved_at, earning_count, net_payment_total into v_batch
  from public.payroll_batches
  where id = p_batch_id and studio_id = p_studio_id;
  if not found then raise exception 'Payroll batch not found.'; end if;
  if v_batch.status not in ('approved', 'paid') then
    raise exception 'Only approved payroll batches have export evidence.';
  end if;

  select id, fingerprint, earning_count, net_payment_total into v_snapshot
  from public.payroll_batch_approval_snapshots
  where payroll_batch_id = v_batch.id and studio_id = p_studio_id;
  if found then
    v_snapshot_id := v_snapshot.id;
    v_fingerprint := v_snapshot.fingerprint;
    if public.payroll_approval_snapshot_fingerprint(v_snapshot_id) is distinct from v_fingerprint then
      raise exception 'Payroll approval snapshot failed verification.';
    end if;
    if p_line_count is distinct from v_snapshot.earning_count
       or round(p_net_payment_total, 2) is distinct from round(v_snapshot.net_payment_total, 2) then
      raise exception 'Payroll export does not match the approval snapshot.';
    end if;
  else
    if v_batch.approved_at is null
       or v_batch.approved_at >= (select activated_at from public.payroll_evidence_activation) then
      raise exception 'Payroll batch is missing its approval snapshot.';
    end if;
    if p_line_count is distinct from v_batch.earning_count
       or round(p_net_payment_total, 2) is distinct from round(v_batch.net_payment_total, 2) then
      raise exception 'Payroll export does not match the approved batch.';
    end if;
  end if;

  select coalesce(nullif(trim(p.full_name), ''), nullif(trim(p.email), '')) as display_name,
         nullif(trim(p.email), '') as email into v_actor
  from public.profiles p where p.id = auth.uid();

  insert into public.payroll_export_events (
    studio_id, payroll_batch_id, pay_period_id, snapshot_id, snapshot_fingerprint, export_source, export_type,
    line_count, net_payment_total, exported_by, exported_by_name, exported_by_email, exported_by_role)
  values (
    p_studio_id, v_batch.id, v_batch.pay_period_id, v_snapshot_id, v_fingerprint,
    case when v_snapshot_id is null then 'legacy_live' else 'approval_snapshot' end, p_export_type,
    p_line_count, p_net_payment_total, auth.uid(), v_actor.display_name, v_actor.email, v_role)
  returning id into v_id;
  return v_id;
end;
$function$;
revoke all on function public.record_payroll_export(uuid, uuid, text, integer, numeric) from public, anon;
grant execute on function public.record_payroll_export(uuid, uuid, text, integer, numeric) to authenticated, service_role;

-- ============================================================================
-- 9. TRUSTED EXPORT READER (explicit studio; owner/admin/platform admin)
-- ============================================================================

create function public.get_payroll_batch_export(p_studio_id uuid, p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_role text;
  v_batch jsonb;
  v_period_id uuid;
  v_snapshot jsonb;
  v_snapshot_id uuid;
begin
  v_role := public.payroll_actor_role(p_studio_id);
  if coalesce(v_role, '') not in ('studio_owner', 'studio_admin', 'platform_admin') then
    raise exception 'Payroll access denied.';
  end if;

  select to_jsonb(b), b.pay_period_id into v_batch, v_period_id
  from (
    select id, pay_period_id, batch_number, provider, provider_batch_reference, status, compensation_total,
           reimbursement_total, deduction_total, net_payment_total, earning_count, approved_at, paid_at,
           payment_method, created_at
    from public.payroll_batches
    where id = p_batch_id and studio_id = p_studio_id
  ) b;
  if v_batch is null then raise exception 'Payroll batch not found.'; end if;

  select to_jsonb(s), s.id into v_snapshot, v_snapshot_id
  from (
    select id, payroll_batch_id, pay_period_id, batch_number, provider, provider_batch_reference, period_start,
           period_end, pay_date, approved_at, approved_by_name, approved_by_role, worker_count, earning_count,
           compensation_total, reimbursement_total, deduction_total, net_payment_total, fingerprint
    from public.payroll_batch_approval_snapshots
    where payroll_batch_id = p_batch_id and studio_id = p_studio_id
  ) s;

  return jsonb_build_object(
    'batch', v_batch,
    -- Presentation fields of the named studio only (the batch belongs to it).
    'studio', (
      select jsonb_build_object('name', st.name, 'public_name', st.public_name, 'public_logo_url', st.public_logo_url)
      from public.studios st where st.id = p_studio_id),
    'period', (
      select to_jsonb(p) from (
        select id, period_start, period_end, pay_date, status
        from public.payroll_pay_periods where id = v_period_id and studio_id = p_studio_id
      ) p),
    'snapshot', v_snapshot,
    'lines', case when v_snapshot_id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(to_jsonb(l) order by l.line_number) from (
        select line_number, earning_id, instructor_id, instructor_name, client_name, appointment_id, appointment_type,
               source_type, earning_date, gross_revenue_basis, pay_mode, pay_rate_amount, pay_percentage,
               attendance_count, earning_amount, worker_classification_snapshot, accounting_category_snapshot,
               taxable_compensation_amount, reimbursement_amount, deduction_amount, net_amount, notes
        from public.payroll_batch_approval_snapshot_lines
        where snapshot_id = v_snapshot_id and studio_id = p_studio_id
      ) l), '[]'::jsonb) end,
    'payment', (
      select to_jsonb(e) from (
        select paid_at, paid_by_name, paid_by_role, payment_method, provider_batch_reference
        from public.payroll_batch_payment_evidence
        where payroll_batch_id = p_batch_id and studio_id = p_studio_id
      ) e),
    -- Current records only for batches without a snapshot (draft / in review, or approved before snapshots).
    'earnings', case when v_snapshot_id is not null then '[]'::jsonb else coalesce((
      select jsonb_agg(to_jsonb(x) order by x.earning_date, x.id) from (
        select ie.id, ie.earning_date, ie.source_type, ie.appointment_type, ie.gross_revenue_basis, ie.pay_mode,
               ie.pay_rate_amount, ie.pay_percentage, ie.attendance_count, ie.earning_amount, ie.status, ie.paid_at,
               ie.payment_method, ie.notes, ie.appointment_id, ie.instructor_id, ie.pay_period_id, ie.payroll_batch_id,
               ie.worker_classification_snapshot, ie.accounting_category_snapshot, ie.taxable_compensation_amount,
               ie.reimbursement_amount, ie.deduction_amount,
               jsonb_build_object('first_name', i.first_name, 'last_name', i.last_name) as instructors,
               case when c.id is null then null else jsonb_build_object('first_name', c.first_name, 'last_name', c.last_name) end as clients
        from public.instructor_earnings ie
        left join public.instructors i on i.id = ie.instructor_id and i.studio_id = ie.studio_id
        left join public.clients c on c.id = ie.client_id and c.studio_id = ie.studio_id
        where ie.payroll_batch_id = p_batch_id and ie.studio_id = p_studio_id
        order by ie.earning_date, ie.id
        limit 5000
      ) x), '[]'::jsonb) end
  );
end;
$function$;
revoke all on function public.get_payroll_batch_export(uuid, uuid) from public, anon;
grant execute on function public.get_payroll_batch_export(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- POSTFLIGHT
-- ============================================================================

do $$
declare
  t text;
begin
  foreach t in array array['payroll_evidence_activation', 'payroll_batch_approval_snapshots',
    'payroll_batch_approval_snapshot_lines', 'payroll_batch_payment_evidence', 'payroll_export_events'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'Phase 9B postflight: RLS is off on %.', t;
    end if;
    if (select count(*) from pg_trigger where tgrelid = ('public.' || t)::regclass and not tgisinternal and tgenabled = 'O') <> 2 then
      raise exception 'Phase 9B postflight: immutability triggers missing on %.', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd <> 'SELECT') then
      raise exception 'Phase 9B postflight: % has a write policy.', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception 'Phase 9B postflight: % grants are too broad.', t;
    end if;
  end loop;
  if (select count(*) from public.payroll_evidence_activation) <> 1 then
    raise exception 'Phase 9B postflight: activation row missing.';
  end if;
  if has_function_privilege('authenticated', 'public.payroll_approval_snapshot_fingerprint(uuid)', 'execute') then
    raise exception 'Phase 9B postflight: fingerprint function is executable by authenticated.';
  end if;
  if has_function_privilege('anon', 'public.get_payroll_batch_export(uuid, uuid)', 'execute')
     or not (select prosecdef from pg_proc where oid = 'public.get_payroll_batch_export(uuid, uuid)'::regprocedure) then
    raise exception 'Phase 9B postflight: export reader grants or security mode are wrong.';
  end if;
end
$$;

commit;
