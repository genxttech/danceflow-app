-- Template: identifiers, names and amounts are placeholders in square brackets, so this file fails as written.
-- G-SUB prerequisite P2 (entity + [PILOT-CAP] cap). PROD-WRITE: needs the owner's explicit approval of this file hash. Guards refuse unless the genuine owner-attested onboarding exists.
do $$
declare
  v_admin uuid; v_name text; o public.studio_sms_onboarding; v_r jsonb; v_entity uuid;
begin
  select name into v_name from public.studios where id = '[PILOT-STUDIO-ID]'::uuid;
  if v_name is distinct from '[PILOT-STUDIO-NAME]' then raise exception 'STOP: studio name is %, expected [PILOT-STUDIO-NAME]', v_name using errcode = '22023'; end if;
  if (select count(*) from public.profiles where platform_role = 'platform_admin') <> 1 then raise exception 'STOP: expected exactly one platform admin' using errcode = '22023'; end if;
  select id into v_admin from public.profiles where platform_role = 'platform_admin';
  select * into o from public.studio_sms_onboarding x where x.studio_id = '[PILOT-STUDIO-ID]'::uuid and x.state <> 'cancelled' order by x.created_at desc limit 1;
  if o.id is null then raise exception 'STOP: no onboarding for the studio' using errcode = '22023'; end if;
  if lower(btrim(o.legal_name)) is distinct from lower('[PILOT-LEGAL-NAME]') then raise exception 'STOP: legal name on the onboarding is not [PILOT-LEGAL-NAME]' using errcode = '22023'; end if;
  if lower(o.legal_name) like '%genx%' or lower(o.legal_name) like '%totaltech%' then raise exception 'STOP: GenX can never be the subject' using errcode = '22023'; end if;
  if o.attested_at is null or o.state in ('draft','cancelled') or o.ein_stored_at is null or o.ein_last4 is null then raise exception 'STOP: onboarding is not submitted, attested and EIN-stored' using errcode = '22023'; end if;
  if not exists (select 1 from public.user_studio_roles r where r.user_id = o.attested_by and r.studio_id = o.studio_id and r.role = 'studio_owner' and r.active) then raise exception 'STOP: the attestation was not made by an active owner of this studio' using errcode = '22023'; end if;
  if o.rep_first_name is null or o.rep_last_name is null or o.rep_email is null or o.address_line1 is null then raise exception 'STOP: representative or address fields are missing' using errcode = '22023'; end if;
  v_r := public.tw4_entity_create_for_studio('[PILOT-STUDIO-ID]'::uuid, v_admin, 'Created from the owner-attested onboarding; executed by engineering via danceflow-ops under owner authorization');
  v_entity := (v_r ->> 'legal_entity_id')::uuid;
  perform public.tw4_entity_set_spend_cap(v_entity, [PILOT-CAP-CENTS], v_admin);
end $$;
