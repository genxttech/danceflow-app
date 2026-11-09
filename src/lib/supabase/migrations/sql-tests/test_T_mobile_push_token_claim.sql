-- Suite for 20270211090000_mobile_push_token_claim.sql. LOCAL / DISPOSABLE databases only.
-- Runs in one transaction and rolls back. Any failed check raises and stops psql (ON_ERROR_STOP=1).
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'push-a@example.test', now(), now()),
  ('aaaaaaaa-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'push-b@example.test', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;

create function pg_temp.owner_of(p_token text) returns uuid language sql security definer as $$
  select user_id from public.mobile_push_tokens where expo_push_token = p_token;
$$;
grant execute on function pg_temp.owner_of(text) to authenticated;

-- T1 user A registers a new device.
select pg_temp.act_as('aaaaaaaa-0000-4000-8000-000000000001');
select public.claim_mobile_push_token('ExponentPushToken[device_1]', 'ios');
do $$ begin
  if pg_temp.owner_of('ExponentPushToken[device_1]') <> 'aaaaaaaa-0000-4000-8000-000000000001' then
    raise exception 'T1 failed: A does not own the new device';
  end if;
end $$;
reset role;

-- T2 the defect: B's direct upsert of A's device is refused by RLS and A keeps the row.
select pg_temp.act_as('aaaaaaaa-0000-4000-8000-000000000002');
do $$
declare v_blocked boolean := false;
begin
  begin
    insert into public.mobile_push_tokens (user_id, expo_push_token, platform)
    values ('aaaaaaaa-0000-4000-8000-000000000002', 'ExponentPushToken[device_1]', 'ios')
    on conflict (expo_push_token) do update set user_id = excluded.user_id;
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  if not v_blocked or pg_temp.owner_of('ExponentPushToken[device_1]') <> 'aaaaaaaa-0000-4000-8000-000000000001' then
    raise exception 'T2 failed: direct upsert was not refused';
  end if;
end $$;

-- T3 B cannot read, delete or directly update A's row.
do $$
declare v_count int;
begin
  select count(*) into v_count from public.mobile_push_tokens;
  if v_count <> 0 then raise exception 'T3 failed: B can read A''s row'; end if;

  delete from public.mobile_push_tokens where expo_push_token = 'ExponentPushToken[device_1]';
  update public.mobile_push_tokens set enabled = false where expo_push_token = 'ExponentPushToken[device_1]';

  if pg_temp.owner_of('ExponentPushToken[device_1]') <> 'aaaaaaaa-0000-4000-8000-000000000001' then
    raise exception 'T3 failed: B changed A''s row';
  end if;
end $$;

-- T4 the fix: B signs in on the device and the row moves to B, exactly one row, device name cleared.
reset role;
update public.mobile_push_tokens set device_name = 'A phone', enabled = false where expo_push_token = 'ExponentPushToken[device_1]';
select pg_temp.act_as('aaaaaaaa-0000-4000-8000-000000000002');
select public.claim_mobile_push_token('ExponentPushToken[device_1]', 'android');
reset role;
do $$
declare r public.mobile_push_tokens%rowtype; v_count int;
begin
  select count(*) into v_count from public.mobile_push_tokens where expo_push_token = 'ExponentPushToken[device_1]';
  select * into r from public.mobile_push_tokens where expo_push_token = 'ExponentPushToken[device_1]';
  if v_count <> 1 or r.user_id <> 'aaaaaaaa-0000-4000-8000-000000000002' or r.platform <> 'android'
     or not r.enabled or r.device_name is not null then
    raise exception 'T4 failed: %', row_to_json(r);
  end if;
end $$;

-- T5 A re-claiming keeps working and does not make a second row; the same user keeps the device name.
select pg_temp.act_as('aaaaaaaa-0000-4000-8000-000000000001');
select public.claim_mobile_push_token('ExponentPushToken[device_1]', 'android');
reset role;
update public.mobile_push_tokens set device_name = 'A phone' where expo_push_token = 'ExponentPushToken[device_1]';
select pg_temp.act_as('aaaaaaaa-0000-4000-8000-000000000001');
select public.claim_mobile_push_token('ExponentPushToken[device_1]', 'android');
reset role;
do $$ begin
  if (select device_name from public.mobile_push_tokens where expo_push_token = 'ExponentPushToken[device_1]') is distinct from 'A phone' then
    raise exception 'T5 failed: re-registration lost the device name';
  end if;
end $$;

-- T6 sign-out: the owner can delete the row while signed in.
select pg_temp.act_as('aaaaaaaa-0000-4000-8000-000000000001');
delete from public.mobile_push_tokens where expo_push_token = 'ExponentPushToken[device_1]';
reset role;
do $$ begin
  if exists (select 1 from public.mobile_push_tokens where expo_push_token = 'ExponentPushToken[device_1]') then
    raise exception 'T6 failed: owner delete did not remove the row';
  end if;
end $$;

-- T7 bad input is refused.
select pg_temp.act_as('aaaaaaaa-0000-4000-8000-000000000001');
do $$
declare
  v_case text[];
  v_refused boolean;
begin
  foreach v_case slice 1 in array array[
    array['not-a-token', 'ios', 'danceflow-student'],
    array['ExponentPushToken[]', 'ios', 'danceflow-student'],
    array['ExponentPushToken[abc]x', 'ios', 'danceflow-student'],
    array['ExponentPushToken[abc]', 'symbian', 'danceflow-student'],
    array['ExponentPushToken[abc]', 'ios', 'Not An App']
  ] loop
    v_refused := false;
    begin
      perform public.claim_mobile_push_token(v_case[1], v_case[2], v_case[3]);
    exception when sqlstate '22023' then
      v_refused := true;
    end;
    if not v_refused then raise exception 'T7 failed: accepted %', v_case; end if;
  end loop;
end $$;
reset role;

-- T8 no caller identity is refused, and anon cannot execute (checked by privilege, not by calling).
do $$
declare v_refused boolean := false;
begin
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.claim_mobile_push_token('ExponentPushToken[abc]', 'ios');
  exception when sqlstate '28000' then
    v_refused := true;
  end;
  if not v_refused then raise exception 'T8 failed: no identity was accepted'; end if;

  if has_function_privilege('anon', 'public.claim_mobile_push_token(text,text,text)', 'execute')
     or has_function_privilege('public', 'public.claim_mobile_push_token(text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.claim_mobile_push_token(text,text,text)', 'execute') then
    raise exception 'T8 failed: wrong execute privileges';
  end if;
end $$;

select 'PASS test_T_mobile_push_token_claim' as result;
rollback;
