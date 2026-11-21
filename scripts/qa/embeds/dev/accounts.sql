-- Website Embeds DEV validation: role rows for three FICTIONAL test accounts (never real people).
-- The auth users are created first by provision-accounts.mjs (GoTrue admin API, email pre-confirmed, random password kept off-repo);
-- this file only links them, by email, to the two fictional fixture studios, and raises if a user or studio is missing.
-- sb.sh dev-apply scripts/qa/embeds/dev/accounts.sql <sha256>
do $$
declare
  a constant uuid := 'e3b00000-0000-4000-8000-000000000001';
  b constant uuid := 'e3b00000-0000-4000-8000-000000000002';
  owner_a uuid; instr_a uuid; owner_b uuid;
begin
  if not exists (select 1 from public.studios where id = a and slug = 'embed-qa-fictional-a')
     or not exists (select 1 from public.studios where id = b and slug = 'embed-qa-fictional-b') then
    raise exception 'fictional fixture studios are missing: apply fixtures.sql first';
  end if;
  select id into owner_a from auth.users where email = 'embed-qa-owner-a@example.test';
  select id into instr_a from auth.users where email = 'embed-qa-instructor-a@example.test';
  select id into owner_b from auth.users where email = 'embed-qa-owner-b@example.test';
  if owner_a is null or instr_a is null or owner_b is null then
    raise exception 'test auth users are missing: run provision-accounts.mjs first';
  end if;
  insert into public.profiles (id, full_name, email) values
    (owner_a, 'Embed QA Owner A (fictional)', 'embed-qa-owner-a@example.test'),
    (instr_a, 'Embed QA Instructor A (fictional)', 'embed-qa-instructor-a@example.test'),
    (owner_b, 'Embed QA Owner B (fictional)', 'embed-qa-owner-b@example.test')
  on conflict (id) do update set full_name = excluded.full_name;
  insert into public.user_studio_roles (user_id, studio_id, role, active)
  select v.u, v.s, v.r::public.app_role, true
  from (values (owner_a, a, 'studio_owner'), (instr_a, a, 'instructor'), (owner_b, b, 'studio_owner')) as v(u, s, r)
  where not exists (select 1 from public.user_studio_roles x where x.user_id = v.u and x.studio_id = v.s);
  -- an older row for the same user+studio would have been skipped above: insist the rows are exactly what the tests assume
  if (select count(*) from public.user_studio_roles x
       where x.active and ((x.user_id = owner_a and x.studio_id = a and x.role = 'studio_owner')
                        or (x.user_id = instr_a and x.studio_id = a and x.role = 'instructor')
                        or (x.user_id = owner_b and x.studio_id = b and x.role = 'studio_owner'))) <> 3 then
    raise exception 'role rows for the test accounts are not as expected: run accounts-cleanup.sql and retry';
  end if;
end
$$;
