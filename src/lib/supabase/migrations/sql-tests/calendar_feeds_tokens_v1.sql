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

create or replace function pg_temp.hex(c text) returns text language sql as $$ select repeat(c, 64) $$;

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
  perform pg_temp.ok(public.calendar_feed_revoke(t6, 'user', u1, 'user'), 'revoke returns true');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('6'))) = 0, 'revoked token stops resolving immediately');
  perform pg_temp.ok(not public.calendar_feed_revoke(t6, 'user', u1, 'user'), 'second revoke returns false');

  -- 9. tenant isolation and studio kill switch
  perform public.calendar_feed_set_studio_enabled(s2, true, u1);
  t7 := public.calendar_feed_issue_token(s2, 'dancer_account', u1, pg_temp.hex('7'), 'uvwx1234', 'standard', array['00000000-0000-0000-0000-0000000000d1']::uuid[], u1, 0);
  perform pg_temp.ok((select studio_id from public.calendar_feed_resolve(pg_temp.hex('7'))) = s2, 'token resolves to its own studio (s2)');
  perform pg_temp.ok((select detail_level from public.calendar_feed_resolve(pg_temp.hex('7'))) = 'standard', 'detail level returned');
  perform pg_temp.ok((select count(*) from public.calendar_feed_tokens where subject_user_id = u1 and subject_kind = 'dancer_account' and studio_id <> s2) >= 1, 'same user has separate tokens per studio');
  perform public.calendar_feed_set_studio_enabled(s2, false, u1);
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.hex('7'))) = 0, 'disabling a studio stops its tokens');
  perform pg_temp.ok((select status from public.calendar_feed_tokens where id = t7) = 'revoked', 'disabling a studio revokes its tokens');
  perform pg_temp.ok((select count(*) from public.calendar_feed_tokens where studio_id = s1 and status = 'active') >= 1, 'disabling s2 leaves s1 tokens alone');

  -- 10. set_detail
  t8 := public.calendar_feed_issue_token(s1, 'dancer_account', u3, pg_temp.hex('8'), 'yzab5678', 'minimal', null, u3, 0);
  perform pg_temp.ok(public.calendar_feed_set_detail(t8, 'standard', null, u3), 'detail changed');
  perform pg_temp.ok((select detail_level from public.calendar_feed_tokens where id = t8) = 'standard', 'detail persisted');
  perform pg_temp.raises(format('select public.calendar_feed_set_detail(%L,%L,null,%L)', t8, 'wide', u3), 'invalid detail refused');

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
