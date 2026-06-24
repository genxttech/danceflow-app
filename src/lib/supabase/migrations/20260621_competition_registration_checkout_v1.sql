-- Competition Registration Checkout V1
-- Cross-event cart protection and corrected random-partner defaults.
-- Save in: src/lib/supabase/migrations/20260621_competition_registration_checkout_v1.sql

begin;

alter table public.event_competition_entries
  drop constraint if exists event_competition_entries_registration_cart_id_fkey;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'event_competition_entries_registration_cart_fk'
  ) then
    alter table public.event_competition_entries
      add constraint event_competition_entries_registration_cart_fk
      foreign key (registration_cart_id, event_id)
      references public.event_competition_registration_carts(id, event_id) on delete restrict;
  end if;
end $$;

create or replace function public.default_competition_registration_rule(target_contest_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  contest_row record;
  discipline text;
  dance_mode text;
  pricing text;
  participant_min integer;
  participant_max integer;
  terminology_value jsonb;
begin
  select c.id, c.event_id, c.program_id, c.contest_type, c.entry_format, p.discipline_family
  into contest_row
  from public.event_competition_contests c
  join public.event_competition_programs p on p.id = c.program_id
  where c.id = target_contest_id;
  if not found then return; end if;

  discipline := contest_row.discipline_family;
  dance_mode := case
    when contest_row.contest_type = 'single_dance' then 'individual'
    when contest_row.contest_type in ('showdance', 'cabaret', 'formation', 'line_dance', 'team', 'spotlight') then 'routine'
    when contest_row.contest_type = 'exhibition' then 'none'
    else 'prescribed_set'
  end;
  pricing := case when dance_mode = 'individual' then 'per_dance' else 'flat_entry' end;
  participant_min := case
    when contest_row.entry_format in ('solo', 'random_partner') then 1
    when contest_row.entry_format = 'team' then 2
    else 2
  end;
  participant_max := case
    when contest_row.entry_format in ('solo', 'random_partner') then 1
    when contest_row.entry_format = 'team' then 100
    else 2
  end;
  terminology_value := case
    when discipline = 'ballroom' then '{"division_label":"Division","skill_label":"Level","age_label":"Age Category","partner_label":"Partner","dance_label":"Dance"}'::jsonb
    when discipline = 'country' then '{"division_label":"Division","skill_label":"Skill Division","age_label":"Age Division","partner_label":"Dance Partner","dance_label":"Dance"}'::jsonb
    when discipline = 'showcase' then '{"division_label":"Showcase Category","skill_label":"Level","age_label":"Age Category","partner_label":"Performance Partner","dance_label":"Routine Style"}'::jsonb
    else '{}'::jsonb
  end;

  insert into public.event_competition_contest_registration_rules (
    event_id, program_id, contest_id, dance_selection_mode, pricing_method,
    minimum_dances, minimum_participants, maximum_participants,
    requires_routine_title, requires_music, requires_duration, terminology
  ) values (
    contest_row.event_id, contest_row.program_id, contest_row.id, dance_mode, pricing,
    case when dance_mode = 'individual' then 1 else null end,
    participant_min, participant_max,
    dance_mode = 'routine', dance_mode = 'routine', dance_mode = 'routine', terminology_value
  ) on conflict (contest_id) do nothing;
end;
$$;

update public.event_competition_contest_registration_rules r
set minimum_participants = 1, maximum_participants = 1, updated_at = now()
from public.event_competition_contests c
where c.id = r.contest_id
  and c.entry_format = 'random_partner'
  and r.minimum_participants = 2
  and r.maximum_participants = 2;

create or replace function public.sync_competition_registration_cart_from_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'confirmed' and new.payment_status = 'paid' then
    update public.event_competition_registration_carts
    set status = 'submitted', submitted_at = coalesce(submitted_at, now()), updated_at = now()
    where order_id = new.id and status = 'checkout_pending';
    update public.event_competition_registration_cart_entries ce
    set status = 'submitted', updated_at = now()
    from public.event_competition_registration_carts c
    where c.order_id = new.id and ce.cart_id = c.id and ce.status = 'checkout_pending';
  elsif new.status in ('cancelled', 'expired') then
    update public.event_competition_registration_carts
    set status = case when new.status = 'expired' then 'expired' else 'cancelled' end, updated_at = now()
    where order_id = new.id and status in ('draft', 'checkout_pending');
    update public.event_competition_registration_cart_entries ce
    set status = 'cancelled', updated_at = now()
    from public.event_competition_registration_carts c
    where c.order_id = new.id and ce.cart_id = c.id and ce.status in ('draft', 'quoted', 'checkout_pending');
  end if;
  return new;
end;
$$;

drop trigger if exists sync_competition_registration_cart_from_order on public.event_orders;
create trigger sync_competition_registration_cart_from_order
after update of status, payment_status on public.event_orders
for each row execute function public.sync_competition_registration_cart_from_order();

revoke all on function public.default_competition_registration_rule(uuid) from public;
revoke all on function public.sync_competition_registration_cart_from_order() from public;

comment on column public.event_competition_entries.registration_cart_id is
  'Source competition registration cart; composite foreign key prevents cross-event linkage.';

notify pgrst, 'reload schema';
commit;
