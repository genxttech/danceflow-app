-- Template: identifiers, names and amounts are placeholders in square brackets, so this file fails as written.
-- G-SUB prerequisite P0 (G0 pilot access for [PILOT-STUDIO-NAME]). PROD-WRITE: needs the owner's explicit approval of this file hash. Equivalent to set_sms_onboarding_access(...) in the platform page.
do $$
declare
  v_admin uuid; v_name text;
begin
  select name into v_name from public.studios where id = '[PILOT-STUDIO-ID]'::uuid;
  if v_name is distinct from '[PILOT-STUDIO-NAME]' then raise exception 'STOP: studio name is %, expected [PILOT-STUDIO-NAME]', v_name using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by, updated_at)
  values ('[PILOT-STUDIO-ID]'::uuid, true, 'G0: enable the Settings > Texting onboarding for the pilot studio (executed by engineering via danceflow-ops under owner authorization)', v_admin, now())
  on conflict (studio_id) do update set enabled = true, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform public._sms_onb_audit('[PILOT-STUDIO-ID]'::uuid, null, 'platform_admin', 'access_enabled', null, null, 'G0 pilot access enabled via danceflow-ops');
end $$;
