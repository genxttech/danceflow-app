-- Rollback for 20261119091000_twilio_tw4a1_paused_status_and_legal_continuity.sql (TW-4A.1).
-- Restores the two function bodies exactly as 20261119090000 defined them (lifted verbatim). Privileges are unchanged by either direction.
-- Order: application first (the Texting page reads the "paused"/"can_cancel" keys but tolerates their absence), then this script.
begin;

set local lock_timeout = '5s';

create or replace function public.get_studio_sms_status(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_role text := public._sms_onb_studio_role(p_studio_id);
  v_admin boolean := public._sms_onb_is_platform_admin();
  v_on boolean;
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
  if not public._sms_onb_access_enabled(p_studio_id) then
    return jsonb_build_object('available', false, 'texting_on', v_on);
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  return jsonb_build_object(
    'available', true,
    'texting_on', v_on,
    'role', coalesce(v_role, 'platform_admin'),
    'can_edit', v_role = 'studio_owner' and (o.id is null or o.state in ('draft', 'needs_info')),
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
  -- available while the pilot switch is on, and for as long as a submitted setup exists (the pages are linked from a
  -- campaign once it is registered, so turning the switch off must not 404 them)
  if not public._sms_onb_access_enabled(s.id) and not (o.id is not null and o.state <> 'draft') then
    return null;
  end if;
  return jsonb_build_object(
    'display_name', coalesce(nullif(btrim(s.public_name), ''), s.name),
    'legal_name', case when o.id is not null and o.state <> 'draft' then o.legal_name else null end);
end $$;

do $$
begin
  if position('paused' in (select prosrc from pg_proc where oid = 'public.get_studio_sms_status(uuid)'::regprocedure)) > 0
     or position('studio_sms_registrations' in (select prosrc from pg_proc where oid = 'public.get_sms_legal_context(text)'::regprocedure)) > 0 then
    raise exception 'TW-4A.1 rollback self-check failed: new bodies remain';
  end if;
end $$;

commit;
