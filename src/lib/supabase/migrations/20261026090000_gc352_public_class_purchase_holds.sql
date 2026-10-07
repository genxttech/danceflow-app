-- 20261026090000_gc352_public_class_purchase_holds.sql
--
-- GC-3.5-2: authoritative database layer for PUBLIC paid Group Class
-- acquisition (self-registration only). A signed-in person who is NOT yet
-- linked to the studio buys a seat in a publicly discoverable, self-enrollable
-- class that accepts direct payment. This migration owns:
--
--   1. public.group_class_enrollment_holds -- seat hold + purchase record;
--   2. capacity: _group_class_roster_reserved_count also counts live holds
--      (and the capacity-floor message now says "booked or reserved");
--   3. start_public_class_purchase          (authenticated purchaser);
--   4. attach_public_class_purchase_checkout (service_role only);
--   5. finalize_public_class_purchase        (service_role only);
--   6. release_public_class_purchase         (authenticated purchaser).
--
-- No Stripe objects are created or refunded here; Checkout, the webhook and the
-- automatic refund of conflicted purchases are GC-3.5-3 application work.
--
-- Owner decisions honoured: self-registration only (no dependents); linking is
-- by construction -- a NEW active client is created at finalize and linked to
-- the purchaser as 'self' (never matched to an existing client by email; a
-- possible duplicate is left for staff to reconcile and is never revealed);
-- users already linked to the studio do not use this path; a paid hold that
-- cannot be finalized becomes a durable conflict with truthful paid accounting
-- evidence and no client/link/enrollment (D2); no new checkout inside 30
-- minutes of class start (D3); ~30-minute hold aligned with Checkout plus a
-- small reconciliation grace (D5); USD only (D7); no platform fee (D6).
--
-- AMOUNT REPRESENTATION. The class price stays in
-- group_class_enrollment_policies.direct_payment_amount (numeric dollars,
-- unchanged). The hold snapshots it as INTEGER CENTS (amount_cents): Stripe
-- reports amounts in integer minor units, so finalize compares
-- p_amount_cents = amount_cents exactly, with no rounding. A policy price that
-- is not a whole number of cents is refused at hold creation. The payments row
-- keeps DanceFlow's existing numeric-dollar convention (amount_cents / 100).
--
-- STATUS MODEL (smallest set that keeps capacity and idempotency honest):
--   held       -- seat reserved while expires_at > now(); the ONLY counting state
--   converting -- transient, inside finalize's own transaction only: the hold
--                 stops counting immediately before the attendee insert so the
--                 roster trigger never double-counts the seat. A deferred
--                 constraint trigger refuses to COMMIT a row left 'converting';
--                 a failed finalize rolls back to 'held' naturally.
--   converted  -- paid and enrolled (terminal; result ids required)
--   released   -- purchaser released, or an expired hold was replaced
--   conflict   -- paid but could not be finalized (terminal; app refunds)
-- Transitions: held -> converting | released | conflict; converting ->
-- converted; released -> conflict (a late payment on a released hold).
-- converted and conflict rows are frozen. Enforced by a BEFORE UPDATE trigger.
--
-- LOCK ORDER (matches the roster-capacity trigger and existing enrollment
-- paths): the class appointment row FOR UPDATE first, then hold rows, then the
-- client/link/attendee/payment writes. attach/release lock only the hold and
-- never take the appointment lock afterwards, so no lock cycle is introduced.
--
-- IDEMPOTENCY comes from the database, not from payment_provider_events (whose
-- dedupe is not DB-atomic; pre-existing debt, out of scope): one active hold
-- per (appointment, purchaser) by partial unique index; Checkout Session and
-- PaymentIntent ids unique across holds; one payment per hold through the
-- existing payments_studio_client_request_id_key ('gc35_hold:<hold id>');
-- row locks; terminal converted/conflict states returned as stored.

begin;

-- >>> GC-3.5-2 PRECONDITIONS: refuse to run against anything but the reviewed DEV/PROD shape.
do $$
declare
  v_missing text;
begin
  if to_regclass('public.group_class_enrollment_holds') is not null then
    raise exception 'GC-3.5-2: group_class_enrollment_holds already exists';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'start_public_class_purchase', 'attach_public_class_purchase_checkout',
      'finalize_public_class_purchase', 'release_public_class_purchase',
      '_gc352_guard_hold_transition', '_gc352_refuse_committed_converting')
  ) then
    raise exception 'GC-3.5-2: a GC-3.5-2 function already exists';
  end if;

  -- The function this migration replaces: exact reviewed predecessor.
  if (select count(*) from pg_proc where proname = '_group_class_roster_reserved_count') <> 1 then
    raise exception 'GC-3.5-2: unexpected _group_class_roster_reserved_count overloads';
  end if;
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public._group_class_roster_reserved_count(uuid)'::regprocedure
      and p.prosecdef
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prorettype = 'integer'::regtype
      and p.proconfig = array['search_path=public']
      and md5(replace(p.prosrc, E'\r', '')) = '79777b57f07320850cdfb06513169715'
      and (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x) = 'postgres=X/postgres'
  ) then
    raise exception 'GC-3.5-2: _group_class_roster_reserved_count is not the reviewed gc3a/gcsc3 definition';
  end if;

  -- Every caller of the widened count is reviewed: exactly these three.
  select string_agg(p.oid::regprocedure::text || '=' || md5(replace(p.prosrc, E'\r', '')), ';' order by p.oid::regprocedure::text)
    into v_missing
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname <> '_group_class_roster_reserved_count'
      and p.prosrc ilike '%_group_class_roster_reserved_count%';
  if v_missing is distinct from
       'enforce_group_class_capacity_floor()=5113dccb533402311cf2cfbc9e179959;'
    || 'enforce_group_class_roster_capacity()=0fdbc884e11b638613655078026058cf;'
    || 'public_group_class_occurrences(text,uuid,uuid,integer)=6444059e179dd4d4c2d9654121731e6e'
  then
    raise exception 'GC-3.5-2: reserved-count callers drifted: %', v_missing;
  end if;

  -- Functions the new RPCs depend on.
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public.my_verified_email()'::regprocedure and p.prosecdef
      and p.prorettype = 'text'::regtype
      and md5(replace(p.prosrc, E'\r', '')) = 'a819fefde8ed3d54ba8b3627e1fdc928'
  ) then
    raise exception 'GC-3.5-2: my_verified_email is not the reviewed LAUNCH-SEC-1C definition';
  end if;
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public.is_group_class_publicly_discoverable(uuid)'::regprocedure and p.prosecdef
      and md5(replace(p.prosrc, E'\r', '')) = '21bd382849c76fc0b6c5d9f311c4e1db'
  ) then
    raise exception 'GC-3.5-2: is_group_class_publicly_discoverable is not the reviewed gc3e definition';
  end if;
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public.enforce_appointment_attendee_integrity()'::regprocedure
      and md5(replace(p.prosrc, E'\r', '')) = '212fb4b403dc3af3d93f9edecff513c5'
  ) or not exists (
    select 1 from pg_proc p
    where p.oid = 'public._guard_payments_stripe_identity()'::regprocedure
      and md5(replace(p.prosrc, E'\r', '')) = '1a34303f6dac5b73917105d9ddc2cf6e'
  ) then
    raise exception 'GC-3.5-2: attendee integrity / payments Stripe identity guard drifted';
  end if;

  -- Constraints and unique indexes finalize relies on (exact definitions).
  select string_agg(want.name, ', ') into v_missing
  from (values
    ('appointment_attendees', 'appointment_attendees_status_check',
     'CHECK ((status = ANY (ARRAY[''booked''::text, ''cancelled''::text])))'),
    ('appointment_attendees', 'appointment_attendees_source_check',
     'CHECK ((source = ANY (ARRAY[''staff''::text, ''portal''::text, ''self_service''::text, ''booking_request''::text, ''instructor''::text])))'),
    ('appointment_attendees', 'appointment_attendees_billing_type_check',
     'CHECK ((billing_type = ANY (ARRAY[''package_credit''::text, ''membership''::text, ''pay_as_you_go''::text, ''free_comped''::text])))'),
    ('appointment_attendees', 'appointment_attendees_payment_status_check',
     'CHECK ((payment_status = ANY (ARRAY[''unpaid''::text, ''partial''::text, ''paid''::text, ''waived''::text, ''refunded''::text])))'),
    ('client_account_links', 'client_account_links_relationship_check',
     'CHECK ((relationship_type = ANY (ARRAY[''self''::text, ''guardian''::text, ''parent''::text, ''billing_contact''::text, ''dependent_manager''::text, ''dependent''::text])))'),
    ('client_account_links', 'client_account_links_initiated_by_check',
     'CHECK ((initiated_by = ANY (ARRAY[''system''::text, ''legacy_backfill''::text, ''legacy_email_repair''::text, ''studio''::text, ''dancer''::text, ''guardian''::text])))'),
    ('payments', 'payments_stripe_account_id_format',
     'CHECK (((stripe_account_id IS NULL) OR (stripe_account_id ~ ''^acct_[A-Za-z0-9]+$''::text)))')
  ) as want(tbl, name, def)
  where not exists (
    select 1 from pg_constraint c
    where c.conrelid = ('public.' || want.tbl)::regclass
      and c.conname = want.name
      and pg_get_constraintdef(c.oid) = want.def
  );
  if v_missing is not null then
    raise exception 'GC-3.5-2: constraint drift: %', v_missing;
  end if;

  select string_agg(want.name, ', ') into v_missing
  from (values
    ('uq_appointment_attendees_active',
     'CREATE UNIQUE INDEX uq_appointment_attendees_active ON public.appointment_attendees USING btree (appointment_id, client_id) WHERE (status <> ''cancelled''::text)'),
    ('client_account_links_client_user_unique',
     'CREATE UNIQUE INDEX client_account_links_client_user_unique ON public.client_account_links USING btree (client_id, user_id) WHERE (user_id IS NOT NULL)'),
    ('client_account_links_one_linked_self_per_client',
     'CREATE UNIQUE INDEX client_account_links_one_linked_self_per_client ON public.client_account_links USING btree (client_id) WHERE ((status = ''linked''::text) AND (relationship_type = ''self''::text))'),
    ('client_account_links_one_primary_per_user_studio',
     'CREATE UNIQUE INDEX client_account_links_one_primary_per_user_studio ON public.client_account_links USING btree (user_id, studio_id) WHERE ((status = ''linked''::text) AND (is_primary = true))'),
    ('payments_studio_client_request_id_key',
     'CREATE UNIQUE INDEX payments_studio_client_request_id_key ON public.payments USING btree (studio_id, client_request_id) WHERE (client_request_id IS NOT NULL)')
  ) as want(name, def)
  where not exists (
    select 1 from pg_class i where i.relname = want.name and i.relkind = 'i'
      and pg_get_indexdef(i.oid) = want.def
  );
  if v_missing is not null then
    raise exception 'GC-3.5-2: unique index drift: %', v_missing;
  end if;

  -- Columns and enum values the new code writes.
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studios' and column_name = 'stripe_connected_account_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'group_class_enrollment_policies' and column_name = 'direct_payment_amount')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'payment_channel')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'guest_name')
     or not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'client_status' and e.enumlabel = 'active')
     or not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'payment_method' and e.enumlabel = 'card')
     or not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'payment_status' and e.enumlabel = 'paid')
  then
    raise exception 'GC-3.5-2: required column or enum value missing';
  end if;
end $$;
-- <<< GC-3.5-2 PRECONDITIONS

-- ============================================================================
-- 1. HOLDS TABLE
-- ============================================================================
create table public.group_class_enrollment_holds (
  id                          uuid primary key default gen_random_uuid(),
  studio_id                   uuid not null references public.studios(id),
  appointment_id              uuid not null references public.appointments(id),
  -- The authenticated purchaser (auth.uid() at start). Deliberately no FK to
  -- auth.users: the hold is purchase evidence and must survive account deletion.
  purchaser_user_id           uuid not null,
  purchaser_email             text not null,
  dancer_first_name           text not null,
  dancer_last_name            text not null,
  dancer_phone                text,

  status                      text not null default 'held',
  amount_cents                integer not null,
  currency                    text not null default 'usd',
  expires_at                  timestamptz not null,
  conflict_reason             text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  stripe_account_id           text,
  stripe_checkout_session_id  text,
  stripe_payment_intent_id    text,
  attempt_count               integer not null default 0,

  client_id                   uuid references public.clients(id),
  link_id                     uuid references public.client_account_links(id),
  attendee_id                 uuid references public.appointment_attendees(id),
  payment_id                  uuid references public.payments(id),

  constraint group_class_enrollment_holds_status_check
    check (status in ('held', 'converting', 'converted', 'released', 'conflict')),
  constraint group_class_enrollment_holds_amount_positive
    check (amount_cents > 0 and amount_cents <= 10000000),
  constraint group_class_enrollment_holds_currency_usd
    check (currency = 'usd'),
  constraint group_class_enrollment_holds_email_normalized
    check (purchaser_email = lower(btrim(purchaser_email)) and purchaser_email <> ''),
  constraint group_class_enrollment_holds_names_present
    check (char_length(dancer_first_name) between 1 and 100 and char_length(dancer_last_name) between 1 and 100),
  constraint group_class_enrollment_holds_phone_length
    check (dancer_phone is null or char_length(dancer_phone) between 1 and 32),
  constraint group_class_enrollment_holds_stripe_formats
    check ((stripe_account_id is null or stripe_account_id ~ '^acct_[A-Za-z0-9]+$')
       and (stripe_checkout_session_id is null or stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]+$')
       and (stripe_payment_intent_id is null or stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$')),
  constraint group_class_enrollment_holds_session_requires_account
    check (stripe_checkout_session_id is null or stripe_account_id is not null),
  constraint group_class_enrollment_holds_attempts
    check (attempt_count between 0 and 1 and (attempt_count = 1) = (stripe_checkout_session_id is not null)),
  constraint group_class_enrollment_holds_conflict_reason
    check ((status = 'conflict') = (conflict_reason is not null)
       and (conflict_reason is null or conflict_reason in (
         'hold_released', 'hold_expired', 'class_cancelled', 'class_started',
         'class_full', 'already_enrolled', 'linked_relationship_conflict'))),
  -- Result shape per state.
  constraint group_class_enrollment_holds_converted_shape
    check (status <> 'converted' or (
      client_id is not null and link_id is not null and attendee_id is not null and payment_id is not null
      and stripe_checkout_session_id is not null and stripe_payment_intent_id is not null)),
  constraint group_class_enrollment_holds_conflict_shape
    check (status <> 'conflict' or (
      payment_id is not null and stripe_checkout_session_id is not null and stripe_payment_intent_id is not null
      and client_id is null and link_id is null and attendee_id is null)),
  constraint group_class_enrollment_holds_open_shape
    check (status not in ('held', 'released', 'converting') or (
      client_id is null and link_id is null and attendee_id is null and payment_id is null
      and (status = 'converting' or stripe_payment_intent_id is null)))
);

comment on table public.group_class_enrollment_holds is
  'GC-3.5-2: public paid Group Class acquisition hold + purchase record. Writes only through '
  'start/attach/finalize/release_public_class_purchase. A ''held'' row counts toward class '
  'capacity while expires_at > now(). Rows are never deleted (purchase evidence).';

-- One active logical purchase per class and purchaser (no check-then-insert).
create unique index group_class_enrollment_holds_one_active_per_purchaser
  on public.group_class_enrollment_holds (appointment_id, purchaser_user_id)
  where status in ('held', 'converting');
create unique index group_class_enrollment_holds_checkout_session_unique
  on public.group_class_enrollment_holds (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;
create unique index group_class_enrollment_holds_payment_intent_unique
  on public.group_class_enrollment_holds (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
-- Capacity counting: live holds per class.
create index group_class_enrollment_holds_counting_idx
  on public.group_class_enrollment_holds (appointment_id, expires_at)
  where status = 'held';
create index group_class_enrollment_holds_studio_idx
  on public.group_class_enrollment_holds (studio_id, created_at);
create index group_class_enrollment_holds_purchaser_idx
  on public.group_class_enrollment_holds (purchaser_user_id, created_at);

-- ----------------------------------------------------------------------------
-- Transition + immutability guard. Every write already comes from the reviewed
-- SECURITY DEFINER functions; this makes an invalid transition impossible
-- rather than merely unused.
-- ----------------------------------------------------------------------------
create function public._gc352_guard_hold_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status in ('converted', 'conflict') then
    raise exception 'GC35_HOLD_FINAL: a % purchase hold cannot be changed.', old.status;
  end if;

  if new.id is distinct from old.id
     or new.studio_id is distinct from old.studio_id
     or new.appointment_id is distinct from old.appointment_id
     or new.purchaser_user_id is distinct from old.purchaser_user_id
     or new.purchaser_email is distinct from old.purchaser_email
     or new.dancer_first_name is distinct from old.dancer_first_name
     or new.dancer_last_name is distinct from old.dancer_last_name
     or new.dancer_phone is distinct from old.dancer_phone
     or new.amount_cents is distinct from old.amount_cents
     or new.currency is distinct from old.currency
     or new.created_at is distinct from old.created_at
     or (old.stripe_account_id is not null and new.stripe_account_id is distinct from old.stripe_account_id)
     or (old.stripe_checkout_session_id is not null and new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id)
     or (old.stripe_payment_intent_id is not null and new.stripe_payment_intent_id is distinct from old.stripe_payment_intent_id)
  then
    raise exception 'GC35_HOLD_IMMUTABLE: purchase hold identity, price and Stripe ids cannot be changed.';
  end if;

  if new.status is distinct from old.status and not (
       (old.status = 'held' and new.status in ('converting', 'released', 'conflict'))
    or (old.status = 'converting' and new.status = 'converted')
    or (old.status = 'released' and new.status = 'conflict')
  ) then
    raise exception 'GC35_HOLD_TRANSITION: % -> % is not allowed.', old.status, new.status;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public._gc352_guard_hold_transition() from public, anon, authenticated, service_role;

create trigger group_class_enrollment_holds_00_guard_transition
  before update on public.group_class_enrollment_holds
  for each row execute function public._gc352_guard_hold_transition();

-- 'converting' exists only inside finalize's own transaction; never committed.
create function public._gc352_refuse_committed_converting()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from public.group_class_enrollment_holds h
    where h.id = new.id and h.status = 'converting'
  ) then
    raise exception 'GC35_HOLD_CONVERTING_UNCOMMITTABLE: a purchase hold cannot be committed mid-conversion.';
  end if;
  return null;
end;
$$;

revoke all on function public._gc352_refuse_committed_converting() from public, anon, authenticated, service_role;

create constraint trigger group_class_enrollment_holds_01_no_committed_converting
  after insert or update on public.group_class_enrollment_holds
  deferrable initially deferred
  for each row when (new.status = 'converting')
  execute function public._gc352_refuse_committed_converting();

-- ----------------------------------------------------------------------------
-- RLS + grants: read-only for the purchaser's own rows and the studio's broad
-- staff (same staff rule as group_class_enrollment_policies). No INSERT,
-- UPDATE or DELETE privilege or policy for anyone but the table owner (the
-- SECURITY DEFINER functions). service_role may read (server lookups) but not
-- write directly.
-- ----------------------------------------------------------------------------
alter table public.group_class_enrollment_holds enable row level security;

revoke all on table public.group_class_enrollment_holds from public, anon, authenticated, service_role;
grant select on table public.group_class_enrollment_holds to authenticated, service_role;

create policy "group_class_enrollment_holds_purchaser_select" on public.group_class_enrollment_holds
for select
to authenticated
using (purchaser_user_id = auth.uid());

create policy "group_class_enrollment_holds_staff_select" on public.group_class_enrollment_holds
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_class_enrollment_holds.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
);

-- ============================================================================
-- 2. CAPACITY: booked attendees + live public acquisition holds.
--    Same signature, owner, SECURITY DEFINER, search_path and ACL. Callers
--    (roster-capacity trigger, capacity-floor trigger, public read model) take
--    the class row lock / read as before and inherit the widened count.
-- ============================================================================
create or replace function public._group_class_roster_reserved_count(p_appointment_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  select (
    select count(*)::integer
    from public.appointment_attendees
    where appointment_id = p_appointment_id
      and status = 'booked'
  ) + (
    -- GC-3.5-2: a live public purchase hold reserves its seat until it expires.
    select count(*)::integer
    from public.group_class_enrollment_holds
    where appointment_id = p_appointment_id
      and status = 'held'
      and expires_at > now()
  );
$$;

revoke all on function public._group_class_roster_reserved_count(uuid) from public, anon, authenticated, service_role;

-- Capacity floor: WORDING ONLY. Its count now includes live holds, so "students
-- already booked" would be untrue. The machine code GCSC3_CAPACITY_BELOW_BOOKED,
-- the trigger, the comparison and the lock discipline are unchanged; app
-- parsers accept both the old and the new wording.
create or replace function public.enforce_group_class_capacity_floor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved integer;
begin
  -- Only a LOWERING of a limit can strand booked students: clearing the limit or
  -- raising it never can.
  if new.roster_capacity is null
     or (old.roster_capacity is not null and new.roster_capacity >= old.roster_capacity)
  then
    return new;
  end if;

  -- The UPDATE already holds this row's lock; enrollment takes the same lock before
  -- it counts, so the count below cannot race a booking.
  v_reserved := public._group_class_roster_reserved_count(new.id);

  if v_reserved > new.roster_capacity then
    raise exception 'GCSC3_CAPACITY_BELOW_BOOKED: Maximum students cannot be lower than the % seats already booked or reserved.', v_reserved;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_group_class_capacity_floor() from public, anon, authenticated, service_role;

-- ============================================================================
-- 3. START (authenticated purchaser)
--
-- Derives user, verified email, studio, policy and price on the server; takes
-- only the class id and the dancer's name/phone. Reuse: a live held hold for
-- the same class and user is returned UNCHANGED (same id, same expiry, same
-- price and name snapshot) -- repeated calls never extend it, and later policy
-- or price changes do not invalidate it (only class cancellation does). An
-- expired hold is marked 'released' and replaced, unless it has a Checkout
-- attached and is still inside the reconciliation grace (a payment may still
-- settle): then GC35_PAYMENT_PENDING.
-- ============================================================================
create function public.start_public_class_purchase(
  p_appointment_id uuid,
  p_first_name text,
  p_last_name text,
  p_phone text default null
)
returns table (
  hold_id uuid,
  hold_status text,
  amount_cents integer,
  currency text,
  expires_at timestamptz,
  stripe_checkout_session_id text,
  dancer_first_name text,
  dancer_last_name text,
  reused boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  c_hold_duration constant interval := interval '30 minutes';
  c_checkout_cutoff constant interval := interval '30 minutes';
  c_grace constant interval := interval '10 minutes';
  v_user_id uuid := auth.uid();
  v_email text;
  v_first text := nullif(regexp_replace(btrim(coalesce(p_first_name, '')), '\s+', ' ', 'g'), '');
  v_last text := nullif(regexp_replace(btrim(coalesce(p_last_name, '')), '\s+', ' ', 'g'), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_class record;
  v_policy record;
  v_account text;
  v_cents numeric;
  v_existing public.group_class_enrollment_holds%rowtype;
  v_reserved integer;
  v_new public.group_class_enrollment_holds%rowtype;
begin
  if v_user_id is null then
    raise exception 'GC35_AUTH_REQUIRED: Sign in to register for this class.';
  end if;

  v_email := lower(btrim(coalesce(public.my_verified_email(), '')));
  if v_email = '' then
    raise exception 'GC35_EMAIL_UNVERIFIED: Verify your email address to register for this class.';
  end if;

  -- Lock the class row first (the roster-capacity trigger's lock): serializes
  -- holds against each other and against every enrollment path.
  select a.id, a.studio_id, a.appointment_type, a.status, a.starts_at, a.roster_capacity
    into v_class
    from public.appointments a
    where a.id = p_appointment_id
    for update;

  if v_class.id is null
     or v_class.appointment_type is distinct from 'group_class'::public.appointment_type then
    raise exception 'GC35_CLASS_UNAVAILABLE: This class is not available for registration.';
  end if;

  -- Existing active hold for this class and purchaser.
  select h.* into v_existing
    from public.group_class_enrollment_holds h
    where h.appointment_id = p_appointment_id
      and h.purchaser_user_id = v_user_id
      and h.status in ('held', 'converting')
    for update;

  -- REUSE (locked product decision): a live hold is a temporary offer at its
  -- snapshotted price. Later policy, price, discoverability or relationship
  -- changes do not invalidate it; only class cancellation (authoritative) does.
  -- It is returned unchanged: same id, expiry, price and name snapshot.
  if v_existing.id is not null and v_existing.status = 'held' and v_existing.expires_at > now() then
    if v_class.status = 'cancelled'::public.appointment_status then
      raise exception 'GC35_CLASS_CANCELLED: This class has been cancelled.';
    end if;
    return query select v_existing.id, v_existing.status, v_existing.amount_cents, v_existing.currency,
      v_existing.expires_at, v_existing.stripe_checkout_session_id,
      v_existing.dancer_first_name, v_existing.dancer_last_name, true;
    return;
  end if;

  -- NEW HOLD: every eligibility rule is evaluated live, now.
  -- Not found, not a group class and not publicly discoverable are one answer:
  -- no existence signal for non-public classes.
  if not public.is_group_class_publicly_discoverable(p_appointment_id) then
    raise exception 'GC35_CLASS_UNAVAILABLE: This class is not available for registration.';
  end if;

  if v_class.status = 'cancelled'::public.appointment_status then
    raise exception 'GC35_CLASS_CANCELLED: This class has been cancelled.';
  end if;

  if v_class.starts_at is null or v_class.starts_at <= now() + c_checkout_cutoff then
    raise exception 'GC35_CHECKOUT_CUTOFF: Online registration for this class has closed.';
  end if;

  select gcep.self_enrollment_allowed, gcep.accepted_funding_types, gcep.direct_payment_amount
    into v_policy
    from public.group_class_enrollment_policies gcep
    where gcep.appointment_id = p_appointment_id
      and gcep.studio_id = v_class.studio_id;

  if v_policy.self_enrollment_allowed is not true then
    raise exception 'GC35_SELF_ENROLLMENT_CLOSED: This class is not open for registration.';
  end if;

  select s.stripe_connected_account_id into v_account
    from public.studios s where s.id = v_class.studio_id;

  -- USD only (D7); the price must be a positive whole number of cents.
  v_cents := v_policy.direct_payment_amount * 100;
  if not ('direct_payment' = any (coalesce(v_policy.accepted_funding_types, array[]::text[])))
     or v_cents is null or v_cents <= 0 or v_cents <> trunc(v_cents) or v_cents > 10000000
     or v_account is null then
    raise exception 'GC35_DIRECT_PAYMENT_UNAVAILABLE: Online payment is not available for this class.';
  end if;

  -- Public Discovery is for people NOT yet linked to this studio. Any linked
  -- relationship (self or managing someone else) uses the Student Portal.
  -- Never an email match against clients.
  if exists (
    select 1 from public.client_account_links cal
    where cal.user_id = v_user_id
      and cal.studio_id = v_class.studio_id
      and cal.status = 'linked'
  ) then
    raise exception 'GC35_ALREADY_LINKED: You''re already connected to this studio. Join this class from your Student Portal.';
  end if;

  if v_first is null or v_last is null
     or char_length(v_first) > 100 or char_length(v_last) > 100
     or v_first ~ '[[:cntrl:]]' or v_last ~ '[[:cntrl:]]' then
    raise exception 'GC35_NAME_INVALID: Enter the dancer''s first and last name.';
  end if;

  if v_phone is not null and (
       char_length(v_phone) > 32
       or v_phone !~ '^[0-9+(). -]+$'
       or char_length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 7 and 15
     ) then
    raise exception 'GC35_PHONE_INVALID: Enter a valid phone number or leave it blank.';
  end if;

  -- EXPIRED HOLD (effective state: status 'held' with expires_at <= now()). It
  -- no longer counts, but it still occupies the one-active partial unique index
  -- (status in held/converting), so it is moved to 'released' in this same
  -- transaction, under the class row lock and its own row lock, before the
  -- replacement insert. Exception: a Checkout is attached and the reconciliation
  -- grace has not passed -- a payment may still settle, so no replacement yet.
  if v_existing.id is not null then
    if v_existing.stripe_checkout_session_id is not null and now() <= v_existing.expires_at + c_grace then
      raise exception 'GC35_PAYMENT_PENDING: Your previous payment is still being confirmed. Try again in a few minutes.';
    end if;

    update public.group_class_enrollment_holds h
      set status = 'released'
      where h.id = v_existing.id;
  end if;

  -- Capacity, including every other live hold (the class row is locked).
  if v_class.roster_capacity is not null then
    v_reserved := public._group_class_roster_reserved_count(p_appointment_id);
    if v_reserved >= v_class.roster_capacity then
      raise exception 'GC35_CLASS_FULL: This class is full.';
    end if;
  end if;

  insert into public.group_class_enrollment_holds (
    studio_id, appointment_id, purchaser_user_id, purchaser_email,
    dancer_first_name, dancer_last_name, dancer_phone,
    status, amount_cents, currency, expires_at
  ) values (
    v_class.studio_id, p_appointment_id, v_user_id, v_email,
    v_first, v_last, v_phone,
    'held', v_cents::integer, 'usd', now() + c_hold_duration
  )
  returning * into v_new;

  return query select v_new.id, v_new.status, v_new.amount_cents, v_new.currency,
    v_new.expires_at, v_new.stripe_checkout_session_id,
    v_new.dancer_first_name, v_new.dancer_last_name, false;
end;
$$;

revoke all on function public.start_public_class_purchase(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.start_public_class_purchase(uuid, text, text, text) to authenticated;

-- ============================================================================
-- 4. ATTACH CHECKOUT (service_role only)
--
-- Records the ONE Checkout Session for a live hold, on the studio's own
-- connected account. Re-attaching the same session is an idempotent no-op; a
-- different session is refused while one is attached (a new checkout attempt
-- needs a new hold: release or let this one expire). The hold's expiry is
-- aligned with the Checkout Session's expiry (Stripe sessions last >= 30
-- minutes from creation), bounded by class start and a 35-minute ceiling.
-- ============================================================================
create function public.attach_public_class_purchase_checkout(
  p_hold_id uuid,
  p_stripe_account_id text,
  p_checkout_session_id text,
  p_checkout_expires_at timestamptz
)
returns table (
  hold_id uuid,
  hold_status text,
  amount_cents integer,
  currency text,
  expires_at timestamptz,
  stripe_checkout_session_id text,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  c_checkout_cutoff constant interval := interval '30 minutes';
  c_max_checkout_window constant interval := interval '35 minutes';
  v_hold public.group_class_enrollment_holds%rowtype;
  v_account text;
  v_starts_at timestamptz;
  v_class_status public.appointment_status;
begin
  if p_hold_id is null or p_checkout_expires_at is null
     or coalesce(p_stripe_account_id, '') !~ '^acct_[A-Za-z0-9]+$'
     or coalesce(p_checkout_session_id, '') !~ '^cs_[A-Za-z0-9_]+$' then
    raise exception 'GC35_INPUT_INVALID: Invalid checkout details.';
  end if;

  select h.* into v_hold
    from public.group_class_enrollment_holds h
    where h.id = p_hold_id
    for update;

  if v_hold.id is null then
    raise exception 'GC35_HOLD_NOT_FOUND: Purchase hold not found.';
  end if;

  select s.stripe_connected_account_id into v_account
    from public.studios s where s.id = v_hold.studio_id;

  if v_account is null or v_account <> p_stripe_account_id then
    raise exception 'GC35_ACCOUNT_MISMATCH: Checkout account does not match the studio.';
  end if;

  -- Idempotent re-attach of the same session (no change, no extra attempt).
  if v_hold.stripe_checkout_session_id is not null then
    if v_hold.stripe_checkout_session_id <> p_checkout_session_id then
      raise exception 'GC35_CHECKOUT_ALREADY_ATTACHED: This hold already has a checkout.';
    end if;
    if v_hold.status <> 'held' then
      raise exception 'GC35_HOLD_NOT_ACTIVE: This purchase hold is no longer active.';
    end if;
    return query select v_hold.id, v_hold.status, v_hold.amount_cents, v_hold.currency,
      v_hold.expires_at, v_hold.stripe_checkout_session_id, v_hold.attempt_count;
    return;
  end if;

  if v_hold.status <> 'held' then
    raise exception 'GC35_HOLD_NOT_ACTIVE: This purchase hold is no longer active.';
  end if;
  if v_hold.expires_at <= now() then
    raise exception 'GC35_HOLD_EXPIRED: This purchase hold has expired.';
  end if;

  select a.starts_at, a.status into v_starts_at, v_class_status
    from public.appointments a where a.id = v_hold.appointment_id;
  if v_class_status = 'cancelled'::public.appointment_status then
    raise exception 'GC35_CLASS_CANCELLED: This class has been cancelled.';
  end if;
  if v_starts_at is null or v_starts_at <= now() + c_checkout_cutoff then
    raise exception 'GC35_CHECKOUT_CUTOFF: Online registration for this class has closed.';
  end if;

  if p_checkout_expires_at <= now()
     or p_checkout_expires_at > now() + c_max_checkout_window
     or p_checkout_expires_at > v_starts_at then
    raise exception 'GC35_CHECKOUT_EXPIRY_INVALID: Checkout expiry is outside the allowed window.';
  end if;

  begin
    update public.group_class_enrollment_holds h
      set stripe_account_id = p_stripe_account_id,
          stripe_checkout_session_id = p_checkout_session_id,
          attempt_count = h.attempt_count + 1,
          expires_at = greatest(h.expires_at, p_checkout_expires_at)
      where h.id = p_hold_id
      returning h.* into v_hold;
  exception when unique_violation then
    raise exception 'GC35_SESSION_IN_USE: This checkout session belongs to another purchase.';
  end;

  return query select v_hold.id, v_hold.status, v_hold.amount_cents, v_hold.currency,
    v_hold.expires_at, v_hold.stripe_checkout_session_id, v_hold.attempt_count;
end;
$$;

revoke all on function public.attach_public_class_purchase_checkout(uuid, text, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.attach_public_class_purchase_checkout(uuid, text, text, timestamptz) to service_role;

-- ============================================================================
-- 5. FINALIZE (service_role only) -- the authoritative paid-acquisition write.
--
-- Inputs come from a verified webhook but are still checked against the
-- stored hold: account, Checkout Session, amount (integer cents) and currency
-- must match exactly, else an error and NO write. Lock order: class row, hold.
--
-- Outcomes:
--   converted -- client (new, or the purchaser's own self link acquired while
--                paying), link, paid attendee, payment; hold converted.
--   conflict  -- paid but not finalizable: truthful paid payment row (no
--                client), hold conflict + reason; no client, link or attendee.
--                The application refunds (never from SQL).
-- Repeated calls return the stored outcome; nothing is created twice.
--
-- PAYMENTINTENT BINDING CONTRACT. The Checkout Session (and its account) is
-- bound at attach. The PaymentIntent is NOT known until payment, so it is bound
-- here, exactly once, by the FIRST finalize whose account, session, amount and
-- currency all match the stored hold (checked before any write). It is written
-- in the same statement that moves the hold out of 'held' ('converting', or
-- 'conflict'), so it can never exist on a hold without a settled outcome; any
-- failure rolls the whole call back and leaves no PaymentIntent behind. Replays
-- must present the same PaymentIntent (GC35_PAYMENT_INTENT_MISMATCH otherwise);
-- a PaymentIntent already bound to another hold is refused by the unique index
-- (GC35_PAYMENT_INTENT_IN_USE). The caller is the server's verified Stripe
-- webhook (connected-account scoped); a browser-supplied value is never used.
-- ============================================================================
create function public.finalize_public_class_purchase(
  p_hold_id uuid,
  p_stripe_account_id text,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_amount_cents integer,
  p_currency text
)
returns table (
  outcome text,
  hold_id uuid,
  client_id uuid,
  link_id uuid,
  attendee_id uuid,
  payment_id uuid,
  conflict_reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  c_grace constant interval := interval '10 minutes';
  v_appointment_id uuid;
  v_class record;
  v_hold public.group_class_enrollment_holds%rowtype;
  v_reason text;
  v_link record;
  v_link_count integer;
  v_client_id uuid;
  v_link_id uuid;
  v_attendee_id uuid;
  v_payment_id uuid;
  v_amount numeric;
  v_constraint text;
begin
  if p_hold_id is null or p_amount_cents is null
     or coalesce(p_stripe_account_id, '') !~ '^acct_[A-Za-z0-9]+$'
     or coalesce(p_checkout_session_id, '') !~ '^cs_[A-Za-z0-9_]+$'
     or coalesce(p_payment_intent_id, '') !~ '^pi_[A-Za-z0-9_]+$' then
    raise exception 'GC35_INPUT_INVALID: Invalid payment details.';
  end if;

  -- Lock order: the class row first, then the hold.
  select h.appointment_id into v_appointment_id
    from public.group_class_enrollment_holds h where h.id = p_hold_id;
  if v_appointment_id is null then
    raise exception 'GC35_HOLD_NOT_FOUND: Purchase hold not found.';
  end if;

  select a.id, a.studio_id, a.status, a.starts_at
    into v_class
    from public.appointments a
    where a.id = v_appointment_id
    for update;

  select h.* into v_hold
    from public.group_class_enrollment_holds h
    where h.id = p_hold_id
    for update;

  -- Exact match against stored authority.
  if v_hold.stripe_account_id is null or v_hold.stripe_account_id <> p_stripe_account_id then
    raise exception 'GC35_ACCOUNT_MISMATCH: Payment account does not match this purchase.';
  end if;
  if v_hold.stripe_checkout_session_id is null or v_hold.stripe_checkout_session_id <> p_checkout_session_id then
    raise exception 'GC35_SESSION_MISMATCH: Checkout session does not match this purchase.';
  end if;
  if p_amount_cents <> v_hold.amount_cents then
    raise exception 'GC35_AMOUNT_MISMATCH: Paid amount does not match this purchase.';
  end if;
  if lower(coalesce(p_currency, '')) <> v_hold.currency then
    raise exception 'GC35_CURRENCY_MISMATCH: Paid currency does not match this purchase.';
  end if;
  if v_hold.stripe_payment_intent_id is not null and v_hold.stripe_payment_intent_id <> p_payment_intent_id then
    raise exception 'GC35_PAYMENT_INTENT_MISMATCH: Payment does not match this purchase.';
  end if;

  -- Idempotent replay of a settled outcome.
  if v_hold.status in ('converted', 'conflict') then
    return query select v_hold.status, v_hold.id, v_hold.client_id, v_hold.link_id,
      v_hold.attendee_id, v_hold.payment_id, v_hold.conflict_reason;
    return;
  end if;

  v_amount := round(v_hold.amount_cents::numeric / 100, 2);

  -- Finalizability (D2/D3/D5). Order: released, cancelled, started, expired.
  if v_hold.status = 'released' then
    v_reason := 'hold_released';
  elsif v_class.status = 'cancelled'::public.appointment_status then
    v_reason := 'class_cancelled';
  elsif v_class.starts_at is null or v_class.starts_at <= now() then
    v_reason := 'class_started';
  elsif now() > v_hold.expires_at + c_grace then
    v_reason := 'hold_expired';
  end if;

  -- Relationship acquired while paying: exactly one linked self link with
  -- booking rights (and nothing else linked at this studio) is reused; any
  -- other linked state is a conflict. Never an email match.
  if v_reason is null then
    select count(*) into v_link_count
      from public.client_account_links cal
      where cal.user_id = v_hold.purchaser_user_id
        and cal.studio_id = v_hold.studio_id
        and cal.status = 'linked';

    if v_link_count = 1 then
      select cal.id, cal.client_id, cal.relationship_type, cal.can_manage_bookings
        into v_link
        from public.client_account_links cal
        where cal.user_id = v_hold.purchaser_user_id
          and cal.studio_id = v_hold.studio_id
          and cal.status = 'linked'
        for update;

      if v_link.relationship_type = 'self' and v_link.can_manage_bookings then
        v_client_id := v_link.client_id;
        v_link_id := v_link.id;
        if exists (
          select 1 from public.appointment_attendees aa
          where aa.appointment_id = v_hold.appointment_id
            and aa.client_id = v_client_id
            and aa.status <> 'cancelled'
        ) then
          v_reason := 'already_enrolled';
        end if;
      else
        v_reason := 'linked_relationship_conflict';
      end if;
    elsif v_link_count > 1 then
      v_reason := 'linked_relationship_conflict';
    end if;
  end if;

  if v_reason is null then
    begin
      -- The hold stops counting before the attendee insert so the roster
      -- trigger (which locks the same class row, already held here) never
      -- counts this seat twice.
      update public.group_class_enrollment_holds h
        set status = 'converting', stripe_payment_intent_id = p_payment_intent_id
        where h.id = v_hold.id;

      if v_client_id is null then
        insert into public.clients (
          studio_id, first_name, last_name, email, phone, status, referral_source, created_by
        ) values (
          v_hold.studio_id, v_hold.dancer_first_name, v_hold.dancer_last_name,
          v_hold.purchaser_email, v_hold.dancer_phone, 'active'::public.client_status,
          'Public class registration', v_hold.purchaser_user_id
        )
        returning id into v_client_id;

        insert into public.client_account_links (
          studio_id, client_id, user_id, status, relationship_type, initiated_by,
          linked_at, claimed_at, can_manage_bookings, is_primary
        ) values (
          v_hold.studio_id, v_client_id, v_hold.purchaser_user_id, 'linked', 'self', 'dancer',
          now(), now(), true, true
        )
        returning id into v_link_id;
      end if;

      insert into public.appointment_attendees (
        studio_id, appointment_id, client_id, status, source,
        billing_type, payment_status, price_amount, created_by
      ) values (
        v_hold.studio_id, v_hold.appointment_id, v_client_id, 'booked', 'self_service',
        'pay_as_you_go', 'paid', v_amount, v_hold.purchaser_user_id
      )
      returning id into v_attendee_id;

      insert into public.payments (
        studio_id, client_id, appointment_id, amount, currency, payment_method, status, paid_at,
        source, payment_channel, payment_type, accounting_category, notes,
        stripe_account_id, stripe_checkout_session_id, stripe_payment_intent_id,
        external_reference, client_request_id
      ) values (
        v_hold.studio_id, v_client_id, v_hold.appointment_id, v_amount, 'usd', 'card', 'paid', now(),
        'stripe', 'online', 'group_class_direct_payment', 'group_class_revenue',
        'Group class registration paid online.',
        v_hold.stripe_account_id, v_hold.stripe_checkout_session_id, p_payment_intent_id,
        v_attendee_id::text, 'gc35_hold:' || v_hold.id::text
      )
      returning id into v_payment_id;

      update public.group_class_enrollment_holds h
        set status = 'converted',
            client_id = v_client_id,
            link_id = v_link_id,
            attendee_id = v_attendee_id,
            payment_id = v_payment_id
        where h.id = v_hold.id;

      return query select 'converted'::text, v_hold.id, v_client_id, v_link_id,
        v_attendee_id, v_payment_id, null::text;
      return;
    exception
      when unique_violation then
        -- Rolled back to before 'converting': no client, link or attendee.
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint = 'uq_appointment_attendees_active' then
          v_reason := 'already_enrolled';
        elsif v_constraint in ('client_account_links_one_primary_per_user_studio',
                               'client_account_links_client_user_unique') then
          v_reason := 'linked_relationship_conflict';
        elsif v_constraint = 'group_class_enrollment_holds_payment_intent_unique' then
          raise exception 'GC35_PAYMENT_INTENT_IN_USE: This payment belongs to another purchase.';
        else
          raise;
        end if;
      when others then
        -- Only the roster trigger's own capacity / cancelled refusals become a
        -- conflict; anything else is a real fault and propagates.
        if sqlerrm = 'This class has no available seats remaining.' then
          v_reason := 'class_full';
        elsif sqlerrm like 'GCSC3_CLASS_CANCELLED:%' then
          v_reason := 'class_cancelled';
        else
          raise;
        end if;
    end;
  end if;

  -- Conflict: truthful paid accounting evidence, no client, link or attendee.
  begin
    insert into public.payments (
      studio_id, client_id, appointment_id, amount, currency, payment_method, status, paid_at,
      source, payment_channel, payment_type, accounting_category, notes, guest_name,
      stripe_account_id, stripe_checkout_session_id, stripe_payment_intent_id,
      client_request_id
    ) values (
      v_hold.studio_id, null, v_hold.appointment_id, v_amount, 'usd', 'card', 'paid', now(),
      'stripe', 'online', 'group_class_direct_payment', 'group_class_revenue',
      'Group class online payment could not be applied (' || v_reason || '); refund pending.',
      v_hold.dancer_first_name || ' ' || v_hold.dancer_last_name,
      v_hold.stripe_account_id, v_hold.stripe_checkout_session_id, p_payment_intent_id,
      'gc35_hold:' || v_hold.id::text
    )
    returning id into v_payment_id;

    update public.group_class_enrollment_holds h
      set status = 'conflict',
          conflict_reason = v_reason,
          stripe_payment_intent_id = p_payment_intent_id,
          payment_id = v_payment_id
      where h.id = v_hold.id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'group_class_enrollment_holds_payment_intent_unique' then
      raise exception 'GC35_PAYMENT_INTENT_IN_USE: This payment belongs to another purchase.';
    end if;
    raise;
  end;

  return query select 'conflict'::text, v_hold.id, null::uuid, null::uuid,
    null::uuid, v_payment_id, v_reason;
end;
$$;

revoke all on function public.finalize_public_class_purchase(uuid, text, text, text, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.finalize_public_class_purchase(uuid, text, text, text, integer, text) to service_role;

-- ============================================================================
-- 6. RELEASE (authenticated purchaser, own hold only)
--
-- held -> released (stops counting immediately); released again is a no-op;
-- converted / conflict are refused. Another user's hold is "not found".
-- Rows are kept as history.
-- ============================================================================
create function public.release_public_class_purchase(p_hold_id uuid)
returns table (hold_id uuid, hold_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_hold public.group_class_enrollment_holds%rowtype;
begin
  if v_user_id is null then
    raise exception 'GC35_AUTH_REQUIRED: Sign in to manage this registration.';
  end if;

  select h.* into v_hold
    from public.group_class_enrollment_holds h
    where h.id = p_hold_id
      and h.purchaser_user_id = v_user_id
    for update;

  if v_hold.id is null then
    raise exception 'GC35_HOLD_NOT_FOUND: Purchase hold not found.';
  end if;

  if v_hold.status = 'released' then
    return query select v_hold.id, v_hold.status;
    return;
  end if;

  if v_hold.status <> 'held' then
    raise exception 'GC35_HOLD_NOT_RELEASABLE: This registration can no longer be cancelled here.';
  end if;

  update public.group_class_enrollment_holds h
    set status = 'released'
    where h.id = v_hold.id;

  return query select v_hold.id, 'released'::text;
end;
$$;

revoke all on function public.release_public_class_purchase(uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_public_class_purchase(uuid) to authenticated;

commit;
