-- Legacy instructor token migration + two-way sync SQL suite (disposable Postgres only; see calendar_feeds_legacy_v1.sh).
-- Fixture: the sh runner has already applied the v1 token migration and stubbed instructor_calendar_feeds.

create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;

create or replace function pg_temp.sha(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create or replace function pg_temp.tok(c text) returns text language sql as $$ select repeat(c, 43) $$;

insert into auth.users(id) values
  ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'), ('00000000-0000-0000-0000-0000000000a3'),
  ('00000000-0000-0000-0000-0000000000a4'), ('00000000-0000-0000-0000-0000000000a5'), ('00000000-0000-0000-0000-0000000000a6');
insert into public.studios(id) values ('00000000-0000-0000-0000-0000000000b1');
insert into public.instructors(id, studio_id, user_id, active) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', true),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', true),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b1', null, true),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a3', false),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a4', true),
  ('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a5', true);
insert into public.user_studio_roles(user_id, studio_id, active, role) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', true, 'instructor'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b1', true, 'instructor'),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000b1', true, 'instructor');
-- c1 ok | c2 ok but feed inactive | c3 no user | c4 inactive instructor | c5 ok but already has a current new-model token | c6 user without any role
insert into public.instructor_calendar_feeds(studio_id, instructor_id, token, active) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', pg_temp.tok('A'), true),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c2', pg_temp.tok('B'), false),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c3', pg_temp.tok('C'), true),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c4', pg_temp.tok('D'), true),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c5', pg_temp.tok('E'), true),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c6', pg_temp.tok('F'), true);
select public.calendar_feed_set_studio_enabled('00000000-0000-0000-0000-0000000000b1', true, null);
select public.calendar_feed_issue_token('00000000-0000-0000-0000-0000000000b1', 'staff', '00000000-0000-0000-0000-0000000000a4', repeat('9', 64), 'nnnn0001', 'minimal', null, null, 0);

\i :migration

do $t$
declare
  s1 uuid := '00000000-0000-0000-0000-0000000000b1';
  u1 uuid := '00000000-0000-0000-0000-0000000000a1';
  u2 uuid := '00000000-0000-0000-0000-0000000000a2';
  c1 uuid := '00000000-0000-0000-0000-0000000000c1';
  c2 uuid := '00000000-0000-0000-0000-0000000000c2';
  newtok text := repeat('Z', 43);
begin
  -- backfill
  perform pg_temp.ok((select count(*) from public.calendar_feed_tokens where legacy_source = 'instructor_feed') = 1, 'exactly one legacy token migrated');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(pg_temp.tok('A')))) = 1, 'migrated token resolves by its hash (same subscription URL keeps working)');
  perform pg_temp.ok((select subject_kind from public.calendar_feed_resolve(pg_temp.sha(pg_temp.tok('A')))) = 'staff', 'migrated as a staff feed');
  perform pg_temp.ok((select detail_level from public.calendar_feed_resolve(pg_temp.sha(pg_temp.tok('A')))) = 'minimal', 'migrated feeds start at minimal detail');
  perform pg_temp.ok((select subject_user_id from public.calendar_feed_resolve(pg_temp.sha(pg_temp.tok('A')))) = u1, 'subject is the instructor user');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(pg_temp.tok('B')))) = 0, 'inactive legacy feed not migrated');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(pg_temp.tok('C')))) = 0, 'instructor without a user not migrated');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(pg_temp.tok('D')))) = 0, 'inactive instructor not migrated');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(pg_temp.tok('E')))) = 0, 'subject with an existing current token not overwritten');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(pg_temp.tok('F')))) = 0, 'user without an active studio role not migrated');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(repeat('9', 64))) = 1, 'existing new-model token untouched');
  perform pg_temp.ok((select count(*) from public.calendar_feed_tokens where token_hash = pg_temp.tok('A')) = 0, 'no plaintext stored in the token table');
  perform pg_temp.ok((select count(*) from public.calendar_feed_tokens t join public.instructor_calendar_feeds f on f.token = t.token_hash) = 0, 'no stored hash equals a legacy plaintext token');
  -- known-answer: sha256 of 43 x 'A' computed independently with Node crypto
  perform pg_temp.ok(pg_temp.sha(pg_temp.tok('A')) = '0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a', 'SQL sha256 equals the Node createHash value (same hash on both sides)');
  perform pg_temp.ok((select count(*) from public.calendar_feed_audit_events where action = 'migrated') = 1, 'migration audited once');
  perform pg_temp.ok((select token_prefix from public.calendar_feed_tokens where legacy_source = 'instructor_feed') = 'AAAAAA', 'prefix recorded for support display');
  perform pg_temp.ok((select expires_at > now() + interval '50 years' from public.calendar_feed_tokens where legacy_source = 'instructor_feed'), 'migrated tokens do not silently expire');
  perform pg_temp.ok((select token from public.instructor_calendar_feeds where instructor_id = c1) = pg_temp.tok('A'), 'legacy plaintext column untouched by the backfill');

  -- a disabled studio does not serve migrated tokens (the route then falls through to legacy)
  perform public.calendar_feed_set_studio_enabled(s1, false, null);
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(pg_temp.tok('A')))) = 0, 'migrated token dark while the studio is disabled');
  perform public.calendar_feed_set_studio_enabled(s1, true, null);

  -- legacy -> new: regenerating the legacy token kills the old hash and registers the new one
  update public.instructor_calendar_feeds set token = newtok where instructor_id = c1;
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(pg_temp.tok('A')))) = 0, 'regenerate: old hash stops resolving');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(newtok))) = 1, 'regenerate: new token is carried over');
  perform pg_temp.ok((select revoked_reason from public.calendar_feed_tokens where token_hash = pg_temp.sha(pg_temp.tok('A'))) = 'rotated', 'regenerate: old hash reason = rotated');

  -- new -> legacy: revoking the migrated token deactivates the legacy feed (no fall-back to the old URL behaviour)
  perform public.calendar_feed_revoke((select id from public.calendar_feed_tokens where token_hash = pg_temp.sha(newtok)), s1, u1, 'user', u1, 'user');
  perform pg_temp.ok((select active from public.instructor_calendar_feeds where instructor_id = c1) = false, 'revoke in the new model deactivates the legacy feed');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(newtok))) = 0, 'revoked token no longer resolves');

  -- legacy re-activation with a fresh token re-registers (feeds created or regenerated after the migration are carried over)
  update public.instructor_calendar_feeds set token = repeat('Y', 43), active = true where instructor_id = c1;
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(repeat('Y', 43)))) = 1, 'a feed re-activated with a new token is carried over');

  -- legacy deactivate / delete
  update public.instructor_calendar_feeds set active = false where instructor_id = c1;
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(repeat('Y', 43)))) = 0, 'legacy deactivation revokes the hash');
  insert into public.instructor_calendar_feeds(studio_id, instructor_id, token, active) values (s1, c2, repeat('W', 43), true);
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(repeat('W', 43)))) = 1, 'a feed created after the migration is carried over');
  delete from public.instructor_calendar_feeds where instructor_id = c2;
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(repeat('W', 43)))) = 0, 'legacy deletion revokes the hash');

  -- instructor deactivation (v1 trigger) kills the legacy URL too
  update public.instructor_calendar_feeds set token = repeat('V', 43), active = true where instructor_id = c1;
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(repeat('V', 43)))) = 1, 'setup: V registered');
  update public.instructors set active = false where id = c1;
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha(repeat('V', 43)))) = 0, 'deactivating the instructor revokes the migrated token');
  perform pg_temp.ok((select active from public.instructor_calendar_feeds where instructor_id = c1) = false, 'deactivating the instructor also deactivates the legacy feed');
end
$t$;

-- re-run is a no-op for already-processed rows
\i :migration
select pg_temp.ok((select count(*) from public.calendar_feed_tokens where legacy_source = 'instructor_feed' and status = 'active') = 0, 're-run does not resurrect revoked or deactivated feeds');
select 'ALL LEGACY MIGRATION SQL CHECKS PASSED' as result;
