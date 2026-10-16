-- 20261119091000_twilio_tw4a1_paused_status_and_legal_continuity.sql
-- TW-4A.1 (forward fix on top of 20261119090000; function bodies only, no table, index, trigger or privilege change).
--
--   1. get_studio_sms_status: when a platform admin turns the pilot switch OFF after a setup has started, the owner (and admin)
--      still see that setup (`available` true, `paused` true, editing off) and the owner can still cancel it
--      (`can_cancel`). Before this, the Texting page vanished and a submitted setup could not be followed or cancelled from the UI.
--      With the switch off and NO setup, the answer is unchanged: { available: false, texting_on }.
--   2. get_sms_legal_context: the per-studio SMS Terms/Privacy pages stay available for a studio that has an existing registration
--      (in_review / approved / suspended in studio_sms_registrations), not only for studios with the pilot switch on or a submitted setup.
--
-- Privileges are unchanged (CREATE OR REPLACE keeps the grants made by 20261119090000; the self-check below proves it).
-- Rollback: rollback/20261119091000_twilio_tw4a1_paused_status_and_legal_continuity_rollback.sql
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_onboarding') is null
     or to_regprocedure('public.get_studio_sms_status(uuid)') is null
     or to_regprocedure('public.get_sms_legal_context(text)') is null then
    raise exception 'TW-4A.1 precondition failed: TW-4A (20261119090000) is not applied';
  end if;
end $$;

create or replace function public.get_studio_sms_status(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_role text := public._sms_onb_studio_role(p_studio_id);
  v_admin boolean := public._sms_onb_is_platform_admin();
  v_on boolean;
  v_enabled boolean;
  o public.studio_sms_onboarding;
begin
  if auth.uid() is null or (v_role is null and not v_admin) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_role is not null and v_role not in ('studio_owner', 'studio_admin', 'front_desk') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_on := exists (select 1 from public.studio_sms_registrations r
                  where r.studio_id = p_studio_id and r.registration_status = 'approved');
  if v_role = 'front_desk' then
    return jsonb_build_object('texting_on', v_on);
  end if;
  v_enabled := public._sms_onb_access_enabled(p_studio_id);
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  -- switch off and nothing started: the page does not exist for this studio
  if not v_enabled and o.id is null then
    return jsonb_build_object('available', false, 'texting_on', v_on);
  end if;
  return jsonb_build_object(
    'available', true,
    'paused', not v_enabled,
    'texting_on', v_on,
    'role', coalesce(v_role, 'platform_admin'),
    'can_edit', coalesce(v_enabled and v_role = 'studio_owner' and (o.id is null or o.state in ('draft', 'needs_info')), false),
    'can_cancel', coalesce(v_role = 'studio_owner' and o.id is not null and o.state in ('draft', 'submitted_for_checks', 'needs_info', 'profile_review'), false),
    'state', coalesce(o.state, 'not_started'),
    'needs_info_fields', case when o.state = 'needs_info' and o.last_error_field is not null then jsonb_build_array(o.last_error_field) else '[]'::jsonb end,
    'submitted_at', o.submitted_at,
    'submission_seq', coalesce(o.submission_seq, 0));
end $$;

create or replace function public.get_sms_legal_context(p_studio_slug text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s record;
  o public.studio_sms_onboarding;
begin
  select st.id, st.name, st.slug, st.public_name into s from public.studios st where st.slug = p_studio_slug;
  if s.id is null then return null; end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = s.id and x.state <> 'cancelled';
  -- served while the pilot switch is on, for as long as a submitted setup exists, and for studios with an existing registration
  -- (a campaign links to these pages once it is registered, so neither turning the switch off nor a TW-3 registration may 404 them)
  if not public._sms_onb_access_enabled(s.id)
     and not (o.id is not null and o.state <> 'draft')
     and not exists (select 1 from public.studio_sms_registrations r
                     where r.studio_id = s.id and r.registration_status in ('in_review', 'approved', 'suspended')) then
    return null;
  end if;
  return jsonb_build_object(
    'display_name', coalesce(nullif(btrim(s.public_name), ''), s.name),
    'legal_name', case when o.id is not null and o.state <> 'draft' then o.legal_name else null end);
end $$;

-- self-check: privileges are exactly those of 20261119090000
do $$
declare
  v_bad text[] := '{}';
begin
  if not has_function_privilege('authenticated', 'public.get_studio_sms_status(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.get_studio_sms_status(uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.get_studio_sms_status(uuid)', 'EXECUTE') then
    v_bad := v_bad || 'get_studio_sms_status privileges changed';
  end if;
  if not has_function_privilege('service_role', 'public.get_sms_legal_context(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.get_sms_legal_context(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.get_sms_legal_context(text)', 'EXECUTE') then
    v_bad := v_bad || 'get_sms_legal_context privileges changed';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.get_studio_sms_status(uuid)'::regprocedure and p.prosecdef
                 and 'search_path=pg_catalog, public, pg_temp' = any (p.proconfig))
     or not exists (select 1 from pg_proc p where p.oid = 'public.get_sms_legal_context(text)'::regprocedure and p.prosecdef
                    and 'search_path=pg_catalog, public, pg_temp' = any (p.proconfig)) then
    v_bad := v_bad || 'definer or search_path pin lost';
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'TW-4A.1 self-check failed: %', array_to_string(v_bad, '; ') using errcode = '42501';
  end if;
end $$;

commit;
