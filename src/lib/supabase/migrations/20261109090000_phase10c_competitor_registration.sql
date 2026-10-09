-- 20261109090000_phase10c_competitor_registration.sql
--
-- PHASE 10 -- 10C: Competitors + Transactional Registration (REGISTER -> PAY).
--
-- PERSON != COMPETITOR != ENTRY. A PERSON is an existing DanceFlow identity (auth user / dancer
-- profile, studio client, instructor) or a guest with no account. A COMPETITOR is one human at
-- one competition event. An ENTRY is one competitor, or a set of competitors, in one division.
--
--   1. event_competition_competitors: one row per human per event. Optional trusted anchors
--      (user_id, client_id, instructor_id), each unique per event, so an anchored human is
--      exactly one competitor per event however many entries they dance. Guests carry only
--      the minimum Competition OS needs (name, optional contact email, optional date of birth,
--      external ids, primary role) and are NEVER merged by name or email. Client/instructor
--      anchors must belong to the event's own studio. Anchors are set only by trusted
--      database code and never change once set.
--   2. event_competition_entry_participants.competitor_id (NOT NULL, composite event FK). A
--      BEFORE trigger resolves legacy/staff inserts (client / instructor / guest) to the
--      canonical competitor and keeps the participant's client/instructor columns equal to the
--      competitor's anchors. One competitor appears at most once per entry. Couples, ProAm
--      pairs, Jack & Jill role entries and team rosters are entry-local: there is no global
--      partnership entity.
--   3. Registration lifecycle: event_competition_programs.registration_status
--      ('closed' | 'open'), written only by open_/close_competition_registration. Publishing
--      (10B) no longer makes anything publicly readable: every public registration-catalog
--      policy now requires competition_registration_program_open() -- event published, public
--      or unlisted, registration required, inside the event registration window, program
--      configured/active, published profile locked, registration_status = 'open' -- plus
--      the row's own open/active state. Fee rules are visible only inside their date window.
--   4. Transactional registration: start_competition_registration (service role; the public
--      route passes the server-verified actor) validates EVERYTHING and creates the whole
--      registration graph -- cart snapshot, competitors, entries, participants, dances, order,
--      order items, registration, registration items, attendees, price snapshot -- in ONE
--      transaction, idempotent per (event, client_request_id). The authoritative price is
--      computed here (_comp10c_quote) from the registrable catalog and the fee rules whose
--      window contains the database's now(). prepare / attach / finalize / release complete
--      the payment lifecycle on the existing event commerce rows (event_orders,
--      event_order_items, event_registrations, event_payments, Stripe Connect direct charge).
--   5. Signing: required event documents go through the Phase 8 event_signing_checkpoints
--      workflow. prepare and finalize refuse an order whose required documents are not signed.
--   6. Payment idempotency: event_payments gains partial unique indexes on
--      (registration_id, stripe_checkout_session_id) and (registration_id,
--      stripe_payment_intent_id) so a webhook retry or a concurrent delivery can never create
--      a second payment row.
--   7. Accounting: competition entry revenue posts to the new category
--      competition_entry_revenue on the existing event-payment ledger trigger, classified from
--      the order's own items; ordinary event tickets stay event_ticket_revenue. Orders are kept
--      homogeneous (a trigger refuses mixing competition and ordinary items in one order) because
--      the ledger holds exactly one row per event payment, so no payment is ever mis-split or
--      double counted.
--
-- Out of scope (bounded follow-ups): per-entry / partial refunds, refund accounting entries,
-- order-level refund reconciliation, division capacity, persistent partnerships, random
-- pairing, heats, scoring. The public NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED flag is not
-- touched.

begin;

-- ---------------------------------------------------------------------------
-- Preflight: 10B present, 10C absent, replaced bodies are the reviewed ones
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.event_competition_program_locks') is null then
    raise exception 'Phase 10C preflight: Phase 10B must be applied first.';
  end if;
  if to_regclass('public.event_competition_competitors') is not null then
    raise exception 'Phase 10C preflight: event_competition_competitors already exists.';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and ((table_name = 'event_competition_programs' and column_name = 'registration_status')
        or (table_name = 'event_competition_entry_participants' and column_name = 'competitor_id')
        or (table_name = 'event_competition_entries' and column_name = 'order_item_id')
        or (table_name = 'event_competition_registration_carts' and column_name = 'client_request_id'))
  ) then
    raise exception 'Phase 10C preflight: a 10C column already exists.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like '\_comp10c\_%' or p.proname in (
      'competition_registration_program_open', 'competition_registration_event_open',
      'start_competition_registration', 'prepare_competition_registration_payment',
      'attach_competition_registration_checkout', 'finalize_competition_registration',
      'release_competition_registration', 'quote_competition_registration',
      'open_competition_registration', 'close_competition_registration',
      'competition_contest_registrable', 'competition_division_registrable', 'competition_offering_registrable'))
  ) then
    raise exception 'Phase 10C preflight: a 10C function already exists.';
  end if;
  -- Replaced bodies must be exactly the reviewed (10A / accounting hardening / bridge) definitions.
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.sync_event_payment_accounting_entry()'::regprocedure)
       is distinct from '46b3b768b1a11984588f8cac38e64a67' then
    raise exception 'Phase 10C preflight: sync_event_payment_accounting_entry is not the reviewed definition.';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.validate_competition_entry_registration_links()'::regprocedure)
       is distinct from 'ed6183835a3166d8d9967a799c1f5054' then
    raise exception 'Phase 10C preflight: validate_competition_entry_registration_links is not the reviewed definition.';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.sync_competition_entries_from_registration()'::regprocedure)
       is distinct from 'fabd4052257f261e300ccc1f191c4cdb' then
    raise exception 'Phase 10C preflight: sync_competition_entries_from_registration is not the reviewed 10A definition.';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.verified_email_for_user(uuid)'::regprocedure)
       is distinct from 'fe54123fd771584d1fc25a682cf57ee5' then
    raise exception 'Phase 10C preflight: verified_email_for_user is not the reviewed LAUNCH-SEC-1C definition.';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and policyname in (
        'competition_programs_public_registration_read', 'competition_registration_rules_public_read',
        'competition_fee_rules_public_read', 'competition_contests_public_registration_read',
        'competition_divisions_public_registration_read', 'competition_dances_public_registration_read',
        'competition_division_dances_public_registration_read')) <> 7 then
    raise exception 'Phase 10C preflight: the seven public registration-catalog policies are not the reviewed set.';
  end if;
  if exists (select 1 from public.accounting_categories where key = 'competition_entry_revenue') then
    raise exception 'Phase 10C preflight: competition_entry_revenue already exists.';
  end if;
  if exists (
    select 1 from public.event_order_items oi
    group by oi.order_id
    having count(distinct (oi.item_type = 'competition_entry' or coalesce(oi.metadata->>'revenue_class', '') = 'competition_entry')) > 1
  ) then
    raise exception 'Phase 10C preflight: an existing order mixes competition and ordinary items.';
  end if;
  -- The new payment uniqueness must not be violated by existing evidence.
  if exists (
    select 1 from public.event_payments where stripe_checkout_session_id is not null
    group by registration_id, stripe_checkout_session_id having count(*) > 1
  ) or exists (
    select 1 from public.event_payments where stripe_payment_intent_id is not null
    group by registration_id, stripe_payment_intent_id having count(*) > 1
  ) then
    raise exception 'Phase 10C preflight: duplicate event_payments rows exist; reconcile before applying.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Accounting category
-- ---------------------------------------------------------------------------
insert into public.accounting_categories (
  key, label, entry_class, statement_section, normal_direction,
  allowed_external_account_types, blocks_auto_post_when_unmapped
) values (
  'competition_entry_revenue', 'Competition Entry Revenue', 'revenue', 'income', 'credit',
  array['INCOME', 'REVENUE', 'LIABILITY'], true
);

-- ---------------------------------------------------------------------------
-- 2. Competitors
-- ---------------------------------------------------------------------------
create table public.event_competition_competitors (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  instructor_id uuid references public.instructors(id) on delete set null,
  first_name text not null,
  last_name text not null default '',
  email text,
  date_of_birth date,
  primary_role text,
  external_ids jsonb not null default '{}'::jsonb,
  bib_number text,
  created_via text not null default 'registration',
  created_order_id uuid references public.event_orders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_competitors_name_check
    check (length(btrim(first_name)) between 1 and 100 and length(last_name) <= 100),
  constraint event_competition_competitors_email_check
    check (email is null or (length(email) <= 254 and position('@' in email) > 1)),
  constraint event_competition_competitors_role_check
    check (primary_role is null or primary_role in ('leader', 'follower')),
  constraint event_competition_competitors_external_ids_check
    check (jsonb_typeof(external_ids) = 'object'),
  constraint event_competition_competitors_bib_check
    check (bib_number is null or length(btrim(bib_number)) between 1 and 20),
  constraint event_competition_competitors_created_via_check
    check (created_via in ('registration', 'staff', 'backfill')),
  unique (id, event_id)
);

comment on table public.event_competition_competitors is
  'Phase 10C: one human at one competition event (PERSON != COMPETITOR != ENTRY). Anchors (user/client/instructor) are optional, unique per event and immutable once set; guests are never merged by name or email. Holds only what Competition OS needs; the PERSON record stays canonical in profiles/clients/instructors.';

create unique index event_competition_competitors_event_user_uidx
  on public.event_competition_competitors(event_id, user_id) where user_id is not null;
create unique index event_competition_competitors_event_client_uidx
  on public.event_competition_competitors(event_id, client_id) where client_id is not null;
create unique index event_competition_competitors_event_instructor_uidx
  on public.event_competition_competitors(event_id, instructor_id) where instructor_id is not null;
create unique index event_competition_competitors_event_bib_uidx
  on public.event_competition_competitors(event_id, upper(btrim(bib_number))) where bib_number is not null;
create index event_competition_competitors_studio_idx
  on public.event_competition_competitors(studio_id, event_id);
create index event_competition_competitors_created_order_idx
  on public.event_competition_competitors(created_order_id) where created_order_id is not null;

create or replace function public._comp10c_competitor_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_studio uuid;
begin
  if tg_op = 'UPDATE' then
    if new.event_id is distinct from old.event_id then
      raise exception 'COMP10C_COMPETITOR_EVENT_IMMUTABLE: a competitor cannot move to another event.' using errcode = '42501';
    end if;
    if (old.user_id is not null and new.user_id is distinct from old.user_id)
       or (old.client_id is not null and new.client_id is distinct from old.client_id)
       or (old.instructor_id is not null and new.instructor_id is distinct from old.instructor_id) then
      raise exception 'COMP10C_ANCHOR_IMMUTABLE: competitor identity anchors cannot change once set.' using errcode = '42501';
    end if;
  end if;

  select e.studio_id into v_studio from public.events e where e.id = new.event_id;
  if v_studio is null then
    raise exception 'COMP10C_EVENT_NOT_FOUND: competitor event was not found.';
  end if;
  new.studio_id := v_studio;

  if new.client_id is not null and not exists (
    select 1 from public.clients c where c.id = new.client_id and c.studio_id = v_studio
  ) then
    raise exception 'COMP10C_ANCHOR_CROSS_STUDIO: client does not belong to the event studio.' using errcode = '42501';
  end if;
  if new.instructor_id is not null and not exists (
    select 1 from public.instructors i where i.id = new.instructor_id and i.studio_id = v_studio
  ) then
    raise exception 'COMP10C_ANCHOR_CROSS_STUDIO: instructor does not belong to the event studio.' using errcode = '42501';
  end if;

  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.first_name := btrim(new.first_name);
  new.last_name := btrim(coalesce(new.last_name, ''));
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public._comp10c_competitor_guard() from public, anon, authenticated;

create trigger event_competition_competitors_guard
  before insert or update on public.event_competition_competitors
  for each row execute function public._comp10c_competitor_guard();

alter table public.event_competition_competitors enable row level security;

create policy competition_competitors_manager_read
  on public.event_competition_competitors for select to authenticated
  using (public.can_manage_event_competition(event_id));
create policy competition_competitors_manager_bib
  on public.event_competition_competitors for update to authenticated
  using (public.can_manage_event_competition(event_id))
  with check (public.can_manage_event_competition(event_id));

revoke all on public.event_competition_competitors from public, anon, authenticated;
grant select on public.event_competition_competitors to authenticated;
-- Managers may assign/correct a bib number only; identity, anchors and PII are written by trusted functions.
grant update (bib_number) on public.event_competition_competitors to authenticated;
grant all on public.event_competition_competitors to service_role;

-- Canonical resolver: trusted anchors deduplicate; anchor-less people are always new guests.
create or replace function public._comp10c_resolve_competitor(
  p_event_id uuid,
  p_user_id uuid,
  p_client_id uuid,
  p_instructor_id uuid,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_date_of_birth date,
  p_primary_role text,
  p_external_ids jsonb,
  p_created_via text,
  p_created_order_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_id uuid;
  v_row public.event_competition_competitors%rowtype;
begin
  if p_user_id is null and p_client_id is null and p_instructor_id is null then
    insert into public.event_competition_competitors (
      event_id, studio_id, first_name, last_name, email, date_of_birth, primary_role, external_ids, created_via, created_order_id
    ) values (
      p_event_id, p_event_id /* replaced by guard */, p_first_name, coalesce(p_last_name, ''), p_email, p_date_of_birth,
      p_primary_role, coalesce(p_external_ids, '{}'::jsonb), p_created_via, p_created_order_id
    ) returning id into v_id;
    return v_id;
  end if;

  -- Serialize anchored resolution per event so concurrent registrations converge on one row.
  perform pg_advisory_xact_lock(hashtextextended('comp10c:competitor:' || p_event_id::text, 0));

  select array_agg(distinct c.id) into v_ids
  from public.event_competition_competitors c
  where c.event_id = p_event_id
    and ((p_user_id is not null and c.user_id = p_user_id)
      or (p_client_id is not null and c.client_id = p_client_id)
      or (p_instructor_id is not null and c.instructor_id = p_instructor_id));

  if coalesce(array_length(v_ids, 1), 0) > 1 then
    raise exception 'COMP10C_ANCHOR_CONFLICT: these identity anchors belong to different competitors at this event.';
  end if;

  if coalesce(array_length(v_ids, 1), 0) = 1 then
    select * into v_row from public.event_competition_competitors where id = v_ids[1] for update;
    if (p_user_id is not null and v_row.user_id is not null and v_row.user_id <> p_user_id)
       or (p_client_id is not null and v_row.client_id is not null and v_row.client_id <> p_client_id)
       or (p_instructor_id is not null and v_row.instructor_id is not null and v_row.instructor_id <> p_instructor_id) then
      raise exception 'COMP10C_ANCHOR_CONFLICT: these identity anchors belong to different people.';
    end if;
    -- Only trusted callers reach here, so missing anchors may be completed (never changed).
    update public.event_competition_competitors
    set user_id = coalesce(user_id, p_user_id),
        client_id = coalesce(client_id, p_client_id),
        instructor_id = coalesce(instructor_id, p_instructor_id)
    where id = v_row.id
      and ((user_id is null and p_user_id is not null)
        or (client_id is null and p_client_id is not null)
        or (instructor_id is null and p_instructor_id is not null));
    return v_row.id;
  end if;

  insert into public.event_competition_competitors (
    event_id, studio_id, user_id, client_id, instructor_id, first_name, last_name, email, date_of_birth,
    primary_role, external_ids, created_via, created_order_id
  ) values (
    p_event_id, p_event_id /* replaced by guard */, p_user_id, p_client_id, p_instructor_id, p_first_name,
    coalesce(p_last_name, ''), p_email, p_date_of_birth, p_primary_role, coalesce(p_external_ids, '{}'::jsonb),
    p_created_via, p_created_order_id
  ) returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public._comp10c_resolve_competitor(uuid, uuid, uuid, uuid, text, text, text, date, text, jsonb, text, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Entry participants -> competitor
-- ---------------------------------------------------------------------------
alter table public.event_competition_entry_participants add column competitor_id uuid;
alter table public.event_competition_entry_participants
  add constraint event_competition_entry_participants_competitor_fk
    foreign key (competitor_id, event_id)
    references public.event_competition_competitors(id, event_id) on delete restrict;

create or replace function public._comp10c_participant_competitor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_comp public.event_competition_competitors%rowtype;
  v_name text;
  v_first text;
  v_last text;
begin
  if new.competitor_id is null then
    if new.client_id is null and new.instructor_id is null then
      v_name := btrim(regexp_replace(coalesce(new.display_name, ''), '\s+', ' ', 'g'));
      v_first := left(coalesce(nullif(split_part(v_name, ' ', 1), ''), 'Participant'), 100);
      v_last := left(btrim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1)), 100);
    else
      select left(coalesce(nullif(btrim(c.first_name), ''), 'Participant'), 100), left(coalesce(btrim(c.last_name), ''), 100)
        into v_first, v_last
      from public.clients c where c.id = new.client_id;
      if v_first is null then
        select left(coalesce(nullif(btrim(i.first_name), ''), 'Participant'), 100), left(coalesce(btrim(i.last_name), ''), 100)
          into v_first, v_last
        from public.instructors i where i.id = new.instructor_id;
      end if;
    end if;
    new.competitor_id := public._comp10c_resolve_competitor(
      new.event_id, null, new.client_id, new.instructor_id, coalesce(v_first, 'Participant'), coalesce(v_last, ''),
      null, null, null, '{}'::jsonb,
      case when current_setting('app.comp10c_backfill', true) = 'on' then 'backfill' else 'staff' end, null);
  end if;

  select * into v_comp from public.event_competition_competitors
  where id = new.competitor_id and event_id = new.event_id;
  if v_comp.id is null then
    raise exception 'COMP10C_COMPETITOR_EVENT_MISMATCH: participant competitor belongs to a different event.' using errcode = '23503';
  end if;
  if (new.client_id is not null and new.client_id is distinct from v_comp.client_id)
     or (new.instructor_id is not null and new.instructor_id is distinct from v_comp.instructor_id) then
    raise exception 'COMP10C_ANCHOR_CONFLICT: participant client/instructor does not match its competitor.' using errcode = '42501';
  end if;
  new.client_id := v_comp.client_id;
  new.instructor_id := v_comp.instructor_id;
  return new;
end;
$$;

revoke all on function public._comp10c_participant_competitor() from public, anon, authenticated;

create trigger event_competition_entry_participants_competitor
  before insert or update of competitor_id, client_id, instructor_id, event_id
  on public.event_competition_entry_participants
  for each row execute function public._comp10c_participant_competitor();

-- Conservative backfill: anchored rows deduplicate through their client/instructor anchor
-- only; every anchor-less row becomes its own guest competitor (no name/email inference).
select set_config('app.comp10c_backfill', 'on', true);
update public.event_competition_entry_participants set competitor_id = null where competitor_id is null;
select set_config('app.comp10c_backfill', '', true);

alter table public.event_competition_entry_participants alter column competitor_id set not null;
alter table public.event_competition_entry_participants
  add constraint event_competition_entry_participants_entry_competitor_key unique (entry_id, competitor_id);
create index event_competition_entry_participants_competitor_idx
  on public.event_competition_entry_participants(competitor_id);

-- Registration roster person -> canonical competitor (snapshot link).
alter table public.event_competition_registration_cart_people add column competitor_id uuid;
alter table public.event_competition_registration_cart_people
  add constraint event_competition_registration_cart_people_competitor_fk
    foreign key (competitor_id, event_id)
    references public.event_competition_competitors(id, event_id) on delete restrict;

-- ---------------------------------------------------------------------------
-- 4. Entry <-> order item linkage (future per-entry refunds) and idempotent carts
-- ---------------------------------------------------------------------------
alter table public.event_competition_entries
  add column order_item_id uuid references public.event_order_items(id) on delete restrict;
create unique index event_competition_entries_order_item_uidx
  on public.event_competition_entries(order_item_id) where order_item_id is not null;

create or replace function public.validate_competition_entry_registration_links()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  linked_registration_event_id uuid;
  linked_registration_order_id uuid;
  linked_order_event_id uuid;
  linked_item record;
begin
  if new.registration_id is not null then
    select er.event_id, er.order_id
    into linked_registration_event_id, linked_registration_order_id
    from public.event_registrations er
    where er.id = new.registration_id;

    if linked_registration_event_id is distinct from new.event_id then
      raise exception 'Competition entry registration belongs to a different event.';
    end if;
  end if;

  if new.order_id is not null then
    select eo.event_id
    into linked_order_event_id
    from public.event_orders eo
    where eo.id = new.order_id;

    if linked_order_event_id is distinct from new.event_id then
      raise exception 'Competition entry order belongs to a different event.';
    end if;
  end if;

  if new.registration_id is not null
    and new.order_id is not null
    and linked_registration_order_id is distinct from new.order_id then
    raise exception 'Competition entry registration does not belong to the selected order.';
  end if;

  -- Phase 10C: the entry's order item must be a competition_entry line of the entry's own order.
  if new.order_item_id is not null then
    select oi.order_id, oi.event_id, oi.item_type into linked_item
    from public.event_order_items oi where oi.id = new.order_item_id;
    if linked_item.order_id is null
       or linked_item.order_id is distinct from new.order_id
       or linked_item.event_id is distinct from new.event_id
       or linked_item.item_type <> 'competition_entry' then
      raise exception 'Competition entry order item does not belong to the entry order.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists validate_competition_entry_registration_links on public.event_competition_entries;
create trigger validate_competition_entry_registration_links
  before insert or update of event_id, registration_id, order_id, order_item_id
  on public.event_competition_entries
  for each row execute function public.validate_competition_entry_registration_links();

alter table public.event_competition_registration_carts
  add column client_request_id uuid,
  add column request_fingerprint text,
  add column buyer_user_id uuid references auth.users(id) on delete set null,
  add column buyer_client_id uuid references public.clients(id) on delete set null,
  add column priced_at timestamptz,
  add column price_snapshot jsonb;
alter table public.event_competition_registration_carts
  add constraint event_competition_registration_carts_request_pair_check
    check ((client_request_id is null) = (request_fingerprint is null));
create unique index event_competition_registration_carts_request_uidx
  on public.event_competition_registration_carts(event_id, client_request_id) where client_request_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Registration lifecycle on the program
-- ---------------------------------------------------------------------------
alter table public.event_competition_programs
  add column registration_status text not null default 'closed',
  add column registration_opened_at timestamptz,
  add column registration_closed_at timestamptz;
alter table public.event_competition_programs
  add constraint event_competition_programs_registration_status_check
    check (registration_status in ('closed', 'open'));

comment on column public.event_competition_programs.registration_status is
  'Phase 10C: written only by open_/close_competition_registration. Public registration catalog visibility requires open (plus event window and published state). Existing programs start closed.';

-- Re-grant ordinary client column privileges without the three lifecycle columns (10B pattern).
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into v_cols
  from pg_attribute
  where attrelid = 'public.event_competition_programs'::regclass and attnum > 0 and not attisdropped
    and attname not in ('rules_profile_key', 'rules_profile_version', 'profile_locked_at',
                        'registration_status', 'registration_opened_at', 'registration_closed_at');
  execute 'revoke insert, update on public.event_competition_programs from anon, authenticated';
  execute format('grant insert (%s), update (%s) on public.event_competition_programs to authenticated', v_cols, v_cols);
end $$;

-- The canonical "registration is actually open" predicate shared by every public catalog
-- policy and by start_competition_registration.
create or replace function public.competition_registration_program_open(p_event_id uuid, p_program_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.events e
    join public.event_competition_programs p on p.event_id = e.id
    where e.id = p_event_id
      and p.id = p_program_id
      and e.status = 'published'
      and e.visibility in ('public', 'unlisted')
      and e.registration_required
      and (e.registration_opens_at is null or e.registration_opens_at <= now())
      and (e.registration_closes_at is null or e.registration_closes_at >= now())
      and p.status in ('configured', 'active')
      and p.registration_status = 'open'
      and (p.rules_profile_key is null or p.profile_locked_at is not null)
  );
$$;

create or replace function public.competition_registration_event_open(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.event_competition_programs p
    where p.event_id = p_event_id and public.competition_registration_program_open(p_event_id, p.id)
  );
$$;

revoke all on function public.competition_registration_program_open(uuid, uuid) from public;
revoke all on function public.competition_registration_event_open(uuid) from public;
grant execute on function public.competition_registration_program_open(uuid, uuid) to anon, authenticated, service_role;
grant execute on function public.competition_registration_event_open(uuid) to anon, authenticated, service_role;

-- Row-level registrability predicates (SECURITY DEFINER, so policies never recurse through each
-- other's RLS). The public policies AND _comp10c_quote use exactly these, so the anonymous
-- catalog and the server-authoritative catalog are the same set by construction.
create or replace function public.competition_contest_registrable(p_contest_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.event_competition_contests c
    join public.event_competition_contest_registration_rules r on r.contest_id = c.id and r.event_id = c.event_id
    where c.id = p_contest_id
      and c.status = 'open'
      and r.registration_open
      and public.competition_registration_program_open(c.event_id, c.program_id)
  );
$$;

create or replace function public.competition_division_registrable(p_division_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.event_competition_divisions d
    join public.event_competition_contests c on c.id = d.contest_id and c.event_id = d.event_id and c.program_id = d.program_id
    where d.id = p_division_id
      and d.status = 'open'
      and public.competition_contest_registrable(c.id)
  );
$$;

create or replace function public.competition_offering_registrable(p_offering_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.event_competition_division_dances dd
    join public.event_competition_dances dn on dn.id = dd.dance_id and dn.event_id = dd.event_id
    where dd.id = p_offering_id
      and dd.active
      and dn.active
      and public.competition_division_registrable(dd.division_id)
  );
$$;

revoke all on function public.competition_contest_registrable(uuid) from public;
revoke all on function public.competition_division_registrable(uuid) from public;
revoke all on function public.competition_offering_registrable(uuid) from public;
grant execute on function public.competition_contest_registrable(uuid) to anon, authenticated, service_role;
grant execute on function public.competition_division_registrable(uuid) to anon, authenticated, service_role;
grant execute on function public.competition_offering_registrable(uuid) to anon, authenticated, service_role;

drop policy competition_programs_public_registration_read on public.event_competition_programs;
create policy competition_programs_public_registration_read
  on public.event_competition_programs for select
  using (public.competition_registration_program_open(event_id, id));

drop policy competition_registration_rules_public_read on public.event_competition_contest_registration_rules;
create policy competition_registration_rules_public_read
  on public.event_competition_contest_registration_rules for select
  using (registration_open and public.competition_contest_registrable(contest_id));

drop policy competition_fee_rules_public_read on public.event_competition_fee_rules;
create policy competition_fee_rules_public_read
  on public.event_competition_fee_rules for select
  using (
    active
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
    and case when program_id is null then public.competition_registration_event_open(event_id)
             else public.competition_registration_program_open(event_id, program_id) end
  );

drop policy competition_contests_public_registration_read on public.event_competition_contests;
create policy competition_contests_public_registration_read
  on public.event_competition_contests for select
  using (public.competition_contest_registrable(id));

drop policy competition_divisions_public_registration_read on public.event_competition_divisions;
create policy competition_divisions_public_registration_read
  on public.event_competition_divisions for select
  using (public.competition_division_registrable(id));

drop policy competition_dances_public_registration_read on public.event_competition_dances;
create policy competition_dances_public_registration_read
  on public.event_competition_dances for select
  using (active and public.competition_registration_program_open(event_id, program_id));

drop policy competition_division_dances_public_registration_read on public.event_competition_division_dances;
create policy competition_division_dances_public_registration_read
  on public.event_competition_division_dances for select
  using (public.competition_offering_registrable(id));

-- Manager authority for an explicit actor (service-role callers have no auth.uid()). Same
-- roles as can_manage_event_competition.
create or replace function public._comp10c_actor_can_manage(p_event_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null and exists (
    select 1 from public.events e
    where e.id = p_event_id
      and (
        exists (select 1 from public.profiles p where p.id = p_user_id and p.platform_role = 'platform_admin')
        or exists (
          select 1 from public.user_studio_roles usr
          where usr.studio_id = e.studio_id and usr.user_id = p_user_id and usr.active = true
            and usr.role in ('studio_owner', 'studio_admin'))
        or exists (
          select 1 from public.organizer_users ou
          where ou.organizer_id = e.organizer_id and ou.user_id = p_user_id and ou.active = true
            and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff'))
      )
  );
$$;

revoke all on function public._comp10c_actor_can_manage(uuid, uuid) from public, anon, authenticated;

create or replace function public.open_competition_registration(p_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_program record;
  v_event record;
  v_contests int;
  v_divisions int;
begin
  select p.* into v_program from public.event_competition_programs p where p.id = p_program_id for update;
  if v_program.id is null or not public.can_manage_event_competition(v_program.event_id) then
    raise exception 'COMP10C_FORBIDDEN: competition was not found or cannot be managed.' using errcode = '42501';
  end if;
  select e.* into v_event from public.events e where e.id = v_program.event_id;
  if v_program.status not in ('configured', 'active') then
    raise exception 'COMP10C_NOT_PUBLISHED: publish the competition before opening registration.';
  end if;
  if v_program.rules_profile_key is not null and v_program.profile_locked_at is null then
    raise exception 'COMP10C_NOT_PUBLISHED: publish the competition before opening registration.';
  end if;
  if not v_event.registration_required then
    raise exception 'COMP10C_EVENT_REGISTRATION_OFF: turn on event registration before opening competition registration.';
  end if;

  -- Open every category that has at least one division, its draft divisions, and its rule.
  with ready as (
    select c.id from public.event_competition_contests c
    where c.program_id = v_program.id and c.event_id = v_program.event_id
      and c.status in ('draft', 'open')
      and exists (select 1 from public.event_competition_divisions d
                  where d.contest_id = c.id and d.event_id = c.event_id and d.status in ('draft', 'open'))
      and exists (select 1 from public.event_competition_contest_registration_rules r
                  where r.contest_id = c.id and r.event_id = c.event_id)
  ), opened as (
    update public.event_competition_contests c set status = 'open', updated_at = now()
    from ready where c.id = ready.id and c.status = 'draft' returning c.id
  )
  select (select count(*) from ready) into v_contests;
  if v_contests = 0 then
    raise exception 'COMP10C_NOTHING_REGISTRABLE: add a category with at least one division before opening registration.';
  end if;

  update public.event_competition_divisions d set status = 'open', updated_at = now()
  where d.program_id = v_program.id and d.event_id = v_program.event_id and d.status = 'draft'
    and exists (select 1 from public.event_competition_contests c where c.id = d.contest_id and c.status = 'open');
  select count(*) into v_divisions from public.event_competition_divisions d
  where d.program_id = v_program.id and d.status = 'open';

  update public.event_competition_contest_registration_rules r set registration_open = true, updated_at = now()
  where r.program_id = v_program.id and r.event_id = v_program.event_id and not r.registration_open
    and exists (select 1 from public.event_competition_contests c where c.id = r.contest_id and c.status = 'open');

  update public.event_competition_programs
  set registration_status = 'open', registration_opened_at = now(), updated_at = now()
  where id = v_program.id;

  return jsonb_build_object('program_id', v_program.id, 'registration_status', 'open',
    'open_categories', v_contests, 'open_divisions', v_divisions);
end;
$$;

create or replace function public.close_competition_registration(p_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_program record;
begin
  select p.* into v_program from public.event_competition_programs p where p.id = p_program_id for update;
  if v_program.id is null or not public.can_manage_event_competition(v_program.event_id) then
    raise exception 'COMP10C_FORBIDDEN: competition was not found or cannot be managed.' using errcode = '42501';
  end if;
  update public.event_competition_programs
  set registration_status = 'closed', registration_closed_at = now(), updated_at = now()
  where id = v_program.id;
  return jsonb_build_object('program_id', v_program.id, 'registration_status', 'closed');
end;
$$;

revoke all on function public.open_competition_registration(uuid) from public, anon;
revoke all on function public.close_competition_registration(uuid) from public, anon;
grant execute on function public.open_competition_registration(uuid) to authenticated, service_role;
grant execute on function public.close_competition_registration(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Authoritative pricing (mirrored for display by src/lib/competition/registrationPricing.ts)
-- ---------------------------------------------------------------------------
create or replace function public._comp10c_uuid(p_value text)
returns uuid
language sql
immutable
as $$
  select case when p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_value::uuid end;
$$;

create or replace function public._comp10c_allowed_roles(p_entry_format text)
returns text[]
language sql
immutable
as $$
  select case
    when p_entry_format = 'pro_am' then array['student', 'professional']
    when p_entry_format = 'pro_pro' then array['professional']
    when p_entry_format in ('couple', 'mixed_amateur', 'professional') then array['leader', 'follower']
    when p_entry_format = 'random_partner' then array['leader', 'follower']
    when p_entry_format = 'team' then array['team_member']
    else array['dancer', 'leader', 'follower', 'student', 'professional', 'instructor', 'alternate', 'other']
  end;
$$;

revoke all on function public._comp10c_uuid(text) from public, anon, authenticated;
revoke all on function public._comp10c_allowed_roles(text) from public, anon, authenticated;

create or replace function public._comp10c_quote(p_event_id uuid, p_draft jsonb, p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_errors text[] := '{}';
  v_lines jsonb := '[]'::jsonb;
  v_effective jsonb := '{}'::jsonb;
  v_currency text := '';
  v_mode text := coalesce(p_draft->>'registrationMode', '');
  v_people jsonb := coalesce(p_draft->'people', '[]'::jsonb);
  v_entries jsonb := coalesce(p_draft->'entries', '[]'::jsonb);
  v_person_ids text[] := '{}';
  v_entry jsonb;
  v_contest record;
  v_division record;
  v_rule record;
  v_offering record;
  v_fee record;
  v_ids text[];
  v_id text;
  v_role text;
  v_roles text[];
  v_available text[];
  v_required text[];
  v_submitted text[];
  v_effective_ids text[];
  v_entry_currency text;
  v_base_cents bigint;
  v_unit_cents bigint;
  v_line_cents bigint;
  v_qty int;
  v_scoped boolean;
  v_matching text[];
  v_matching_people text[];
  v_matching_dances int;
  v_current_subtotal bigint;
  v_rule_currency text;
  v_line_type text;
  v_subtotal bigint;
  v_discount bigint;
  v_self_count int := 0;
  v_entry_ok boolean;
begin
  if jsonb_typeof(v_people) <> 'array' or jsonb_typeof(v_entries) <> 'array' then
    return jsonb_build_object('valid', false, 'errors', jsonb_build_array('Registration details are malformed.'),
      'lines', '[]'::jsonb, 'subtotal_cents', 0, 'discount_cents', 0, 'total_cents', 0, 'currency', 'USD', 'effective', '{}'::jsonb);
  end if;

  if v_mode not in ('individual', 'studio') then v_errors := array_append(v_errors, 'Choose individual or studio registration.'); end if;
  if btrim(coalesce(p_draft->>'buyerName', '')) = '' then v_errors := array_append(v_errors, 'Buyer name is required.'); end if;
  if btrim(coalesce(p_draft->>'buyerEmail', '')) = '' or position('@' in coalesce(p_draft->>'buyerEmail', '')) = 0 then
    v_errors := array_append(v_errors, 'A valid buyer email is required.');
  end if;
  if v_mode = 'studio' and btrim(coalesce(p_draft->>'registeringStudioName', '')) = '' then
    v_errors := array_append(v_errors, 'Studio name is required for studio registration.');
  end if;
  if jsonb_array_length(v_people) = 0 then v_errors := array_append(v_errors, 'Add at least one dancer or instructor.'); end if;
  if jsonb_array_length(v_entries) = 0 then v_errors := array_append(v_errors, 'Add at least one competition entry.'); end if;
  if jsonb_array_length(v_people) > 100 or jsonb_array_length(v_entries) > 100 then
    v_errors := array_append(v_errors, 'One registration can include at most 100 people and 100 entries.');
  end if;

  select coalesce(array_agg(x->>'clientId'), '{}') into v_person_ids from jsonb_array_elements(v_people) x;
  if (select count(distinct id) from unnest(v_person_ids) id) <> cardinality(v_person_ids)
     or exists (select 1 from unnest(v_person_ids) id where coalesce(id, '') = '') then
    v_errors := array_append(v_errors, 'Each roster person needs a unique id.');
  end if;
  -- Entry ids key the per-entry price lines, order items and snapshot: they must be unique too.
  if (select count(distinct coalesce(x->>'clientId', '')) from jsonb_array_elements(v_entries) x) <> jsonb_array_length(v_entries)
     or exists (select 1 from jsonb_array_elements(v_entries) x where coalesce(x->>'clientId', '') = '') then
    v_errors := array_append(v_errors, 'Each entry needs a unique id.');
  end if;
  for v_entry in select x from jsonb_array_elements(v_people) x loop
    if length(btrim(coalesce(v_entry->>'firstName', ''))) not between 1 and 100
       or length(btrim(coalesce(v_entry->>'lastName', ''))) not between 1 and 100 then
      v_errors := array_append(v_errors, 'Each person needs a first and last name.');
    end if;
    if coalesce(v_entry->>'personType', 'dancer') not in ('dancer', 'student', 'professional', 'instructor', 'team_member', 'alternate', 'other') then
      v_errors := array_append(v_errors, 'Choose a valid person type.');
    end if;
    if coalesce(v_entry->>'dateOfBirth', '') <> '' and (v_entry->>'dateOfBirth') !~ '^\d{4}-\d{2}-\d{2}$' then
      v_errors := array_append(v_errors, 'Enter dates of birth as YYYY-MM-DD.');
    end if;
    if coalesce(v_entry->>'primaryRole', '') not in ('', 'leader', 'follower') then
      v_errors := array_append(v_errors, 'Choose Leader or Follower as the primary role.');
    end if;
    if coalesce(v_entry->'isSelf' = 'true'::jsonb, false) then v_self_count := v_self_count + 1; end if;
  end loop;
  if v_self_count > 1 then v_errors := array_append(v_errors, 'Only one roster person can be you.'); end if;

  for v_entry in select x from jsonb_array_elements(v_entries) x loop
    select c.id, c.name, c.entry_format into v_contest
    from public.event_competition_contests c
    where c.id = public._comp10c_uuid(v_entry->>'contestId')
      and c.program_id = public._comp10c_uuid(v_entry->>'programId')
      and c.event_id = p_event_id
      and public.competition_contest_registrable(c.id);
    select d.id, d.name into v_division
    from public.event_competition_divisions d
    where d.id = public._comp10c_uuid(v_entry->>'divisionId')
      and d.contest_id = v_contest.id and d.program_id = public._comp10c_uuid(v_entry->>'programId')
      and d.event_id = p_event_id and public.competition_division_registrable(d.id);
    select r.* into v_rule
    from public.event_competition_contest_registration_rules r
    where r.contest_id = v_contest.id and r.event_id = p_event_id and r.registration_open;
    if v_contest.id is null or v_division.id is null or v_rule.id is null then
      v_errors := array_append(v_errors, 'One entry references a competition option that is no longer available.');
      continue;
    end if;

    select coalesce(array_agg(distinct x), '{}') into v_ids
    from jsonb_array_elements_text(coalesce(v_entry->'participantIds', '[]'::jsonb)) x;
    if exists (select 1 from unnest(v_ids) i where not (i = any(v_person_ids))) then
      v_errors := array_append(v_errors, (v_division.name || ': select valid roster participants.'));
    end if;
    if cardinality(v_ids) < v_rule.minimum_participants or cardinality(v_ids) > v_rule.maximum_participants then
      v_errors := array_append(v_errors, (v_division.name || ': select '
        || case when v_rule.minimum_participants = v_rule.maximum_participants then v_rule.minimum_participants::text
                else v_rule.minimum_participants::text || '-' || v_rule.maximum_participants::text end
        || ' participants.'));
    end if;
    if v_contest.entry_format = 'random_partner' then
      v_role := case when cardinality(v_ids) = 1 then coalesce(v_entry->'participantRoles'->>v_ids[1], '') else '' end;
      if v_role not in ('leader', 'follower') then
        v_errors := array_append(v_errors, (v_division.name || ': select Leader or Follower for this entry.'));
      end if;
    end if;
    v_roles := public._comp10c_allowed_roles(v_contest.entry_format);
    if exists (select 1 from unnest(v_ids) i
               where not (coalesce(v_entry->'participantRoles'->>i, 'dancer') = any(v_roles))) then
      v_errors := array_append(v_errors, (v_division.name || ': choose a valid role for each participant.'));
    end if;
    if v_contest.entry_format = 'team' and btrim(coalesce(v_entry->>'teamName', '')) = '' then
      v_errors := array_append(v_errors, (v_division.name || ': team name is required.'));
    end if;
    if v_rule.requires_routine_title and btrim(coalesce(v_entry->>'routineTitle', '')) = '' then
      v_errors := array_append(v_errors, (v_division.name || ': routine title is required.'));
    end if;
    if v_rule.requires_music and btrim(coalesce(v_entry->>'musicTitle', '')) = '' then
      v_errors := array_append(v_errors, (v_division.name || ': music title is required.'));
    end if;
    if v_rule.requires_duration and not (coalesce(nullif(v_entry->>'routineDurationSeconds', ''), '0') ~ '^\d+$'
         and (v_entry->>'routineDurationSeconds')::bigint > 0) then
      v_errors := array_append(v_errors, (v_division.name || ': routine duration is required.'));
    end if;

    select coalesce(array_agg(dd.id::text order by dd.sort_order, dd.id), '{}'),
           coalesce(array_agg(dd.id::text order by dd.sort_order, dd.id) filter (where dd.required), '{}')
      into v_available, v_required
    from public.event_competition_division_dances dd
    join public.event_competition_dances dn on dn.id = dd.dance_id and dn.event_id = dd.event_id
    where dd.division_id = v_division.id and dd.event_id = p_event_id and public.competition_offering_registrable(dd.id);

    select coalesce(array_agg(x order by o), '{}') into v_submitted
    from (
      select x, min(o) o
      from jsonb_array_elements_text(coalesce(v_entry->'selectedOfferingIds', '[]'::jsonb)) with ordinality s(x, o)
      where x = any(v_available)
      group by x
    ) q;

    if v_rule.dance_selection_mode in ('prescribed_set', 'routine') then
      v_effective_ids := v_available;
    elsif v_rule.dance_selection_mode = 'none' then
      v_effective_ids := '{}';
    else
      v_effective_ids := v_required;
      foreach v_id in array v_submitted loop
        if not (v_id = any(v_effective_ids)) then v_effective_ids := v_effective_ids || v_id; end if;
      end loop;
    end if;
    v_effective := v_effective || jsonb_build_object(v_entry->>'clientId', to_jsonb(v_effective_ids));

    if v_rule.dance_selection_mode in ('individual', 'choose_count') then
      if v_rule.minimum_dances is not null and cardinality(v_effective_ids) < v_rule.minimum_dances then
        v_errors := array_append(v_errors, (v_division.name || ': select at least ' || v_rule.minimum_dances || ' dances.'));
      end if;
      if v_rule.maximum_dances is not null and cardinality(v_effective_ids) > v_rule.maximum_dances then
        v_errors := array_append(v_errors, (v_division.name || ': select no more than ' || v_rule.maximum_dances || ' dances.'));
      end if;
    end if;

    v_entry_currency := upper(coalesce(nullif(v_rule.currency, ''), 'USD'));
    if v_currency <> '' and v_entry_currency <> v_currency then
      v_errors := array_append(v_errors, (v_division.name || ': all competition entries in one checkout must use ' || v_currency || '.'));
    end if;
    if v_currency = '' then v_currency := v_entry_currency; end if;

    if v_rule.pricing_method in ('flat_entry', 'base_plus_dance', 'included_set', 'custom') then
      v_base_cents := greatest(0, round(v_rule.base_entry_fee * 100))::bigint;
      v_lines := v_lines || jsonb_build_object(
        'clientEntryId', v_entry->>'clientId', 'feeRuleId', null, 'lineType', 'base_entry',
        'description', v_contest.name || ' — ' || v_division.name, 'quantity', 1,
        'unitCents', v_base_cents, 'lineCents', v_base_cents, 'currency', v_currency,
        'metadata', jsonb_build_object('contestId', v_contest.id, 'divisionId', v_division.id,
          'ruleId', v_rule.id, 'pricingMethod', v_rule.pricing_method));
    end if;
    if v_rule.pricing_method in ('per_dance', 'base_plus_dance') then
      foreach v_id in array v_effective_ids loop
        select dd.id, dd.entry_fee, dd.currency, dn.name as dance_name into v_offering
        from public.event_competition_division_dances dd
        join public.event_competition_dances dn on dn.id = dd.dance_id
        where dd.id = v_id::uuid;
        if v_offering.id is null then continue; end if;
        if upper(coalesce(nullif(v_offering.currency, ''), v_currency)) <> v_currency then
          v_errors := array_append(v_errors, (v_division.name || ': all fees must use ' || v_currency || '.'));
        end if;
        v_unit_cents := greatest(0, round(v_offering.entry_fee * 100))::bigint;
        v_lines := v_lines || jsonb_build_object(
          'clientEntryId', v_entry->>'clientId', 'feeRuleId', null, 'lineType', 'dance',
          'description', v_contest.name || ' — ' || v_division.name || ' — ' || coalesce(v_offering.dance_name, 'Dance'),
          'quantity', 1, 'unitCents', v_unit_cents, 'lineCents', v_unit_cents, 'currency', v_currency,
          'metadata', jsonb_build_object('contestId', v_contest.id, 'divisionId', v_division.id, 'offeringId', v_offering.id));
      end loop;
    end if;
  end loop;

  -- Fee rules: registrable, active, inside their window at p_now, matching the mode; applied in
  -- (priority, name, id) order -- percentage rules see the lines produced before them.
  for v_fee in
    select f.* from public.event_competition_fee_rules f
    where f.event_id = p_event_id and f.active
      and (f.starts_at is null or f.starts_at <= p_now)
      and (f.ends_at is null or f.ends_at > p_now)
      and f.registration_mode in ('both', v_mode)
      and case when f.program_id is null then public.competition_registration_event_open(p_event_id)
               else public.competition_registration_program_open(p_event_id, f.program_id) end
    order by f.priority, f.name collate "C", f.id
  loop
    select coalesce(array_agg(x->>'clientId'), '{}') into v_matching
    from jsonb_array_elements(v_entries) x
    where (v_fee.program_id is null or x->>'programId' = v_fee.program_id::text)
      and (v_fee.contest_id is null or x->>'contestId' = v_fee.contest_id::text)
      and (v_fee.division_id is null or x->>'divisionId' = v_fee.division_id::text);
    v_scoped := v_fee.program_id is not null or v_fee.contest_id is not null or v_fee.division_id is not null;
    if v_scoped and cardinality(v_matching) = 0 then continue; end if;

    v_rule_currency := upper(coalesce(nullif(v_fee.currency, ''), nullif(v_currency, ''), 'USD'));
    if v_currency = '' then v_currency := v_rule_currency; end if;
    if v_rule_currency <> v_currency then
      v_errors := array_append(v_errors, (v_fee.name || ': all fees must use ' || v_currency || '.'));
      continue;
    end if;

    select coalesce(sum(jsonb_array_length(coalesce(v_effective->(m), '[]'::jsonb))), 0) into v_matching_dances
    from unnest(v_matching) m;
    select coalesce(array_agg(distinct p), '{}') into v_matching_people
    from jsonb_array_elements(v_entries) x, jsonb_array_elements_text(coalesce(x->'participantIds', '[]'::jsonb)) p
    where x->>'clientId' = any(v_matching);
    select coalesce(sum((l->>'lineCents')::bigint), 0) into v_current_subtotal
    from jsonb_array_elements(v_lines) l
    where l->>'lineType' <> 'discount'
      and (not v_scoped or (l->>'clientEntryId' is not null and l->>'clientEntryId' = any(v_matching)));

    v_qty := 1;
    v_unit_cents := greatest(0, round(v_fee.amount * 100))::bigint;
    if v_fee.calculation_type = 'flat_per_person' then
      v_qty := case when cardinality(v_matching_people) > 0 then cardinality(v_matching_people) else jsonb_array_length(v_people) end;
    elsif v_fee.calculation_type = 'flat_per_entry' then
      v_qty := case when cardinality(v_matching) > 0 then cardinality(v_matching) else jsonb_array_length(v_entries) end;
    elsif v_fee.calculation_type = 'flat_per_dance' then
      v_qty := v_matching_dances;
    elsif v_fee.calculation_type in ('percentage', 'discount_percentage') then
      v_unit_cents := round(v_current_subtotal::numeric * greatest(0, coalesce(v_fee.percentage, 0)) / 100)::bigint;
      v_qty := 1;
    end if;
    v_line_cents := v_unit_cents * greatest(0, v_qty);
    v_line_type := case when v_fee.calculation_type in ('discount_flat', 'discount_percentage') then 'discount' else 'fee' end;
    if v_line_cents > 0 then
      v_lines := v_lines || jsonb_build_object(
        'clientEntryId', null, 'feeRuleId', v_fee.id, 'lineType', v_line_type, 'description', v_fee.name,
        'quantity', greatest(1, v_qty), 'unitCents', v_unit_cents, 'lineCents', v_line_cents, 'currency', v_currency,
        'metadata', jsonb_build_object('calculationType', v_fee.calculation_type, 'amount', v_fee.amount,
          'percentage', v_fee.percentage, 'startsAt', v_fee.starts_at, 'endsAt', v_fee.ends_at,
          'priority', v_fee.priority, 'scope', jsonb_build_object('programId', v_fee.program_id,
            'contestId', v_fee.contest_id, 'divisionId', v_fee.division_id)));
    end if;
  end loop;

  select coalesce(sum((l->>'lineCents')::bigint) filter (where l->>'lineType' <> 'discount'), 0),
         coalesce(sum((l->>'lineCents')::bigint) filter (where l->>'lineType' = 'discount'), 0)
    into v_subtotal, v_discount
  from jsonb_array_elements(v_lines) l;
  v_discount := least(v_subtotal, v_discount);

  return jsonb_build_object(
    'valid', cardinality(v_errors) = 0,
    'errors', to_jsonb(v_errors),
    'lines', v_lines,
    'subtotal_cents', v_subtotal,
    'discount_cents', v_discount,
    'total_cents', v_subtotal - v_discount,
    'currency', coalesce(nullif(v_currency, ''), 'USD'),
    'effective', v_effective,
    'priced_at', p_now
  );
end;
$$;

revoke all on function public._comp10c_quote(uuid, jsonb, timestamptz) from public, anon, authenticated;

-- Read-only preview of the authoritative quote at the database's now() (service role; tests).
create or replace function public.quote_competition_registration(p_event_id uuid, p_draft jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._comp10c_quote(p_event_id, p_draft, now());
$$;

revoke all on function public.quote_competition_registration(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.quote_competition_registration(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 7. START: one transaction creates the whole pending registration graph
-- ---------------------------------------------------------------------------
create or replace function public._comp10c_result(p_cart_id uuid, p_replay boolean)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'cart_id', c.id,
    'cart_token', c.public_token,
    'order_id', o.id,
    'registration_id', (select er.id from public.event_registrations er where er.order_id = o.id order by er.created_at limit 1),
    'order_status', o.status,
    'payment_status', o.payment_status,
    'total_cents', round(o.total_amount * 100)::bigint,
    'currency', o.currency,
    'requires_signing', coalesce((o.metadata->>'requires_signing')::boolean, false),
    'expires_at', o.expires_at,
    'checkout_session_id', o.stripe_checkout_session_id,
    'stripe_account_id', o.metadata->>'stripe_account_id',
    'entry_count', (select count(*) from public.event_competition_entries e where e.order_id = o.id),
    'replay', p_replay
  )
  from public.event_competition_registration_carts c
  join public.event_orders o on o.id = c.order_id
  where c.id = p_cart_id;
$$;

revoke all on function public._comp10c_result(uuid, boolean) from public, anon, authenticated;

create or replace function public.start_competition_registration(
  p_event_id uuid,
  p_client_request_id uuid,
  p_draft jsonb,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
-- extensions: the attendee ticket-code trigger (set_event_attendee_ticket_code) calls gen_random_bytes unqualified.
set search_path = public, extensions, pg_temp
as $$
declare
  c_hold interval := interval '40 minutes';
  v_now timestamptz := now();
  v_fingerprint text;
  v_existing record;
  v_event record;
  v_quote jsonb;
  v_mode text;
  v_buyer_name text;
  v_buyer_first text;
  v_buyer_last text;
  v_buyer_email text;
  v_buyer_phone text;
  v_studio_name text;
  v_actor_verified_email text;
  v_actor_client uuid;
  v_actor_instructor uuid;
  v_is_manager boolean;
  v_requires_signing boolean;
  v_total bigint;
  v_free_now boolean;
  v_cart_id uuid;
  v_order_id uuid;
  v_registration_id uuid;
  v_person jsonb;
  v_entry jsonb;
  v_line jsonb;
  v_person_map jsonb := '{}'::jsonb;
  v_competitor_map jsonb := '{}'::jsonb;
  v_attendee_map jsonb := '{}'::jsonb;
  v_cart_entry_map jsonb := '{}'::jsonb;
  v_entry_map jsonb := '{}'::jsonb;
  v_competitor_id uuid;
  v_cart_person_id uuid;
  v_cart_entry_id uuid;
  v_entry_id uuid;
  v_item_id uuid;
  v_attendee_id uuid;
  v_user uuid;
  v_client uuid;
  v_instructor uuid;
  v_email text;
  v_dob date;
  v_contest record;
  v_division record;
  v_display text;
  v_names text[];
  v_entry_cents bigint;
  v_entry_lines jsonb;
  v_offering text;
  v_sort int;
  v_idx int;
  v_pid text;
  v_role text;
  v_person_type text;
  v_primary_role text;
  v_snapshot jsonb;
begin
  if p_event_id is null or p_client_request_id is null or p_draft is null or jsonb_typeof(p_draft) <> 'object' then
    raise exception 'COMP10C_INVALID: registration request is incomplete.';
  end if;

  -- Idempotency: one logical registration per (event, client_request_id). Concurrent retries
  -- serialize here; the loser replays the winner's stored result.
  perform pg_advisory_xact_lock(hashtextextended('comp10c:start:' || p_event_id::text || ':' || p_client_request_id::text, 0));
  v_fingerprint := md5(jsonb_build_object('actor', p_actor_user_id, 'draft', p_draft)::text);

  select c.id, c.request_fingerprint into v_existing
  from public.event_competition_registration_carts c
  where c.event_id = p_event_id and c.client_request_id = p_client_request_id;
  if v_existing.id is not null then
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception 'COMP10C_IDEMPOTENCY_CONFLICT: this registration request was already submitted with different details.';
    end if;
    return public._comp10c_result(v_existing.id, true);
  end if;

  select e.id, e.studio_id, e.organizer_id, e.name, e.account_required_for_registration into v_event
  from public.events e where e.id = p_event_id for share;
  if v_event.id is null or not public.competition_registration_event_open(p_event_id) then
    raise exception 'COMP10C_CLOSED: competition registration is not open.';
  end if;
  if v_event.account_required_for_registration and p_actor_user_id is null then
    raise exception 'COMP10C_SIGN_IN_REQUIRED: sign in before registering.';
  end if;

  v_quote := public._comp10c_quote(p_event_id, p_draft, v_now);
  if not (v_quote->>'valid')::boolean then
    raise exception 'COMP10C_INVALID: %', coalesce(v_quote->'errors'->>0, 'Registration is incomplete.')
      using detail = (v_quote->'errors')::text;
  end if;

  v_mode := p_draft->>'registrationMode';
  v_buyer_name := left(btrim(regexp_replace(p_draft->>'buyerName', '\s+', ' ', 'g')), 200);
  v_buyer_first := split_part(v_buyer_name, ' ', 1);
  v_buyer_last := btrim(substr(v_buyer_name, length(v_buyer_first) + 1));
  v_buyer_email := left(lower(btrim(p_draft->>'buyerEmail')), 254);
  v_buyer_phone := nullif(left(btrim(coalesce(p_draft->>'buyerPhone', '')), 40), '');
  v_studio_name := case when v_mode = 'studio' then nullif(left(btrim(coalesce(p_draft->>'registeringStudioName', '')), 200), '') end;

  -- Buyer identity: the server-verified session user, and their own LINKED self client at the
  -- event studio (canonical client_account_links; never an email match).
  if p_actor_user_id is not null then
    v_actor_verified_email := public.verified_email_for_user(p_actor_user_id);
    select l.client_id into v_actor_client
    from public.client_account_links l
    where l.user_id = p_actor_user_id and l.studio_id = v_event.studio_id
      and l.status = 'linked' and l.relationship_type = 'self'
    order by l.is_primary desc nulls last, l.linked_at nulls last
    limit 1;
    select i.id into v_actor_instructor
    from public.instructors i
    where i.user_id = p_actor_user_id and i.studio_id = v_event.studio_id and i.active
    limit 1;
  end if;
  v_is_manager := public._comp10c_actor_can_manage(p_event_id, p_actor_user_id);

  v_total := (v_quote->>'total_cents')::bigint;
  v_requires_signing := exists (
    select 1 from public.event_document_requirements r
    where r.event_id = p_event_id and r.active and r.is_required
  );
  v_free_now := v_total = 0 and not v_requires_signing;

  v_snapshot := jsonb_build_object(
    'pricing_version', '10c.1',
    'priced_at', v_now,
    'currency', v_quote->>'currency',
    'subtotal_cents', (v_quote->>'subtotal_cents')::bigint,
    'discount_cents', (v_quote->>'discount_cents')::bigint,
    'total_cents', v_total,
    'lines', v_quote->'lines'
  );

  insert into public.event_competition_registration_carts (
    event_id, registration_mode, buyer_name, buyer_email, buyer_phone, registering_studio_name, status, currency,
    quoted_subtotal, quoted_discount, quoted_total, quote_checksum, quoted_at, expires_at, submitted_at,
    client_request_id, request_fingerprint, buyer_user_id, buyer_client_id, priced_at, price_snapshot
  ) values (
    p_event_id, v_mode, v_buyer_name, v_buyer_email, v_buyer_phone, v_studio_name,
    case when v_free_now then 'submitted' else 'checkout_pending' end, v_quote->>'currency',
    ((v_quote->>'subtotal_cents')::numeric / 100), ((v_quote->>'discount_cents')::numeric / 100), (v_total::numeric / 100),
    md5(v_snapshot::text), v_now, v_now + c_hold, case when v_free_now then v_now end,
    p_client_request_id, v_fingerprint, p_actor_user_id, v_actor_client, v_now, v_snapshot
  ) returning id into v_cart_id;

  insert into public.event_orders (
    event_id, studio_id, organizer_id, buyer_name, buyer_email, buyer_phone, buyer_notes,
    subtotal_amount, discount_amount, total_amount, currency, status, payment_status, expires_at, paid_at,
    client_request_id, metadata
  ) values (
    p_event_id, v_event.studio_id, v_event.organizer_id, v_buyer_name, v_buyer_email, v_buyer_phone,
    case when v_studio_name is not null then 'Studio registration: ' || v_studio_name end,
    ((v_quote->>'subtotal_cents')::numeric / 100), ((v_quote->>'discount_cents')::numeric / 100), (v_total::numeric / 100),
    v_quote->>'currency',
    case when v_free_now then 'confirmed' else 'pending' end,
    case when v_free_now then 'paid' else 'pending' end,
    case when v_free_now then null else v_now + c_hold end,
    case when v_free_now then v_now end,
    'comp10c:' || p_client_request_id::text,
    jsonb_build_object(
      'source', 'competition_registration',
      'registration_cart_id', v_cart_id,
      'client_request_id', p_client_request_id,
      'registration_mode', v_mode,
      'registering_studio_name', v_studio_name,
      'requires_signing', v_requires_signing,
      'buyer_user_id', p_actor_user_id,
      'price_snapshot', v_snapshot
    )
  ) returning id into v_order_id;

  update public.event_competition_registration_carts set order_id = v_order_id where id = v_cart_id;

  insert into public.event_registrations (
    studio_id, event_id, ticket_type_id, client_id, user_id, order_id, status, payment_status,
    attendee_first_name, attendee_last_name, attendee_email, attendee_phone,
    quantity, unit_price, total_price, total_amount, currency, registration_source, source, notes
  ) values (
    v_event.studio_id, p_event_id, null, v_actor_client, p_actor_user_id, v_order_id,
    case when v_free_now then 'confirmed' else 'pending' end,
    case when v_free_now then 'paid' else 'pending' end,
    coalesce(nullif(v_buyer_first, ''), 'Competition'), coalesce(nullif(v_buyer_last, ''), 'Registrant'),
    v_buyer_email, v_buyer_phone,
    1, (v_total::numeric / 100), (v_total::numeric / 100), (v_total::numeric / 100), v_quote->>'currency',
    'public_event_page', 'competition_registration',
    case when v_studio_name is not null then 'Studio: ' || v_studio_name end
  ) returning id into v_registration_id;

  -- People -> roster snapshot + canonical competitor + admission attendee (one per competitor).
  v_sort := 0;
  for v_person in select x from jsonb_array_elements(p_draft->'people') x loop
    v_sort := v_sort + 1;
    v_user := null; v_client := null; v_instructor := null;
    v_email := nullif(left(lower(btrim(coalesce(v_person->>'email', ''))), 254), '');
    if v_email is not null and position('@' in v_email) <= 1 then v_email := null; end if;
    v_dob := case when coalesce(v_person->>'dateOfBirth', '') ~ '^\d{4}-\d{2}-\d{2}$' then (v_person->>'dateOfBirth')::date end;
    v_person_type := coalesce(nullif(v_person->>'personType', ''), 'dancer');
    v_primary_role := nullif(v_person->>'primaryRole', '');

    if coalesce(v_person->'isSelf' = 'true'::jsonb, false) then
      -- "This is me": the verified account anchors the competitor (LAUNCH-SEC-1C rules). It can never
      -- be combined with a staff anchor (that would bind the actor's account to someone else).
      if public._comp10c_uuid(v_person->>'anchorClientId') is not null
         or public._comp10c_uuid(v_person->>'anchorInstructorId') is not null then
        raise exception 'COMP10C_INVALID: a roster person cannot be both you and a linked studio record.';
      end if;
      if p_actor_user_id is null then
        raise exception 'COMP10C_SIGN_IN_REQUIRED: sign in to register yourself to your DanceFlow account.';
      end if;
      if v_actor_verified_email is null then
        raise exception 'COMP10C_IDENTITY_UNVERIFIED: verify your email before linking this registration to your account.';
      end if;
      v_user := p_actor_user_id;
      v_client := v_actor_client;
      v_instructor := v_actor_instructor;
      v_email := v_actor_verified_email;
    end if;
    if public._comp10c_uuid(v_person->>'anchorClientId') is not null
       or public._comp10c_uuid(v_person->>'anchorInstructorId') is not null then
      -- Studio-side anchoring of someone else: only an event manager, only their own studio's records.
      if not v_is_manager then
        raise exception 'COMP10C_FORBIDDEN: only event staff can link roster people to studio records.' using errcode = '42501';
      end if;
      v_client := coalesce(public._comp10c_uuid(v_person->>'anchorClientId'), v_client);
      v_instructor := coalesce(public._comp10c_uuid(v_person->>'anchorInstructorId'), v_instructor);
    end if;

    v_competitor_id := public._comp10c_resolve_competitor(
      p_event_id, v_user, v_client, v_instructor,
      left(btrim(v_person->>'firstName'), 100), left(btrim(v_person->>'lastName'), 100), v_email, v_dob,
      v_primary_role,
      case when nullif(btrim(coalesce(v_person->>'wsdcCompetitorId', '')), '') is not null
           then jsonb_build_object('wsdc_competitor_id', left(btrim(v_person->>'wsdcCompetitorId'), 40)) else '{}'::jsonb end,
      case when v_is_manager and (v_client is not null or v_instructor is not null) and v_user is null then 'staff' else 'registration' end,
      v_order_id);
    if v_competitor_map ? v_competitor_id::text then
      raise exception 'COMP10C_DUPLICATE_PERSON: the same person appears twice in the roster.';
    end if;
    v_competitor_map := v_competitor_map || jsonb_build_object(v_competitor_id::text, true);

    insert into public.event_competition_registration_cart_people (
      event_id, cart_id, first_name, last_name, email, phone, date_of_birth, person_type, sort_order,
      wsdc_competitor_id, primary_role, role_points_snapshot, competitor_id
    ) values (
      p_event_id, v_cart_id, left(btrim(v_person->>'firstName'), 100), left(btrim(v_person->>'lastName'), 100), v_email,
      nullif(left(btrim(coalesce(v_person->>'phone', '')), 40), ''), v_dob, v_person_type, v_sort,
      nullif(left(btrim(coalesce(v_person->>'wsdcCompetitorId', '')), 40), ''), v_primary_role, '{}'::jsonb, v_competitor_id
    ) returning id into v_cart_person_id;

    insert into public.event_registration_attendees (
      registration_id, event_id, ticket_type_id, first_name, last_name, email, attendee_role, sort_order
    ) values (
      v_registration_id, p_event_id, null, left(btrim(v_person->>'firstName'), 100), left(btrim(v_person->>'lastName'), 100),
      v_email, 'competitor', v_sort
    ) returning id into v_attendee_id;

    v_person_map := v_person_map || jsonb_build_object(v_person->>'clientId', jsonb_build_object(
      'cart_person_id', v_cart_person_id, 'competitor_id', v_competitor_id, 'attendee_id', v_attendee_id,
      'name', btrim(v_person->>'firstName') || ' ' || btrim(v_person->>'lastName'),
      'primary_role', v_primary_role, 'wsdc', nullif(btrim(coalesce(v_person->>'wsdcCompetitorId', '')), '')));
  end loop;

  -- Entries -> cart entry + order item + canonical entry + participants + dances.
  v_sort := 0;
  for v_entry in select x from jsonb_array_elements(p_draft->'entries') x loop
    v_sort := v_sort + 1;
    select c.id, c.name, c.entry_format into v_contest from public.event_competition_contests c
    where c.id = (v_entry->>'contestId')::uuid;
    select d.id, d.name, d.program_id into v_division from public.event_competition_divisions d
    where d.id = (v_entry->>'divisionId')::uuid;

    select coalesce(array_agg(v_person_map->(p)->>'name' order by o), '{}') into v_names
    from (select p, min(o) o from jsonb_array_elements_text(v_entry->'participantIds') with ordinality s(p, o) group by p) q;
    v_display := left(case
      when v_contest.entry_format = 'team' then btrim(v_entry->>'teamName')
      when cardinality(v_names) > 0 then array_to_string(v_names, ' / ')
      else v_contest.name || ' — ' || v_division.name end, 240);

    select coalesce(jsonb_agg(l), '[]'::jsonb), coalesce(sum((l->>'lineCents')::bigint), 0)
      into v_entry_lines, v_entry_cents
    from jsonb_array_elements(v_quote->'lines') l
    where l->>'clientEntryId' = v_entry->>'clientId' and l->>'lineType' <> 'discount';

    insert into public.event_competition_registration_cart_entries (
      event_id, cart_id, program_id, contest_id, division_id, display_name, routine_title, routine_duration_seconds,
      music_title, music_artist, notes, status, sort_order
    ) values (
      p_event_id, v_cart_id, v_division.program_id, v_contest.id, v_division.id, v_display,
      nullif(left(btrim(coalesce(v_entry->>'routineTitle', '')), 200), ''),
      case when coalesce(v_entry->>'routineDurationSeconds', '') ~ '^\d+$' and (v_entry->>'routineDurationSeconds')::bigint between 1 and 86400
           then (v_entry->>'routineDurationSeconds')::int end,
      nullif(left(btrim(coalesce(v_entry->>'musicTitle', '')), 200), ''),
      nullif(left(btrim(coalesce(v_entry->>'musicArtist', '')), 200), ''),
      nullif(left(btrim(coalesce(v_entry->>'notes', '')), 1000), ''),
      case when v_free_now then 'submitted' else 'checkout_pending' end, v_sort
    ) returning id into v_cart_entry_id;
    v_cart_entry_map := v_cart_entry_map || jsonb_build_object(v_entry->>'clientId', v_cart_entry_id);

    v_entry_id := gen_random_uuid();
    insert into public.event_order_items (
      order_id, event_id, item_type, reference_id, ticket_type_id, coach_slot_id, description, quantity,
      unit_price, total_price, currency, attendee_names, metadata
    ) values (
      v_order_id, p_event_id, 'competition_entry', v_entry_id, null, null,
      left(v_event.name || ' — ' || v_contest.name || ' — ' || v_division.name, 500), 1,
      (v_entry_cents::numeric / 100), (v_entry_cents::numeric / 100), v_quote->>'currency', to_jsonb(v_names),
      jsonb_build_object('revenue_class', 'competition_entry', 'registration_id', v_registration_id,
        'registration_cart_id', v_cart_id, 'cart_entry_id', v_cart_entry_id, 'contest_id', v_contest.id,
        'division_id', v_division.id, 'price_lines', v_entry_lines)
    ) returning id into v_item_id;

    insert into public.event_competition_entries (
      id, event_id, program_id, division_id, registration_id, order_id, order_item_id, registration_cart_id,
      display_name, represented_studio_name, status, eligibility_status, registration_channel,
      submitted_by_user_id, submitted_at, confirmed_at, sort_order, metadata
    ) values (
      v_entry_id, p_event_id, v_division.program_id, v_division.id, v_registration_id, v_order_id, v_item_id, v_cart_id,
      v_display, v_studio_name, case when v_free_now then 'confirmed' else 'pending' end, 'unverified',
      case when v_mode = 'studio' then 'studio' else 'student_self' end,
      p_actor_user_id, v_now, case when v_free_now then v_now end, v_sort,
      jsonb_build_object('cart_entry_id', v_cart_entry_id, 'contest_id', v_contest.id,
        'team_name', case when v_contest.entry_format = 'team' then btrim(v_entry->>'teamName') end,
        'routine_title', nullif(btrim(coalesce(v_entry->>'routineTitle', '')), ''),
        'routine_duration_seconds', case when coalesce(v_entry->>'routineDurationSeconds', '') ~ '^\d+$' then (v_entry->>'routineDurationSeconds')::bigint end,
        'music_title', nullif(btrim(coalesce(v_entry->>'musicTitle', '')), ''),
        'music_artist', nullif(btrim(coalesce(v_entry->>'musicArtist', '')), ''))
    );
    update public.event_competition_registration_cart_entries set official_entry_id = v_entry_id where id = v_cart_entry_id;
    v_entry_map := v_entry_map || jsonb_build_object(v_entry->>'clientId', v_entry_id);

    v_idx := 0;
    for v_pid in select p from (select p, min(o) o from jsonb_array_elements_text(v_entry->'participantIds') with ordinality s(p, o) group by p) q order by o loop
      v_idx := v_idx + 1;
      v_role := coalesce(nullif(v_entry->'participantRoles'->>v_pid, ''), 'dancer');
      insert into public.event_competition_registration_cart_entry_people (
        event_id, cart_id, cart_entry_id, cart_person_id, participant_role, sort_order
      ) values (
        p_event_id, v_cart_id, v_cart_entry_id, (v_person_map->v_pid->>'cart_person_id')::uuid, v_role, v_idx
      );
      insert into public.event_competition_entry_participants (
        event_id, entry_id, competitor_id, registration_attendee_id, participant_role, display_name,
        registry_member_id, competition_role_type, role_level_snapshot, sort_order
      ) values (
        p_event_id, v_entry_id, (v_person_map->v_pid->>'competitor_id')::uuid, (v_person_map->v_pid->>'attendee_id')::uuid,
        v_role, left(v_person_map->v_pid->>'name', 200), v_person_map->v_pid->>'wsdc',
        case when v_role in ('leader', 'follower') and v_person_map->v_pid->>'primary_role' is not null
             then case when v_person_map->v_pid->>'primary_role' = v_role then 'primary' else 'secondary' end end,
        jsonb_build_object('primary_role', v_person_map->v_pid->>'primary_role', 'registered_role', v_role), v_idx
      );
    end loop;

    v_idx := 0;
    for v_offering in select jsonb_array_elements_text(coalesce(v_quote->'effective'->(v_entry->>'clientId'), '[]'::jsonb)) loop
      v_idx := v_idx + 1;
      insert into public.event_competition_registration_cart_entry_dances (event_id, cart_id, cart_entry_id, division_dance_id)
      values (p_event_id, v_cart_id, v_cart_entry_id, v_offering::uuid);
      -- dance_key/label/fee/currency are copied from the offering by validate_competition_entry_dance_offering.
      insert into public.event_competition_entry_dances (event_id, entry_id, division_dance_id, dance_key, dance_label, status, sort_order)
      values (p_event_id, v_entry_id, v_offering::uuid, 'offering', 'Offering',
        case when v_free_now then 'confirmed' else 'registered' end, v_idx);
    end loop;
  end loop;

  -- Immutable price lines (fee rule details copied into metadata; fee_rule_id may later be nulled).
  insert into public.event_competition_registration_cart_price_lines (
    event_id, cart_id, cart_entry_id, fee_rule_id, line_type, description, quantity, unit_amount, line_amount, currency, metadata
  )
  select p_event_id, v_cart_id,
    case when l->>'clientEntryId' is not null then (v_cart_entry_map->>(l->>'clientEntryId'))::uuid end,
    (l->>'feeRuleId')::uuid, l->>'lineType', left(l->>'description', 500), (l->>'quantity')::int,
    ((l->>'unitCents')::numeric / 100), ((l->>'lineCents')::numeric / 100), l->>'currency',
    coalesce(l->'metadata', '{}'::jsonb) || jsonb_build_object('feeRuleId', l->>'feeRuleId', 'unitCents', (l->>'unitCents')::bigint,
      'lineCents', (l->>'lineCents')::bigint)
  from jsonb_array_elements(v_quote->'lines') l;

  -- Cart-level fee and discount lines as order items (existing add_on convention: discount totals 0).
  insert into public.event_order_items (
    order_id, event_id, item_type, reference_id, ticket_type_id, coach_slot_id, description, quantity,
    unit_price, total_price, currency, attendee_names, metadata
  )
  select v_order_id, p_event_id, 'add_on', null, null, null, left(v_event.name || ' — ' || (l->>'description'), 500),
    (l->>'quantity')::int,
    case when l->>'lineType' = 'discount' then 0 else ((l->>'unitCents')::numeric / 100) end,
    case when l->>'lineType' = 'discount' then 0 else ((l->>'lineCents')::numeric / 100) end,
    l->>'currency', '[]'::jsonb,
    jsonb_build_object('revenue_class', 'competition_entry', 'fee_rule_id', l->>'feeRuleId', 'line_type', l->>'lineType',
      'discount_amount', case when l->>'lineType' = 'discount' then ((l->>'lineCents')::numeric / 100) else 0 end,
      'price_line', l)
  from jsonb_array_elements(v_quote->'lines') l
  where l->>'clientEntryId' is null;

  -- Receipt-level registration items mirror the order items.
  insert into public.event_registration_items (registration_id, ticket_type_id, ticket_name_snapshot, quantity, unit_price, line_total)
  select v_registration_id, null, left(oi.description, 500), oi.quantity, oi.unit_price, oi.total_price
  from public.event_order_items oi where oi.order_id = v_order_id;

  return public._comp10c_result(v_cart_id, false);
end;
$$;

revoke all on function public.start_competition_registration(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.start_competition_registration(uuid, uuid, jsonb, uuid) to service_role;

-- Required documents signed for this order: the Phase 8 checkpoint is past signing AND every
-- required document has a signed assignment backed by a COMPLETED signing envelope of this
-- checkpoint (Phase 8A: only a completed envelope signs its assignment). Every currently
-- required document of the event must be part of the checkpoint.
create or replace function public._comp10c_signing_complete(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.event_signing_checkpoints cp
    where cp.order_id = p_order_id
      and cp.status in ('ready_for_payment', 'payment_started', 'completed')
      and cp.current_position >= cp.total_required
      and cp.total_required = cardinality(cp.requirement_ids)
      and (select count(distinct a.event_document_requirement_id)
           from public.document_assignments a
           join public.document_sign_envelopes env
             on env.assignment_id = a.id
            and env.event_signing_checkpoint_id = cp.id
            and env.event_document_requirement_id = a.event_document_requirement_id
            and env.status = 'completed'
           where a.event_signing_checkpoint_id = cp.id and a.event_order_id = p_order_id and a.status = 'signed'
             and a.event_document_requirement_id = any(cp.requirement_ids)) >= cp.total_required
      and (select count(*) from public.event_document_requirements r
           where r.event_id = cp.event_id and r.active and r.is_required and not (r.id = any(cp.requirement_ids))) = 0
  );
$$;

revoke all on function public._comp10c_signing_complete(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. PREPARE / ATTACH: payment window and provider binding
-- ---------------------------------------------------------------------------
create or replace function public.prepare_competition_registration_payment(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
begin
  select o.* into v_order from public.event_orders o where o.id = p_order_id for update;
  if v_order.id is null or coalesce(v_order.metadata->>'source', '') <> 'competition_registration' then
    raise exception 'COMP10C_ORDER_NOT_FOUND: competition order was not found.';
  end if;
  if v_order.status = 'confirmed' and v_order.payment_status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'state', 'finalized');
  end if;
  if v_order.status <> 'pending' or v_order.payment_status <> 'pending' then
    raise exception 'COMP10C_ORDER_NOT_PAYABLE: this registration is no longer awaiting payment.';
  end if;
  -- A bound Checkout Session decides the outcome (it may have been paid inside the hold with the
  -- webhook still in flight): never declare such an order expired here; the caller asks Stripe.
  if v_order.stripe_checkout_session_id is null and v_order.expires_at is not null and v_order.expires_at <= now() then
    raise exception 'COMP10C_EXPIRED: this registration hold has expired.';
  end if;
  if v_order.stripe_checkout_session_id is null
     and coalesce((v_order.metadata->>'requires_signing')::boolean, false) and not public._comp10c_signing_complete(v_order.id) then
    raise exception 'COMP10C_SIGNING_INCOMPLETE: required event documents must be signed before payment.';
  end if;
  if v_order.stripe_checkout_session_id is null and (v_order.expires_at is null or v_order.expires_at < now() + interval '31 minutes') then
    -- Stripe Checkout needs >= 30 minutes of life; re-open the window once signing is done.
    update public.event_orders set expires_at = now() + interval '40 minutes', updated_at = now()
    where id = v_order.id returning * into v_order;
    update public.event_competition_registration_carts set expires_at = v_order.expires_at, updated_at = now()
    where order_id = v_order.id;
  end if;
  return jsonb_build_object(
    'order_id', v_order.id,
    'state', case when round(v_order.total_amount * 100) = 0 then 'free' else 'payable' end,
    'event_id', v_order.event_id,
    'studio_id', v_order.studio_id,
    'organizer_id', v_order.organizer_id,
    'buyer_email', v_order.buyer_email,
    'amount_cents', round(v_order.total_amount * 100)::bigint,
    'currency', v_order.currency,
    'expires_at', v_order.expires_at,
    'checkout_session_id', v_order.stripe_checkout_session_id,
    'stripe_account_id', v_order.metadata->>'stripe_account_id',
    'entry_count', (select count(*) from public.event_competition_entries e where e.order_id = v_order.id)
  );
end;
$$;

create or replace function public.attach_competition_registration_checkout(
  p_order_id uuid,
  p_stripe_account_id text,
  p_checkout_session_id text,
  p_checkout_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_studio record;
begin
  if coalesce(p_stripe_account_id, '') !~ '^acct_[A-Za-z0-9]+$' or coalesce(p_checkout_session_id, '') !~ '^cs_[A-Za-z0-9_]+$' then
    raise exception 'COMP10C_BINDING_INVALID: provider identifiers are malformed.';
  end if;
  select o.* into v_order from public.event_orders o where o.id = p_order_id for update;
  if v_order.id is null or coalesce(v_order.metadata->>'source', '') <> 'competition_registration' then
    raise exception 'COMP10C_ORDER_NOT_FOUND: competition order was not found.';
  end if;
  if v_order.stripe_checkout_session_id is not null then
    if v_order.stripe_checkout_session_id = p_checkout_session_id and v_order.metadata->>'stripe_account_id' = p_stripe_account_id then
      return jsonb_build_object('order_id', v_order.id, 'attached', true, 'replay', true);
    end if;
    raise exception 'COMP10C_BINDING_CONFLICT: a different checkout session is already bound to this order.';
  end if;
  if v_order.status <> 'pending' or v_order.payment_status <> 'pending' then
    raise exception 'COMP10C_ORDER_NOT_PAYABLE: this registration is no longer awaiting payment.';
  end if;
  if v_order.expires_at is null or v_order.expires_at <= now() then
    raise exception 'COMP10C_EXPIRED: this registration hold has expired.';
  end if;
  if p_checkout_expires_at is null or p_checkout_expires_at <= now() or p_checkout_expires_at > v_order.expires_at + interval '1 minute' then
    raise exception 'COMP10C_BINDING_INVALID: checkout expiry is outside the registration hold.';
  end if;
  if coalesce((v_order.metadata->>'requires_signing')::boolean, false) and not public._comp10c_signing_complete(v_order.id) then
    raise exception 'COMP10C_SIGNING_INCOMPLETE: required event documents must be signed before payment.';
  end if;
  select s.stripe_connected_account_id, s.stripe_connect_onboarding_complete, s.stripe_connect_charges_enabled,
         s.stripe_connect_payouts_enabled into v_studio
  from public.studios s where s.id = v_order.studio_id;
  if v_studio.stripe_connected_account_id is distinct from p_stripe_account_id
     or v_studio.stripe_connect_onboarding_complete is not true
     or v_studio.stripe_connect_charges_enabled is not true
     or v_studio.stripe_connect_payouts_enabled is not true then
    raise exception 'COMP10C_BINDING_INVALID: checkout account is not the event studio''s ready connected account.';
  end if;
  if exists (select 1 from public.event_orders o where o.stripe_checkout_session_id = p_checkout_session_id and o.id <> v_order.id) then
    raise exception 'COMP10C_BINDING_CONFLICT: this checkout session is bound to another order.';
  end if;

  update public.event_orders
  set stripe_checkout_session_id = p_checkout_session_id,
      metadata = metadata || jsonb_build_object('stripe_account_id', p_stripe_account_id,
                                                'checkout_expires_at', p_checkout_expires_at),
      updated_at = now()
  where id = v_order.id;
  update public.event_registrations set stripe_checkout_session_id = p_checkout_session_id
  where order_id = v_order.id and stripe_checkout_session_id is null;
  update public.event_signing_checkpoints
  set status = 'payment_started', payment_started_at = coalesce(payment_started_at, now()), updated_at = now()
  where order_id = v_order.id and status = 'ready_for_payment';
  return jsonb_build_object('order_id', v_order.id, 'attached', true, 'replay', false);
end;
$$;

revoke all on function public.prepare_competition_registration_payment(uuid) from public, anon, authenticated;
revoke all on function public.attach_competition_registration_checkout(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.prepare_competition_registration_payment(uuid) to service_role;
grant execute on function public.attach_competition_registration_checkout(uuid, text, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 9. FINALIZE (verified webhook or free order) and RELEASE
-- ---------------------------------------------------------------------------
create or replace function public.finalize_competition_registration(
  p_order_id uuid,
  p_stripe_account_id text,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_amount_cents bigint,
  p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_registration record;
  v_total bigint;
  v_now timestamptz := now();
  v_outcome text;
begin
  select o.* into v_order from public.event_orders o where o.id = p_order_id for update;
  if v_order.id is null or coalesce(v_order.metadata->>'source', '') <> 'competition_registration' then
    raise exception 'COMP10C_ORDER_NOT_FOUND: competition order was not found.';
  end if;
  v_total := round(v_order.total_amount * 100)::bigint;
  select er.* into v_registration from public.event_registrations er where er.order_id = v_order.id
  order by er.created_at limit 1 for update;

  -- Free order (no provider evidence): only after signing, only while still pending.
  if p_checkout_session_id is null then
    if v_total <> 0 then
      raise exception 'COMP10C_SETTLEMENT_REQUIRED: a paid registration can only be finalized from verified payment evidence.';
    end if;
    if v_order.status = 'confirmed' and v_order.payment_status = 'paid' then
      return jsonb_build_object('order_id', v_order.id, 'outcome', 'already_finalized');
    end if;
    if v_order.status <> 'pending' then
      raise exception 'COMP10C_ORDER_NOT_PAYABLE: this registration is no longer pending.';
    end if;
    if coalesce((v_order.metadata->>'requires_signing')::boolean, false) and not public._comp10c_signing_complete(v_order.id) then
      raise exception 'COMP10C_SIGNING_INCOMPLETE: required event documents must be signed first.';
    end if;
    v_outcome := 'finalized';
  else
    -- Provider evidence must be bound to THIS order, studio account and snapshot amount.
    if v_order.stripe_checkout_session_id is distinct from p_checkout_session_id then
      raise exception 'COMP10C_BINDING_MISMATCH: checkout session is not bound to this order.';
    end if;
    if coalesce(v_order.metadata->>'stripe_account_id', '') = '' or v_order.metadata->>'stripe_account_id' is distinct from p_stripe_account_id then
      raise exception 'COMP10C_BINDING_MISMATCH: payment account is not the account bound to this order.';
    end if;
    if p_amount_cents is distinct from v_total or upper(coalesce(p_currency, '')) is distinct from upper(v_order.currency) then
      raise exception 'COMP10C_AMOUNT_MISMATCH: settled amount does not match the registration price snapshot.';
    end if;
    if coalesce(p_payment_intent_id, '') !~ '^pi_[A-Za-z0-9_]+$' then
      raise exception 'COMP10C_BINDING_INVALID: payment intent is missing.';
    end if;
    if v_order.payment_status = 'paid' then
      v_outcome := case when v_order.status = 'confirmed' then 'already_finalized' else 'already_recorded' end;
    elsif v_order.status in ('cancelled', 'expired') then
      v_outcome := 'late_payment_after_release';
    elsif coalesce((v_order.metadata->>'requires_signing')::boolean, false) and not public._comp10c_signing_complete(v_order.id) then
      v_outcome := 'signing_incomplete_payment_recorded';
    else
      v_outcome := 'finalized';
    end if;

    -- Money moved: record the evidence exactly once (unique per registration + session).
    insert into public.event_payments (
      registration_id, amount, currency, payment_method, status, source, stripe_checkout_session_id,
      stripe_payment_intent_id, external_reference, notes, stripe_account_id
    ) values (
      v_registration.id, (v_total::numeric / 100), upper(v_order.currency), 'stripe_checkout', 'paid', 'stripe',
      p_checkout_session_id, p_payment_intent_id, p_checkout_session_id,
      'Phase 10C competition registration (finalize_competition_registration).', p_stripe_account_id
    )
    on conflict (registration_id, stripe_checkout_session_id) where stripe_checkout_session_id is not null do nothing;

    if v_outcome in ('already_finalized', 'already_recorded') then
      return jsonb_build_object('order_id', v_order.id, 'outcome', v_outcome);
    end if;

    update public.event_orders
    set payment_status = 'paid', paid_at = coalesce(paid_at, v_now), stripe_payment_intent_id = p_payment_intent_id,
        metadata = case when v_outcome = 'finalized' then metadata
                        else metadata || jsonb_build_object('needs_review', v_outcome) end,
        updated_at = v_now
    where id = v_order.id;
    update public.event_registrations
    set payment_status = 'paid', stripe_payment_intent_id = p_payment_intent_id
    where order_id = v_order.id;

    if v_outcome <> 'finalized' then
      return jsonb_build_object('order_id', v_order.id, 'outcome', v_outcome);
    end if;
  end if;

  -- Activate exactly once.
  update public.event_orders
  set status = 'confirmed', payment_status = 'paid', paid_at = coalesce(paid_at, v_now), expires_at = null, updated_at = v_now
  where id = v_order.id;
  update public.event_registrations set status = 'confirmed', payment_status = 'paid' where order_id = v_order.id;
  update public.event_competition_entries
  set status = 'confirmed', confirmed_at = coalesce(confirmed_at, v_now), updated_at = v_now
  where order_id = v_order.id and status = 'pending';
  update public.event_competition_entry_dances d set status = 'confirmed', updated_at = v_now
  from public.event_competition_entries e
  where e.order_id = v_order.id and d.entry_id = e.id and d.status = 'registered';
  update public.event_signing_checkpoints
  set status = 'completed', completed_at = coalesce(completed_at, v_now), updated_at = v_now
  where order_id = v_order.id and status in ('ready_for_payment', 'payment_started');
  return jsonb_build_object('order_id', v_order.id, 'outcome', 'finalized');
end;
$$;

create or replace function public.release_competition_registration(
  p_order_id uuid,
  p_reason text,
  p_checkout_session_id text default null,
  p_stripe_account_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_status text;
  v_payment text;
begin
  if p_reason not in ('expired', 'failed', 'abandoned', 'attach_failed', 'signing_expired') then
    raise exception 'COMP10C_INVALID: unknown release reason.';
  end if;
  select o.* into v_order from public.event_orders o where o.id = p_order_id for update;
  if v_order.id is null or coalesce(v_order.metadata->>'source', '') <> 'competition_registration' then
    raise exception 'COMP10C_ORDER_NOT_FOUND: competition order was not found.';
  end if;
  -- Provider-originated releases must name the session (and account) bound to this order.
  if p_checkout_session_id is not null and v_order.stripe_checkout_session_id is distinct from p_checkout_session_id then
    raise exception 'COMP10C_BINDING_MISMATCH: checkout session is not bound to this order.';
  end if;
  if p_stripe_account_id is not null and v_order.metadata->>'stripe_account_id' is distinct from p_stripe_account_id then
    raise exception 'COMP10C_BINDING_MISMATCH: payment account is not the account bound to this order.';
  end if;
  if v_order.payment_status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'outcome', 'already_paid');
  end if;
  if v_order.status in ('cancelled', 'expired') then
    return jsonb_build_object('order_id', v_order.id, 'outcome', 'already_released');
  end if;

  v_status := case when p_reason in ('expired', 'signing_expired') then 'expired' else 'cancelled' end;
  v_payment := case when p_reason = 'failed' then 'failed' else 'unpaid' end;

  update public.event_orders
  set status = v_status, payment_status = v_payment, cancelled_at = coalesce(cancelled_at, now()),
      metadata = metadata || jsonb_build_object('release_reason', p_reason, 'released_at', now()), updated_at = now()
  where id = v_order.id;
  -- Cancelling the registration withdraws its pending entries (sync_competition_entries_from_registration);
  -- the cart follows the order (sync_competition_registration_cart_from_order).
  update public.event_registrations
  set status = 'cancelled', payment_status = case when p_reason = 'failed' then 'failed' else payment_status end,
      cancelled_at = coalesce(cancelled_at, now())
  where order_id = v_order.id and status in ('pending', 'waitlisted');
  update public.event_competition_entry_dances d set status = 'scratched', updated_at = now()
  from public.event_competition_entries e
  where e.order_id = v_order.id and d.entry_id = e.id and d.status = 'registered';
  update public.event_signing_checkpoints
  set status = case when v_status = 'expired' then 'expired' else 'cancelled' end, updated_at = now()
  where order_id = v_order.id and status in ('signing', 'ready_for_payment', 'payment_started');
  return jsonb_build_object('order_id', v_order.id, 'outcome', 'released', 'order_status', v_status);
end;
$$;

revoke all on function public.finalize_competition_registration(uuid, text, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.release_competition_registration(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.finalize_competition_registration(uuid, text, text, text, bigint, text) to service_role;
grant execute on function public.release_competition_registration(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Payment idempotency (shared with ordinary event checkout)
-- ---------------------------------------------------------------------------
create unique index event_payments_registration_checkout_session_uidx
  on public.event_payments(registration_id, stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;
create unique index event_payments_registration_payment_intent_uidx
  on public.event_payments(registration_id, stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- ---------------------------------------------------------------------------
-- 11. Accounting classification by order items (existing event-payment ledger)
-- ---------------------------------------------------------------------------
-- An order is homogeneous: either competition entry items (competition_entry, or add_on lines
-- written with revenue_class = competition_entry) or ordinary event items, never both. The
-- canonical ledger (accounting_upsert_entry, 20260715) keeps ONE active revenue category per source
-- row -- an upsert in another category voids the previous one -- so a payment cannot carry two
-- revenue classes; homogeneity is what makes "classify by order items" exact without double
-- counting. (DEV additionally carries uq_accounting_entries_event_payment_source, environment drift.)
create or replace function public._comp10c_order_item_class(p_item_type text, p_metadata jsonb)
returns text
language sql
immutable
as $$
  select case when p_item_type = 'competition_entry' or coalesce(p_metadata->>'revenue_class', '') = 'competition_entry'
              then 'competition_entry' else 'event' end;
$$;

revoke all on function public._comp10c_order_item_class(text, jsonb) from public, anon, authenticated;

create or replace function public._comp10c_guard_order_item_class()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.event_order_items oi
    where oi.order_id = new.order_id and oi.id <> new.id
      and public._comp10c_order_item_class(oi.item_type, oi.metadata)
          <> public._comp10c_order_item_class(new.item_type, new.metadata)
  ) then
    raise exception 'COMP10C_MIXED_ORDER: competition entries and ordinary event items cannot share one order.';
  end if;
  return new;
end;
$$;

revoke all on function public._comp10c_guard_order_item_class() from public, anon, authenticated;

create trigger event_order_items_comp10c_class_guard
  before insert or update of order_id, item_type, metadata on public.event_order_items
  for each row execute function public._comp10c_guard_order_item_class();

create or replace function public.sync_event_payment_accounting_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_studio_id uuid;
  v_organizer_id uuid;
  v_order_id uuid;
  v_fee_amount numeric;
  v_refund_amount numeric;
  v_net_amount numeric;
  v_competition boolean := false;
begin
  if tg_op = 'DELETE' then
    perform public.accounting_mark_source_voided('event_payments', old.id, 'Event payment source was deleted.');
    return old;
  end if;

  if new.status::text is distinct from 'paid' then
    perform public.accounting_mark_source_voided('event_payments', new.id, 'Event payment is not paid.');
    return new;
  end if;

  -- event_payments.event_id (20260502000600) is missing on DEV (known drift); read it without
  -- binding to the column so the trigger works on both shapes.
  v_event_id := nullif(to_jsonb(new)->>'event_id', '')::uuid;

  if new.registration_id is not null then
    select er.event_id, er.studio_id, er.order_id
      into v_event_id, v_studio_id, v_order_id
    from public.event_registrations er
    where er.id = new.registration_id
    limit 1;
  end if;

  if v_studio_id is null and v_organizer_id is null then
    select eo.studio_id, eo.organizer_id, coalesce(v_event_id, eo.event_id), coalesce(v_order_id, eo.id)
      into v_studio_id, v_organizer_id, v_event_id, v_order_id
    from public.event_orders eo
    where (new.stripe_checkout_session_id is not null and eo.stripe_checkout_session_id = new.stripe_checkout_session_id)
       or (new.stripe_payment_intent_id is not null and eo.stripe_payment_intent_id = new.stripe_payment_intent_id)
    limit 1;
  end if;

  if v_event_id is not null and v_studio_id is null and v_organizer_id is null then
    select e.studio_id, e.organizer_id into v_studio_id, v_organizer_id
    from public.events e where e.id = v_event_id limit 1;
  end if;

  if v_studio_id is null and v_organizer_id is null then
    return new;
  end if;

  -- Phase 10C: classify from the order's own (server-written, homogeneous) items, never from client input.
  if v_order_id is not null then
    v_competition := exists (
      select 1 from public.event_order_items oi
      where oi.order_id = v_order_id
        and public._comp10c_order_item_class(oi.item_type, oi.metadata) = 'competition_entry'
    );
  end if;

  v_fee_amount := coalesce(new.stripe_processing_fee_amount, 0)
    + coalesce(new.stripe_application_fee_amount, 0)
    + coalesce(new.platform_fee_amount, 0);
  v_refund_amount := coalesce(new.refund_amount, 0);
  v_net_amount := coalesce(new.amount, 0) - v_fee_amount - v_refund_amount;

  perform public.accounting_upsert_entry(
    v_studio_id, v_organizer_id, coalesce(new.created_at::date, current_date),
    'revenue', case when v_competition then 'competition_entry_revenue' else 'event_ticket_revenue' end,
    'credit', new.amount, v_fee_amount,
    v_refund_amount, v_net_amount, new.currency::text, new.payment_method::text,
    'event_payments', new.id, null, v_event_id, null,
    coalesce(new.stripe_payment_intent_id, new.processor_payment_intent_id,
      new.external_reference, new.processor_reference),
    coalesce(new.stripe_payment_intent_id, new.processor_payment_intent_id),
    coalesce(new.stripe_charge_id, new.processor_charge_id), new.stripe_invoice_id,
    case when v_competition then 'Competition entry revenue' else 'Event ticket revenue' end,
    jsonb_build_object(
      'event_payment_id', new.id,
      'registration_id', new.registration_id,
      'stripe_checkout_session_id', new.stripe_checkout_session_id,
      'stripe_balance_transaction_id', new.stripe_balance_transaction_id,
      'stripe_refund_id', new.stripe_refund_id,
      'stripe_processing_fee_amount', new.stripe_processing_fee_amount,
      'stripe_application_fee_amount', new.stripe_application_fee_amount,
      'platform_fee_amount', new.platform_fee_amount,
      'processor_reference', new.processor_reference,
      'source', new.source
    ), null
  );

  return new;
end;
$$;

revoke all on function public.sync_event_payment_accounting_entry() from public, anon, authenticated;
grant execute on function public.sync_event_payment_accounting_entry() to service_role;

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  if exists (select 1 from public.event_competition_entry_participants where competitor_id is null) then
    raise exception 'Phase 10C postflight: a participant has no competitor.';
  end if;
  if exists (select 1 from public.event_competition_programs where registration_status <> 'closed') then
    raise exception 'Phase 10C postflight: a program opened registration during the migration.';
  end if;
  if has_column_privilege('authenticated', 'public.event_competition_programs', 'registration_status', 'UPDATE')
     or has_column_privilege('authenticated', 'public.event_competition_programs', 'registration_status', 'INSERT')
     or has_column_privilege('anon', 'public.event_competition_programs', 'registration_status', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.event_competition_programs', 'name', 'UPDATE')
     or has_column_privilege('authenticated', 'public.event_competition_programs', 'profile_locked_at', 'UPDATE') then
    raise exception 'Phase 10C postflight: program column privileges are wrong.';
  end if;
  if has_table_privilege('anon', 'public.event_competition_competitors', 'SELECT')
     or has_table_privilege('authenticated', 'public.event_competition_competitors', 'INSERT')
     or has_column_privilege('authenticated', 'public.event_competition_competitors', 'client_id', 'UPDATE')
     or has_column_privilege('authenticated', 'public.event_competition_competitors', 'user_id', 'UPDATE') then
    raise exception 'Phase 10C postflight: competitor privileges are too broad.';
  end if;
  foreach v_fn in array array[
    'public.start_competition_registration(uuid, uuid, jsonb, uuid)',
    'public.prepare_competition_registration_payment(uuid)',
    'public.attach_competition_registration_checkout(uuid, text, text, timestamptz)',
    'public.finalize_competition_registration(uuid, text, text, text, bigint, text)',
    'public.release_competition_registration(uuid, text, text, text)',
    'public.quote_competition_registration(uuid, jsonb)'
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'Phase 10C postflight: % must be service-role only.', v_fn;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.open_competition_registration(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public._comp10c_quote(uuid, jsonb, timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._comp10c_resolve_competitor(uuid, uuid, uuid, uuid, text, text, text, date, text, jsonb, text, uuid)', 'EXECUTE') then
    raise exception 'Phase 10C postflight: internal function exposed.';
  end if;
  if not exists (select 1 from public.accounting_categories where key = 'competition_entry_revenue' and active) then
    raise exception 'Phase 10C postflight: competition_entry_revenue category missing.';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
