-- 20270211090000_mobile_push_token_claim.sql
--
-- Phase 20-R, Student App: a device's Expo push token follows whoever is signed
-- in on that device.
--
-- mobile_push_tokens.expo_push_token is unique and its UPDATE policy is
-- user_id = auth.uid(), so when user B signs in on a device whose row still names
-- user A, the app's upsert is refused by RLS. B never registers, and the device
-- keeps receiving A's notifications.
--
-- The table's policies stay as they are: nobody may write another user's row
-- directly. This one function moves a row, for a caller presenting the token
-- itself. Expo tokens are unguessable capabilities; a caller who somehow holds
-- someone's token could only redirect that device to its own notifications.
--
-- Release order: apply before any app build that calls it.
-- Rollback: rollback/20270211090000_mobile_push_token_claim_rollback.sql

begin;

create function public.claim_mobile_push_token(
  p_expo_push_token text,
  p_platform text,
  p_app_slug text default 'danceflow-student'
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_expo_push_token is null
     or length(p_expo_push_token) > 255
     or p_expo_push_token !~ '^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$' then
    raise exception 'invalid push token' using errcode = '22023';
  end if;

  if p_platform is null or p_platform not in ('ios', 'android', 'web', 'unknown') then
    raise exception 'invalid platform' using errcode = '22023';
  end if;

  if p_app_slug is null or p_app_slug !~ '^[a-z0-9-]{1,64}$' then
    raise exception 'invalid app' using errcode = '22023';
  end if;

  insert into public.mobile_push_tokens as t (
    user_id, expo_push_token, platform, app_slug, enabled, last_registered_at
  ) values (
    v_uid, p_expo_push_token, p_platform, p_app_slug, true, now()
  )
  on conflict (expo_push_token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        app_slug = excluded.app_slug,
        device_name = case when t.user_id = excluded.user_id then t.device_name end,
        enabled = true,
        last_registered_at = now();
end;
$$;

alter function public.claim_mobile_push_token(text, text, text) owner to postgres;

revoke all on function public.claim_mobile_push_token(text, text, text) from public, anon, service_role;
grant execute on function public.claim_mobile_push_token(text, text, text) to authenticated;

commit;
