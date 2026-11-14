-- Removes exactly the three fictional test accounts and their rows (matched by the fixed emails). Safe to re-run.
-- Run fixtures-cleanup.sql afterwards if the fictional studios should go too.
-- sb.sh dev-apply scripts/qa/embeds/dev/accounts-cleanup.sql <sha256>
do $$
declare
  ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into ids from auth.users
   where email in ('embed-qa-owner-a@example.test', 'embed-qa-instructor-a@example.test', 'embed-qa-owner-b@example.test');
  delete from public.user_studio_roles where user_id = any (ids);
  delete from public.profiles where id = any (ids);
  delete from auth.users where id = any (ids);
end
$$;
