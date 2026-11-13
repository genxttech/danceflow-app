-- Website Embeds settings -- database regression suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY).
-- Covers 20270216090000_website_embed_settings.sql. One transaction with synthetic fixtures, rolled back by an always-raising final block:
-- "EMBED SETTINGS SUITE PASS (<n> checks)" or "EMBED SETTINGS SUITE FAIL: ...". Refuses to run unless embedtest.local = 'on'.
-- Privileges are asserted with has_*_privilege; role-switched calls only call functions that are granted to that role.
begin;
do $$ begin
  if coalesce(current_setting('embedtest.local', true), '') <> 'on' then
    raise exception 'embed settings suite refused: set embedtest.local = ''on'' only on a disposable local stack';
  end if;
end $$;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.val_as(p_role text, p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_role)::text end, true);
  begin execute format('set local role %I', p_role); execute p_sql into v;
  exception when others then v := 'ERR ' || sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

-- fixtures: studio A (public, active), studio B (public, trialing), studio P (private)
insert into auth.users (id, email) values
  ('e0000000-0000-4000-8000-0000000000a1', 'ownerA@embed.test'), ('e0000000-0000-4000-8000-0000000000a2', 'instrA@embed.test'),
  ('e0000000-0000-4000-8000-0000000000b1', 'ownerB@embed.test');
insert into public.profiles (id) select id from auth.users where email like '%@embed.test' on conflict do nothing;
insert into public.studios (id, name, slug, public_directory_enabled, subscription_status) values
  ('e1000000-0000-4000-8000-00000000000a', 'Embed A', 'embed-a', true, 'active'),
  ('e1000000-0000-4000-8000-00000000000b', 'Embed B', 'embed-b', true, 'trialing'),
  ('e1000000-0000-4000-8000-00000000000c', 'Embed P', 'embed-p', false, 'active');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('e0000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-00000000000a', 'studio_owner', true),
  ('e0000000-0000-4000-8000-0000000000a2', 'e1000000-0000-4000-8000-00000000000a', 'instructor', true),
  ('e0000000-0000-4000-8000-0000000000b1', 'e1000000-0000-4000-8000-00000000000b', 'studio_owner', true);

-- defaults
select pg_temp.chk('no row: embeds on, events on, details off',
  (select embeds_enabled and show_events and not show_class_description and not show_class_price and default_view = 'agenda' from public.public_studio_embed_settings('embed-a')));
select pg_temp.chk('private studio returns no settings', not exists (select 1 from public.public_studio_embed_settings('embed-p')));
select pg_temp.chk('unknown slug returns nothing', not exists (select 1 from public.public_studio_embed_settings('nope')));

-- privileges
select pg_temp.chk('table has no API privileges', not has_table_privilege('anon', 'public.studio_embed_settings', 'select') and not has_table_privilege('authenticated', 'public.studio_embed_settings', 'select') and not has_table_privilege('authenticated', 'public.studio_embed_settings', 'insert'));
select pg_temp.chk('anon cannot execute get/set', not has_function_privilege('anon', 'public.get_studio_embed_settings(uuid)', 'execute') and not has_function_privilege('anon', 'public.set_studio_embed_settings(uuid,boolean,boolean,boolean,boolean,text,text,text)', 'execute'));
select pg_temp.chk('anon can execute the public functions', has_function_privilege('anon', 'public.public_studio_embed_settings(text)', 'execute') and has_function_privilege('anon', 'public.public_group_class_extras(text,uuid[])', 'execute'));
select pg_temp.chk('helper is not callable by API roles', not has_function_privilege('authenticated', 'public._embed_can_manage(uuid)', 'execute'));

-- authorization
select pg_temp.chk('owner can save settings',
  pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$select 'saved' from (select public.set_studio_embed_settings('e1000000-0000-4000-8000-00000000000a', false, false, true, true, 'month', 'dark', '#112233')) s$q$) = 'saved');
select pg_temp.chk('saved values are public', (select not embeds_enabled and not show_events and show_class_description and show_class_price and default_view = 'month' and default_theme = 'dark' and default_accent = '#112233' from public.public_studio_embed_settings('embed-a')));
select pg_temp.chk('instructor of the same studio is refused', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a2', $q$select 'saved' from (select public.set_studio_embed_settings('e1000000-0000-4000-8000-00000000000a', true, true, false, false, 'agenda', 'light', null)) s$q$) like 'ERR 42501%');
select pg_temp.chk('owner of another studio is refused', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', $q$select 'saved' from (select public.set_studio_embed_settings('e1000000-0000-4000-8000-00000000000a', true, true, false, false, 'agenda', 'light', null)) s$q$) like 'ERR 42501%');
select pg_temp.chk('owner of another studio cannot read it', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', $q$select count(*)::text from public.get_studio_embed_settings('e1000000-0000-4000-8000-00000000000a')$q$) like 'ERR 42501%');
select pg_temp.chk('refused writes changed nothing', (select not embeds_enabled and default_view = 'month' from public.public_studio_embed_settings('embed-a')));
select pg_temp.chk('owner reads own settings', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$select default_theme from public.get_studio_embed_settings('e1000000-0000-4000-8000-00000000000a')$q$) = 'dark');
select pg_temp.chk('bad view is rejected by the table check', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$select 'saved' from (select public.set_studio_embed_settings('e1000000-0000-4000-8000-00000000000a', true, true, false, false, 'sideways', 'light', null)) s$q$) like 'ERR 23514%');
select pg_temp.chk('bad accent is rejected by the table check', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$select 'saved' from (select public.set_studio_embed_settings('e1000000-0000-4000-8000-00000000000a', true, true, false, false, 'agenda', 'light', 'red;}')) s$q$) like 'ERR 23514%');
select pg_temp.chk('a signed-out caller is refused', pg_temp.val_as('authenticated', null, $q$select count(*)::text from public.get_studio_embed_settings('e1000000-0000-4000-8000-00000000000a')$q$) like 'ERR 42501%');

-- class extras: a public class with a series description and a direct price
insert into public.group_class_series (id, studio_id, title, description, timezone, weekdays, interval_weeks, starts_on, occurrence_count, local_start_time, duration_minutes, default_roster_capacity, publicly_discoverable, self_enrollment_allowed, accepted_funding_types, direct_payment_amount)
values ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000a', 'Embed Class', '  Bring flat shoes.  ', 'America/New_York', array[2], 1, '2030-01-01', 1, '19:00', 60, 5, true, true, array['direct_payment'], 20);
insert into public.appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, roster_capacity, group_class_series_id, series_occurrence_index, occurrence_original_start, notes)
values ('e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000a', 'group_class', 'Embed Class', '2030-01-01 19:00-05', '2030-01-01 20:00-05', 'scheduled', 5, 'e2000000-0000-4000-8000-000000000001', 1, '2030-01-01 19:00-05', 'PRIVATE NOTE'),
       ('e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-00000000000a', 'group_class', 'Not Public', '2030-01-02 19:00-05', '2030-01-02 20:00-05', 'scheduled', 5, null, null, null, 'PRIVATE NOTE');
insert into public.group_class_enrollment_policies (studio_id, appointment_id, publicly_discoverable, self_enrollment_allowed, accepted_funding_types, direct_payment_amount) values
  ('e1000000-0000-4000-8000-00000000000a', 'e3000000-0000-4000-8000-000000000001', true, true, array['direct_payment'], 20);

-- embeds are still OFF for studio A here, so the kill switch silences extras first
select pg_temp.chk('kill switch: extras are empty while embeds are off', not exists (select 1 from public.public_group_class_extras('embed-a', array['e3000000-0000-4000-8000-000000000001']::uuid[])));
update public.studio_embed_settings set embeds_enabled = true where studio_id = 'e1000000-0000-4000-8000-00000000000a';
select pg_temp.chk('extras: description trimmed and price shown when both flags are on',
  (select description = 'Bring flat shoes.' and price_amount = 20 from public.public_group_class_extras('embed-a', array['e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002']::uuid[]) where appointment_id = 'e3000000-0000-4000-8000-000000000001'));
select pg_temp.chk('extras: a non-public class is never returned', not exists (select 1 from public.public_group_class_extras('embed-a', array['e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002']::uuid[]) where appointment_id = 'e3000000-0000-4000-8000-000000000002'));
select pg_temp.chk('extras: never leaks the private note', not exists (select 1 from public.public_group_class_extras('embed-a', array['e3000000-0000-4000-8000-000000000001']::uuid[]) e where e::text like '%PRIVATE%'));
select pg_temp.chk('extras: another studio slug returns nothing', not exists (select 1 from public.public_group_class_extras('embed-b', array['e3000000-0000-4000-8000-000000000001']::uuid[])));
select pg_temp.chk('extras: anon can call it', pg_temp.val_as('anon', null, $q$select count(*)::text from public.public_group_class_extras('embed-a', array['e3000000-0000-4000-8000-000000000001']::uuid[])$q$) = '1');
update public.studio_embed_settings set show_class_description = false where studio_id = 'e1000000-0000-4000-8000-00000000000a';
select pg_temp.chk('description flag off: description null, price still shown', (select description is null and price_amount = 20 from public.public_group_class_extras('embed-a', array['e3000000-0000-4000-8000-000000000001']::uuid[])));
update public.studio_embed_settings set show_class_description = true, show_class_price = false where studio_id = 'e1000000-0000-4000-8000-00000000000a';
select pg_temp.chk('price flag off: price null, description shown', (select description = 'Bring flat shoes.' and price_amount is null from public.public_group_class_extras('embed-a', array['e3000000-0000-4000-8000-000000000001']::uuid[])));
update public.studio_embed_settings set show_class_price = true where studio_id = 'e1000000-0000-4000-8000-00000000000a';
update public.group_class_enrollment_policies set accepted_funding_types = array['package'], direct_payment_amount = null where appointment_id = 'e3000000-0000-4000-8000-000000000001';
select pg_temp.chk('no direct payment: no price advertised', (select price_amount is null from public.public_group_class_extras('embed-a', array['e3000000-0000-4000-8000-000000000001']::uuid[])));
update public.studios set public_directory_enabled = false where id = 'e1000000-0000-4000-8000-00000000000a';
select pg_temp.chk('studio leaving the directory: settings and extras vanish', not exists (select 1 from public.public_studio_embed_settings('embed-a')) and not exists (select 1 from public.public_group_class_extras('embed-a', array['e3000000-0000-4000-8000-000000000001']::uuid[])));

do $$
declare v_fail text; v_n int;
begin
  select count(*) into v_n from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is not null then raise exception 'EMBED SETTINGS SUITE FAIL: %', v_fail; end if;
  raise exception 'EMBED SETTINGS SUITE PASS (% checks)', v_n;
end $$;
rollback;
