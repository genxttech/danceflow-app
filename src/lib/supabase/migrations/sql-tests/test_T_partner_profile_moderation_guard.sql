-- Suite for 20270213090000_partner_profile_moderation_guard.sql. LOCAL / DISPOSABLE databases only.
-- Runs in one transaction and rolls back. Any failed check raises and stops psql (ON_ERROR_STOP=1).
-- Before the migration, T2 and T3 fail (the self-approval defect); after it, every check passes.
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('bbbbbbbb-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dancer-a@example.test', now(), now()),
  ('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dancer-b@example.test', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true); -- older auth.uid() bodies read this
  execute 'set local role authenticated';
end;
$$;

create function pg_temp.status_of(p_uid uuid) returns text language sql security definer as $$
  select moderation_status from public.dancer_partner_profiles where user_id = p_uid;
$$;
grant execute on function pg_temp.status_of(uuid) to authenticated;

create function pg_temp.profile_of(p_uid uuid) returns uuid language sql security definer as $$
  select id from public.dancer_partner_profiles where user_id = p_uid;
$$;
grant execute on function pg_temp.profile_of(uuid) to authenticated;

-- Runs a statement as the current role and reports whether it was refused with 42501.
create function pg_temp.refused(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when insufficient_privilege then
  return true;
end;
$$;
grant execute on function pg_temp.refused(text) to authenticated;

-- T1 a dancer creates a listing the way the app does (no moderation_status): pending.
select pg_temp.act_as('bbbbbbbb-0000-4000-8000-000000000001');
insert into public.dancer_partner_profiles (user_id, display_name, bio, visibility)
values ('bbbbbbbb-0000-4000-8000-000000000001', 'Dancer A', 'Social foxtrot', 'published');
do $$ begin
  if pg_temp.status_of('bbbbbbbb-0000-4000-8000-000000000001') <> 'pending' then
    raise exception 'T1 failed: new listing is not pending';
  end if;
end $$;
reset role;

-- T2 the defect: the owner sets their own listing to approved.
select pg_temp.act_as('bbbbbbbb-0000-4000-8000-000000000001');
do $$ begin
  if not pg_temp.refused($q$update public.dancer_partner_profiles set moderation_status = 'approved'
                             where user_id = 'bbbbbbbb-0000-4000-8000-000000000001'$q$) then
    raise exception 'T2 failed: owner self-approved their listing';
  end if;
  if pg_temp.status_of('bbbbbbbb-0000-4000-8000-000000000001') <> 'pending' then
    raise exception 'T2 failed: status changed';
  end if;
end $$;
reset role;

-- T3 a new listing cannot start approved, and report counters cannot be forged on insert.
select pg_temp.act_as('bbbbbbbb-0000-4000-8000-000000000002');
do $$ begin
  if not pg_temp.refused($q$insert into public.dancer_partner_profiles (user_id, display_name, moderation_status)
                             values ('bbbbbbbb-0000-4000-8000-000000000002', 'Dancer B', 'approved')$q$) then
    raise exception 'T3 failed: insert as approved was accepted';
  end if;
  if not pg_temp.refused($q$insert into public.dancer_partner_profiles (user_id, display_name, blocked_reason)
                             values ('bbbbbbbb-0000-4000-8000-000000000002', 'Dancer B', 'x')$q$) then
    raise exception 'T3 failed: insert with blocked_reason was accepted';
  end if;
end $$;
-- Released clients send moderation_status = 'pending' explicitly: still accepted.
insert into public.dancer_partner_profiles (user_id, display_name, moderation_status)
values ('bbbbbbbb-0000-4000-8000-000000000002', 'Dancer B', 'pending');
reset role;

-- T4 B reports A's listing through the SECURITY DEFINER function: the counter still moves.
select pg_temp.act_as('bbbbbbbb-0000-4000-8000-000000000002');
select public.report_partner_profile(
  pg_temp.profile_of('bbbbbbbb-0000-4000-8000-000000000001'),
  'test report');
reset role;
do $$ begin
  if (select reported_count from public.dancer_partner_profiles where user_id = 'bbbbbbbb-0000-4000-8000-000000000001') <> 1 then
    raise exception 'T4 failed: report did not increment reported_count';
  end if;
end $$;

-- T5 the owner cannot reset report counters or the block reason.
select pg_temp.act_as('bbbbbbbb-0000-4000-8000-000000000001');
do $$ begin
  if not pg_temp.refused($q$update public.dancer_partner_profiles set reported_count = 0
                             where user_id = 'bbbbbbbb-0000-4000-8000-000000000001'$q$) then
    raise exception 'T5 failed: owner reset reported_count';
  end if;
  if not pg_temp.refused($q$update public.dancer_partner_profiles set last_reported_at = null
                             where user_id = 'bbbbbbbb-0000-4000-8000-000000000001'$q$) then
    raise exception 'T5 failed: owner cleared last_reported_at';
  end if;
end $$;
reset role;

-- T6 moderation (service side, not anon/authenticated) approves A.
update public.dancer_partner_profiles set moderation_status = 'approved'
where user_id = 'bbbbbbbb-0000-4000-8000-000000000001';

-- T7 a non-content change keeps the approval; anon sees the listing.
select pg_temp.act_as('bbbbbbbb-0000-4000-8000-000000000001');
update public.dancer_partner_profiles set visibility = 'published', updated_at = now()
where user_id = 'bbbbbbbb-0000-4000-8000-000000000001';
do $$ begin
  if pg_temp.status_of('bbbbbbbb-0000-4000-8000-000000000001') <> 'approved' then
    raise exception 'T7 failed: non-content save lost the approval';
  end if;
end $$;
reset role;
set local role anon;
do $$ begin
  if (select count(*) from public.dancer_partner_profiles) <> 1 then
    raise exception 'T7 failed: anon does not see exactly the approved listing';
  end if;
end $$;
reset role;

-- T8 a content edit on an approved listing sends it back to review.
select pg_temp.act_as('bbbbbbbb-0000-4000-8000-000000000001');
update public.dancer_partner_profiles set bio = 'Book private lessons with me'
where user_id = 'bbbbbbbb-0000-4000-8000-000000000001';
do $$ begin
  if pg_temp.status_of('bbbbbbbb-0000-4000-8000-000000000001') <> 'pending' then
    raise exception 'T8 failed: edited approved listing kept its approval';
  end if;
end $$;
reset role;

-- T9 approved -> pending sent explicitly (released clients on publish) is accepted.
update public.dancer_partner_profiles set moderation_status = 'approved'
where user_id = 'bbbbbbbb-0000-4000-8000-000000000001';
select pg_temp.act_as('bbbbbbbb-0000-4000-8000-000000000001');
update public.dancer_partner_profiles set moderation_status = 'pending'
where user_id = 'bbbbbbbb-0000-4000-8000-000000000001';
reset role;

-- T10 a hidden listing stays hidden: the owner cannot move it to pending, and edits keep it hidden.
update public.dancer_partner_profiles set moderation_status = 'hidden'
where user_id = 'bbbbbbbb-0000-4000-8000-000000000001';
select pg_temp.act_as('bbbbbbbb-0000-4000-8000-000000000001');
do $$ begin
  if not pg_temp.refused($q$update public.dancer_partner_profiles set moderation_status = 'pending'
                             where user_id = 'bbbbbbbb-0000-4000-8000-000000000001'$q$) then
    raise exception 'T10 failed: owner moved a hidden listing to pending';
  end if;
end $$;
update public.dancer_partner_profiles set bio = 'Edited while hidden'
where user_id = 'bbbbbbbb-0000-4000-8000-000000000001';
do $$ begin
  if pg_temp.status_of('bbbbbbbb-0000-4000-8000-000000000001') <> 'hidden' then
    raise exception 'T10 failed: edit changed a hidden listing';
  end if;
end $$;
reset role;

-- T11 the guard function is not callable through the API roles.
do $$ begin
  if has_function_privilege('authenticated', 'public._guard_dancer_partner_profile_moderation()', 'execute')
     or has_function_privilege('anon', 'public._guard_dancer_partner_profile_moderation()', 'execute') then
    raise exception 'T11 failed: guard function is executable by API roles';
  end if;
end $$;

select 'partner profile moderation guard: all checks passed' as result;
rollback;
