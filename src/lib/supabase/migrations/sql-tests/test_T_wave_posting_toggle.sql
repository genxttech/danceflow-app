-- Wave posting toggle trigger suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY). Covers 20270223100000.
-- Prints "WAVE TOGGLE SUITE PASS (<n> checks)" or "... FAIL: ..." from an always-raising final block. Refuses unless wavetest.local = 'on'.
begin;
do $$ begin
  if coalesce(current_setting('wavetest.local', true), '') <> 'on' then
    raise exception 'wave toggle suite refused: set wavetest.local = ''on'' only on a disposable local stack';
  end if;
end $$;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return 'ERR ' || sqlerrm; end $$;

insert into public.studios (id, name, slug) values ('d1000000-0000-4000-8000-00000000000a', 'Wave Toggle A', 'wave-toggle-a');
insert into public.studio_wave_connections (id, studio_id, status, posting_enabled, posting_enabled_at, posting_mode)
values ('d2000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-00000000000a', 'connected', true, now(), 'approval_required');

select pg_temp.chk('app can mark needs_reauth and switch posting off while posting is on',
  pg_temp.try($q$update public.studio_wave_connections set status = 'needs_reauth', posting_enabled = false where id = 'd2000000-0000-4000-8000-00000000000a'$q$) = 'ok'
  and (select posting_enabled from public.studio_wave_connections where id = 'd2000000-0000-4000-8000-00000000000a') = false);
select pg_temp.chk('posting_disabled_at may be recorded when disabling',
  pg_temp.try($q$update public.studio_wave_connections set posting_disabled_at = now() where id = 'd2000000-0000-4000-8000-00000000000a'$q$) = 'ok');
select pg_temp.chk('a direct update cannot switch posting ON',
  pg_temp.try($q$update public.studio_wave_connections set posting_enabled = true where id = 'd2000000-0000-4000-8000-00000000000a'$q$) like 'ERR%controlled Wave posting toggle%');
select pg_temp.chk('a direct update cannot rewrite who/when posting was enabled',
  pg_temp.try($q$update public.studio_wave_connections set posting_enabled_at = now() where id = 'd2000000-0000-4000-8000-00000000000a'$q$) like 'ERR%controlled Wave posting toggle%');
select pg_temp.chk('the controlled path (GUC) can still enable',
  (select set_config('app.wave_posting_toggle', 'allowed', true)) = 'allowed'
  and pg_temp.try($q$update public.studio_wave_connections set posting_enabled = true, posting_enabled_at = now(), posting_disabled_at = null where id = 'd2000000-0000-4000-8000-00000000000a'$q$) = 'ok');
select set_config('app.wave_posting_toggle', '', true);
select pg_temp.chk('disconnect-style update (posting off, mode reset) works from enabled',
  pg_temp.try($q$update public.studio_wave_connections set status = 'disconnected', posting_enabled = false, posting_mode = 'manual_review' where id = 'd2000000-0000-4000-8000-00000000000a'$q$) = 'ok');
select pg_temp.chk('unrelated updates are unaffected',
  pg_temp.try($q$update public.studio_wave_connections set last_error = 'x' where id = 'd2000000-0000-4000-8000-00000000000a'$q$) = 'ok');

do $$ declare n int; f text; begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into n, f from t_results;
  if f is null then raise exception 'WAVE TOGGLE SUITE PASS (% checks)', n; else raise exception 'WAVE TOGGLE SUITE FAIL: %', f; end if;
end $$;
