  v_admin uuid; v_name text;
begin
  select name into v_name from public.studios where id = '__STUDIO__'::uuid;
  if v_name is distinct from '__NAME__' then raise exception 'STOP: studio name is %, expected __NAME__', v_name using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by, updated_at)
  values ('__STUDIO__'::uuid, true, 'G0: enable the Settings > Texting onboarding for the pilot studio (executed by engineering via danceflow-ops under owner authorization)', v_admin, now())
  on conflict (studio_id) do update set enabled = true, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform public._sms_onb_audit('__STUDIO__'::uuid, null, 'platform_admin', 'access_enabled', null, null, 'G0 pilot access enabled via danceflow-ops');
