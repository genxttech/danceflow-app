-- Calendar feeds v1 SQL suite. Runs against a DISPOSABLE Postgres only (see calendar_feeds_tokens_v1.sh).
-- Every check raises on failure (ON_ERROR_STOP); passes are printed as NOTICE lines.

create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;

-- run a statement that must raise
create or replace function pg_temp.raises(stmt text, label text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'PASS: % (%)', label, sqlerrm;
    return;
  end;
  raise exception 'FAIL: % (did not raise)', label;
end $$;

create or replace function pg_temp.hex(c text) returns text language sql as $$ select repeat(c, 64 / length(c)) $$;

insert into auth.users(id) values
  ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'), ('00000000-0000-0000-0000-0000000000a3');
insert into public.studios(id) values ('00000000-0000-0000-0000-0000000000b1'), ('00000000-0000-0000-0000-0000000000b2');
insert into public.instructors(id, studio_id, user_id, active) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', true);
insert into public.user_studio_roles(user_id, studio_id, active, role) values
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b1', true, 'instructor');

do $t$
declare
  s1 uuid := '00000000-0000-0000-0000-0000000000b1';
  s2 uuid := '00000000-0000-0000-0000-0000000000b2';
  u1 uuid := '00000000-0000-0000-0000-0000000000a1';
  u2 uuid := '00000000-0000-0000-0000-0000000000a2';
  u3 uuid := '00000000-0000-0000-0000-0000000000a3';
  t1 uuid; t2 uuid; t3 uuid; t6 uuid; t7 uuid; t8 uuid;
  n integer;
begin
  -- 1. privileges
  perform pg_temp.ok(not has_table_privilege('anon', 'public.calendar_feed_tokens', 'select'), 'anon cannot select tokens');
  perform pg_temp.ok(not has_table_privilege('authenticated', 'public.calendar_feed_tokens', 'select'), 'authenticated cannot select tokens');
  perform pg_temp.ok(not has_table_privilege('authenticated', 'public.calendar_feed_tokens', 'insert'), 'authenticated cannot insert tokens');
  perform pg_temp.ok(not has_table_privilege('authenticated', 'public.calendar_feed_audit_events', 'select'), 'authenticated cannot read audit');
  perform pg_temp.ok(not has_table_privilege('authenticated', 'public.calendar_feed_rate_buckets', 'update'), 'authenticated cannot write buckets');
  perform pg_temp.ok(not has_table_privilege('authenticated', 'public.calendar_feed_settings', 'update'), 'authenticated cannot write settings');
  perform pg_temp.ok(not has_function_privilege('authenticated', 'public.calendar_feed_resolve(text)', 'execute'), 'authenticated cannot resolve');
  perform pg_temp.ok(not has_function_privilege('anon', 'public.calendar_feed_issue_token(uuid,text,uuid,text,text,text,uuid[],uuid,integer)', 'execute'), 'anon cannot issue');
  perform pg_temp.ok(not has_function_privilege('authenticated', 'public.calendar_feed_rate_check(text,integer,integer)', 'execute'), 'authenticated cannot use rate check');
  perform pg_temp.ok(has_function_privilege('service_role', 'public.calendar_feed_issue_token(uuid,text,uuid,text,text,text,uuid[],uuid,integer)', 'execute'), 'service_role can issue');
  perform pg_temp.ok(has_function_privilege('service_role', 'public.calendar_feed_resolve(text)', 'execute'), 'service_role can resolve');
  perform pg_temp.ok((select relrowsecurity from pg_class where oid = 'public.calendar_feed_tokens'::regclass), 'RLS enabled on tokens');
  perform pg_temp.ok((select count(*) from pg_policies where tablename like 'calendar_feed_%') = 0, 'no policies on feed tables');

  -- 1b. exhaustive privilege sweep over every feed table and function
  perform pg_temp.ok((select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name like 'calendar_feed_%' and grantee in ('PUBLIC', 'anon', 'authenticated')) = 0, 'no table grants to PUBLIC/anon/authenticated on any feed table');
  perform pg_temp.ok((select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where ns.nspname = 'public' and p.proname like 'calendar_feed_%' and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))) = 0, 'no function grants to PUBLIC/anon/authenticated on any feed function');
  perform pg_temp.ok(not has_function_privilege('service_role', 'public.calendar_feed_audit(uuid,uuid,uuid,text,text,text,jsonb)', 'execute'), 'internal audit helper is not exposed to the API role');

  -- 2. disabled studio
  perform pg_temp.raises(format('select public.calendar_feed_issue_token(%L,%L,%L,%L,%L,%L,null,%L,0)', s1, 'staff', u2, pg_temp.hex('a'), 'abcd1234', 'minimal', u2), 'issue refused when studio disabled');
  perform public.calendar_feed_set_studio_enabled(s1, true, u1);
  perform pg_temp.ok((select enabled from public.calendar_feed_settings where studio_id = s1), 'studio enabled');

  -- 3. constraints
  perform pg_temp.raises(format('select public.calendar_feed_issue_token(%L,%L,%L,%L,%L,%L,null,%L,0)', s1, 'bogus', u2, pg_temp.hex('b'), 'abcd1234', 'minimal', u2), 'bad subject kind refused');
  perform pg_temp.raises(format('select public.calendar_feed_issue_token(%L,%L,%L,%L,%L,%L,null,%L,0)', s1, 'staff', u2, 'NOTHEX', 'abcd1234', 'minimal', u2), 'non-hash token refused');
  perform pg_temp.raises(format('select public.calendar_feed_issue_token(%L,%L,%L,%L,%L,%L,null,%L,0)', s1, 'staff', u2, pg_temp.hex('c'), 'abcd1234', 'verbose', u2), 'bad detail level refused');
  perform pg_temp.raises(format('select public.calendar_feed_issue_token(%L,%L,%L,%L,%L,%L,null,%L,0)', s1, 'staff', u2, pg_temp.hex('c'), 'ab', 'minimal', u2), 'short prefix refused');

  -- 4. issue + resolve
  t1 := public.calendar_feed_issue_token(s1, 'staff', u2, pg_temp.hex('1'), 'abcd1234', 'minimal', null, u2, 0);
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('1'))) = 1, 'valid token resolves');
  perform pg_temp.ok((select studio_id from public.calendar_feed_resolve(pg_temp.hex('1'))) = s1, 'resolve returns the token studio only');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('9'))) = 0, 'unknown token resolves to nothing');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve('not-a-hash')) = 0, 'malformed hash resolves to nothing');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(null)) = 0, 'null hash resolves to nothing');
  perform pg_temp.ok((select last_accessed_at is not null from public.calendar_feed_tokens where id = t1), 'last_accessed_at set on first resolve');
  perform pg_temp.ok((select count(*) from information_schema.columns where table_name = 'calendar_feed_tokens' and column_name in ('token', 'secret', 'plaintext')) = 0, 'no plaintext token column');

  -- 5. rotate without overlap revokes the old token
  t2 := public.calendar_feed_issue_token(s1, 'staff', u2, pg_temp.hex('2'), 'efgh5678', 'minimal', null, u2, 0);
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('1'))) = 0, 'rotated token (no overlap) stops resolving');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('2'))) = 1, 'new token resolves');
  perform pg_temp.ok((select revoked_reason from public.calendar_feed_tokens where id = t1) = 'rotated', 'old token reason = rotated');
  perform pg_temp.ok((select rotated_from from public.calendar_feed_tokens where id = t2) = t1, 'rotated_from links previous token');

  -- 6. rotate with overlap
  t3 := public.calendar_feed_issue_token(s1, 'staff', u2, pg_temp.hex('3'), 'ijkl9012', 'minimal', null, u2, 600);
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('2'))) = 1, 'overlapping old token still resolves');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('3'))) = 1, 'new token resolves during overlap');
  update public.calendar_feed_tokens set valid_until = now() - interval '1 second' where id = t2;
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('2'))) = 0, 'overlap elapsed: old token stops resolving');
  perform pg_temp.raises(format('insert into public.calendar_feed_tokens(studio_id,subject_kind,subject_user_id,token_hash,token_prefix) values (%L,%L,%L,%L,%L)', s1, 'staff', u2, pg_temp.hex('4'), 'zzzz1111'), 'second current token for same subject refused by unique index');
  perform public.calendar_feed_issue_token(s1, 'staff', u2, pg_temp.hex('5'), 'mnop3456', 'minimal', null, u2, 999999);
  perform pg_temp.ok((select max(valid_until) - now() <= interval '24 hours 1 minute' from public.calendar_feed_tokens where superseded_at is not null and status = 'active'), 'overlap clamped to 24h');

  -- 7. expiry
  update public.calendar_feed_tokens set expires_at = now() - interval '1 second' where token_hash = pg_temp.hex('5');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('5'))) = 0, 'expired token does not resolve');

  -- 8. revoke
  t6 := public.calendar_feed_issue_token(s1, 'dancer_account', u1, pg_temp.hex('6'), 'qrst7890', 'minimal', null, u1, 0);
  perform pg_temp.ok(public.calendar_feed_revoke(t6, s1, u1, 'user', u1, 'user'), 'revoke returns true');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('6'))) = 0, 'revoked token stops resolving immediately');
  perform pg_temp.ok(not public.calendar_feed_revoke(t6, s1, u1, 'user', u1, 'user'), 'second revoke returns false');

  -- 9. tenant isolation and studio kill switch
  perform public.calendar_feed_set_studio_enabled(s2, true, u1);
  t7 := public.calendar_feed_issue_token(s2, 'dancer_account', u1, pg_temp.hex('7'), 'uvwx1234', 'standard', array['00000000-0000-0000-0000-0000000000d1']::uuid[], u1, 0);
  perform pg_temp.ok((select studio_id from public.calendar_feed_resolve(pg_temp.hex('7'))) = s2, 'token resolves to its own studio (s2)');
  perform pg_temp.ok((select detail_level from public.calendar_feed_resolve(pg_temp.hex('7'))) = 'standard', 'detail level returned');
  perform pg_temp.ok((select count(*) from public.calendar_feed_tokens where subject_user_id = u1 and subject_kind = 'dancer_account' and studio_id <> s2) >= 1, 'same user has separate tokens per studio');
  perform public.calendar_feed_set_studio_enabled(s2, false, u1);
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('7'))) = 0, 'disabling a studio stops resolution (soft switch)');
  perform pg_temp.ok((select status from public.calendar_feed_tokens where id = t7) = 'active', 'disabling is soft: token kept');
  perform public.calendar_feed_set_studio_enabled(s2, true, u1);
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('7'))) = 1, 're-enabling resumes the kept token');
  perform pg_temp.ok((select count(*) from public.calendar_feed_audit_events where studio_id = s2 and action = 'enabled') = 2, 'enable audited once per real change');
  perform public.calendar_feed_set_studio_enabled(s2, true, u1);
  perform pg_temp.ok((select count(*) from public.calendar_feed_audit_events where studio_id = s2 and action = 'enabled') = 2, 'no-op enable not audited again');
  perform pg_temp.ok(public.calendar_feed_revoke_studio(s2, 'incident', u1) = 1, 'revoke_studio returns the live count');
  perform pg_temp.ok((select status from public.calendar_feed_tokens where id = t7) = 'revoked', 'incident revoke_studio revokes tokens');
  perform pg_temp.ok(public.calendar_feed_revoke_studio(s2, 'incident', u1) = 0, 'revoke_studio is idempotent');
  perform public.calendar_feed_set_studio_enabled(s2, false, u1);
  perform pg_temp.ok((select count(*) from public.calendar_feed_tokens where studio_id = s1 and status = 'active') >= 1, 'disabling s2 leaves s1 tokens alone');

  -- 10. set_detail
  t8 := public.calendar_feed_issue_token(s1, 'dancer_account', u3, pg_temp.hex('8'), 'yzab5678', 'minimal', null, u3, 0);
  perform pg_temp.ok(public.calendar_feed_set_detail(t8, s1, u3, 'standard', null, u3), 'detail changed');
  perform pg_temp.ok((select detail_level from public.calendar_feed_tokens where id = t8) = 'standard', 'detail persisted');
  perform pg_temp.raises(format('select public.calendar_feed_set_detail(%L,%L,%L,%L,null,%L)', t8, s1, u3, 'wide', u3), 'invalid detail refused');

  -- 11. auto-revocation hooks
  perform public.calendar_feed_issue_token(s1, 'staff', u3, pg_temp.hex('d'), 'cdef9012', 'minimal', null, u3, 0);
  insert into public.user_studio_roles(user_id, studio_id, active, role) values (u3, s1, true, 'instructor');
  update public.user_studio_roles set active = false where user_id = u3 and studio_id = s1;
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('d'))) = 0, 'role deactivation revokes staff token');
  perform pg_temp.ok((select revoked_reason from public.calendar_feed_tokens where token_hash = pg_temp.hex('d')) = 'role_lost', 'reason role_lost recorded');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('8'))) = 1, 'role loss does not touch the same user dancer token');
  perform public.calendar_feed_issue_token(s1, 'staff', u2, pg_temp.hex('e'), 'ghij3456', 'minimal', null, u2, 0);
  update public.instructors set active = false where id = '00000000-0000-0000-0000-0000000000c1';
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('e'))) = 0, 'instructor deactivation revokes staff token');
  perform pg_temp.ok((select count(*) from public.calendar_feed_tokens where subject_user_id = u2 and status = 'active') = 0, 'no live token left for deactivated instructor');

  -- 11b. rotation hardening: overlap 600 then 0 kills every older token
  declare
    tx1 uuid; tx2 uuid;
  begin
    tx1 := public.calendar_feed_issue_token(s1, 'dancer_account', u2, pg_temp.hex('a0'), 'aaaa0001', 'minimal', null, u2, 0);
    tx2 := public.calendar_feed_issue_token(s1, 'dancer_account', u2, pg_temp.hex('b0'), 'aaaa0002', 'minimal', null, u2, 600);
    perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('a0'))) = 1, 'older token valid during overlap');
    perform public.calendar_feed_issue_token(s1, 'dancer_account', u2, pg_temp.hex('c0'), 'aaaa0003', 'minimal', null, u2, 0);
    perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('a0'))) = 0, 'rotate with overlap 0 kills the older overlapping token');
    perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('b0'))) = 0, 'rotate with overlap 0 kills the previous token');
    perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('c0'))) = 1, 'only the newest token resolves');
    perform pg_temp.ok((select count(*) from public.calendar_feed_tokens where subject_user_id = u2 and subject_kind = 'dancer_account' and status = 'active') = 1, 'exactly one live token after zero-overlap rotation');
    -- overlap clamp is about 24h on the superseded token, not collapsed to 0
    perform public.calendar_feed_issue_token(s1, 'dancer_account', u2, pg_temp.hex('d0'), 'aaaa0004', 'minimal', null, u2, 999999);
    perform pg_temp.ok((select valid_until - now() from public.calendar_feed_tokens where token_hash = pg_temp.hex('c0')) between interval '23 hours' and interval '24 hours 1 minute', 'overlap clamped to about 24h');
  end;

  -- 11c. tenant guard on revoke/set_detail: wrong studio or wrong subject changes nothing
  declare
    tg uuid := (select id from public.calendar_feed_tokens where token_hash = pg_temp.hex('8'));
  begin
    perform pg_temp.ok(not public.calendar_feed_revoke(tg, s2, u3, 'admin', u1, 'admin'), 'revoke with the wrong studio does nothing');
    perform pg_temp.ok(not public.calendar_feed_revoke(tg, s1, u1, 'admin', u1, 'admin'), 'revoke with the wrong subject does nothing');
    perform pg_temp.ok(not public.calendar_feed_set_detail(tg, s2, u3, 'minimal', null, u1), 'set_detail with the wrong studio does nothing');
    perform pg_temp.ok((select detail_level from public.calendar_feed_tokens where id = tg) = 'standard', 'detail unchanged by a wrong-studio call');
    perform pg_temp.raises(format('select public.calendar_feed_revoke(%L,%L,null,null,%L)', tg, s1, u1), 'revoke requires a reason');
    perform pg_temp.raises(format('select public.calendar_feed_set_detail(%L,%L,null,null,null,%L)', tg, s1, u1), 'set_detail refuses a null level');
    perform pg_temp.ok(public.calendar_feed_revoke(tg, s1, null, 'admin', u1, 'admin'), 'admin revoke within the studio (no subject) works');
  end;

  -- 11d. resolve throttle: a second resolve inside 15 minutes leaves last_accessed_at alone
  declare
    la1 timestamptz; la2 timestamptz; th uuid;
  begin
    th := public.calendar_feed_issue_token(s1, 'staff', u1, pg_temp.hex('f0'), 'tttt0001', 'minimal', null, u1, 0);
    perform * from public.calendar_feed_resolve(pg_temp.hex('f0'));
    select last_accessed_at into la1 from public.calendar_feed_tokens where id = th;
    update public.calendar_feed_tokens set last_accessed_at = la1 - interval '1 minute' where id = th;
    perform * from public.calendar_feed_resolve(pg_temp.hex('f0'));
    select last_accessed_at into la2 from public.calendar_feed_tokens where id = th;
    perform pg_temp.ok(la2 = la1 - interval '1 minute', 'resolve within 15 minutes does not rewrite last_accessed_at');
    update public.calendar_feed_tokens set last_accessed_at = now() - interval '20 minutes' where id = th;
    perform * from public.calendar_feed_resolve(pg_temp.hex('f0'));
    perform pg_temp.ok((select last_accessed_at from public.calendar_feed_tokens where id = th) > now() - interval '1 minute', 'resolve after 15 minutes refreshes last_accessed_at');
  end;

  -- 11e. more automatic revocation triggers: role change, user_id change, DELETE
  declare
    u4 uuid := '00000000-0000-0000-0000-0000000000a4';
  begin
    insert into auth.users(id) values (u4);
    insert into public.user_studio_roles(user_id, studio_id, active, role) values (u4, s1, true, 'instructor');
    perform public.calendar_feed_issue_token(s1, 'staff', u4, pg_temp.hex('e1'), 'rrrr0001', 'minimal', null, u4, 0);
    update public.user_studio_roles set role = 'front_desk' where user_id = u4 and studio_id = s1;
    perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('e1'))) = 0, 'role change revokes staff token');
    perform public.calendar_feed_issue_token(s1, 'staff', u4, pg_temp.hex('e2'), 'ssss0001', 'minimal', null, u4, 0);
    delete from public.user_studio_roles where user_id = u4 and studio_id = s1;
    perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('e2'))) = 0, 'role deletion revokes staff token');
    insert into public.instructors(id, studio_id, user_id, active) values ('00000000-0000-0000-0000-0000000000c4', s1, u4, true);
    perform public.calendar_feed_issue_token(s1, 'staff', u4, pg_temp.hex('e3'), 'uuuu0001', 'minimal', null, u4, 0);
    update public.instructors set user_id = u2 where id = '00000000-0000-0000-0000-0000000000c4';
    perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('e3'))) = 0, 'instructor re-link revokes the old holder token');
    perform public.calendar_feed_issue_token(s1, 'staff', u2, pg_temp.hex('e4'), 'vvvv0001', 'minimal', null, u2, 0);
    delete from public.instructors where id = '00000000-0000-0000-0000-0000000000c4';
    perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('e4'))) = 0, 'instructor deletion revokes staff token');
  end;

  -- 12. account deletion cascades
  perform public.calendar_feed_set_studio_enabled(s2, true, u1);
  perform public.calendar_feed_issue_token(s2, 'dancer_account', u3, pg_temp.hex('f'), 'klmn7890', 'minimal', null, u3, 0);
  delete from auth.users where id = u3;
  perform pg_temp.ok((select count(*) from public.calendar_feed_tokens where subject_user_id = u3) = 0, 'user deletion removes their tokens');

  -- 13. audit
  perform pg_temp.ok((select count(*) from public.calendar_feed_audit_events where action = 'created') >= 3, 'created events audited');
  perform pg_temp.ok((select count(*) from public.calendar_feed_audit_events where action = 'rotated') >= 2, 'rotated events audited');
  perform pg_temp.ok((select count(*) from public.calendar_feed_audit_events where action = 'revoked') >= 4, 'revoke events audited');
  perform pg_temp.raises('update public.calendar_feed_audit_events set reason = ''x''', 'audit rows cannot be updated');
  perform pg_temp.ok((select count(*) from public.calendar_feed_audit_events where metadata::text ~* '[0-9a-f]{64}') = 0, 'no token hash appears in audit metadata');

  -- 14. rate limiter
  perform pg_temp.ok((select allowed from public.calendar_feed_rate_check('t:test', 3, 3600)), 'hit 1 allowed');
  perform pg_temp.ok((select allowed from public.calendar_feed_rate_check('t:test', 3, 3600)), 'hit 2 allowed');
  perform pg_temp.ok((select allowed from public.calendar_feed_rate_check('t:test', 3, 3600)), 'hit 3 allowed');
  perform pg_temp.ok(not (select allowed from public.calendar_feed_rate_check('t:test', 3, 3600)), 'hit 4 denied');
  perform pg_temp.ok((select retry_after_seconds from public.calendar_feed_rate_check('t:test', 3, 3600)) between 1 and 3600, 'retry_after within window');
  perform pg_temp.ok((select allowed from public.calendar_feed_rate_check('t:other', 3, 3600)), 'separate key unaffected');
  perform pg_temp.raises('select * from public.calendar_feed_rate_check('''', 3, 60)', 'empty key refused');
  perform pg_temp.raises('select * from public.calendar_feed_rate_check(''k'', 0, 60)', 'zero limit refused');
  perform pg_temp.raises('select * from public.calendar_feed_rate_check(''k'', 5, 0)', 'zero window refused');
  perform pg_temp.raises(format('select * from public.calendar_feed_rate_check(%L, 5, 60)', repeat('x', 129)), 'oversized key refused');

  -- 15. definer functions pin search_path
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'calendar_feed_%' and p.proname <> 'calendar_feed_audit_no_update'
     and (not p.prosecdef or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));
  perform pg_temp.ok(n = 0, 'all feed functions are SECURITY DEFINER with a pinned search_path');
end
$t$;

select 'ALL CALENDAR FEED SQL CHECKS PASSED' as result;
