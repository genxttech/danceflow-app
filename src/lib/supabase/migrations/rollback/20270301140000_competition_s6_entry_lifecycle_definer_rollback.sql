-- Rollback of 20270301140000: restore exactly the definition that was installed before it (saved by the migration in the function comment: body, SECURITY INVOKER, settings and the previous
-- comment) and the previous ACL in its recorded order (PUBLIC, postgres, anon, authenticated, service_role). Run AFTER rolling back 20270301141000.
begin;

do $$
declare v_oid oid := to_regprocedure('public.change_competition_entry_lifecycle(uuid, text, text, text)'); v_saved text; v_def text; v_comment text;
begin
  if exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname = 'cf1_s6_guard_entry_status') then
    raise exception 'S6 rollback refused: roll back 20270301141000 first.'; end if;
  if v_oid is null or (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) is distinct from '25fdb16ba0e23069254c249c3a738aac' then
    raise exception 'S6 rollback refused: change_competition_entry_lifecycle is not the 20270301140000 definition (another change would be overwritten).'; end if;
  v_saved := obj_description(v_oid, 'pg_proc');
  if v_saved is null or split_part(v_saved, '|', 1) <> 'S6-PRIOR' then
    raise exception 'S6 rollback refused: the saved previous definition is missing from the function comment.'; end if;
  v_def := convert_from(decode(split_part(v_saved, '|', 2), 'base64'), 'UTF8');
  v_comment := convert_from(decode(split_part(v_saved, '|', 4), 'base64'), 'UTF8');
  execute v_def;
  if (select md5(prosrc) from pg_proc where oid = v_oid) is distinct from split_part(v_saved, '|', 3)
     or (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) is distinct from '3b4622d846fa2e6b223b3005d2425650'
     or (select prosecdef from pg_proc where oid = v_oid) then
    raise exception 'S6 rollback failed: the restored definition does not match the saved one.'; end if;
  execute format('comment on function public.change_competition_entry_lifecycle(uuid, text, text, text) is %L', nullif(v_comment, ''));
end $$;

revoke all on function public.change_competition_entry_lifecycle(uuid, text, text, text) from public, postgres, anon, authenticated, service_role;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to public;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to postgres;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to anon;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to authenticated;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to service_role;
commit;
