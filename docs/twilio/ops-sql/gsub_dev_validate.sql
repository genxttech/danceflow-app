do $outer$
declare v_res jsonb := '{}'::jsonb; v_owner uuid := gen_random_uuid();
begin
  set local session_replication_role = replica;
  insert into public.studios (id,name,slug,subscription_status,timezone) values ('d1f27487-656a-4085-8552-94ddd47f8e4d','Rehearsal Studio','gsub-r-d1f27487','active','America/New_York');
  insert into public.user_studio_roles (user_id, studio_id, role, active) values (v_owner, 'd1f27487-656a-4085-8552-94ddd47f8e4d', 'studio_owner', true);
  set local session_replication_role = origin;
  begin execute $q$do $b$
declare
  v_admin uuid; v_name text;
begin
  select name into v_name from public.studios where id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid;
  if v_name is distinct from 'Other Studio' then raise exception 'STOP: studio name is %, expected Other Studio', v_name using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by, updated_at)
  values ('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, true, 'G0: enable the Settings > Texting onboarding for the pilot studio (executed by engineering via danceflow-ops under owner authorization)', v_admin, now())
  on conflict (studio_id) do update set enabled = true, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform public._sms_onb_audit('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, null, 'platform_admin', 'access_enabled', null, null, 'G0 pilot access enabled via danceflow-ops');
end $b$;
$q$; v_res := v_res || jsonb_build_object('access_wrong_name', 'NOT_REFUSED'); exception when others then v_res := v_res || jsonb_build_object('access_wrong_name', sqlerrm); end;
  begin execute $q$do $b$
declare
  v_admin uuid; v_name text;
begin
  select name into v_name from public.studios where id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid;
  if v_name is distinct from 'Rehearsal Studio' then raise exception 'STOP: studio name is %, expected Rehearsal Studio', v_name using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by, updated_at)
  values ('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, true, 'G0: enable the Settings > Texting onboarding for the pilot studio (executed by engineering via danceflow-ops under owner authorization)', v_admin, now())
  on conflict (studio_id) do update set enabled = true, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform public._sms_onb_audit('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, null, 'platform_admin', 'access_enabled', null, null, 'G0 pilot access enabled via danceflow-ops');
end $b$;
$q$; v_res := v_res || jsonb_build_object('access_ok', (select enabled from public.studio_sms_onboarding_access where studio_id='d1f27487-656a-4085-8552-94ddd47f8e4d')::text); exception when others then v_res := v_res || jsonb_build_object('access_ok', sqlerrm); end;
  begin execute $q$do $b$
declare
  v_admin uuid; v_name text;
begin
  select name into v_name from public.studios where id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid;
  if v_name is distinct from 'Rehearsal Studio' then raise exception 'STOP: studio name is %, expected Rehearsal Studio', v_name using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by, updated_at)
  values ('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, true, 'G0: enable the Settings > Texting onboarding for the pilot studio (executed by engineering via danceflow-ops under owner authorization)', v_admin, now())
  on conflict (studio_id) do update set enabled = true, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform public._sms_onb_audit('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, null, 'platform_admin', 'access_enabled', null, null, 'G0 pilot access enabled via danceflow-ops');
end $b$;
$q$; v_res := v_res || jsonb_build_object('access_idempotent', 'ok'); exception when others then v_res := v_res || jsonb_build_object('access_idempotent', sqlerrm); end;
  begin execute $q$do $b$
declare
  v_admin uuid; v_name text; o public.studio_sms_onboarding; v_r jsonb; v_entity uuid;
begin
  select name into v_name from public.studios where id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid;
  if v_name is distinct from 'Rehearsal Studio' then raise exception 'STOP: studio name is %, expected Rehearsal Studio', v_name using errcode = '22023'; end if;
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  select * into o from public.studio_sms_onboarding x where x.studio_id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid and x.state <> 'cancelled' order by x.created_at desc limit 1;
  if o.id is null then raise exception 'STOP: no onboarding for the studio' using errcode = '22023'; end if;
  if lower(btrim(o.legal_name)) is distinct from lower('Rehearsal Dance, LLC') then raise exception 'STOP: legal name on the onboarding is not Rehearsal Dance, LLC' using errcode = '22023'; end if;
  if lower(o.legal_name) like '%genx%' or lower(o.legal_name) like '%totaltech%' then raise exception 'STOP: GenX can never be the subject' using errcode = '22023'; end if;
  if o.attested_at is null or o.state in ('draft','cancelled') or o.ein_stored_at is null or o.ein_last4 is null then raise exception 'STOP: onboarding is not submitted, attested and EIN-stored' using errcode = '22023'; end if;
  if not exists (select 1 from public.user_studio_roles r where r.user_id = o.attested_by and r.studio_id = o.studio_id and r.role = 'studio_owner' and r.active) then raise exception 'STOP: the attestation was not made by an active owner of this studio' using errcode = '22023'; end if;
  if o.rep_first_name is null or o.rep_last_name is null or o.rep_email is null or o.address_line1 is null then raise exception 'STOP: representative or address fields are missing' using errcode = '22023'; end if;
  v_r := public.tw4_entity_create_for_studio('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, v_admin, 'Created from the owner-attested onboarding; executed by engineering via danceflow-ops under owner authorization');
  v_entity := (v_r ->> 'legal_entity_id')::uuid;
  perform public.tw4_entity_set_spend_cap(v_entity, 15000, v_admin);
end $b$;
$q$; v_res := v_res || jsonb_build_object('entity_no_onboarding', 'NOT_REFUSED'); exception when others then v_res := v_res || jsonb_build_object('entity_no_onboarding', sqlerrm); end;
  set local session_replication_role = replica;
  insert into public.studio_sms_onboarding (studio_id,state,legal_name,ein_last4,submission_seq) values ('d1f27487-656a-4085-8552-94ddd47f8e4d','draft','Rehearsal Dance, LLC','0000',0);
  set local session_replication_role = origin;
  begin execute $q$do $b$
declare
  v_admin uuid; v_name text; o public.studio_sms_onboarding; v_r jsonb; v_entity uuid;
begin
  select name into v_name from public.studios where id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid;
  if v_name is distinct from 'Rehearsal Studio' then raise exception 'STOP: studio name is %, expected Rehearsal Studio', v_name using errcode = '22023'; end if;
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  select * into o from public.studio_sms_onboarding x where x.studio_id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid and x.state <> 'cancelled' order by x.created_at desc limit 1;
  if o.id is null then raise exception 'STOP: no onboarding for the studio' using errcode = '22023'; end if;
  if lower(btrim(o.legal_name)) is distinct from lower('Rehearsal Dance, LLC') then raise exception 'STOP: legal name on the onboarding is not Rehearsal Dance, LLC' using errcode = '22023'; end if;
  if lower(o.legal_name) like '%genx%' or lower(o.legal_name) like '%totaltech%' then raise exception 'STOP: GenX can never be the subject' using errcode = '22023'; end if;
  if o.attested_at is null or o.state in ('draft','cancelled') or o.ein_stored_at is null or o.ein_last4 is null then raise exception 'STOP: onboarding is not submitted, attested and EIN-stored' using errcode = '22023'; end if;
  if not exists (select 1 from public.user_studio_roles r where r.user_id = o.attested_by and r.studio_id = o.studio_id and r.role = 'studio_owner' and r.active) then raise exception 'STOP: the attestation was not made by an active owner of this studio' using errcode = '22023'; end if;
  if o.rep_first_name is null or o.rep_last_name is null or o.rep_email is null or o.address_line1 is null then raise exception 'STOP: representative or address fields are missing' using errcode = '22023'; end if;
  v_r := public.tw4_entity_create_for_studio('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, v_admin, 'Created from the owner-attested onboarding; executed by engineering via danceflow-ops under owner authorization');
  v_entity := (v_r ->> 'legal_entity_id')::uuid;
  perform public.tw4_entity_set_spend_cap(v_entity, 15000, v_admin);
end $b$;
$q$; v_res := v_res || jsonb_build_object('entity_draft', 'NOT_REFUSED'); exception when others then v_res := v_res || jsonb_build_object('entity_draft', sqlerrm); end;
  set local session_replication_role = replica;
  update public.studio_sms_onboarding set state='submitted_for_checks', attested_at=now(), attested_by=gen_random_uuid(), ein_stored_at=now(), rep_first_name='R', rep_last_name='Rep', rep_email='rep@example.test', address_line1='1 Test St', submission_seq=1, submitted_at=now() where studio_id='d1f27487-656a-4085-8552-94ddd47f8e4d';
  set local session_replication_role = origin;
  begin execute $q$do $b$
declare
  v_admin uuid; v_name text; o public.studio_sms_onboarding; v_r jsonb; v_entity uuid;
begin
  select name into v_name from public.studios where id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid;
  if v_name is distinct from 'Rehearsal Studio' then raise exception 'STOP: studio name is %, expected Rehearsal Studio', v_name using errcode = '22023'; end if;
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  select * into o from public.studio_sms_onboarding x where x.studio_id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid and x.state <> 'cancelled' order by x.created_at desc limit 1;
  if o.id is null then raise exception 'STOP: no onboarding for the studio' using errcode = '22023'; end if;
  if lower(btrim(o.legal_name)) is distinct from lower('Rehearsal Dance, LLC') then raise exception 'STOP: legal name on the onboarding is not Rehearsal Dance, LLC' using errcode = '22023'; end if;
  if lower(o.legal_name) like '%genx%' or lower(o.legal_name) like '%totaltech%' then raise exception 'STOP: GenX can never be the subject' using errcode = '22023'; end if;
  if o.attested_at is null or o.state in ('draft','cancelled') or o.ein_stored_at is null or o.ein_last4 is null then raise exception 'STOP: onboarding is not submitted, attested and EIN-stored' using errcode = '22023'; end if;
  if not exists (select 1 from public.user_studio_roles r where r.user_id = o.attested_by and r.studio_id = o.studio_id and r.role = 'studio_owner' and r.active) then raise exception 'STOP: the attestation was not made by an active owner of this studio' using errcode = '22023'; end if;
  if o.rep_first_name is null or o.rep_last_name is null or o.rep_email is null or o.address_line1 is null then raise exception 'STOP: representative or address fields are missing' using errcode = '22023'; end if;
  v_r := public.tw4_entity_create_for_studio('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, v_admin, 'Created from the owner-attested onboarding; executed by engineering via danceflow-ops under owner authorization');
  v_entity := (v_r ->> 'legal_entity_id')::uuid;
  perform public.tw4_entity_set_spend_cap(v_entity, 15000, v_admin);
end $b$;
$q$; v_res := v_res || jsonb_build_object('entity_attested_by_non_owner', 'NOT_REFUSED'); exception when others then v_res := v_res || jsonb_build_object('entity_attested_by_non_owner', sqlerrm); end;
  set local session_replication_role = replica; update public.studio_sms_onboarding set attested_by = v_owner where studio_id='d1f27487-656a-4085-8552-94ddd47f8e4d'; set local session_replication_role = origin;
  begin execute $q$do $b$
declare
  v_admin uuid; v_name text; o public.studio_sms_onboarding; v_r jsonb; v_entity uuid;
begin
  select name into v_name from public.studios where id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid;
  if v_name is distinct from 'Rehearsal Studio' then raise exception 'STOP: studio name is %, expected Rehearsal Studio', v_name using errcode = '22023'; end if;
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  select * into o from public.studio_sms_onboarding x where x.studio_id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid and x.state <> 'cancelled' order by x.created_at desc limit 1;
  if o.id is null then raise exception 'STOP: no onboarding for the studio' using errcode = '22023'; end if;
  if lower(btrim(o.legal_name)) is distinct from lower('Someone Else LLC') then raise exception 'STOP: legal name on the onboarding is not Someone Else LLC' using errcode = '22023'; end if;
  if lower(o.legal_name) like '%genx%' or lower(o.legal_name) like '%totaltech%' then raise exception 'STOP: GenX can never be the subject' using errcode = '22023'; end if;
  if o.attested_at is null or o.state in ('draft','cancelled') or o.ein_stored_at is null or o.ein_last4 is null then raise exception 'STOP: onboarding is not submitted, attested and EIN-stored' using errcode = '22023'; end if;
  if not exists (select 1 from public.user_studio_roles r where r.user_id = o.attested_by and r.studio_id = o.studio_id and r.role = 'studio_owner' and r.active) then raise exception 'STOP: the attestation was not made by an active owner of this studio' using errcode = '22023'; end if;
  if o.rep_first_name is null or o.rep_last_name is null or o.rep_email is null or o.address_line1 is null then raise exception 'STOP: representative or address fields are missing' using errcode = '22023'; end if;
  v_r := public.tw4_entity_create_for_studio('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, v_admin, 'Created from the owner-attested onboarding; executed by engineering via danceflow-ops under owner authorization');
  v_entity := (v_r ->> 'legal_entity_id')::uuid;
  perform public.tw4_entity_set_spend_cap(v_entity, 15000, v_admin);
end $b$;
$q$; v_res := v_res || jsonb_build_object('entity_wrong_legal', 'NOT_REFUSED'); exception when others then v_res := v_res || jsonb_build_object('entity_wrong_legal', sqlerrm); end;
  begin execute $q$do $b$
declare
  v_admin uuid; v_name text; o public.studio_sms_onboarding; v_r jsonb; v_entity uuid;
begin
  select name into v_name from public.studios where id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid;
  if v_name is distinct from 'Rehearsal Studio' then raise exception 'STOP: studio name is %, expected Rehearsal Studio', v_name using errcode = '22023'; end if;
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  select * into o from public.studio_sms_onboarding x where x.studio_id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid and x.state <> 'cancelled' order by x.created_at desc limit 1;
  if o.id is null then raise exception 'STOP: no onboarding for the studio' using errcode = '22023'; end if;
  if lower(btrim(o.legal_name)) is distinct from lower('Rehearsal Dance, LLC') then raise exception 'STOP: legal name on the onboarding is not Rehearsal Dance, LLC' using errcode = '22023'; end if;
  if lower(o.legal_name) like '%genx%' or lower(o.legal_name) like '%totaltech%' then raise exception 'STOP: GenX can never be the subject' using errcode = '22023'; end if;
  if o.attested_at is null or o.state in ('draft','cancelled') or o.ein_stored_at is null or o.ein_last4 is null then raise exception 'STOP: onboarding is not submitted, attested and EIN-stored' using errcode = '22023'; end if;
  if not exists (select 1 from public.user_studio_roles r where r.user_id = o.attested_by and r.studio_id = o.studio_id and r.role = 'studio_owner' and r.active) then raise exception 'STOP: the attestation was not made by an active owner of this studio' using errcode = '22023'; end if;
  if o.rep_first_name is null or o.rep_last_name is null or o.rep_email is null or o.address_line1 is null then raise exception 'STOP: representative or address fields are missing' using errcode = '22023'; end if;
  v_r := public.tw4_entity_create_for_studio('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, v_admin, 'Created from the owner-attested onboarding; executed by engineering via danceflow-ops under owner authorization');
  v_entity := (v_r ->> 'legal_entity_id')::uuid;
  perform public.tw4_entity_set_spend_cap(v_entity, 15000, v_admin);
end $b$;
$q$; v_res := v_res || jsonb_build_object('entity_ok', (select e.spend_cap_cents from public.studio_sms_legal_entities e join public.studio_sms_entity_studios s on s.legal_entity_id=e.id where s.studio_id='d1f27487-656a-4085-8552-94ddd47f8e4d')::text); exception when others then v_res := v_res || jsonb_build_object('entity_ok', sqlerrm); end;
  begin execute $q$do $b$
declare
  v_admin uuid; v_name text; o public.studio_sms_onboarding; v_r jsonb; v_entity uuid;
begin
  select name into v_name from public.studios where id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid;
  if v_name is distinct from 'Rehearsal Studio' then raise exception 'STOP: studio name is %, expected Rehearsal Studio', v_name using errcode = '22023'; end if;
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  select * into o from public.studio_sms_onboarding x where x.studio_id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid and x.state <> 'cancelled' order by x.created_at desc limit 1;
  if o.id is null then raise exception 'STOP: no onboarding for the studio' using errcode = '22023'; end if;
  if lower(btrim(o.legal_name)) is distinct from lower('Rehearsal Dance, LLC') then raise exception 'STOP: legal name on the onboarding is not Rehearsal Dance, LLC' using errcode = '22023'; end if;
  if lower(o.legal_name) like '%genx%' or lower(o.legal_name) like '%totaltech%' then raise exception 'STOP: GenX can never be the subject' using errcode = '22023'; end if;
  if o.attested_at is null or o.state in ('draft','cancelled') or o.ein_stored_at is null or o.ein_last4 is null then raise exception 'STOP: onboarding is not submitted, attested and EIN-stored' using errcode = '22023'; end if;
  if not exists (select 1 from public.user_studio_roles r where r.user_id = o.attested_by and r.studio_id = o.studio_id and r.role = 'studio_owner' and r.active) then raise exception 'STOP: the attestation was not made by an active owner of this studio' using errcode = '22023'; end if;
  if o.rep_first_name is null or o.rep_last_name is null or o.rep_email is null or o.address_line1 is null then raise exception 'STOP: representative or address fields are missing' using errcode = '22023'; end if;
  v_r := public.tw4_entity_create_for_studio('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, v_admin, 'Created from the owner-attested onboarding; executed by engineering via danceflow-ops under owner authorization');
  v_entity := (v_r ->> 'legal_entity_id')::uuid;
  perform public.tw4_entity_set_spend_cap(v_entity, 15000, v_admin);
end $b$;
$q$; v_res := v_res || jsonb_build_object('entity_replay', 'NOT_REFUSED'); exception when others then v_res := v_res || jsonb_build_object('entity_replay', sqlerrm); end;
  set local session_replication_role = replica; update public.studio_sms_onboarding set legal_name='GenX TotalTech LLC' where studio_id='d1f27487-656a-4085-8552-94ddd47f8e4d'; set local session_replication_role = origin;
  begin execute $q$do $b$
declare
  v_admin uuid; v_name text; o public.studio_sms_onboarding; v_r jsonb; v_entity uuid;
begin
  select name into v_name from public.studios where id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid;
  if v_name is distinct from 'Rehearsal Studio' then raise exception 'STOP: studio name is %, expected Rehearsal Studio', v_name using errcode = '22023'; end if;
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  select * into o from public.studio_sms_onboarding x where x.studio_id = 'd1f27487-656a-4085-8552-94ddd47f8e4d'::uuid and x.state <> 'cancelled' order by x.created_at desc limit 1;
  if o.id is null then raise exception 'STOP: no onboarding for the studio' using errcode = '22023'; end if;
  if lower(btrim(o.legal_name)) is distinct from lower('GenX TotalTech LLC') then raise exception 'STOP: legal name on the onboarding is not GenX TotalTech LLC' using errcode = '22023'; end if;
  if lower(o.legal_name) like '%genx%' or lower(o.legal_name) like '%totaltech%' then raise exception 'STOP: GenX can never be the subject' using errcode = '22023'; end if;
  if o.attested_at is null or o.state in ('draft','cancelled') or o.ein_stored_at is null or o.ein_last4 is null then raise exception 'STOP: onboarding is not submitted, attested and EIN-stored' using errcode = '22023'; end if;
  if not exists (select 1 from public.user_studio_roles r where r.user_id = o.attested_by and r.studio_id = o.studio_id and r.role = 'studio_owner' and r.active) then raise exception 'STOP: the attestation was not made by an active owner of this studio' using errcode = '22023'; end if;
  if o.rep_first_name is null or o.rep_last_name is null or o.rep_email is null or o.address_line1 is null then raise exception 'STOP: representative or address fields are missing' using errcode = '22023'; end if;
  v_r := public.tw4_entity_create_for_studio('d1f27487-656a-4085-8552-94ddd47f8e4d'::uuid, v_admin, 'Created from the owner-attested onboarding; executed by engineering via danceflow-ops under owner authorization');
  v_entity := (v_r ->> 'legal_entity_id')::uuid;
  perform public.tw4_entity_set_spend_cap(v_entity, 15000, v_admin);
end $b$;
$q$; v_res := v_res || jsonb_build_object('genx_subject', 'NOT_REFUSED'); exception when others then v_res := v_res || jsonb_build_object('genx_subject', sqlerrm); end;
  v_res := v_res || jsonb_build_object('twilio_account_rows', (select count(*) from public.studio_sms_twilio_accounts), 'audit', (select jsonb_agg(action order by created_at) from public.studio_sms_onboarding_audit where studio_id='d1f27487-656a-4085-8552-94ddd47f8e4d'));
  raise exception 'GSUB_RESULT %', v_res::text;
end $outer$;
