-- Rollback for 20261109090000_phase10c_competitor_registration.sql
--
-- Restores the exact pre-10C schema: no competitors table / competitor_id / order_item_id / cart
-- idempotency columns / program registration lifecycle columns, the seven 10A public catalog
-- policies, the reviewed bodies of sync_event_payment_accounting_entry and
-- validate_competition_entry_registration_links (and its trigger column list), no event_payments
-- uniqueness indexes, no competition_entry_revenue category.
--
-- It REFUSES, changing nothing, when 10C state that is real history exists: a registration created
-- by start_competition_registration, a competitor that did not come from the backfill, accounting
-- posted to competition_entry_revenue, or a program whose registration is open. Roll the
-- APPLICATION back first (the 10C app calls the functions removed here). After a real 10C launch,
-- forward-fix instead of rolling back.

begin;

do $$
declare
  v_carts int;
  v_competitors int;
  v_accounting int;
  v_open int;
begin
  select count(*) into v_carts from public.event_competition_registration_carts where client_request_id is not null;
  select count(*) into v_competitors from public.event_competition_competitors where created_via <> 'backfill';
  select count(*) into v_accounting from public.accounting_entries where category = 'competition_entry_revenue';
  select count(*) into v_open from public.event_competition_programs where registration_status = 'open';
  if v_carts > 0 or v_competitors > 0 or v_accounting > 0 or v_open > 0 then
    raise exception 'Phase 10C rollback refused: % 10C registrations, % registered competitors, % competition revenue entries, % programs open for registration exist.',
      v_carts, v_competitors, v_accounting, v_open;
  end if;
end $$;

-- 11. Accounting trigger body (reviewed accounting-hardening definition, verbatim).
create or replace function public.sync_event_payment_accounting_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_event_id uuid;
  v_studio_id uuid;
  v_organizer_id uuid;
  v_fee_amount numeric;
  v_refund_amount numeric;
  v_net_amount numeric;
begin
  if tg_op = 'DELETE' then
    perform public.accounting_mark_source_voided('event_payments', old.id, 'Event payment source was deleted.');
    return old;
  end if;

  if new.status::text is distinct from 'paid' then
    perform public.accounting_mark_source_voided('event_payments', new.id, 'Event payment is not paid.');
    return new;
  end if;

  v_event_id := new.event_id;

  if new.registration_id is not null then
    select er.event_id, er.studio_id
      into v_event_id, v_studio_id
    from public.event_registrations er
    where er.id = new.registration_id
    limit 1;
  end if;

  if v_studio_id is null and v_organizer_id is null then
    select eo.studio_id, eo.organizer_id, coalesce(v_event_id, eo.event_id)
      into v_studio_id, v_organizer_id, v_event_id
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

  v_fee_amount := coalesce(new.stripe_processing_fee_amount, 0)
    + coalesce(new.stripe_application_fee_amount, 0)
    + coalesce(new.platform_fee_amount, 0);
  v_refund_amount := coalesce(new.refund_amount, 0);
  v_net_amount := coalesce(new.amount, 0) - v_fee_amount - v_refund_amount;

  perform public.accounting_upsert_entry(
    v_studio_id, v_organizer_id, coalesce(new.created_at::date, current_date),
    'revenue', 'event_ticket_revenue', 'credit', new.amount, v_fee_amount,
    v_refund_amount, v_net_amount, new.currency::text, new.payment_method::text,
    'event_payments', new.id, null, v_event_id, null,
    coalesce(new.stripe_payment_intent_id, new.processor_payment_intent_id,
      new.external_reference, new.processor_reference),
    coalesce(new.stripe_payment_intent_id, new.processor_payment_intent_id),
    coalesce(new.stripe_charge_id, new.processor_charge_id), new.stripe_invoice_id,
    'Event ticket revenue',
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
$function$;

drop trigger event_order_items_comp10c_class_guard on public.event_order_items;
drop function public._comp10c_guard_order_item_class();
drop function public._comp10c_order_item_class(text, jsonb);

-- 10. Payment uniqueness.
drop index public.event_payments_registration_payment_intent_uidx;
drop index public.event_payments_registration_checkout_session_uidx;

-- 9 / 8 / 7 / 6. Registration lifecycle functions.
drop function public.release_competition_registration(uuid, text, text, text);
drop function public.finalize_competition_registration(uuid, text, text, text, bigint, text);
drop function public.attach_competition_registration_checkout(uuid, text, text, timestamptz);
drop function public.prepare_competition_registration_payment(uuid);
drop function public._comp10c_signing_complete(uuid);
drop function public.start_competition_registration(uuid, uuid, jsonb, uuid);
drop function public._comp10c_result(uuid, boolean);
drop function public.quote_competition_registration(uuid, jsonb);
drop function public._comp10c_quote(uuid, jsonb, timestamptz);
drop function public._comp10c_allowed_roles(text);
drop function public._comp10c_uuid(text);
drop function public.close_competition_registration(uuid);
drop function public.open_competition_registration(uuid);
drop function public._comp10c_actor_can_manage(uuid, uuid);

-- 5. Public catalog policies: the reviewed 10A / cart-foundation definitions.
drop policy competition_programs_public_registration_read on public.event_competition_programs;
create policy competition_programs_public_registration_read on public.event_competition_programs
  for select to public using (
    status in ('configured', 'active') and exists (
      select 1 from public.events e where e.id = event_id and e.status = 'published'
        and e.visibility in ('public', 'unlisted') and e.registration_required
    )
  );

drop policy competition_registration_rules_public_read on public.event_competition_contest_registration_rules;
create policy competition_registration_rules_public_read on public.event_competition_contest_registration_rules
  for select to public using (
    registration_open and exists (
      select 1 from public.events e
      where e.id = event_id and e.status = 'published'
        and e.visibility in ('public', 'unlisted') and e.registration_required
    )
  );

drop policy competition_fee_rules_public_read on public.event_competition_fee_rules;
create policy competition_fee_rules_public_read on public.event_competition_fee_rules
  for select to public using (
    active and exists (
      select 1 from public.events e
      where e.id = event_id and e.status = 'published'
        and e.visibility in ('public', 'unlisted') and e.registration_required
    )
  );

drop policy competition_contests_public_registration_read on public.event_competition_contests;
create policy competition_contests_public_registration_read on public.event_competition_contests
  for select to public using (
    event_competition_contests.status = 'open'
    and exists (
      select 1
      from public.event_competition_contest_registration_rules r
      join public.event_competition_programs p
        on p.id = event_competition_contests.program_id
       and p.event_id = event_competition_contests.event_id
      join public.events e on e.id = event_competition_contests.event_id
      where r.contest_id = event_competition_contests.id
        and r.event_id = event_competition_contests.event_id
        and r.registration_open
        and p.status in ('configured', 'active')
        and e.status = 'published'
        and e.visibility in ('public', 'unlisted')
        and e.registration_required
    )
  );

drop policy competition_divisions_public_registration_read on public.event_competition_divisions;
create policy competition_divisions_public_registration_read on public.event_competition_divisions
  for select to public using (
    event_competition_divisions.status = 'open'
    and exists (
      select 1
      from public.event_competition_contest_registration_rules r
      join public.event_competition_contests c
        on c.id = r.contest_id
       and c.event_id = r.event_id
      join public.event_competition_programs p
        on p.id = event_competition_divisions.program_id
       and p.event_id = event_competition_divisions.event_id
      join public.events e on e.id = event_competition_divisions.event_id
      where r.contest_id = event_competition_divisions.contest_id
        and r.event_id = event_competition_divisions.event_id
        and r.registration_open
        and c.status = 'open'
        and p.status in ('configured', 'active')
        and e.status = 'published'
        and e.visibility in ('public', 'unlisted')
        and e.registration_required
    )
  );

drop policy competition_dances_public_registration_read on public.event_competition_dances;
create policy competition_dances_public_registration_read on public.event_competition_dances
  for select to public using (
    event_competition_dances.active
    and exists (
      select 1
      from public.event_competition_programs p
      join public.events e on e.id = event_competition_dances.event_id
      where p.id = event_competition_dances.program_id
        and p.event_id = event_competition_dances.event_id
        and p.status in ('configured', 'active')
        and e.status = 'published'
        and e.visibility in ('public', 'unlisted')
        and e.registration_required
    )
  );

drop policy competition_division_dances_public_registration_read on public.event_competition_division_dances;
create policy competition_division_dances_public_registration_read on public.event_competition_division_dances
  for select to public using (
    event_competition_division_dances.active
    and exists (
      select 1
      from public.event_competition_divisions d
      join public.event_competition_contest_registration_rules r
        on r.contest_id = d.contest_id
       and r.event_id = d.event_id
      join public.event_competition_contests c
        on c.id = d.contest_id
       and c.event_id = d.event_id
      join public.event_competition_programs p
        on p.id = d.program_id
       and p.event_id = d.event_id
      join public.events e on e.id = d.event_id
      where d.id = event_competition_division_dances.division_id
        and d.event_id = event_competition_division_dances.event_id
        and d.status = 'open'
        and r.registration_open
        and c.status = 'open'
        and p.status in ('configured', 'active')
        and e.status = 'published'
        and e.visibility in ('public', 'unlisted')
        and e.registration_required
    )
  );

drop function public.competition_offering_registrable(uuid);
drop function public.competition_division_registrable(uuid);
drop function public.competition_contest_registrable(uuid);
drop function public.competition_registration_event_open(uuid);
drop function public.competition_registration_program_open(uuid, uuid);

-- Dropping the lifecycle columns drops their column privileges; the remaining grants are the
-- 10B set (every non-profile column for authenticated insert/update).
alter table public.event_competition_programs drop constraint event_competition_programs_registration_status_check;
alter table public.event_competition_programs
  drop column registration_closed_at,
  drop column registration_opened_at,
  drop column registration_status;

-- 4. Cart idempotency columns and entry <-> order item linkage.
drop index public.event_competition_registration_carts_request_uidx;
alter table public.event_competition_registration_carts drop constraint event_competition_registration_carts_request_pair_check;
alter table public.event_competition_registration_carts
  drop column price_snapshot,
  drop column priced_at,
  drop column buyer_client_id,
  drop column buyer_user_id,
  drop column request_fingerprint,
  drop column client_request_id;

drop trigger validate_competition_entry_registration_links on public.event_competition_entries;
create or replace function public.validate_competition_entry_registration_links()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  linked_registration_event_id uuid;
  linked_registration_order_id uuid;
  linked_order_event_id uuid;
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

  return new;
end;
$function$;
create trigger validate_competition_entry_registration_links
  before insert or update of event_id, registration_id, order_id
  on public.event_competition_entries
  for each row execute function public.validate_competition_entry_registration_links();

drop index public.event_competition_entries_order_item_uidx;
alter table public.event_competition_entries drop column order_item_id;

-- 3. Participants / roster -> competitor.
alter table public.event_competition_registration_cart_people drop constraint event_competition_registration_cart_people_competitor_fk;
alter table public.event_competition_registration_cart_people drop column competitor_id;

drop trigger event_competition_entry_participants_competitor on public.event_competition_entry_participants;
drop function public._comp10c_participant_competitor();
drop index public.event_competition_entry_participants_competitor_idx;
alter table public.event_competition_entry_participants drop constraint event_competition_entry_participants_entry_competitor_key;
alter table public.event_competition_entry_participants drop constraint event_competition_entry_participants_competitor_fk;
alter table public.event_competition_entry_participants drop column competitor_id;

-- 2. Competitors.
drop function public._comp10c_resolve_competitor(uuid, uuid, uuid, uuid, text, text, text, date, text, jsonb, text, uuid);
drop table public.event_competition_competitors;
drop function public._comp10c_competitor_guard();

-- 1. Accounting category.
delete from public.accounting_categories where key = 'competition_entry_revenue';

do $$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.sync_event_payment_accounting_entry()'::regprocedure)
       is distinct from '46b3b768b1a11984588f8cac38e64a67' then
    raise exception 'Phase 10C rollback postflight: sync_event_payment_accounting_entry body was not restored exactly.';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.validate_competition_entry_registration_links()'::regprocedure)
       is distinct from 'ed6183835a3166d8d9967a799c1f5054' then
    raise exception 'Phase 10C rollback postflight: validate_competition_entry_registration_links body was not restored exactly.';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and (p.proname like '\_comp10c\_%' or p.proname in (
               'competition_registration_program_open', 'competition_registration_event_open',
               'start_competition_registration', 'prepare_competition_registration_payment',
               'attach_competition_registration_checkout', 'finalize_competition_registration',
               'release_competition_registration', 'quote_competition_registration',
               'open_competition_registration', 'close_competition_registration',
               'competition_contest_registrable', 'competition_division_registrable', 'competition_offering_registrable'))) then
    raise exception 'Phase 10C rollback postflight: a 10C function remains.';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
