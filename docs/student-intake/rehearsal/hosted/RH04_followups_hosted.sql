-- RH04 — follow-ups (rolled back): audit UPDATE with rows present; trapped wrapper error then protected change
-- (hosted) no explicit transaction
create temp table rh(id text, expected text, actual text, pass boolean);
do $$ declare m text; ok boolean; n int; begin
  select count(*) into n from public.nsi_rh_audit;
  begin update public.nsi_rh_audit set event_type = 'tampered'; m := 'update succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  insert into rh values ('G8-07e2 audit UPDATE with '||n||' rows present', '42501', m, ok and n > 0);
  begin
    perform set_config('request.jwt.claims', '{"sub":"dcfef737-a50f-4013-8e35-46e9472abf83","role":"authenticated"}', true);
    execute 'set role authenticated';
    perform public.intake_erase_client('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000002','x');
  exception when others then null; end;
  execute 'reset role';
  begin delete from public.nsi_rh_requests where client_id = 'c0000000-0000-0000-0000-000000000002'; m := 'delete succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  insert into rh values ('G8-14 trapped wrapper error, then owner delete in same txn', '42501', m, ok);
end $$;
create table if not exists public.nsi_rh_results(run text, id text, pass boolean, test text, expected text, actual text);
insert into public.nsi_rh_results select 'RH04', id, pass, null, expected, actual from rh;
select id, pass, expected, actual from rh;
